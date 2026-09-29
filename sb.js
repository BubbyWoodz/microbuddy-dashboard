"use strict";
/* ============ sb.js — direct Supabase client for the Micro Buddy dashboard ============
 * The browser is a full Supabase client, just like the phone app. The QR
 * pairing hands over the user's Supabase session (access_token +
 * refresh_token), stored in localStorage. All reads/writes go through the
 * same RLS rules as the phone.
 *
 * The backup blob (user_backups.data) is the sync unit: the whole thing is
 * downloaded on login, cached in IndexedDB, edited locally, and PUT back
 * when online. Last-write-wins on conflicts (noted limitation).
 */
const SB = (() => {
  let SUPABASE_URL = "https://tgarraczeevyrjfxzkkf.supabase.co";
  let ANON_KEY = null; // fetched from /api/config (public)

  const LS_KEY = "mb_supabase_session";

  async function config() {
    if (ANON_KEY) return;
    try {
      const res = await fetch("/api/config");
      if (res.ok) {
        const c = await res.json();
        if (c.supabaseUrl) SUPABASE_URL = c.supabaseUrl;
        if (c.supabaseAnonKey) ANON_KEY = c.supabaseAnonKey;
      }
    } catch (e) {}
    if (!ANON_KEY) throw new Error("Dashboard not configured (missing Supabase key).");
  }

  function getSession() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function setSession(s) {
    try {
      if (s) localStorage.setItem(LS_KEY, JSON.stringify(s));
      else localStorage.removeItem(LS_KEY);
    } catch (e) {}
  }

  function isExpired(session) {
    if (!session || !session.access_token) return true;
    try {
      const payload = JSON.parse(atob(session.access_token.split(".")[1]));
      // Refresh 60s before actual expiry.
      return (payload.exp * 1000) < (Date.now() + 60000);
    } catch (e) { return true; }
  }

  async function refreshSession(session) {
    const res = await fetch(SUPABASE_URL + "/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      headers: {
        "apikey": ANON_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });
    if (!res.ok) {
      const err = new Error("Session expired — please re-pair.");
      err.isAuth = true;
      throw err;
    }
    const data = await res.json();
    const next = {
      user_id: session.user_id,
      email: session.email || data.user?.email || "",
      access_token: data.access_token,
      refresh_token: data.refresh_token || session.refresh_token,
    };
    setSession(next);
    return next;
  }

  async function getValidSession() {
    await config();
    let session = getSession();
    if (!session) {
      const err = new Error("Not paired — scan the QR code.");
      err.isAuth = true;
      throw err;
    }
    if (isExpired(session)) {
      session = await refreshSession(session);
    }
    return session;
  }

  async function rest(method, path, body, session) {
    session = session || await getValidSession();
    const res = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
      method,
      headers: {
        "apikey": ANON_KEY,
        "Authorization": "Bearer " + session.access_token,
        "Content-Type": "application/json",
        "Prefer": "return=representation",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      // Token might have expired mid-flight — refresh once and retry.
      session = await refreshSession(session);
      const retry = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
        method,
        headers: {
          "apikey": ANON_KEY,
          "Authorization": "Bearer " + session.access_token,
          "Content-Type": "application/json",
          "Prefer": "return=representation",
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (retry.status === 401) {
        const err = new Error("Session expired — please re-pair.");
        err.isAuth = true;
        throw err;
      }
      if (!retry.ok) throw new Error("Supabase " + retry.status);
      const text = (await retry.text()).trim();
      return text ? JSON.parse(text) : null;
    }
    if (!res.ok) throw new Error("Supabase " + res.status);
    const text = (await res.text()).trim();
    return text ? JSON.parse(text) : null;
  }

  // ---- backup blob ----

  async function getBackup() {
    const session = await getValidSession();
    const rows = await rest("GET",
      "user_backups?user_id=eq." + encodeURIComponent(session.user_id) +
      "&select=data,updated_at", undefined, session);
    if (!rows || !rows.length) return { data: null, updated_at: null, session };
    return { data: rows[0].data || {}, updated_at: rows[0].updated_at, session };
  }

  async function saveBackup(data) {
    const session = await getValidSession();
    const now = new Date().toISOString();
    // Try update first; if no row, insert.
    const updated = await rest("PATCH",
      "user_backups?user_id=eq." + encodeURIComponent(session.user_id),
      { data, updated_at: now }, session);
    if (!updated || !updated.length) {
      await rest("POST", "user_backups",
        { user_id: session.user_id, data, updated_at: now }, session);
    }
    return now;
  }

  return { getSession, setSession, getValidSession, rest, getBackup, saveBackup,
           SUPABASE_URL };
})();
