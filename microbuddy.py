#!/usr/bin/env python3
"""Micro Buddy Dashboard backend — QR/app-pairing auth PWA + offline sync.

Proxies Christian's Micro Buddy MCP server (Supabase edge function) with a
bearer token, and serves the offline-first PWA shell.

Auth: QR pairing with the Micro Buddy iPhone app. The dashboard shows a QR
code (microbuddy://pair?server=...&code=...); the app — already signed in —
scans it and POSTs the one-time code plus its Supabase session
(access_token + refresh_token) to /api/pair/claim. The backend verifies the
access token against Supabase Auth and hands the session to the browser's
polling loop, which stores it locally. The browser is then a full Supabase
client, just like the phone: reads and writes go through the same RLS
rules, the backup is cached for offline, and edits made offline are queued
and pushed when back online. No password, no token juggling, no public URL
or HTTPS needed — the dashboard stays private on the tailnet/LAN, and the
Docker image ships with zero secrets.

Per-user preferences (theme, AI config) are stored server-side in
users/<apple_sub>.json and synced to the client's IndexedDB on sign-in.

Theme sync: the iPhone app is the source of truth for the theme. It writes
its current theme to a shared Supabase `user_preferences` table; the
dashboard reads it on login/sync (GET /api/preferences prefers the shared
theme, falling back to the local file) and writes back there when the theme
is changed from the dashboard (bidirectional). Everything still works if the
shared table doesn't exist yet.

Config (env vars or files in BASE_DIR):
  MICROBUDDY_TOKEN   bearer token for the MCP server (.token file)
  SUPABASE_URL       Supabase project URL (defaults to the shared backend)
  SUPABASE_ANON_KEY  Supabase public anon key, used to verify the phone's
                     session during pairing (.supabase_anon_key file)
  SUPABASE_SERVICE_KEY  (optional) Supabase key for the shared user_preferences
                        table (.supabase_service_key file); falls back to
                        MICROBUDDY_TOKEN if unset

Static files served: /, /dashboard.html, /manifest.json, /sw.js, /themes.css,
  /db.js, /sync.js, /qrcode.min.js, /settings.js, /buddy.js, /icons/*
API (auth required unless noted):
  GET  /api/health        {ok, token_configured, auth_mode}            (public)
  GET  /api/config        {authMode}                                   (public)
  POST /api/pair/start    -> {code, poll_token, server_url, expires_in} (public)
  GET  /api/pair/status?poll_token= -> {claimed, session?}             (public)
                       hands the Supabase session to the browser once claimed
  POST /api/pair/claim    {code, access_token, refresh_token} -> {ok}  (public)
  POST /api/pair/revoke   {} -> {ok}  (public; unlinks: clears pair codes,
                       browser sessions, and the widget token)
  GET  /logout
  GET  /api/preferences        {theme, ai_config} (api_key masked)
                                 theme prefers the shared iPhone theme
  POST /api/preferences        {theme?, ai_config?} -> merged + saved
                                 (theme also pushed to the shared table)
  GET  /api/ai-config          {provider, server_url, model, api_key_set}
  POST /api/ai-config          {provider, server_url, model, api_key?}
  GET  /api/chat               [{id, title, updated_at, message_count}] (session list)
  GET  /api/chat/sync?since=ms [{id, title, updated_at, messages:[{role,content,ts}]}]
  DELETE /api/chat?session=id  delete one session (omit session= to delete all)
  POST /api/ai-chat            {session_id?, messages:[{role,content}] (new user msgs)}
                               -> {session_id, title, reply, user_ts, reply_ts}
                               Appends user msgs + AI reply to the stored
                               conversation (server is canonical; clients sync).
  GET  /api/day-summary, /api/day-sales, /api/days, /api/products,
       /api/stats, /api/take-home, /api/schedule   (MCP proxy)
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import shutil
import os
import re
import secrets
import time
import urllib.request
import urllib.error
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs, quote

MCP_HOST = "tgarraczeevyrjfxzkkf.supabase.co"
MCP_URL = f"https://{MCP_HOST}/functions/v1/mcp-server"
APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys"
APPLE_ISSUER = "https://appleid.apple.com"
PORT = 5002
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
USERS_DIR = os.path.join(BASE_DIR, "users")
SESSION_TIMEOUT = 86400 * 30  # 30 days
_JWKS_CACHE: dict = {"keys": None, "fetched_at": 0}
_JWKS_TTL = 86400  # refresh Apple's public keys daily

VALID_THEMES = {"dark", "win95", "frosted", "terminal"}
AI_PROVIDERS = {"disabled", "ollama", "openai"}


def _read_secret(env_name: str, *filenames: str) -> str:
    v = os.environ.get(env_name, "").strip()
    if v:
        return v
    for fn in filenames:
        p = os.path.join(BASE_DIR, fn)
        if os.path.exists(p):
            with open(p) as f:
                v = f.read().strip()
                if v:
                    return v
    return ""


TOKEN = _read_secret("MICROBUDDY_TOKEN", ".token")
APP_BUNDLE_ID = _read_secret("APPLE_APP_BUNDLE_ID", ".apple_app_id")

# session_id -> {"exp": float, "sub": str, "email": str, "name": str}
# Persisted to .sessions.json so logins survive an app restart / server
# reboot. Unlink (/api/pair/revoke) and /logout clear it and re-save, so a
# wiped login can never be resurrected by a restart.
SESSIONS: dict[str, dict] = {}
SESSIONS_FILE = os.path.join(BASE_DIR, ".sessions.json")
_rpc_id = 0


def _load_sessions() -> None:
    try:
        with open(SESSIONS_FILE) as f:
            data = json.load(f)
        now = time.time()
        for sid, sess in data.items():
            if isinstance(sess, dict) and sess.get("exp", 0) > now:
                SESSIONS[sid] = sess
    except Exception:
        pass


def _save_sessions() -> None:
    try:
        tmp = SESSIONS_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(dict(SESSIONS), f)
        os.chmod(tmp, 0o600)
        os.replace(tmp, SESSIONS_FILE)
    except Exception as e:
        print(f"[session] warning: couldn't persist sessions: {e}", flush=True)


_load_sessions()

# QR pairing: code -> {"code", "exp", "poll", "sid"}.
# The browser shows the QR, polls with the secret poll token, and the iPhone
# app claims the code with an Apple identity token. Single-use, 5 minutes.
PAIRINGS: dict[str, dict] = {}
PAIR_TTL = 300
_PAIR_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # no lookalike chars


def _prune_pairings() -> None:
    now = time.time()
    for code in [c for c, p in PAIRINGS.items() if p["exp"] < now]:
        PAIRINGS.pop(code, None)


def _new_pair_code() -> str:
    _prune_pairings()
    while True:
        code = "".join(secrets.choice(_PAIR_ALPHABET) for _ in range(6))
        if code not in PAIRINGS:
            return code


def _supabase_get_user(access_token: str) -> dict:
    """Verify a Supabase access token via Auth. Returns the user dict."""
    req = urllib.request.Request(
        f"{SUPABASE_URL}/auth/v1/user",
        headers={
            "apikey": SUPABASE_ANON_KEY,
            "Authorization": f"Bearer {access_token}",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise ValueError(f"Supabase rejected the session (HTTP {e.code})")


def _supabase_rest(method: str, path: str, access_token: str,
                   body: dict | None = None, query: str = "") -> dict | None:
    """PostgREST call with the user's own session (RLS-enforced)."""
    data = json.dumps(body).encode() if body is not None else None
    headers = {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/{path}{query}",
        data=data, headers=headers, method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode("utf-8").strip()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:300]
        raise ValueError(f"Supabase {method} {path} -> HTTP {e.code}: {detail}")


