"use strict";
/* ============ leaderboard.js — Leaderboard tab (port of the iOS Leaderboard) ============
 *
 * SOURCE OF TRUTH (BubbyWoodz/micro-buddy, branch main):
 *   ios-micro-buddy/MicroBuddy/Models/Leaderboard.swift
 *   ios-micro-buddy/MicroBuddy/Services/LeaderboardService.swift
 *   ios-micro-buddy/MicroBuddy/Views/LeaderboardView.swift
 *
 * WHAT IT DOES
 *   You vs. the coworkers you've linked Micro Buddy accounts with. Links are
 *   strictly mutual — both sides accept, both see each other. Rows show money
 *   sold, plans, and CPH, but are ORDERED by a hidden take-home
 *   (commission + $4 × open-floor hours) that is never rendered anywhere.
 *
 * CLOUD CONTRACT (exact ports of LeaderboardService):
 *   RPC  search_profiles      {p_query}            -> [{id, username, first_name, last_name}]
 *   RPC  send_peer_request    {p_target}           -> void (server errors surface as messages)
 *   RPC  accept_peer_request  {p_request_id}       -> [{peer_id, username, first_name, last_name}]
 *   RPC  remove_peer          {p_peer}             -> void (drops the link on BOTH sides)
 *   GET  peer_links?user_id=eq.{id}&order=created_at.asc
 *   GET  peer_requests?target_id=eq.{id}&order=created_at.desc      (incoming)
 *   GET  peer_requests?requester_id=eq.{id}&order=created_at.desc   (outgoing)
 *   DEL  peer_requests?id=eq.{requestID}                            (decline)
 *   POST leaderboard_daily   (Prefer: resolution=merge-duplicates — idempotent upsert)
 *        rows: {user_id, day, money_sold, plans_sold, customers,
 *               worked_hours, open_floor_hours, commission}
 *   GET  leaderboard_shared?select=user_id,day,money_sold,plans_sold,customers,
 *        worked_hours,open_floor_hours,rank_score
 *        (own rows + every accepted peer's public metrics; RLS-scoped)
 *
 * PRIVACY — HARD RULES, mirroring the app:
 *   1. Commission amounts are NEVER displayed. The `commission` column has no
 *      SELECT grant; peers only ever read the sanitized `leaderboard_shared`
 *      view. We never request it and never render it.
 *   2. `rank_score` is used ONLY for sorting. It is never rendered, never put
 *      in the DOM (not even in data attributes), and never logged.
 *   3. Displayed columns are exactly: Sold, Plans, CPH — "the numbers shown
 *      stay friendly".
 *
 * OPT-IN / OPT-OUT
 *   The app pushes daily rows on every save; there is no server-side toggle.
 *   Like the app, the dashboard always shares while signed in — there is
 *   no dashboard-only "Share my numbers" switch.
 *
 * PARENT WIRING (dashboard.html — the parent does this, not this file):
 *   <script src="/leaderboard.js"></script>   (after sb.js, sync.js, payengine.js)
 *   tab button: <button class="tab-btn" data-tab="leaderboard">Board</button>
 *   panel: <section class="tab-panel" id="tab-leaderboard"><div id="leaderboard-body">…</div></section>
 *   loadTab dispatch: leaderboard: () => LeaderboardUI.open(document.getElementById("leaderboard-body"))
 *   After sales mutations settle: LeaderboardUI.schedulePush()
 *     (e.g. call it after SyncEngine.processWriteQueue() completes)
 *
 * SYNC OPS USED (all already exist in sync.js — no new ops needed):
 *   updateContact { contactId, updates }  — link/unlink a leaderboard account
 *   addContact    { contact }             — create a contact for a peer account
 *
 * DEPENDENCIES (must load before this file): sb.js (SB), sync.js (SyncEngine),
 *   payengine.js (PayEngine). All are used defensively — the module degrades
 *   gracefully if one is missing, except SB which is required for cloud calls.
 */