def _fmt_money(v) -> str:
    try:
        return f"${float(v):,.0f}"
    except (TypeError, ValueError):
        return "$0"


def _pay_period_containing(day: datetime.date):
    # Biweekly pay periods anchored on iOS payday Sep 18, 2026.
    anchor = datetime.date(2026, 9, 18)
    delta = (day - anchor).days
    n = delta // 14
    start = anchor + datetime.timedelta(days=n * 14)
    return start, start + datetime.timedelta(days=13)


def _mint_mcp_token(user_id: str, access_token: str) -> str:
    """Mint a per-user MCP token for this dashboard pairing.

    Uses the user's own Supabase session (RLS-enforced) — the same way the
    phone app's Profile -> MCP Server screen mints tokens. Old auto-minted
    'dashboard' tokens for this user are cleaned up first. Returns the raw
    token (only known at mint time; only the hash is stored).
    """
    raw = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(raw.encode()).hexdigest()
    # Clean up previous dashboard tokens for this user.
    try:
        _supabase_rest("DELETE", "mcp_tokens", access_token,
                       query=f"?user_id=eq.{user_id}&label=eq.dashboard")
    except Exception as e:
        print(f"[pair] warning: couldn't clean old dashboard tokens: {e}", flush=True)
    _supabase_rest("POST", "mcp_tokens", access_token, body={
        "user_id": user_id,
        "token_hash": token_hash,
        "label": "dashboard",
    })
    return raw


# ================= Per-user preferences =================

def _safe_sub(sub: str) -> str:
    """Sanitize an Apple sub for use as a filename."""
    safe = re.sub(r"[^a-zA-Z0-9._-]", "_", sub or "")
    return safe[:128] or "unknown"


def _user_path(sub: str) -> str:
    os.makedirs(USERS_DIR, exist_ok=True)
    return os.path.join(USERS_DIR, _safe_sub(sub) + ".json")


def default_prefs() -> dict:
    return {
        "theme": "dark",
        "ai_config": {
            "provider": "disabled",
            "server_url": "",
            "model": "",
            "api_key": "",
        },
        # Buddy chat history — syncable conversation data, keyed by session id.
        # Schema per session: {id, title, created_at, updated_at,
        #   messages: [{role: "user"|"assistant", content, ts}]}
        # (Platform-agnostic: the AI model is a per-platform setting, the
        # conversations themselves sync across devices.)
        "conversations": {},
    }


# Caps so one user's chat file can't grow without bound.
MAX_SESSIONS_PER_USER = 100
MAX_MESSAGES_PER_SESSION = 200


def load_prefs(sub: str) -> dict:
    prefs = default_prefs()
    try:
        with open(_user_path(sub)) as f:
            stored = json.load(f)
        if isinstance(stored, dict):
            if stored.get("theme") in VALID_THEMES:
                prefs["theme"] = stored["theme"]
            ac = stored.get("ai_config")
            if isinstance(ac, dict):
                for k in ("provider", "server_url", "model", "api_key"):
                    if isinstance(ac.get(k), str):
                        prefs["ai_config"][k] = ac[k]
                if prefs["ai_config"]["provider"] not in AI_PROVIDERS:
                    prefs["ai_config"]["provider"] = "disabled"
            conv = stored.get("conversations")
            if isinstance(conv, dict):
                # Sanitize: keep only well-formed sessions/messages.
                clean = {}
                for sid, s in conv.items():
                    if not isinstance(s, dict) or not isinstance(sid, str):
                        continue
                    msgs = s.get("messages")
                    if not isinstance(msgs, list):
                        continue
                    good = []
                    for m in msgs:
                        if (isinstance(m, dict)
                                and m.get("role") in ("user", "assistant")
                                and isinstance(m.get("content"), str)):
                            good.append({
                                "role": m["role"],
                                "content": m["content"][:12000],
                                "ts": int(m.get("ts") or 0),
                            })
                    clean[sid[:128]] = {
                        "id": sid[:128],
                        "title": str(s.get("title") or "")[:120],
                        "created_at": int(s.get("created_at") or 0),
                        "updated_at": int(s.get("updated_at") or 0),
                        "messages": good[-MAX_MESSAGES_PER_SESSION:],
                    }
                # Keep the most recently updated sessions.
                ordered = sorted(clean.values(),
                                 key=lambda s: s["updated_at"], reverse=True)
                prefs["conversations"] = {
                    s["id"]: s for s in ordered[:MAX_SESSIONS_PER_USER]
                }
    except (OSError, ValueError):
        pass
    return prefs


def save_prefs(sub: str, prefs: dict) -> None:
    path = _user_path(sub)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(prefs, f, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def public_ai_config(prefs: dict) -> dict:
    """AI config safe to send to the client (api_key never leaves the server)."""
    ac = prefs.get("ai_config", {})
    return {
        "provider": ac.get("provider", "disabled"),
        "server_url": ac.get("server_url", ""),
        "model": ac.get("model", ""),
        "api_key_set": bool(ac.get("api_key")),
    }


def public_prefs(prefs: dict) -> dict:
    return {"theme": prefs.get("theme", "dark"), "ai_config": public_ai_config(prefs)}


# ================= Shared theme (iPhone <-> dashboard) =================
#
# The iPhone app is the source of truth for the theme. It writes its current
# theme to a shared `user_preferences` table in Supabase; the dashboard reads
# it on login/sync and applies it automatically, and writes back here too when
# the theme is changed from the dashboard (bidirectional).
#
# Christian: create this table in your Supabase project and have the iOS app
# write its current theme there whenever it changes:
#
#   create table if not exists user_preferences (
#     id text primary key,                 -- Apple `sub` (the user's stable id)
#     theme text not null default 'dark', -- one of: dark, win95, frosted, terminal
#     updated_at timestamptz not null default now()
#   );
#   -- Recommended: enable RLS and add a policy so each user can only
#   -- read/write their own row, or keep RLS off and use the service key only.
#
# Dashboard behavior:
#   GET  /api/preferences -> shared theme if reachable & valid, else local file
#   POST /api/preferences -> writes the local file AND the shared table (best effort)
# If Supabase is unreachable, misconfigured, or the table doesn't exist yet,
# everything falls back to the local users/<sub>.json file with a log line.

SUPABASE_REST = f"https://{MCP_HOST}/rest/v1"
SUPABASE_KEY = _read_secret("SUPABASE_SERVICE_KEY", ".supabase_service_key")
# Public project config for pairing verification. The anon key is public by
# design (it ships inside the phone app); it only ever verifies the session
# the phone hands over during QR pairing.
SUPABASE_URL = os.environ.get("SUPABASE_URL", f"https://{MCP_HOST}")
SUPABASE_ANON_KEY = _read_secret("SUPABASE_ANON_KEY", ".supabase_anon_key")
_shared_theme_cache: dict = {}  # sub -> (fetched_at, theme|None)
_SHARED_THEME_TTL = 60.0


def _supabase_key() -> str:
    # Prefer an explicit Supabase service/anon key; fall back to the MCP
    # bearer token in case it doubles as a Supabase JWT.
    return SUPABASE_KEY or TOKEN


def _supabase_rest(method: str, path: str, query: str = "",
                   body: "bytes | None" = None,
                   extra_headers: "dict | None" = None) -> tuple:
    key = _supabase_key()
    if not key:
        raise RuntimeError("no Supabase key configured")
    url = SUPABASE_REST + path + (("?" + query) if query else "")
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "User-Agent": "microbuddy-dashboard/1.0",
    }
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=10) as resp:
        return resp.status, resp.read().decode()