const LeaderboardUI = (() => {
  // ------------------------------------------------------------------ utils
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function toKey(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function moneyLabel(v) {
    v = Number(v) || 0;
    if (v >= 10000) {
      const k = v / 1000;
      const s = k >= 100 ? String(Math.round(k)) : String(Math.round(k * 10) / 10);
      return "$" + s + "K";
    }
    return "$" + Math.round(v).toLocaleString("en-US");
  }

  // ------------------------------------------------------- state & config
  const RANGES = [
    { id: "today", label: "Today" },
    { id: "thisWeek", label: "Week" },
    { id: "thisMonth", label: "Month" },
    { id: "thisYear", label: "Year" },
    { id: "allTime", label: "All" },
  ];

  let container = null;
  let range = "thisWeek";
  let loading = true;
  let snapshot = { peers: [], incoming: [], outgoing: [], sharedStats: [] };
  let signedIn = true;
  let errorText = null;
  let flashMsg = null;
  let flashTimer = null;
  let busyId = null;
  let showAddSheet = false;
  let linkPeerTarget = null; // LeaderboardPeer awaiting contact link

  // Parent hook: override the contact-link flow (e.g. open CoworkersUI's sheet).
  // Called as onLinkPeer(peer) -> Promise<boolean> (true = handled & linked).
  let onLinkPeer = null;

  // No dashboard-only sharing switch: sharing is always on while signed
  // in, matching the app. Kept as functions for the internal guards below.
  function isSharingEnabled() { return true; }
  function setSharingEnabled(on) {}

  // ------------------------------------------------------- supabase plumbing
  // We need the `Prefer: resolution=merge-duplicates` header for the daily
  // upsert, which SB.rest doesn't expose — so this module does its own fetch
  // with the same auth (session from SB, public anon key from /api/config).
  let _anonKey = null;
  async function anonKey() {
    if (_anonKey) return _anonKey;
    const res = await fetch("/api/config");
    if (!res.ok) throw new Error("Dashboard not configured.");
    const c = await res.json();
    if (!c.supabaseAnonKey) throw new Error("Dashboard not configured.");
    _anonKey = c.supabaseAnonKey;
    return _anonKey;
  }

  async function sbFetch(method, path, opts) {
    opts = opts || {};
    const session = await SB.getValidSession();
    const key = await anonKey();
    const headers = {
      "apikey": key,
      "Authorization": "Bearer " + session.access_token,
      "Content-Type": "application/json",
    };
    if (opts.prefer) headers["Prefer"] = opts.prefer;
    const res = await fetch(SB.SUPABASE_URL + "/rest/v1/" + path, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
      // PostgREST RPC exceptions arrive as 4xx JSON: { "message": "..." }.
      let msg = "Server error (" + res.status + "). Please try again.";
      try {
        const j = await res.json();
        if (j && typeof j.message === "string" && j.message) msg = j.message;
      } catch (e) {}
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    const text = (await res.text()).trim();
    return { data: text ? JSON.parse(text) : null, session };
  }

  async function rpc(name, body) {
    const { data } = await sbFetch("POST", "rpc/" + name, { body });
    return data;
  }

  // ------------------------------------------------------- service ports
  // (mirrors LeaderboardService.swift one for one)
  async function searchUsers(query) {
    // The app ignores a typed "@".
    const q = String(query || "").trim().replace(/^@+/, "");
    const rows = await rpc("search_profiles", { p_query: q });
    return Array.isArray(rows) ? rows : [];
  }

  async function fetchPeers(userID) {
    const { data } = await sbFetch("GET",
      "peer_links?user_id=eq." + encodeURIComponent(userID) + "&order=created_at.asc");
    return Array.isArray(data) ? data : [];
  }

  async function fetchIncoming(userID) {
    const { data } = await sbFetch("GET",
      "peer_requests?target_id=eq." + encodeURIComponent(userID) + "&order=created_at.desc");
    return Array.isArray(data) ? data : [];
  }

  async function fetchOutgoing(userID) {
    const { data } = await sbFetch("GET",
      "peer_requests?requester_id=eq." + encodeURIComponent(userID) + "&order=created_at.desc");
    return Array.isArray(data) ? data : [];
  }

  async function sendRequest(targetID) {
    await rpc("send_peer_request", { p_target: targetID });
  }

  async function acceptRequest(requestID) {
    const rows = await rpc("accept_peer_request", { p_request_id: requestID });
    return (Array.isArray(rows) && rows[0]) || null;
  }

  async function declineRequest(requestID) {
    await sbFetch("DELETE", "peer_requests?id=eq." + encodeURIComponent(requestID));
  }

  async function removePeer(peerID) {
    await rpc("remove_peer", { p_peer: peerID });
  }

  async function pushDailyStats(rows) {
    await sbFetch("POST", "leaderboard_daily",
      { body: rows, prefer: "resolution=merge-duplicates" });
  }

  async function fetchSharedStats() {
    const { data } = await sbFetch("GET",
      "leaderboard_shared?select=user_id,day,money_sold,plans_sold,customers,worked_hours,open_floor_hours,rank_score");
    return Array.isArray(data) ? data : [];
  }

  // ------------------------------------------------------- local aggregation
  // Port of the AppStore leaderboard helpers: per-day rows from the local
  // backup blob, computed with the exact PayEngine math.
  function backupData() {
    // SyncEngine.getLocalBackup() resolves { data, updated_at, cachedAt }.
    return SyncEngine.getLocalBackup().then(b => (b && b.data) || b || {});
  }

  function buildLocalDayRows(data) {
    const days = data.days || [];
    const profile = data.profile || {};
    const table = PayEngine.tableForProfile(profile);
    const shifts = data.shifts || [];
    const holidayDates = data.holidayDates || [];
    let premiumByDay = {};
    try { premiumByDay = PayEngine.premiumsByDay(shifts, holidayDates) || {}; } catch (e) {}
    const rows = [];
    for (const day of days) {
      const dk = day.id || day.date;
      if (!dk) continue;
      const lines = [];
      for (const t of (day.tickets || [])) {
        for (const l of (t.lines || [])) lines.push(l);
      }
      const money = lines.reduce((s, l) => s + PayEngine.lineRevenue(l), 0);
      const plans = lines.reduce((s, l) =>
        s + ((!l.isReturn && l.kind === "servicePlan") ? (l.quantity || 0) : 0), 0);
      const customers = (day.tickets || []).length;
      const worked = PayEngine.workedHours(day);
      if (money === 0 && customers === 0 && worked <= 0) continue;
      const premium = premiumByDay[dk] || PayEngine.emptyPremium();
      const pay = PayEngine.dayPay(day, premium, table);
      rows.push({
        day: dk,
        money_sold: money,
        plans_sold: plans,
        customers,
        worked_hours: worked,
        open_floor_hours: pay.openHours,
        commission: pay.commission, // uploaded; never SELECTed back, never shown
      });
    }
    return rows;
  }

  // "yyyy-MM-dd" bounds for the range — day keys sort lexicographically.
  // (port of LeaderboardView.dayBounds; week starts Sunday like the app)
  function dayBounds() {
    const now = new Date();
    const sod = d => { const c = new Date(d); c.setHours(0, 0, 0, 0); return c; };
    switch (range) {
      case "today": {
        const t = sod(now);
        return { start: toKey(t), end: toKey(now) };
      }
      case "thisWeek": {
        const s = sod(now);
        s.setDate(s.getDate() - s.getDay());
        return { start: toKey(s), end: toKey(now) };
      }
      case "thisMonth": {
        const s = new Date(now.getFullYear(), now.getMonth(), 1);
        return { start: toKey(s), end: toKey(now) };
      }
      case "thisYear": {
        const s = new Date(now.getFullYear(), 0, 1);
        return { start: toKey(s), end: toKey(now) };
      }
      default:
        return { start: null, end: null };
    }
  }

  function inBounds(day, bounds) {
    if (bounds.start && day < bounds.start) return false;
    if (bounds.end && day > bounds.end) return false;
    return true;
  }

  // ------------------------------------------------------- display names
  function peerDisplayName(p) {
    const name = [p.peer_first_name, p.peer_last_name]
      .map(s => (s || "").trim()).filter(Boolean).join(" ");
    if (name) return name;
    const u = (p.peer_username || "").trim();
    return u ? "@" + u : "";
  }
  function peerUsernameDisplay(p) {
    const u = (p.peer_username || "").trim();
    return u ? "@" + u : "";
  }
  function requestDisplayName(r) {
    const name = [r.requester_first_name, r.requester_last_name]
      .map(s => (s || "").trim()).filter(Boolean).join(" ");
    if (name) return name;
    const u = (r.requester_username || "").trim();
    return u ? "@" + u : "";
  }
  function contactPreferredName(c) {
    if (c.nickname && String(c.nickname).trim()) return String(c.nickname).trim();
    const parts = [c.firstName, c.lastName].map(s => (s || "").trim()).filter(Boolean);
    if (parts.length) return parts.join(" ");
    return (c.name || "").trim() || "Unnamed";
  }
  function myDisplayName(profile) {
    if (profile.displayName && String(profile.displayName).trim())
      return String(profile.displayName).trim();
    const parts = [profile.firstName, profile.lastName]
      .map(s => (s || "").trim()).filter(Boolean);
    if (parts.length) return parts.join(" ");
    return "You";
  }
  function myUsername(profile) {
    const u = (profile.username || profile.handle || "").trim();
    return u ? "@" + u.replace(/^@+/, "") : "";
  }

  // ------------------------------------------------------- board rows
  // Aggregated rows for the selected range, sorted by the hidden take-home
  // (commission + $4 × open-floor hours) — displayed columns never include it.
  // NOTE: rankScore is used for sorting ONLY. It must never reach the DOM.
  function buildRows(data) {
    const bounds = dayBounds();
    const profile = data.profile || {};
    const contacts = data.contacts || [];
    const byUserID = {};
    for (const c of contacts) {
      const uid = c.linkedUserID || c.linked_user_id;
      if (uid) byUserID[String(uid)] = c;
    }

    const entries = [];
    // You — computed locally, exactly like the app (never from the cloud).
    const myDays = buildLocalDayRows(data).filter(r => inBounds(r.day, bounds));
    entries.push(aggregateRow({
      id: "me", name: myDisplayName(profile),
      username: myUsername(profile), isYou: true, days: myDays,
    }));
    // Peers — from the shared view.
    for (const peer of snapshot.peers) {
      const pid = String(peer.peer_id);
      const days = snapshot.sharedStats.filter(s =>
        String(s.user_id) === pid && inBounds(s.day, bounds));
      const contact = byUserID[pid];
      entries.push(aggregateRow({
        id: pid,
        name: contact ? contactPreferredName(contact) : (peerDisplayName(peer) || "Coworker"),
        username: contact ? "" : peerUsernameDisplay(peer),
        isYou: false, days,
      }));
    }
    entries.sort((a, b) =>
      a.rankScore !== b.rankScore ? b.rankScore - a.rankScore : b.moneySold - a.moneySold);
    return entries;
  }

  function aggregateRow({ id, name, username, isYou, days }) {
    const money = days.reduce((s, d) => s + (Number(d.money_sold) || 0), 0);
    const plans = days.reduce((s, d) => s + (Number(d.plans_sold) || 0), 0);
    const customers = days.reduce((s, d) => s + (Number(d.customers) || 0), 0);
    const hours = days.reduce((s, d) => s + (Number(d.worked_hours) || 0), 0);
    // Hidden ordering key: commission + $4 × open-floor hours.
    // For shared rows the server precomputes rank_score; for local rows we
    // compute the identical formula. NEVER rendered.
    const rankScore = days.reduce((s, d) => {
      if (d.rank_score != null) return s + Number(d.rank_score);
      return s + (Number(d.commission) || 0) +
        PayEngine.BASE_HOURLY_RATE * (Number(d.open_floor_hours) || 0);
    }, 0);
    return {
      id, name, username, isYou,
      moneySold: money, plans,
      cph: hours > 0 ? customers / hours : 0,
      rankScore, // sort-only; never rendered
    };
  }

  // ------------------------------------------------------- contact linking
  function linkedContactFor(contacts, peerID) {
    return (contacts || []).find(c =>
      String(c.linkedUserID || c.linked_user_id || "") === String(peerID)) || null;
  }

  // Port of the app's reconcileUnlinkedPeers: exact name matches link
  // themselves; partial names stay for the inline prompt.
  async function reconcileUnlinkedPeers(data) {
    const contacts = data.contacts || [];
    const ops = [];
    for (const peer of snapshot.peers) {
      if (linkedContactFor(contacts, peer.peer_id)) continue;
      const full = [peer.peer_first_name, peer.peer_last_name]
        .map(s => (s || "").trim()).filter(Boolean).join(" ").toLowerCase();
      if (!full) continue;
      const match = contacts.find(c => {
        const cn = [c.firstName, c.lastName]
          .map(s => (s || "").trim()).filter(Boolean).join(" ").toLowerCase();
        return cn && cn === full && !c.linkedUserID && !c.linked_user_id;
      });
      if (match) ops.push({ type: "updateContact", contactId: match.id || match.name,
        updates: { linkedUserID: peer.peer_id, linkedPhotoData: peer.peer_photo || null } });
    }
    for (const op of ops) {
      try { await SyncEngine.queueWrite(op); } catch (e) {}
    }
    return ops.length > 0;
  }

  async function doLinkPeer(peer, contact) {
    await SyncEngine.queueWrite({
      type: "updateContact",
      contactId: contact.id || contact.name,
      updates: { linkedUserID: peer.peer_id, linkedPhotoData: peer.peer_photo || null },
    });
    flash("Linked to " + contactPreferredName(contact));
    await refresh();
  }

  async function doCreateLinkedContact(peer) {
    await SyncEngine.queueWrite({
      type: "addContact",
      contact: {
        firstName: (peer.peer_first_name || "").trim(),
        lastName: (peer.peer_last_name || "").trim(),
        linkedUserID: peer.peer_id,
        linkedPhotoData: peer.peer_photo || null,
      },
    });
    flash("Contact created & linked");
    await refresh();
  }

  async function doUnlinkPeer(peerID) {
    const data = await backupData();
    const c = linkedContactFor(data.contacts, peerID);
    if (c) {
      await SyncEngine.queueWrite({
        type: "updateContact", contactId: c.id || c.name,
        updates: { linkedUserID: null, linkedPhotoData: null },
      });
    }
  }

  // ------------------------------------------------------- push engine
  // Debounced mirror of local saves into leaderboard_daily (port of
  // LeaderboardSyncService.schedulePush/flush). Retries with backoff.
  let pushTimer = null;
  let retryDelayMs = 2000;
  const MAX_RETRY_MS = 30000;

  function schedulePush() {
    if (!isSharingEnabled()) return;
    if (typeof PayEngine === "undefined" || typeof SyncEngine === "undefined") return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(pushNow, 2000);
  }

  async function pushNow() {
    clearTimeout(pushTimer);
    pushTimer = null;
    if (!isSharingEnabled()) return;
    let session;
    try { session = await SB.getValidSession(); }
    catch (e) { return; } // not paired — nothing to push to
    try {
      const data = await backupData();
      const rows = buildLocalDayRows(data).map(r => ({
        user_id: session.user_id,
        day: r.day,
        money_sold: r.money_sold,
        plans_sold: r.plans_sold,
        customers: r.customers,
        worked_hours: r.worked_hours,
        open_floor_hours: r.open_floor_hours,
        commission: r.commission, // private column: uploaded, never readable
      }));
      if (!rows.length) return;
      await pushDailyStats(rows);
      retryDelayMs = 2000;
    } catch (e) {
      // Retry with backoff, like the app.
      const d = retryDelayMs;
      retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_MS);
      clearTimeout(pushTimer);
      pushTimer = setTimeout(pushNow, d);
    }
  }

  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", () => {
      // Best-effort flush, like the app's flush-on-background.
      if (pushTimer && isSharingEnabled()) { clearTimeout(pushTimer); pushNow(); }
    });
  }

  // ------------------------------------------------------- data refresh
  async function refresh() {
    loading = true; errorText = null; render();
    let session;
    try {
      session = await SB.getValidSession();
    } catch (e) {
      signedIn = false; loading = false; render();
      return;
    }
    signedIn = true;
    try {
      const [peers, incoming, outgoing, sharedStats] = await Promise.all([
        fetchPeers(session.user_id),
        fetchIncoming(session.user_id),
        fetchOutgoing(session.user_id),
        fetchSharedStats(),
      ]);
      snapshot = { peers, incoming, outgoing, sharedStats };
      // Exact names link themselves; partial names stay for the inline prompt.
      const data = await backupData();
      await reconcileUnlinkedPeers(data);
    } catch (e) {
      errorText = e.message || "Couldn't load the leaderboard.";
    }
    loading = false;
    render();
  }

  function flash(msg) {
    flashMsg = msg;
    renderFlash();
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flashMsg = null; renderFlash(); }, 4000);
  }

  // ------------------------------------------------------- rendering
  function ensureCSS() {
    if (document.getElementById("lb-css")) return;
    const st = document.createElement("style");
    st.id = "lb-css";
    st.textContent = `
    .lb-wrap { display:flex; flex-direction:column; gap:12px; }
    .lb-toolbar { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; }
    .lb-ranges { display:flex; gap:6px; flex-wrap:wrap; }
    .lb-range { padding:6px 12px; border-radius:999px; border:1px solid var(--border);
      background:transparent; color:var(--muted); font-size:13px; font-weight:600; cursor:pointer; }
    .lb-range.active { background:var(--accent); border-color:var(--accent); color:#fff; }
    .lb-flash { display:flex; align-items:center; gap:8px; padding:10px 14px; border-radius:12px;
      background:var(--card); border:1px solid var(--border); font-size:13px; font-weight:600; }
    .lb-row { display:flex; align-items:center; gap:10px; padding:12px 10px; }
    .lb-rank { width:26px; height:26px; border-radius:50%; display:flex; align-items:center;
      justify-content:center; font-size:12px; font-weight:800; color:var(--muted); flex:none; }
    .lb-rank.r1 { background:var(--amber); color:#fff; }
    .lb-rank.r2 { background:var(--blue); color:#fff; }
    .lb-rank.r3 { background:var(--accent); color:#fff; }
    .lb-you { background:color-mix(in srgb, var(--accent) 12%, transparent); border-radius:12px; }
    .lb-cols { display:flex; padding:0 16px; }
    .lb-col { width:64px; text-align:right; font-size:9px; font-weight:800; letter-spacing:.6px;
      color:var(--muted); text-transform:uppercase; flex:none; }
    .lb-val { width:64px; text-align:right; font-size:13px; font-weight:700; flex:none; }
    .lb-identity { min-width:0; }
    .lb-name { font-size:14px; font-weight:600; color:var(--text); white-space:nowrap;
      overflow:hidden; text-overflow:ellipsis; }
    .lb-sub { font-size:11px; color:var(--muted); white-space:nowrap; overflow:hidden;
      text-overflow:ellipsis; }
    .lb-sheet-backdrop { position:fixed; inset:0; background:rgba(0,0,0,.5); z-index:90;
      display:flex; align-items:flex-end; justify-content:center; }
    .lb-sheet { background:var(--bg); border-radius:16px 16px 0 0; width:100%; max-width:520px;
      max-height:80vh; display:flex; flex-direction:column; padding:16px; }
    .lb-search { display:flex; align-items:center; gap:10px; background:var(--card);
      border:1px solid var(--border); border-radius:12px; padding:12px 14px; margin-bottom:12px; }
    .lb-search input { flex:1; background:transparent; border:none; outline:none;
      color:var(--text); font-size:15px; }
    .lb-result { display:flex; align-items:center; gap:12px; padding:12px 4px;
      border-bottom:1px solid var(--border); }
    `;
    document.head.appendChild(st);
  }

  function renderFlash() {
    const el = container && container.querySelector("#lb-flash-slot");
    if (!el) return;
    el.innerHTML = flashMsg
      ? `<div class="lb-flash">✓ ${esc(flashMsg)}</div>` : "";
  }

  function rankBadge(i) {
    const r = i + 1;
    const cls = r === 1 ? "r1" : r === 2 ? "r2" : r === 3 ? "r3" : "";
    return `<div class="lb-rank ${cls}">${r <= 3 ? r : "#" + r}</div>`;
  }

  function boardRowHTML(row, index, total) {
    // NOTE: row.rankScore is deliberately never interpolated below.
    const cph = row.cph > 0 ? row.cph.toFixed(1) : "—";
    const peerTag = row.isYou ? "" : ` data-lb-peer="${esc(row.id)}"`;
    return `<div class="lb-row${row.isYou ? " lb-you" : ""}"${peerTag}>` +
      rankBadge(index) +
      `<div class="lb-identity" style="flex:1">` +
        `<div class="lb-name">${esc(row.name)}${row.isYou ? ' <span class="pill live">You</span>' : ""}</div>` +
        (row.username ? `<div class="lb-sub">${esc(row.username)}</div>` : "") +
      `</div>` +
      `<div class="lb-val">${esc(moneyLabel(row.moneySold))}</div>` +
      `<div class="lb-val" style="color:var(--blue)">${row.plans}</div>` +
      `<div class="lb-val" style="color:var(--amber)">${esc(cph)}</div>` +
    `</div>` +
    (index < total - 1 ? `<div style="border-bottom:1px solid var(--border);margin-left:46px"></div>` : "");
  }

  function requestsHTML() {
    const inc = snapshot.incoming, out = snapshot.outgoing;
    if (!inc.length && !out.length) return "";
    let h = `<div class="section-title">Requests</div><div class="panel">`;
    for (const r of inc) {
      const dis = busyId === r.id ? " disabled" : "";
      h += `<div class="list-item"><div class="li-main">` +
        `<div style="font-weight:600">${esc(requestDisplayName(r))}</div>` +
        (r.requester_username ? `<div class="li-sub">@${esc(r.requester_username)}</div>` : "") +
        `<div class="li-sub" style="margin-top:4px">You'll each see sold $, plans, and CPH. Your contact notes stay private.</div>` +
        `</div><div style="display:flex;gap:8px">` +
        `<button class="btn primary" data-lb-accept="${esc(r.id)}"${dis} style="padding:6px 14px;font-size:13px">Accept</button>` +
        `<button class="btn ghost" data-lb-decline="${esc(r.id)}"${dis} style="padding:6px 14px;font-size:13px">Decline</button>` +
        `</div></div>`;
    }
    for (const r of out) {
      const dis = busyId === r.id ? " disabled" : "";
      h += `<div class="list-item"><div class="li-main">` +
        `<div style="font-weight:600">${esc(requestDisplayName(r))}</div>` +
        (r.requester_username ? `<div class="li-sub">@${esc(r.requester_username)}</div>` : "") +
        `</div><div style="display:flex;gap:8px;align-items:center">` +
        `<span class="pill">Waiting…</span>` +
        `<button class="btn ghost" data-lb-cancel="${esc(r.id)}"${dis} style="padding:6px 10px;font-size:13px">✕</button>` +
        `</div></div>`;
    }
    return h + `</div>`;
  }

  function linkPromptHTML(data) {
    const needing = snapshot.peers.filter(p => !linkedContactFor(data.contacts, p.peer_id));
    if (!needing.length) return "";
    let h = `<div class="section-title">Link to contact</div>` +
      `<div class="li-sub" style="margin:-6px 0 4px">Match each account to someone in your file</div><div class="panel">`;
    for (const p of needing) {
      h += `<div class="list-item"><div class="li-main">` +
        `<div style="font-weight:600">${esc(peerDisplayName(p) || "Coworker")}</div>` +
        (peerUsernameDisplay(p) ? `<div class="li-sub">${esc(peerUsernameDisplay(p))}</div>` : "") +
        `</div><button class="btn ghost" data-lb-link="${esc(p.peer_id)}" style="padding:6px 14px;font-size:13px">Link</button></div>`;
    }
    return h + `</div>`;
  }

  function boardHTML(data) {
    const rows = buildRows(data);
    let h = `<div class="section-title">Leaderboard</div>` +
      `<div class="li-sub" style="margin:-6px 0 4px">Ordered by overall performance — the numbers shown stay friendly</div>`;
    if (!rows.length || rows.every(r => r.moneySold === 0 && r.plans === 0 && r.cph === 0)) {
      h += `<div class="panel" style="text-align:center;padding:28px 16px">` +
        `<div style="font-size:28px;margin-bottom:8px">📊</div>` +
        `<div style="font-weight:700;margin-bottom:4px">No numbers this range</div>` +
        `<div style="color:var(--muted);font-size:13px">Once you and your friends log sales in this range, the board fills in.</div></div>`;
      return h;
    }
    h += `<div class="lb-cols"><div style="flex:1"></div>` +
      `<div class="lb-col">Sold</div><div class="lb-col">Plans</div><div class="lb-col">CPH</div></div>`;
    h += `<div class="panel" style="padding:6px">` +
      rows.map((r, i) => boardRowHTML(r, i, rows.length)).join("") + `</div>`;
    return h;
  }

  function emptyHTML() {
    return `<div class="panel" style="text-align:center;padding:32px 20px">` +
      `<div style="font-size:32px;margin-bottom:8px">🏆</div>` +
      `<div style="font-weight:700;margin-bottom:4px">Add friends to build your leaderboard</div>` +
      `<div style="color:var(--muted);font-size:13px;margin-bottom:14px">Link with Micro Buddy coworkers by username. You both have to accept, then your sold $, plans, and CPH line up side by side.</div>` +
      `<button class="btn primary" id="lb-add-btn">Add a coworker</button></div>`;
  }

  function render() {
    if (!container) return;
    ensureCSS();
    if (loading) {
      container.innerHTML = `<div class="lb-wrap"><div class="spinner">Loading leaderboard…</div></div>`;
      return;
    }
    if (!signedIn) {
      container.innerHTML = `<div class="lb-wrap"><div class="panel" style="text-align:center;padding:32px 20px">` +
        `<div style="font-size:32px;margin-bottom:8px">👤</div>` +
        `<div style="font-weight:700;margin-bottom:4px">Sign in to compete</div>` +
        `<div style="color:var(--muted);font-size:13px">Leaderboards link Micro Buddy accounts, so sign in first.</div></div></div>`;
      return;
    }
    if (errorText) {
      container.innerHTML = `<div class="lb-wrap"><div class="panel" style="text-align:center;padding:28px 16px">` +
        `<div style="font-weight:700;margin-bottom:4px">Couldn't load the leaderboard</div>` +
        `<div style="color:var(--muted);font-size:13px;margin-bottom:12px">${esc(errorText)}</div>` +
        `<button class="btn" id="lb-retry">Try again</button></div></div>`;
      bindStatic();
      return;
    }
    const hasAny = snapshot.peers.length || snapshot.incoming.length || snapshot.outgoing.length;
    let h = `<div class="lb-wrap"><div id="lb-flash-slot"></div>`;
    h += `<div class="lb-toolbar"><div class="lb-ranges">` +
      RANGES.map(r => `<button class="lb-range${range === r.id ? " active" : ""}" data-lb-range="${r.id}">${r.label}</button>`).join("") +
      `</div></div>`;
    if (!hasAny) {
      h += emptyHTML();
    } else {
      h += requestsHTML();
      // boardHTML needs contacts for link prompts — rendered async below.
      h += `<div id="lb-board-slot"><div class="spinner">Loading…</div></div>`;
    }
    h += `<div style="display:flex;justify-content:center"><button class="btn ghost" id="lb-add-btn2" style="font-size:13px">+ Add a coworker</button></div>`;
    h += `</div>`;
    container.innerHTML = h;
    renderFlash();
    bindStatic();
    if (hasAny) {
      backupData().then(data => {
        const slot = container && container.querySelector("#lb-board-slot");
        if (!slot) return;
        slot.innerHTML = linkPromptHTML(data) + boardHTML(data);
        bindDynamic(slot);
      }).catch(() => {});
    }
  }

  // ------------------------------------------------------- events
  function bindStatic() {
    container.querySelectorAll("[data-lb-range]").forEach(b =>
      b.addEventListener("click", () => { range = b.dataset.lbRange; refresh(); }));
    const r = container.querySelector("#lb-retry");
    if (r) r.addEventListener("click", () => refresh());
    const a1 = container.querySelector("#lb-add-btn");
    if (a1) a1.addEventListener("click", () => openAddSheet());
    const a2 = container.querySelector("#lb-add-btn2");
    if (a2) a2.addEventListener("click", () => openAddSheet());
    bindDynamic(container);
  }

  function bindDynamic(root) {
    root.querySelectorAll("[data-lb-accept]").forEach(b =>
      b.addEventListener("click", () => acceptFlow(b.dataset.lbAccept)));
    root.querySelectorAll("[data-lb-decline]").forEach(b =>
      b.addEventListener("click", () => declineFlow(b.dataset.lbDecline)));
    root.querySelectorAll("[data-lb-cancel]").forEach(b =>
      b.addEventListener("click", () => cancelFlow(b.dataset.lbCancel)));
    root.querySelectorAll("[data-lb-link]").forEach(b =>
      b.addEventListener("click", () => linkFlow(b.dataset.lbLink)));
  }

  async function acceptFlow(requestID) {
    const req = snapshot.incoming.find(r => String(r.id) === String(requestID));
    busyId = requestID; render();
    try {
      const acc = await acceptRequest(requestID);
      // Normalize to the peer_links row shape (peer_first_name / peer_last_name)
      // — the RPC returns first_name / last_name instead.
      const peer = acc ? {
        peer_id: acc.peer_id, peer_username: acc.username,
        peer_first_name: acc.first_name, peer_last_name: acc.last_name,
      } : (req ? {
        peer_id: req.requester_id, peer_username: req.requester_username,
        peer_first_name: req.requester_first_name, peer_last_name: req.requester_last_name,
      } : null);
      await refresh();
      if (peer) {
        // Try the parent's link flow first; fall back to the inline prompt.
        let handled = false;
        if (typeof onLinkPeer === "function") {
          try { handled = await onLinkPeer(peer); } catch (e) {}
        }
        if (!handled) {
          const data = await backupData();
          const full = [peer.peer_first_name, peer.peer_last_name].map(s => (s || "").trim())
            .filter(Boolean).join(" ").toLowerCase();
          const match = (data.contacts || []).find(c => {
            const cn = [c.firstName, c.lastName].map(s => (s || "").trim())
              .filter(Boolean).join(" ").toLowerCase();
            return cn && cn === full && !c.linkedUserID && !c.linked_user_id;
          });
          if (match) {
            await doLinkPeer(peer, match);
            flash("Accepted — linked to " + contactPreferredName(match));
          } else {
            linkPeerTarget = peer;
            openLinkSheet();
          }
        } else {
          flash("Accepted");
        }
      }
    } catch (e) {
      flash(e.message || "Couldn't accept the request.");
    }
    busyId = null;
    render();
  }

  async function declineFlow(requestID) {
    busyId = requestID; render();
    try {
      await declineRequest(requestID);
      snapshot.incoming = snapshot.incoming.filter(r => String(r.id) !== String(requestID));
    } catch (e) {
      flash(e.message || "Couldn't decline the request.");
    }
    busyId = null;
    render();
  }

  async function cancelFlow(requestID) {
    const req = snapshot.outgoing.find(r => String(r.id) === String(requestID));
    busyId = requestID; render();
    try {
      // Cancelling a sent request drops it via remove_peer on the target.
      await removePeer(req ? req.target_id : requestID);
      snapshot.outgoing = snapshot.outgoing.filter(r => String(r.id) !== String(requestID));
    } catch (e) {
      flash(e.message || "Couldn't cancel the request.");
    }
    busyId = null;
    render();
  }

  async function removePeerFlow(peerID) {
    if (!confirm("Remove this coworker from your leaderboard? It removes the link on both sides.")) return;
    try {
      await removePeer(peerID);
      await doUnlinkPeer(peerID);
      flash("Removed — gone from both leaderboards");
      await refresh();
    } catch (e) {
      flash(e.message || "Couldn't remove them.");
    }
  }

  async function linkFlow(peerID) {
    const peer = snapshot.peers.find(p => String(p.peer_id) === String(peerID));
    if (!peer) return;
    if (typeof onLinkPeer === "function") {
      try {
        const handled = await onLinkPeer(peer);
        if (handled) { await refresh(); return; }
      } catch (e) {}
    }
    linkPeerTarget = peer;
    openLinkSheet();
  }

  // ------------------------------------------------------- sheets
  function closeSheets() {
    document.querySelectorAll(".lb-sheet-backdrop").forEach(el => el.remove());
    showAddSheet = false;
    linkPeerTarget = null;
  }

  function sheetShell(title, bodyHTML) {
    closeSheets();
    const bd = document.createElement("div");
    bd.className = "lb-sheet-backdrop";
    bd.innerHTML = `<div class="lb-sheet">` +
      `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">` +
      `<div style="font-size:17px;font-weight:700">${esc(title)}</div>` +
      `<button class="btn ghost" id="lb-sheet-done" style="padding:6px 12px;font-size:13px">Done</button></div>` +
      `<div style="overflow-y:auto">${bodyHTML}</div></div>`;
    bd.addEventListener("click", e => { if (e.target === bd) closeSheets(); });
    document.body.appendChild(bd);
    bd.querySelector("#lb-sheet-done").addEventListener("click", closeSheets);
    return bd;
  }

  // Add-a-coworker sheet: username search + ask-to-join (port of AddPeerSheet).
  function openAddSheet() {
    showAddSheet = true;
    const linkedIDs = new Set(snapshot.peers.map(p => String(p.peer_id)));
    const requestedIDs = new Set(snapshot.outgoing.map(r => String(r.target_id)));
    const sentIDs = new Set();
    const bd = sheetShell("Add a coworker",
      `<div class="lb-search"><span style="color:var(--muted)">🔍</span>` +
      `<input id="lb-search-input" placeholder="username" autocomplete="off" autocapitalize="off" spellcheck="false"></div>` +
      `<div id="lb-search-err" style="font-size:13px;color:var(--muted);margin-bottom:8px"></div>` +
      `<div id="lb-search-results"></div>`);
    const input = bd.querySelector("#lb-search-input");
    const resultsEl = bd.querySelector("#lb-search-results");
    const errEl = bd.querySelector("#lb-search-err");
    let timer = null, searching = false;

    function renderResults(users) {
      if (!users.length) {
        resultsEl.innerHTML = input.value.trim().length >= 2 && !searching
          ? `<div style="color:var(--muted);font-size:13px;padding:8px 0">No Micro Buddy accounts found for "${esc(input.value.trim())}". Usernames are exact — try the first few letters.</div>`
          : "";
        return;
      }
      resultsEl.innerHTML = users.map(u => {
        const uid = String(u.id);
        const name = [u.first_name, u.last_name].map(s => (s || "").trim())
          .filter(Boolean).join(" ") || "@" + u.username;
        let right;
        if (linkedIDs.has(uid)) right = `<span class="pill live">Linked</span>`;
        else if (requestedIDs.has(uid) || sentIDs.has(uid)) right = `<span class="pill">Asked</span>`;
        else right = `<button class="btn primary" data-lb-ask="${esc(uid)}" style="padding:6px 16px;font-size:13px">Ask</button>`;
        return `<div class="lb-result"><div style="flex:1;min-width:0">` +
          `<div class="lb-name">${esc(name)}</div><div class="lb-sub">@${esc(u.username)}</div>` +
          `</div>${right}</div>`;
      }).join("");
      resultsEl.querySelectorAll("[data-lb-ask]").forEach(b =>
        b.addEventListener("click", async () => {
          b.disabled = true;
          try {
            await sendRequest(b.dataset.lbAsk);
            sentIDs.add(b.dataset.lbAsk);
            errEl.textContent = "";
            renderResults(users);
            refresh(); // picks up the new outgoing request
          } catch (e) {
            errEl.textContent = e.message || "Couldn't send the request.";
            b.disabled = false;
          }
        }));
    }

    async function searchNow() {
      const q = input.value.trim();
      if (q.length < 2) { resultsEl.innerHTML = ""; errEl.textContent = ""; return; }
      searching = true; renderResults([]);
      try {
        const found = await searchUsers(q);
        // Exact username hits lead the prefix list (port of exactUsernameFirst).
        const needle = q.replace(/^@+/, "").toLowerCase();
        const exact = found.filter(u => (u.username || "").toLowerCase() === needle);
        const rest = found.filter(u => (u.username || "").toLowerCase() !== needle);
        errEl.textContent = "";
        renderResults(exact.concat(rest));
      } catch (e) {
        errEl.textContent = e.message || "Search failed.";
      }
      searching = false;
    }

    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(searchNow, 350);
    });
    input.addEventListener("keydown", e => { if (e.key === "Enter") { clearTimeout(timer); searchNow(); } });
    setTimeout(() => input.focus(), 50);
  }

  // Link-account sheet: pick an existing contact or create one.
  // (port of LinkAccountSheet; same chrome as the Add sheet)
  async function openLinkSheet() {
    const peer = linkPeerTarget;
    if (!peer) return;
    const data = await backupData();
    const contacts = (data.contacts || []).slice().sort((a, b) =>
      contactPreferredName(a).localeCompare(contactPreferredName(b)));
    const needle = [peer.peer_first_name, peer.peer_last_name]
      .map(s => (s || "").trim()).filter(Boolean).join(" ").toLowerCase();
    const suggestions = needle
      ? contacts.filter(c => {
          const n = [c.firstName, c.lastName].map(s => (s || "").trim())
            .filter(Boolean).join(" ").toLowerCase();
          const nn = (c.nickname || "").trim().toLowerCase();
          return (n && n.includes(needle)) || (nn && needle.includes(nn));
        })
      : [];
    const rest = contacts.filter(c => !suggestions.includes(c)).slice(0, 50);
    const handle = peerUsernameDisplay(peer);
    const title = handle ? `Link ${handle} to a contact` : "Link account to a contact";

    const rowHTML = c =>
      `<button class="lb-result" data-lb-pick="${esc(c.id || c.name)}" style="width:100%;background:none;border:none;border-bottom:1px solid var(--border);cursor:pointer;text-align:left">` +
      `<div style="flex:1;min-width:0"><div class="lb-name">${esc(contactPreferredName(c))}</div>` +
      `</div><span style="color:var(--accent);font-size:13px;font-weight:700">Link</span></button>`;

    const bd = sheetShell(title,
      `<div style="font-size:13px;color:var(--muted);margin-bottom:10px">You'll each see sold $, plans, and CPH. Your contact notes stay private.</div>` +
      (suggestions.length ? `<div class="section-title">Suggestions</div>` + suggestions.map(rowHTML).join("") : "") +
      `<div class="section-title">All contacts</div>` +
      (rest.length ? rest.map(rowHTML).join("") : `<div style="color:var(--muted);font-size:13px">No contacts yet.</div>`) +
      `<button class="btn ghost" id="lb-create-contact" style="margin-top:12px;width:100%">+ Create new contact</button>`);

    bd.querySelectorAll("[data-lb-pick]").forEach(b =>
      b.addEventListener("click", async () => {
        const c = contacts.find(x => String(x.id || x.name) === b.dataset.lbPick);
        if (!c) return;
        b.disabled = true;
        try { await doLinkPeer(peer, c); closeSheets(); }
        catch (e) { flash(e.message || "Couldn't link."); b.disabled = false; }
      }));
    bd.querySelector("#lb-create-contact").addEventListener("click", async e => {
      e.target.disabled = true;
      try { await doCreateLinkedContact(peer); closeSheets(); }
      catch (err) { flash(err.message || "Couldn't create the contact."); e.target.disabled = false; }
    });
  }

  // ------------------------------------------------------- public API
  async function open(el) {
    container = el;
    // Long-press / right-click a peer row to remove? The app uses a context
    // menu; the dashboard exposes removal on the peer's contact instead, plus
    // here: double-click a non-you row removes the peer.
    await refresh();
  }

  // Remove-peer affordance: double-clicking someone else's row (with confirm).
  document.addEventListener("dblclick", e => {
    const row = e.target && e.target.closest ? e.target.closest("[data-lb-peer]") : null;
    if (!row || !container || !container.contains(row)) return;
    removePeerFlow(row.dataset.lbPeer);
  });

  return {
    open, refresh, schedulePush,
    isSharingEnabled, setSharingEnabled,
    // Parent hook: override the contact-link flow.
    // Set to async (peer) => true when handled.
    set onLinkPeer(fn) { onLinkPeer = fn; },
    get onLinkPeer() { return onLinkPeer; },
  };
})();