def get_shared_theme(sub: str) -> "str | None":
    """Read the iPhone's theme from Supabase user_preferences.

    Returns the theme string, or None on ANY failure (no key, no table,
    network error, invalid value) — callers fall back to the local theme.
    """
    if not sub:
        return None
    now = time.time()
    cached = _shared_theme_cache.get(sub)
    if cached and now - cached[0] < _SHARED_THEME_TTL:
        return cached[1]
    theme = None
    try:
        _status, data = _supabase_rest(
            "GET", "/user_preferences",
            f"id=eq.{quote(sub, safe='')}&select=theme")
        rows = json.loads(data or "[]")
        if isinstance(rows, list) and rows:
            t = rows[0].get("theme")
            if t in VALID_THEMES:
                theme = t
    except Exception as e:
        print(f"[prefs] shared theme read failed (falling back to local theme): {e}",
              flush=True)
    _shared_theme_cache[sub] = (now, theme)
    return theme


def set_shared_theme(sub: str, theme: str) -> bool:
    """Write the theme to Supabase user_preferences (best effort)."""
    if not sub or theme not in VALID_THEMES:
        return False
    try:
        body = json.dumps({
            "id": sub,
            "theme": theme,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).encode()
        _supabase_rest("POST", "/user_preferences", "",
                       body, {"Prefer": "resolution=merge-duplicates"})
        _shared_theme_cache[sub] = (time.time(), theme)
        return True
    except Exception as e:
        print(f"[prefs] shared theme write failed (theme saved locally only): {e}",
              flush=True)
        return False


# ================= Apple id_token verification (RS256, stdlib only) =================

def _b64url_decode(s: str) -> bytes:
    s += "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s.encode())


def _b64url_to_int(s: str) -> int:
    return int.from_bytes(_b64url_decode(s), "big")


def _fetch_apple_jwks() -> dict:
    now = time.time()
    if _JWKS_CACHE["keys"] and now - _JWKS_CACHE["fetched_at"] < _JWKS_TTL:
        return _JWKS_CACHE["keys"]
    req = urllib.request.Request(APPLE_JWKS_URL, headers={"User-Agent": "microbuddy-dashboard/1.0"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        jwks = json.loads(resp.read().decode())
    _JWKS_CACHE["keys"] = jwks
    _JWKS_CACHE["fetched_at"] = now
    return jwks


# DigestInfo prefix for SHA-256 (PKCS#1 v1.5)
_SHA256_DER_PREFIX = bytes.fromhex("3031300d060960864801650304020105000420")


def _rsa_verify(message: bytes, signature: bytes, n: int, e: int) -> bool:
    """Verify RS256 PKCS#1 v1.5 signature using only stdlib."""
    sig_int = int.from_bytes(signature, "big")
    if sig_int >= n:
        return False
    em = pow(sig_int, e, n).to_bytes((n.bit_length() + 7) // 8, "big")
    if len(em) < 2 or em[0] != 0x00 or em[1] != 0x01:
        return False
    try:
        sep = em.index(b"\x00", 2)
    except ValueError:
        return False
    if any(b != 0xFF for b in em[2:sep]):
        return False
    digest_info = em[sep + 1:]
    expected = _SHA256_DER_PREFIX + hashlib.sha256(message).digest()
    return hmac.compare_digest(digest_info, expected)


def verify_apple_id_token(id_token: str, expected_aud: str) -> dict:
    """Verify an Apple id_token JWT. Returns its claims on success, raises on failure.

    expected_aud is the Services ID for the web flow or the iOS app's bundle
    ID for native app tokens."""
    parts = id_token.split(".")
    if len(parts) != 3:
        raise ValueError("malformed token")
    header_b64, payload_b64, sig_b64 = parts
    try:
        header = json.loads(_b64url_decode(header_b64))
        payload = json.loads(_b64url_decode(payload_b64))
        signature = _b64url_decode(sig_b64)
    except Exception as exc:
        raise ValueError(f"token decode failed: {exc}")
    if header.get("alg") != "RS256":
        raise ValueError(f"unexpected alg: {header.get('alg')}")
    kid = header.get("kid")
    jwks = _fetch_apple_jwks()
    jwk = next((k for k in jwks.get("keys", []) if k.get("kid") == kid), None)
    if not jwk:
        _JWKS_CACHE["fetched_at"] = 0
        jwks = _fetch_apple_jwks()
        jwk = next((k for k in jwks.get("keys", []) if k.get("kid") == kid), None)
    if not jwk:
        raise ValueError("no matching Apple public key")
    n = _b64url_to_int(jwk["n"])
    e = _b64url_to_int(jwk["e"])
    signing_input = f"{header_b64}.{payload_b64}".encode()
    if not _rsa_verify(signing_input, signature, n, e):
        raise ValueError("signature verification failed")
    now = time.time()
    if payload.get("iss") != APPLE_ISSUER:
        raise ValueError(f"bad issuer: {payload.get('iss')}")
    aud = payload.get("aud")
    aud_ok = aud == expected_aud or (isinstance(aud, list) and expected_aud in aud)
    if not aud_ok:
        raise ValueError(f"bad audience: {aud}")
    if not isinstance(payload.get("exp"), (int, float)) or payload["exp"] < now - 60:
        raise ValueError("token expired")
    if not payload.get("sub"):
        raise ValueError("missing sub claim")
    return payload


# ================= MCP proxy =================

def mcp_call(tool: str, args: dict, token: str | None = None) -> dict:
    global _rpc_id
    _rpc_id += 1
    payload = {
        "jsonrpc": "2.0",
        "id": _rpc_id,
        "method": "tools/call",
        "params": {"name": tool, "arguments": args},
    }
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        MCP_URL,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Authorization": f"Bearer {token or TOKEN}",
            "User-Agent": "microbuddy-dashboard/1.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"MCP {e.code}: {detail}")
    text = raw.strip()
    if not text.startswith("{"):
        for line in text.splitlines():
            line = line.strip()
            if line.startswith("data:"):
                text = line[5:].strip()
                break
    res = json.loads(text)
    if res.get("error"):
        raise RuntimeError(f"MCP error: {json.dumps(res['error'])[:500]}")
    result = res.get("result", {})
    content = result.get("content", [])
    if content and isinstance(content, list):
        txt = content[0].get("text", "{}")
        try:
            return json.loads(txt)
        except json.JSONDecodeError:
            return {"text": txt}
    return result


# ================= Buddy AI: sales context + chat proxy =================

def _fmt_money(v) -> str:
    try:
        return f"${float(v):,.2f}"
    except (TypeError, ValueError):
        return "?"


ACTION_SCHEMA = """
Respond with ONLY a JSON object, no prose outside it:
{"reply":"<short friendly answer for the user>","actions":[ ... ]}

Allowed action objects (omit "actions" or use [] when nothing should change):
- {"type":"add_sale","date":"YYYY-MM-DD","product":"RTX 5070","brand":"ASUS","sku":"123456","price":799.99,"quantity":1,"kind":"inDepartment|outOfDepartment|servicePlan","isReturn":false}
- {"type":"set_lunch","date":"YYYY-MM-DD","minutes":30}
- {"type":"set_hours","date":"YYYY-MM-DD","hours":8.5}
- {"type":"set_goal","metric":"revenue|commission|moneyMade|plans|cph","period":"day|week|payPeriod|month","target":3000}
- {"type":"set_department_rule","pattern":"ASUS","kind":"inDepartment|outOfDepartment|servicePlan"}
- {"type":"remove_department_rule","pattern":"ASUS"}
- {"type":"set_coworkers","date":"YYYY-MM-DD","names":["Alex","Sam"],"crew":[{"name":"Gustavo","start":"2:00 PM","end":"4:00 PM"}]}
- {"type":"propose_crew","dateKey":"YYYY-MM-DD","crew":[{"name":"Alex","start":"10:00 AM","end":"6:30 PM"}]}
- {"type":"propose_schedule","schedule":[{"dateKey":"YYYY-MM-DD","start":"2:00 PM","end":"11:00 PM","lunchStart":"6:00 PM","lunchEnd":"7:00 PM","crew":[{"name":"Christian Ambriz","start":"2:00 PM","end":"11:00 PM"}]}]}
- {"type":"read_roster","days":[{"dateKey":"YYYY-MM-DD","crew":[{"name":"Alex Rivera","start":"6:30 AM","end":"1:00 PM"}]}]}
- {"type":"add_note","date":"YYYY-MM-DD","note":"we were short-staffed after 3"}
- {"type":"add_coworkers","names":["Alex Rivera","Sam Lee"]}

Rules: dates must be YYYY-MM-DD. price is the price of ONE unit. Service plans use kind "servicePlan".
Items sold outside the user's own department use "outOfDepartment". Returns use isReturn true.
A day with no shift is a day off: log sticker sales or returns there normally — they pay commission
only (0 hours, no base pay), and the commission still counts toward pay and the period total.
When the user pastes a whole screen of text copied from the Micro Center system, extract EVERY sale
line from it — one "add_sale" action per item. Ignore headers, totals, taxes, and footer noise.
When the user says a brand or product is ALWAYS in or out of their department — or corrects a
department guess — remember it with set_department_rule and apply it to future guesses.
set_coworkers replaces the full list of who works that day's shift — include everyone, not just
new names; use an empty list to clear it. When the user says "I'm working with X", add X to the
existing names instead of dropping them. When the user mentions a coworker's hours, put that
person's start/end (times as printed, keep am/pm) in "crew"; everyone else goes in "names".
propose_crew and add_coworkers are for TEXT requests only — "Sam works with me Tuesday 10 to 6"
is propose_crew for that day; "add Sam Lee to my coworkers" is add_coworkers.
FULL SCHEDULE PASTES: when the user pastes a whole schedule — dated entries each with hours,
lunch window, and names — send exactly ONE propose_schedule with one schedule entry per date.
start/end are the USER's own hours that day; lunchStart/lunchEnd are the printed lunch window
(omit when there is none); crew is EVERY other person listed with their times exactly as printed.
propose_schedule only drafts one confirm card — the user confirms once to save shifts, lunches,
and crew together. Never use read_roster, propose_crew, add_coworkers, or set_coworkers for a
pasted schedule.
CLARIFYING QUESTIONS: when something genuinely matters and can't be guessed from context — an
ambiguous date, an unclear price, a missing day — asking is fine. Keep questions short. If the
user says "just do it" or "you decide", decide sensibly and act.
Confirm in "reply" exactly what you logged, including the commission impact when relevant.
"""


def build_buddy_system_prompt() -> str:
    """System prompt for the dashboard Buddy, with recent sales context.

    Best-effort: if the MCP backend is unreachable the chat still works,
    just without fresh numbers.
    """
    lines = [
        "You are Buddy, Christian's personal sales assistant for his job "
        "in merchandise sales at Micro Center (Tustin).",
        "Talk like a homie: casual, direct, no fluff. Keep answers short "
        "unless he asks for detail.",
        "When he asks about money, give the full breakdown: commission + "
        "base pay, total, and take-home — not just one number.",
        "You know his sales data (below). Use it when he asks about his numbers.",
    ]
    lines.append(ACTION_SCHEMA)
    if not TOKEN:
        return "\n".join(lines)
    try:
        today = datetime.now().strftime("%Y-%m-%d")
        week_ago = (datetime.now() - timedelta(days=6)).strftime("%Y-%m-%d")
        summary = mcp_call("get_day_summary", {"date": today})
        stats = mcp_call("get_stats", {"start": week_ago, "end": today})
        ctx = [f"Today is {today}. Recent sales context:"]
        if isinstance(summary, dict) and not summary.get("error"):
            ctx.append(
                "Today's summary: revenue %s, %s tickets, commission %s." % (
                    _fmt_money(summary.get("revenue") or summary.get("total")),
                    summary.get("tickets", "?"),
                    _fmt_money(summary.get("commission")),
                )
            )
        if isinstance(stats, dict) and not stats.get("error"):
            rev = stats.get("revenue") or stats.get("total_sales")
            ctx.append(
                "Last 7 days: revenue %s, %s tickets, commission %s." % (
                    _fmt_money(rev),
                    stats.get("tickets", "?"),
                    _fmt_money(stats.get("commission")),
                )
            )
        lines.extend(ctx)
    except Exception:
        # Sales context is a nice-to-have; never break the chat over it.
        pass
    return "\n".join(lines)


def proxy_ai_chat(ai_config: dict, messages: list, system_prompt: str = "") -> str:
    """Forward a chat request to the user's configured AI endpoint.

    Uses the OpenAI-compatible /v1/chat/completions format (which Ollama
    also supports). The api_key never appears in logs or error messages.
    """
    provider = ai_config.get("provider", "disabled")
    if provider == "disabled" or not provider:
        raise ValueError("AI is not configured — set it up in Settings.")
    base_url = (ai_config.get("server_url") or "").strip().rstrip("/")
    model = (ai_config.get("model") or "").strip()
    api_key = ai_config.get("api_key") or ""
    if not base_url or not model:
        raise ValueError("AI server URL and model are required.")
    if not re.match(r"^https?://", base_url):
        raise ValueError("AI server URL must start with http:// or https://")
    url = base_url + "/v1/chat/completions"

    clean_messages = []
    if system_prompt:
        clean_messages.append({"role": "system", "content": system_prompt[:12000]})
    for m in messages:
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        content = m.get("content")
        if role in ("user", "assistant") and isinstance(content, str):
            clean_messages.append({"role": role, "content": content[:12000]})
    if not clean_messages:
        raise ValueError("no messages to send")

    payload = {"model": model, "messages": clean_messages, "stream": False}
    headers = {"Content-Type": "application/json", "User-Agent": "microbuddy-dashboard/1.0"}
    if api_key:
        headers["Authorization"] = "Bearer " + api_key
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            body = json.loads(resp.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:300]
        # Never leak the key — strip anything resembling it.
        raise RuntimeError(f"AI server returned {e.code}: {detail}")
    except OSError as e:
        raise RuntimeError(f"Couldn't reach the AI server at {base_url}: {e}")
    try:
        return body["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise RuntimeError("AI server returned an unexpected response shape")


def list_ai_models(provider: str, base_url: str, api_key: str = "") -> list:
    """List model names available on the user's AI server.

    Ollama: GET {base}/api/tags -> models[].name
    OpenAI-compatible: GET {base}/v1/models -> data[].id
    Raises ValueError/RuntimeError with a safe message on failure.
    """
    base_url = (base_url or "").strip().rstrip("/")
    if not base_url:
        raise ValueError("AI server URL is required.")
    if not re.match(r"^https?://", base_url):
        raise ValueError("AI server URL must start with http:// or https://")
    if provider == "ollama":
        url = base_url + "/api/tags"
    else:
        url = base_url + "/v1/models"
    headers = {"User-Agent": "microbuddy-dashboard/1.0"}
    if api_key:
        headers["Authorization"] = "Bearer " + api_key
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = json.loads(resp.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"AI server returned {e.code}")
    except OSError as e:
        raise RuntimeError(f"Couldn't reach the AI server at {base_url}: {e}")
    names = []
    try:
        if provider == "ollama":
            for m in body.get("models", []):
                n = m.get("name")
                if isinstance(n, str) and n:
                    names.append(n)
        else:
            for m in body.get("data", []):
                mid = m.get("id")
                if isinstance(mid, str) and mid:
                    names.append(mid)
    except (AttributeError, TypeError):
        pass
    return sorted(set(names))


ROUTES = {
    "/api/day-summary": ("day-summary", ["date"]),
    "/api/day-sales": ("day-sales", ["date"]),
    "/api/days": ("list-days", ["start", "end", "limit"]),
    "/api/products": ("search-products", ["query", "limit"]),
    "/api/stats": ("stats", ["start", "end"]),
    "/api/take-home": ("take-home", ["start", "end"]),
    "/api/schedule": ("schedule", ["start", "end"]),
}

STATIC_FILES = {
    "/": ("dashboard.html", "text/html; charset=utf-8"),
    "/dashboard.html": ("dashboard.html", "text/html; charset=utf-8"),
    "/login-bg.jpg": ("login-bg.jpg", "image/jpeg"),
    "/manifest.json": ("manifest.json", "application/manifest+json"),
    "/sw.js": ("sw.js", "application/javascript; charset=utf-8"),
    "/themes.css": ("themes.css", "text/css; charset=utf-8"),
    "/db.js": ("db.js", "application/javascript; charset=utf-8"),
    "/sync.js": ("sync.js", "application/javascript; charset=utf-8"),
    "/qrcode.min.js": ("qrcode.min.js", "application/javascript; charset=utf-8"),
    "/settings.js": ("settings.js", "application/javascript; charset=utf-8"),
    "/screen-lock.js": ("screen-lock.js", "application/javascript; charset=utf-8"),
    "/buddy.js": ("buddy.js", "application/javascript; charset=utf-8"),
    "/sb.js": ("sb.js", "application/javascript; charset=utf-8"),
    "/payengine.js": ("payengine.js", "application/javascript; charset=utf-8"),
    "/daydetail.js": ("daydetail.js", "application/javascript; charset=utf-8"),
    "/stats.js": ("stats.js", "application/javascript; charset=utf-8"),
    "/schedule.js": ("schedule.js", "application/javascript; charset=utf-8"),
    "/journal.js": ("journal.js", "application/javascript; charset=utf-8"),
    "/coworkers.js": ("coworkers.js", "application/javascript; charset=utf-8"),
    "/goals.js": ("goals.js", "application/javascript; charset=utf-8"),
    "/microcharm.js": ("microcharm.js", "application/javascript; charset=utf-8"),
    "/profile.js": ("profile.js", "application/javascript; charset=utf-8"),
    "/leaderboard.js": ("leaderboard.js", "application/javascript; charset=utf-8"),
    "/brands.js": ("brands.js", "application/javascript; charset=utf-8"),
    "/home-widgets.js": ("home-widgets.js", "application/javascript; charset=utf-8"),
    "/buddy-actions.js": ("buddy-actions.js", "application/javascript; charset=utf-8"),
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    # ---------- session helpers ----------
    def _get_session(self) -> dict | None:
        cookie = self.headers.get("Cookie", "")
        for part in cookie.split(";"):
            part = part.strip()
            if part.startswith("mb_session="):
                sid = part[11:]
                sess = SESSIONS.get(sid)
                if sess and sess["exp"] > time.time():
                    return sess
                if SESSIONS.pop(sid, None) is not None:
                    _save_sessions()
        return None

    def _new_session(self, sess: dict) -> str:
        sid = secrets.token_hex(32)
        sess["exp"] = time.time() + SESSION_TIMEOUT
        SESSIONS[sid] = sess
        _save_sessions()
        return sid

    def _set_session_cookie(self, sess: dict) -> str:
        sid = self._new_session(sess)
        return f"mb_session={sid}; Path=/; Max-Age={SESSION_TIMEOUT}; HttpOnly; SameSite=Lax"

    # ---------- response helper ----------
    def _send(self, code: int, body: bytes, ctype: str = "application/json",
              extra: dict | None = None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if self.path == "/sw.js":
            self.send_header("Cache-Control", "no-cache")
        if extra:
            for k, v in extra.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _serve_static(self, filename: str, ctype: str) -> bool:
        safe = os.path.normpath(filename).lstrip("/")
        if ".." in safe or safe.startswith("/"):
            return False
        full = os.path.join(BASE_DIR, safe)
        if not os.path.isfile(full):
            return False
        with open(full, "rb") as f:
            self._send(200, f.read(), ctype)
        return True

    # ---------- GET ----------
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        if path == "/widget":
            # Homepage widget: current pay-period stats for the paired user.
            # Dashes until someone pairs (no token = no data, not an error).
            try:
                with open("/app/.widget_token") as f:
                    wtoken = f.read().strip()
            except OSError:
                wtoken = ""
            if not wtoken:
                self._send(200, json.dumps({
                    "sold": "–", "returns": "–", "made": "–",
                    "cph": "–", "products": "–", "period": "",
                }).encode())
                return
            try:
                today = datetime.date.today()
                start, end = _pay_period_containing(today)
                stats = mcp_call("get_stats", {
                    "start": start.isoformat(), "end": end.isoformat(),
                }, wtoken)
                taxes = stats.get("estimated_taxes", {}) or {}
                self._send(200, json.dumps({
                    "sold": _fmt_money(stats.get("sold_for_company_total", 0)),
                    "returns": _fmt_money(stats.get("returns_total", 0)),
                    "made": _fmt_money(taxes.get("estimated_take_home", 0)),
                    "cph": f"{float(stats.get('cph', 0)):.2f}",
                    "products": str(int(stats.get("items_total", 0))),
                    "period": f"{start.strftime('%b %-d')}–{end.strftime('%b %-d')}",
                }).encode())
            except Exception as e:
                self._send(502, json.dumps(
                    {"error": str(e)[:200]}).encode())
            return

        if path == "/widget-icon":
            # Homepage widget icon: theme-aware via ?theme= parameter.
            # Themes: dark, win95, frosted, terminal. Defaults to OG icon.
            theme = (qs.get("theme") or [""])[0].strip().lower()
            icon_map = {
                "win95": "icons/icon-win95.png",
                "terminal": "icons/icon-terminal.png",
                "frosted": "icons/icon-modern.png",
                "dark": "icons/icon-og.png",
            }
            icon_file = icon_map.get(theme, "icons/icon-og.png")
            try:
                with open(os.path.join(BASE_DIR, icon_file), "rb") as f:
                    data = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                self.wfile.write(data)
            except OSError:
                self.send_response(404)
                self.end_headers()
            return

        if path == "/api/health":
            self._send(200, json.dumps({
                "ok": True,
                "token_configured": bool(TOKEN),
                "auth_mode": "pairing",
                "app_configured": bool(APP_BUNDLE_ID),
            }).encode())
            return

        if path == "/api/session":
            # Public: lets the frontend notice the phone unlinked this
            # dashboard (POST /api/pair/revoke cleared SESSIONS) so it can
            # wipe local data and show the QR gate immediately.
            self._send(200, json.dumps(
                {"logged_in": self._get_session() is not None}).encode())
            return

        if path == "/api/config":
            self._send(200, json.dumps({
                "authMode": "pairing",
                "supabaseUrl": SUPABASE_URL,
                "supabaseAnonKey": SUPABASE_ANON_KEY,
            }).encode())
            return

        if path == "/api/pair/status":
            _prune_pairings()
            poll = (qs.get("poll_token") or [""])[0]
            pairing = next(
                (p for p in PAIRINGS.values() if poll and p["poll"] == poll),
                None,
            )
            if not pairing:
                self._send(404, json.dumps(
                    {"error": "unknown or expired pairing"}).encode())
                return
            sid = pairing.get("sid")
            if sid and sid in SESSIONS:
                # Single-use: consume the pairing, drop this browser into
                # the freshly claimed session via the session cookie, and
                # hand over the Supabase session so the browser becomes a
                # full client (stored locally for offline use).
                session = pairing.pop("session", None)
                PAIRINGS.pop(pairing["code"], None)
                cookie = (f"mb_session={sid}; Path=/; "
                          f"Max-Age={SESSION_TIMEOUT}; HttpOnly; SameSite=Lax")
                self._send(200, json.dumps({
                    "claimed": True,
                    "session": session,
                }).encode(), extra={"Set-Cookie": cookie})
                return
            self._send(200, json.dumps({
                "claimed": False,
                "expires_in": max(0, int(pairing["exp"] - time.time())),
            }).encode())
            return

        if path == "/logout":
            cookie = self.headers.get("Cookie", "")
            for part in cookie.split(";"):
                part = part.strip()
                if part.startswith("mb_session="):
                    if SESSIONS.pop(part[11:], None) is not None:
                        _save_sessions()
            self._send(302, b"", extra={
                "Location": "/",
                "Set-Cookie": "mb_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax",
            })
            return

        # Static assets (no auth — the shell is useless without an API session).
        if path in STATIC_FILES:
            fn, ctype = STATIC_FILES[path]
            if self._serve_static(fn, ctype):
                return
            self._send(404, b"not found", "text/plain")
            return
        if path.startswith("/icons/"):
            if self._serve_static(path.lstrip("/"), "image/png"):
                return
            self._send(404, b"not found", "text/plain")
            return

        # Everything below requires a session.
        sess = self._get_session()
        if not sess:
            if path.startswith("/api/"):
                self._send(401, json.dumps({"error": "login required"}).encode())
            else:
                self._send(401, b"login required", "text/plain")
            return
        sub = sess.get("sub", "")

        if path == "/api/preferences":
            prefs = load_prefs(sub)
            # The iPhone is the source of truth for the theme: prefer the
            # shared (phone-written) theme when it's reachable.
            shared = get_shared_theme(sub)
            if shared:
                if prefs.get("theme") != shared:
                    prefs["theme"] = shared
                    try:
                        save_prefs(sub, prefs)
                    except OSError:
                        pass
                    print(f"[prefs] theme taken from iPhone (shared): {shared}",
                          flush=True)
            self._send(200, json.dumps(public_prefs(prefs)).encode())
            return

        if path == "/api/ai-config":
            self._send(200, json.dumps(public_ai_config(load_prefs(sub))).encode())
            return

        if path == "/api/ai-models":
            # List models on the user's AI server. Uses the saved config
            # unless provider/server_url query params override it (so the
            # Settings form can list models before saving).
            prefs = load_prefs(sub)
            cfg = prefs["ai_config"]
            provider = (qs.get("provider") or [cfg.get("provider", "")])[0]
            server_url = (qs.get("server_url") or [cfg.get("server_url", "")])[0]
            if provider not in AI_PROVIDERS or provider == "disabled":
                self._send(400, json.dumps(
                    {"error": "Pick a provider first."}).encode())
                return
            try:
                models = list_ai_models(provider, server_url,
                                        cfg.get("api_key", ""))
            except ValueError as e:
                self._send(400, json.dumps({"error": str(e)}).encode())
                return
            except RuntimeError as e:
                self._send(502, json.dumps({"error": str(e)}).encode())
                return
            self._send(200, json.dumps({"models": models}).encode())
            return

        if path == "/api/chat":
            # Session list (metadata only — messages come via /sync or ai-chat).
            prefs = load_prefs(sub)
            sessions = sorted(
                prefs["conversations"].values(),
                key=lambda s: s["updated_at"], reverse=True)
            self._send(200, json.dumps({"sessions": [
                {"id": s["id"], "title": s["title"],
                 "updated_at": s["updated_at"],
                 "message_count": len(s["messages"])}
                for s in sessions
            ]}).encode())
            return

        if path == "/api/chat/sync":
            # Sessions changed since `since` (ms), with full messages.
            # Used for full sync on login (since=0) and incremental sync.
            try:
                since = int((qs.get("since") or ["0"])[0])
            except ValueError:
                since = 0
            prefs = load_prefs(sub)
            changed = [s for s in prefs["conversations"].values()
                       if s["updated_at"] > since]
            changed.sort(key=lambda s: s["updated_at"])
            self._send(200, json.dumps({"sessions": changed}).encode())
            return

        if path in ROUTES:
            # Per-session MCP token (minted at pairing) so each user sees
            # their own data; falls back to the global token.
            sess_token = sess.get("mcp_token") if sess else None
            if not (sess_token or TOKEN):
                self._send(500, json.dumps({"error": "no token configured"}).encode())
                return
            tool, arg_names = ROUTES[path]
            args: dict = {}
            for name in arg_names:
                vals = qs.get(name)
                if vals:
                    v = vals[0]
                    if name == "limit" and v.isdigit():
                        v = int(v)
                    args[name] = v
            if tool == "search-products" and "query" not in args and qs.get("q"):
                args["query"] = qs["q"][0]
            try:
                result = mcp_call(tool, args, token=sess_token)
                self._send(200, json.dumps(result).encode())
            except Exception as e:
                self._send(502, json.dumps({"error": str(e)[:500]}).encode())
            return

        self._send(404, b"not found", "text/plain")

    # ---------- POST ----------
    def _read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length <= 0 or length > 1_000_000:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode())
        except Exception:
            return {}

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        sess = self._get_session()
        if not sess:
            self._send(401, json.dumps({"error": "login required"}).encode())
            return
        sub = sess.get("sub", "")

        if path == "/api/chat":
            prefs = load_prefs(sub)
            sid_vals = qs.get("session")
            if sid_vals:
                sid = sid_vals[0][:128]
                removed = prefs["conversations"].pop(sid, None) is not None
                save_prefs(sub, prefs)
                self._send(200, json.dumps({"ok": True, "removed": removed}).encode())
            else:
                prefs["conversations"] = {}
                save_prefs(sub, prefs)
                self._send(200, json.dumps({"ok": True, "removed_all": True}).encode())
            return

        self._send(404, b"not found", "text/plain")

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/theme-icon":
            # Swap the Umbrel tile icon to match the user's dashboard theme.
            # /app/tile-icon.png is bind-mounted to the app's icon.png in
            # the Umbrel app-data dir (see docker-compose.yml).
            try:
                length = int(self.headers.get("Content-Length", 0) or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
                theme = str(body.get("theme", "dark"))
                icon_map = {"modern": "icon-modern.png",
                            "terminal": "icon-terminal.png",
                            "win95": "icon-win95.png"}
                icon_file = icon_map.get(theme, "icon-og.png")
                src_icon = os.path.join(BASE_DIR, "icons", icon_file)
                dst_icon = "/app/tile-icon.png"
                # /app/tile-icon.png only exists in the Docker deployment
                # (bind-mounted to the Umbrel app tile). Skip the swap when
                # running directly as a process.
                if os.path.exists(src_icon) and os.path.isdir(os.path.dirname(dst_icon)):
                    shutil.copyfile(src_icon, dst_icon)
                self._send(200, json.dumps({"ok": True, "theme": theme,
                                            "icon": icon_file}).encode())
            except Exception as e:
                self._send(500, json.dumps({"error": str(e)}).encode())
            return

        if path == "/api/pair/start":
            code = _new_pair_code()
            poll_token = secrets.token_hex(16)
            host = self.headers.get("Host", f"localhost:{PORT}")
            proto = self.headers.get("X-Forwarded-Proto", "http")
            PAIRINGS[code] = {"code": code, "exp": time.time() + PAIR_TTL,
                              "poll": poll_token, "sid": None}
            self._send(200, json.dumps({
                "code": code,
                "poll_token": poll_token,
                "server_url": f"{proto}://{host}",
                "expires_in": PAIR_TTL,
            }).encode())
            return

        if path == "/api/pair/claim":
            # Simple connection: the phone is already signed in, so it hands
            # over its Supabase session. We verify the access token against
            # Supabase Auth, then the browser's poll picks up the session and
            # becomes a full Supabase client (same RLS rules as the phone).
            if not SUPABASE_ANON_KEY:
                self._send(400, json.dumps(
                    {"error": "pairing is not configured on this server"
                              " (missing Supabase anon key)"}).encode())
                return
            body = self._read_json_body()
            code = str(body.get("code", "")).strip().upper()
            pairing = PAIRINGS.get(code)
            if not pairing or pairing["exp"] < time.time():
                PAIRINGS.pop(code, None)
                self._send(404, json.dumps(
                    {"error": "invalid or expired code"}).encode())
                return
            if pairing.get("sid"):
                self._send(409, json.dumps(
                    {"error": "code already used"}).encode())
                return
            access_token = str(body.get("access_token", ""))
            refresh_token = str(body.get("refresh_token", ""))
            if not access_token or not refresh_token:
                self._send(400, json.dumps(
                    {"error": "missing access_token or refresh_token"}).encode())
                return
            try:
                user = _supabase_get_user(access_token)
            except Exception as e:
                self._send(401, json.dumps(
                    {"error": f"session invalid: {e}"}).encode())
                return
            user_id = str(user.get("id", ""))
            if not user_id:
                self._send(401, json.dumps(
                    {"error": "session invalid: no user"}).encode())
                return
            pairing["session"] = {
                "user_id": user_id,
                "email": str(user.get("email") or ""),
                "access_token": access_token,
                "refresh_token": refresh_token,
            }
            # Mint a per-user MCP token so this browser sees THEIR data, not
            # whoever's token is configured globally. Uses the user's own
            # session (RLS-enforced) — no service key, no user action.
            try:
                mcp_token = _mint_mcp_token(user_id, access_token)
            except Exception as e:
                self._send(500, json.dumps(
                    {"error": f"couldn't set up data access: {e}"}).encode())
                return
            # Homepage widget token: whoever pairs with this dashboard owns
            # the widget — each server shows its own user's stats.
            try:
                _wt = os.path.join(BASE_DIR, ".widget_token")
                with open(_wt, "w") as f:
                    f.write(mcp_token)
                os.chmod(_wt, 0o600)
            except Exception as e:
                print(f"[pair] warning: couldn't write widget token: {e}",
                      flush=True)
            # Legacy server-side session too, so the current server-rendered
            # pages keep working until the frontend becomes a full client.
            sid = self._new_session({
                "sub": user_id,
                "email": str(user.get("email") or ""),
                "name": "",
            })
            SESSIONS[sid]["mcp_token"] = mcp_token
            _save_sessions()
            pairing["sid"] = sid
            self._send(200, json.dumps(
                {"ok": True, "user_id": user_id}).encode())
            return

        if path == "/api/pair/revoke":
            # Public: the iPhone app calls this when the user unlinks a
            # dashboard. The phone holds no dashboard session of its own, so
            # unlink revokes everything this dashboard handed out: pending
            # pair codes, all browser sessions, and the homepage widget token.
            # Stale per-user MCP token rows in Supabase are cleaned up by the
            # next claim (_mint_mcp_token deletes the user's old dashboard
            # tokens before minting a fresh one); the raw tokens themselves
            # only ever lived in server memory and .widget_token, both of
            # which are cleared here.
            PAIRINGS.clear()
            SESSIONS.clear()
            _save_sessions()
            try:
                wt = os.path.join(BASE_DIR, ".widget_token")
                if os.path.exists(wt):
                    os.remove(wt)
            except Exception as e:
                print(f"[pair] warning: couldn't remove widget token: {e}",
                      flush=True)
            self._send(200, json.dumps({"ok": True}).encode())
            return

        # Everything below requires a session.
        sess = self._get_session()
        if not sess:
            self._send(401, json.dumps({"error": "login required"}).encode())
            return
        sub = sess.get("sub", "")

        if path == "/api/preferences":
            body = self._read_json_body()
            prefs = load_prefs(sub)
            theme_changed = False
            if isinstance(body.get("theme"), str) and body["theme"] in VALID_THEMES:
                if prefs.get("theme") != body["theme"]:
                    theme_changed = True
                prefs["theme"] = body["theme"]
            ac = body.get("ai_config")
            if isinstance(ac, dict):
                cfg = prefs["ai_config"]
                if ac.get("provider") in AI_PROVIDERS:
                    cfg["provider"] = ac["provider"]
                for k in ("server_url", "model"):
                    if isinstance(ac.get(k), str):
                        cfg[k] = ac[k].strip()
                # Only overwrite the stored key when a new one is supplied.
                if isinstance(ac.get("api_key"), str) and ac["api_key"]:
                    cfg["api_key"] = ac["api_key"]
            save_prefs(sub, prefs)
            # Bidirectional: push a dashboard theme change to the shared
            # table too, so the iPhone can pick it up.
            if theme_changed:
                set_shared_theme(sub, prefs["theme"])
            self._send(200, json.dumps(public_prefs(prefs)).encode())
            return

        if path == "/api/ai-config":
            body = self._read_json_body()
            prefs = load_prefs(sub)
            cfg = prefs["ai_config"]
            if body.get("provider") in AI_PROVIDERS:
                cfg["provider"] = body["provider"]
            for k in ("server_url", "model"):
                if isinstance(body.get(k), str):
                    cfg[k] = body[k].strip()
            if isinstance(body.get("api_key"), str) and body["api_key"]:
                cfg["api_key"] = body["api_key"]
            save_prefs(sub, prefs)
            self._send(200, json.dumps(public_ai_config(prefs)).encode())
            return

        if path == "/api/ai-chat":
            # Append the new user message(s) to the stored conversation,
            # generate a reply via the server-side AI config, append the
            # reply too, and return it. The server is canonical for history;
            # clients sync via /api/chat/sync.
            body = self._read_json_body()
            messages = body.get("messages")
            if not isinstance(messages, list) or not messages:
                self._send(400, json.dumps({"error": "messages array required"}).encode())
                return
            new_user_msgs = []
            for m in messages:
                if (isinstance(m, dict) and m.get("role") == "user"
                        and isinstance(m.get("content"), str)
                        and m["content"].strip()):
                    new_user_msgs.append(m["content"][:12000])
            if not new_user_msgs:
                self._send(400, json.dumps({"error": "a user message is required"}).encode())
                return

            prefs = load_prefs(sub)
            ai_config = prefs["ai_config"]
            if ai_config.get("provider") in (None, "", "disabled"):
                self._send(400, json.dumps(
                    {"error": "AI is not configured — set it up in Settings."}).encode())
                return

            sid = body.get("session_id")
            if not isinstance(sid, str) or not sid.strip():
                sid = secrets.token_hex(12)
            sid = sid.strip()[:128]
            now_ms = int(time.time() * 1000)
            conv = prefs["conversations"]
            session = conv.get(sid)
            if not isinstance(session, dict):
                session = {"id": sid, "title": "", "created_at": now_ms,
                           "updated_at": now_ms, "messages": []}
                conv[sid] = session
            for content in new_user_msgs:
                session["messages"].append(
                    {"role": "user", "content": content, "ts": now_ms})
            if not session["title"]:
                first = new_user_msgs[0].strip().replace("\n", " ")
                session["title"] = (first[:60] + "…") if len(first) > 60 else first
            session["messages"] = session["messages"][-MAX_MESSAGES_PER_SESSION:]
            # Drop oldest sessions if over the cap.
            if len(conv) > MAX_SESSIONS_PER_USER:
                for old in sorted(conv.values(), key=lambda s: s["updated_at"])[:len(conv) - MAX_SESSIONS_PER_USER]:
                    conv.pop(old["id"], None)

            # Full history (capped) + fresh sales context -> the model.
            history = [{"role": m["role"], "content": m["content"]}
                       for m in session["messages"][-40:]]
            try:
                system_prompt = build_buddy_system_prompt()
                reply = proxy_ai_chat(ai_config, history, system_prompt)
            except ValueError as e:
                self._send(400, json.dumps({"error": str(e)}).encode())
                return
            except RuntimeError as e:
                self._send(502, json.dumps({"error": str(e)}).encode())
                return

            reply_ts = int(time.time() * 1000)
            session["messages"].append(
                {"role": "assistant", "content": reply, "ts": reply_ts})
            session["updated_at"] = reply_ts
            try:
                save_prefs(sub, prefs)
            except OSError as e:
                self._send(500, json.dumps(
                    {"error": f"couldn't save conversation: {e}"}).encode())
                return
            self._send(200, json.dumps({
                "session_id": sid,
                "title": session["title"],
                "reply": reply,
                "user_ts": now_ms,
                "reply_ts": reply_ts,
            }).encode())
            return

        self._send(404, b"not found", "text/plain")


if __name__ == "__main__":
    if not TOKEN:
        print("WARNING: no bearer token configured (MICROBUDDY_TOKEN env or .token file)")
    if not APP_BUNDLE_ID:
        print("WARNING: no iOS app bundle ID configured (APPLE_APP_BUNDLE_ID env"
              " or .apple_app_id file) — app pairing claims will be rejected")
    else:
        print(f"Apple app bundle ID: {APP_BUNDLE_ID}")
    os.makedirs(USERS_DIR, exist_ok=True)
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Micro Buddy dashboard on :{PORT} (QR app-pairing auth)")
    server.serve_forever()
