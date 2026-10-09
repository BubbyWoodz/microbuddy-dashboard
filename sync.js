"use strict";
/* ============ sync.js — offline-first sync engine for Micro Buddy PWA ============
 * Strategy (2.0):
 *  - The phone's backup blob (user_backups.data) is the single source of
 *    truth. Every view (Home, Sales, Schedule, Stats, Badges) is computed
 *    from it in the browser with PayEngine — exactly like the app.
 *  - fullSync()/incrementalSync(): pull the blob + the profiles row, cache
 *    both in IndexedDB. No more per-day MCP crawling.
 *  - Edits go through queueWrite() (optimistic, conflict-checked, offline
 *    queue) and are sanitized so the phone can always decode them.
 *  - Theme: the phone's profile.themePreference wins ("Match my phone");
 *    otherwise the manual pick saved in this browser.
 * Sync status + "last synced" timestamp are shown in the header.
 */
const SyncEngine = (() => {
  const WIDE_START = "2020-01-01";
  const DAY_LIMIT = 2000;
  const STAGGER_MS = 120;   // pause between detail fetches to be kind to the MCP server
  const CONCURRENCY = 3;

  let syncing = false;
  let statusEl = null;
  let lastSyncEl = null;

  function bindUI() {
    statusEl = document.getElementById("sync-status");
    lastSyncEl = document.getElementById("last-sync");
    updateOnlineBadge();
    window.addEventListener("online", updateOnlineBadge);
    window.addEventListener("offline", updateOnlineBadge);
    refreshLastSyncLabel();
  }

  const DOT = '<svg class="status-dot" viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="4" fill="currentColor"/></svg>';
  function renderStatus(state, label) {
    if (!statusEl) return;
    statusEl.className = "status-pill " + state;
    const text = label || (state === "syncing" ? "Syncing" : state === "offline" ? "Offline" : "Online");
    statusEl.innerHTML = DOT + "<span>" + text.replace(/[<>&]/g, "") + "</span>";
  }

  function updateOnlineBadge() {
    if (!statusEl) return;
    renderStatus(syncing ? "syncing" : (navigator.onLine ? "live" : "offline"));
  }

  function setSyncing(v, label) {
    syncing = v;
    renderStatus(v ? "syncing" : (navigator.onLine ? "live" : "offline"), v ? (label || "Syncing") : "");
  }

  async function refreshLastSyncLabel() {
    const ts = await MBDB.kvGet("lastSync").catch(() => null);
    if (lastSyncEl) {
      lastSyncEl.textContent = ts ? ("Synced " + relTime(ts)) : "Never synced";
      lastSyncEl.title = ts ? new Date(ts).toLocaleString() : "";
    }
  }

  function relTime(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  }

  // ---- date helpers (local copies so sync.js is standalone) ----
  function iso(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
  }
  const todayISO = () => iso(new Date());
  function daysAheadISO(n) { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); }
  function firstOfMonthISO() { const d = new Date(); d.setDate(1); return iso(d); }
  function firstOfYearISO() { const d = new Date(); d.setMonth(0, 1); return iso(d); }

  // ---- raw network fetch (no cache) ----
  async function netGet(path) {
    const res = await fetch(path);
    if (res.status === 401) {
      const err = new Error("Not signed in");
      err.isAuth = true;
      throw err;
    }
    if (!res.ok) throw new Error("Request failed (" + res.status + ")");
    return res.json();
  }

  // ---- cache-aware fetch used by the dashboard's api() ----
  async function fetchCached(path, kind) {
    if (navigator.onLine) {
      try {
        const data = await netGet(path);
        MBDB.putCache(path, data, kind).catch(() => {});
        return { data, fromCache: false };
      } catch (e) {
        if (e.isAuth) throw e; // don't mask auth failures with stale cache
        // fall through to cache
      }
    }
    const entry = await MBDB.getCache(path).catch(() => null);
    if (entry && entry.data !== undefined) return { data: entry.data, fromCache: true };
    // Smart fallback: a /api/days range request can be served from any cached
    // days response whose range covers it (e.g. the full-sync wide range).
    const derived = await deriveDaysRange(path).catch(() => null);
    if (derived) return { data: derived, fromCache: true };
    throw new Error("You're offline and this isn't cached yet. Connect to sync it.");
  }

  // Try to satisfy /api/days?start=A&end=B&limit=N from a cached wider response.
  async function deriveDaysRange(path) {
    const m = /^\/api\/days\?/.test(path) ? parseDaysQuery(path) : null;
    if (!m) return null;
    const paths = await MBDB.getAllCachedPaths().catch(() => []);
    for (const p of paths) {
      if (!/^\/api\/days\?/.test(p) || p === path) continue;
      const q = parseDaysQuery(p);
      if (!q || q.start > m.start || q.end < m.end) continue;
      const entry = await MBDB.getCache(p).catch(() => null);
      const days = entry && entry.data && entry.data.days;
      if (!Array.isArray(days)) continue;
      const filtered = days.filter(d => d.date >= m.start && d.date <= m.end)
        .sort((a, b) => a.date < b.date ? -1 : 1)
        .slice(0, m.limit);
      return { range: { start: m.start, end: m.end }, day_count: filtered.length, days: filtered };
    }
    return null;
  }

  function parseDaysQuery(path) {
    try {
      const u = new URL(path, "http://x");
      const start = u.searchParams.get("start") || "";
      const end = u.searchParams.get("end") || "";
      const limit = parseInt(u.searchParams.get("limit") || "200", 10);
      if (!start || !end) return null;
      return { start, end, limit: isNaN(limit) ? 200 : limit };
    } catch (e) { return null; }
  }

  // ---- blob sync (replaces the old per-day MCP crawl) ----
  // Pull the latest backup blob + profile row and remember when.
  async function pullAll() {
    await processWriteQueue()
      .then(r => { if (r && r.skipped && r.skipped.length) notifySkipped(r.skipped); })
      .catch(e => { if (e && e.isAuth) throw e; });
    const res = await syncBackup();
    try { if (typeof SB !== "undefined") await SB.getProfile({ force: true }); } catch (e) { if (e && e.isAuth) throw e; }
    await MBDB.kvSet("lastSync", Date.now());
    await refreshLastSyncLabel();
    return res;
  }

  async function fullSync(onProgress) {
    if (syncing) return;
    if (!navigator.onLine) {
      // Supabase unreachable: this dashboard's server may still hold the
      // user's latest copy (it's on the LAN).
      if (await seedFromServerCopy()) return;
      throw new Error("Can't do the first sync offline — connect to Wi-Fi.");
    }
    setSyncing(true, "Downloading");
    try {
      if (onProgress) onProgress("fetch", 1, 1);
      try { await pullAll(); }
      catch (e) { if ((e && e.isAuth) || !(await seedFromServerCopy())) throw e; }
      await MBDB.kvSet("fullSyncDone", true);
    } finally {
      setSyncing(false);
      refreshLastSyncLabel();
    }
  }

  /// Refresh from the cloud. opts.force ignores the short throttle.
  /// Resolves to {changed} — true when the phone pushed a newer blob.
  async function incrementalSync(opts) {
    if (syncing || !navigator.onLine) return { changed: false };
    const force = opts === true || (opts && opts.force);
    const last = await MBDB.kvGet("lastSync").catch(() => 0);
    if (!force && last && Date.now() - last < 60 * 1000) return { changed: false };
    const before = await MBDB.kvGet("backupUpdatedAt").catch(() => null);
    setSyncing(true);
    try {
      const res = await pullAll();
      const changed = !!(res && res.updated_at && res.updated_at !== before);
      if (changed) {
        try { await syncThemeFromBlob(); } catch (e) {}
        try { window.dispatchEvent(new CustomEvent("mb:data-changed")); } catch (e) {}
      }
      return { changed };
    } finally {
      setSyncing(false);
      refreshLastSyncLabel();
    }
  }

  async function needsFullSync() {
    const done = await MBDB.kvGet("fullSyncDone").catch(() => false);
    return !done;
  }

  // ---- theme ----
  // The phone is the source of truth: profile.themePreference in the backup
  // blob ("Match my phone", the default). When the phone hasn't shared one
  // (older app builds) or the user turned matching off, the manual pick
  // saved in this browser is used. Nothing theme-related lives on the server.
  const VALID_THEMES = ["auto", "light", "dark", "terminal", "modern", "win95"];

  function normalizeTheme(v) {
    if (v == null) return null;
    const s = String(v).toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!s) return null;
    if (VALID_THEMES.includes(s)) return s;
    if (s.includes("win95") || s.includes("windows95") || s.includes("windows")) return "win95";
    if (s.includes("terminal")) return "terminal";
    if (s.includes("modern") || s.includes("frosted") || s.includes("glass") || s.includes("bliss")) return "modern";
    if (s.includes("auto") || s.includes("system")) return "auto";
    if (s.includes("light")) return "light";
    if (s.includes("dark") || s.includes("classic")) return "dark";
    return null;
  }

  function blobTheme(backup) {
    const d = backup && backup.data;
    if (!d) return null;
    const p = d.profile || {};
    return normalizeTheme(p.themePreference ?? p.theme ?? p.themeName ?? p.appTheme ??
      d.themePreference ?? d.theme ?? null);
  }

  // Toggle + manual pick are per user on the server (follow them across
  // browsers, wiped on unlink); IndexedDB holds a cache for offline starts.
  async function loadAppearance(refresh) {
    let ap = await MBDB.kvGet("appearance").catch(() => null);
    if (refresh || !ap) {
      try {
        const r = await fetch("/api/appearance", { credentials: "same-origin", cache: "no-store" });
        if (r.ok) { ap = await r.json(); await MBDB.kvSet("appearance", ap).catch(() => {}); }
      } catch (e) {}
    }
    return {
      match_phone: !(ap && ap.match_phone === false),
      theme: normalizeTheme(ap && ap.theme) || "auto",
    };
  }
  async function saveAppearance(patch) {
    const cur = await loadAppearance(false);
    const next = Object.assign({}, cur, patch);
    await MBDB.kvSet("appearance", next).catch(() => {});
    try {
      await fetch("/api/appearance", { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) });
    } catch (e) {}
    return next;
  }

  async function themeState(refresh) {
    const ap = await loadAppearance(refresh);
    const mode = ap.match_phone ? "phone" : "manual";
    const manual = ap.theme;
    const phone = blobTheme(await getLocalBackup().catch(() => null));
    // Matching with nothing shared yet: Auto (follows the computer).
    const effective = mode === "phone" ? (phone || "auto") : manual;
    return { mode, manual, phone, effective };
  }

  async function syncPreferences() {
    const st = await themeState(true);
    applyTheme(st.effective);
    return st.effective;
  }

  // ---- theme-aware app icons (robot head) ----
  // Maps dashboard theme -> icon file in /icons/. Used for the login logo
  // and the Umbrel tile (via POST /api/theme-icon).
  const THEME_ICONS = {
    modern: "/icons/icon-modern.png",
    terminal: "/icons/icon-terminal.png",
    win95: "/icons/icon-win95.png",
  };
  function themeIconFor(theme) {
    return THEME_ICONS[theme] || "/icons/icon-og.png";
  }
  function updateLoginLogo(theme) {
    const img = document.getElementById("login-logo-img");
    if (!img) return;
    const src = themeIconFor(theme || document.documentElement.getAttribute("data-theme"));
    if (img.getAttribute("src") !== src) img.setAttribute("src", src);
  }
  let _lastTileTheme = null;
  function pushTileIcon(theme) {
    const t = theme || document.documentElement.getAttribute("data-theme") || "dark";
    if (t === _lastTileTheme) return;
    _lastTileTheme = t;
    fetch("/api/theme-icon", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme: t }),
    }).catch(() => {});
  }

  function applyTheme(theme) {
    // App themes: auto, light, dark, terminal, modern, win95.
    // "auto" follows the OS light/dark setting.
    const valid = ["auto", "light", "dark", "terminal", "modern", "win95"];
    let t = valid.includes(theme) ? theme : "auto";
    let applied = t;
    if (t === "auto") {
      applied = (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches)
        ? "light" : "dark";
    }
    document.documentElement.setAttribute("data-theme", applied);
    // Keep the login logo and Umbrel tile icon on the active theme.
    try { updateLoginLogo(applied); } catch (e) {}
    try { pushTileIcon(applied); } catch (e) {}
    // Keep the PWA chrome in sync with the theme.
    document.documentElement.setAttribute("data-theme-pref", t);
    const meta = document.querySelector('meta[name="theme-color"]');
    const colors = { dark: "#0e121d", light: "#ffffff", win95: "#008080", modern: "#2a7fc0", terminal: "#000000" };
    if (meta) meta.setAttribute("content", colors[applied] || colors.dark);
    try { window.dispatchEvent(new CustomEvent("mb:theme", { detail: { pref: t, applied } })); } catch (e) {}
    return t; // return the preference (auto stays auto), not the resolved theme
  }

  // "auto" follows the OS live.
  try {
    window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
      if (document.documentElement.getAttribute("data-theme-pref") === "auto") applyTheme("auto");
    });
  } catch (e) {}

  // Manual pick (only used with "Match my phone" off). Stored per user on
  // the server; the phone owns profile.themePreference, never written here.
  async function setTheme(theme) {
    const t = normalizeTheme(theme) || "auto";
    await saveAppearance({ theme: t });
    const st = await themeState();
    applyTheme(st.effective);
    return t;
  }

  /// Turn "Match my phone" on/off; returns the new theme state.
  async function setThemeMode(mode) {
    await saveAppearance({ match_phone: mode !== "manual" });
    const st = await themeState();
    applyTheme(st.effective);
    return st;
  }

  // Re-apply after a blob sync (the phone may have changed its theme).
  async function syncThemeFromBlob() {
    try {
      const st = await themeState();
      if (st.effective !== document.documentElement.getAttribute("data-theme-pref")) applyTheme(st.effective);
    } catch (e) {
      console.warn("sync: couldn't read theme from blob:", e.message);
    }
  }

  // ---- Buddy chat sync (conversations are syncable data) ----
  // Full sync on login (server canonical), incremental after.
  // Only the theme and other non-sensitive prefs are cached — AI config
  // is server-only and never touches IndexedDB.
  async function syncChat() {
    if (!navigator.onLine) return { synced: false, offline: true };
    const since = (await MBDB.kvGet("chatSyncTs").catch(() => 0)) || 0;
    const res = await fetch("/api/chat/sync?since=" + encodeURIComponent(since));
    if (res.status === 401) {
      const err = new Error("Not signed in");
      err.isAuth = true;
      throw err;
    }
    if (!res.ok) throw new Error("chat sync failed: " + res.status);
    const data = await res.json();
    const sessions = (data && data.sessions) || [];
    let maxTs = since;
    for (const s of sessions) {
      await MBDB.replaceChatSession(s.id, s.messages);
      if (s.updated_at > maxTs) maxTs = s.updated_at;
    }
    // Also fetch the session list so the UI knows titles/counts.
    try {
      const listRes = await fetch("/api/chat");
      if (listRes.ok) {
        const list = await listRes.json();
        await MBDB.kvSet("chatSessions", list.sessions || []);
      }
    } catch (e) { /* non-fatal */ }
    await MBDB.kvSet("chatSyncTs", maxTs).catch(() => {});
    return { synced: true, updated: sessions.length };
  }

  return {
    bindUI, fullSync, incrementalSync, fetchCached,
    needsFullSync, refreshLastSyncLabel, setSyncing,
    syncPreferences, applyTheme, setTheme, setThemeMode, themeState, normalizeTheme,
    syncChat, syncBackup, queueWrite, processWriteQueue, getLocalBackup,
    pushOfflineCopy, seedFromServerCopy, merge3, replayOp, opScope, applyOp,
    syncThemeFromBlob, applyOp,
  };

  // ============ Backup blob sync + offline write queue ============
  // The user_backups.data blob is the sync unit. Downloaded on login, cached
  // in IndexedDB, edited locally, PUT back when online.

  async function getLocalBackup() {
    return MBDB.kvGet("backup").catch(() => null);
  }

  async function syncBackup() {
    // Download the latest blob from Supabase and cache it locally.
    if (!navigator.onLine) return { synced: false, offline: true };
    const { data, updated_at } = await SB.getBackup();
    if (!data) return { synced: false, empty: true };
    await MBDB.kvSet("backup", { data, updated_at, cachedAt: Date.now() });
    await MBDB.kvSet("backupUpdatedAt", updated_at);
    pushOfflineCopy().catch(() => {});
    return { synced: true, updated_at };
  }

  // Apply a single mutation op to a backup blob (pure function).
  function applyOp(backup, op) {
    if (!backup || !backup.data) return false;
    const data = backup.data;
    if (!Array.isArray(data.days)) data.days = [];
    const dayId = op.dayId;
    let day = data.days.find(d => d.id === dayId);
    if (!day && (op.type === "addTicket" || op.type === "addLine" || op.type === "setDayNote" || op.type === "pasteSalesReport")) {
      // Mirror AppStore.ensureDay: hours seeded from the schedule (0 = day
      // off), lunch by the break rules; the sanitizer fills date/note.
      day = { id: dayId, tickets: [], note: "" };
      data.days.push(day);
      data.days.sort((a, b) => a.id < b.id ? -1 : 1);
      try { if (typeof AppDataSanitizer !== "undefined") AppDataSanitizer.sanitize(data); } catch (e) {}
    }
    // A hand edit to the tickets invalidates the stored raw report (as on
    // the phone), so a future re-parse can never resurrect changed sales.
    if (day && ["addTicket", "addLine", "updateLine", "deleteLine", "deleteTicket", "clearDayTickets"].includes(op.type)) {
      delete day.rawReport;
      delete day.reportParseVersion;
    }
    // Ops that never touch a day must skip the day lookup below —
    // without a dayId the lookup finds nothing and the old early return
    // would silently kill them.
    const GLOBAL_OP_TYPES = new Set([
      "addShift", "updateShift", "deleteShift", "updateProfile",
      "updateContact", "addContact", "deleteContact",
      "addShiftNote", "deleteShiftNote",
      "addComparison", "updateComparison", "deleteComparison",
      "updateGoal", "addGoal", "deleteGoal",
      "setHolidayDates",
      "applyBrandCorrection", "skipBrandCorrection", "renameBrand",
    ]);
    const needsDay = !GLOBAL_OP_TYPES.has(op.type);
    if (needsDay) {
      if (!day) return false;
      if (!Array.isArray(day.tickets)) day.tickets = [];
    }

    switch (op.type) {
      case "addTicket": {
        const uid = (typeof AppDataSanitizer !== "undefined") ? AppDataSanitizer.uuid() : String(Date.now());
        day.tickets.push({
          id: op.ticket.id || (op.ticketId = op.ticketId || uid),
          time: op.ticket.time || (op.ticketTime = op.ticketTime || ((typeof SB !== "undefined") ? SB.isoSeconds(new Date()) : new Date().toISOString())),
          customerNote: op.ticket.customerNote || "",
          lines: (op.ticket.lines || []).map(normalizeLine),
        });
        return true;
      }
      case "addLine": {
        const t = day.tickets[op.ticketIndex];
        if (!t) return false;
        if (!Array.isArray(t.lines)) t.lines = [];
        t.lines.push(normalizeLine(op.line));
        return true;
      }
      case "updateLine": {
        const t = day.tickets[op.ticketIndex];
        if (!t || !Array.isArray(t.lines) || !t.lines[op.lineIndex]) return false;
        const prevId = t.lines[op.lineIndex].id;
        t.lines[op.lineIndex] = normalizeLine(op.line);
        if (prevId && !t.lines[op.lineIndex].id) t.lines[op.lineIndex].id = prevId;
        return true;
      }
      case "deleteLine": {
        const t = day.tickets[op.ticketIndex];
        if (!t || !Array.isArray(t.lines) || !t.lines[op.lineIndex]) return false;
        t.lines.splice(op.lineIndex, 1);
        return true;
      }
      case "setDayNote": {
        day.note = op.note || "";
        return true;
      }
      case "updateDay": {
        // Hours/lunch editor from Day Detail.
        Object.assign(day, op.updates || {});
        return true;
      }
      case "deleteTicket": {
        const t = day.tickets[op.ticketIndex];
        if (!t) return false;
        day.tickets.splice(op.ticketIndex, 1);
        return true;
      }
      case "clearDayTickets": {
        // "Delete all sales" — hours, lunch, and journal stay.
        day.tickets = [];
        return true;
      }
      case "addShift": {
        // Append a shift; keep the array sorted by start.
        if (!Array.isArray(data.shifts)) data.shifts = [];
        if (op.shift && op.shift.id) {
          if (!data.shifts.some(s => s.id === op.shift.id)) data.shifts.push(op.shift);
          data.shifts.sort((a, b) => new Date(a.start) - new Date(b.start));
        }
        return true;
      }
      case "updateShift": {
        // Find by id, shallow-merge updates. Caller sets isEdited:true on hand edits.
        if (!Array.isArray(data.shifts)) return true;
        const sh = data.shifts.find(s => s.id === op.shiftId);
        if (sh && op.updates) Object.assign(sh, op.updates);
        data.shifts.sort((a, b) => new Date(a.start) - new Date(b.start));
        return true;
      }
      case "deleteShift": {
        if (!Array.isArray(data.shifts)) return true;
        data.shifts = data.shifts.filter(s => s.id !== op.shiftId);
        return true;
      }
      case "updateProfile": {
        // Shallow-merge into data.profile (icsURL, reminders, lastSyncedAt, …).
        if (!data.profile) data.profile = {};
        const upd = Object.assign({}, op.updates || {});
        delete upd.themePreference; // the phone owns it
        Object.assign(data.profile, upd);
        return true;
      }
      case "setJournalEntry": {
        // journals: { "YYYY-MM-DD": { content, updatedAt } } or array
        if (!data.journals) data.journals = {};
        if (Array.isArray(data.journals)) {
          let entry = data.journals.find(j => (j.date || j.id) === op.date);
          if (!entry) { entry = { date: op.date, content: "" }; data.journals.push(entry); }
          entry.content = op.content || "";
          entry.updatedAt = new Date().toISOString();
        } else {
          const prev = data.journals[op.date];
          data.journals[op.date] = {
            ...(typeof prev === "object" && prev ? prev : {}),
            content: op.content || "",
            updatedAt: new Date().toISOString(),
          };
        }
        return true;
      }
      case "setJournalEntryFull": {
        // Writes the full JournalEntry object (not just content).
        if (!data.journals) data.journals = {};
        if (Array.isArray(data.journals)) {
          let e = data.journals.find(j => (j.dayKey || j.date) === op.date);
          if (!e) { e = { dayKey: op.date }; data.journals.push(e); }
          Object.assign(e, op.entry, { dayKey: op.date });
        } else {
          data.journals[op.date] = Object.assign({}, op.entry, { dayKey: op.date });
        }
        return true;
      }
      case "updateMomentOverride": {
        // Mirrors AppStore.updateMoment. Upserts a MomentOverride with locks.
        const findEntry = (d) => {
          if (!d.journals) return null;
          if (Array.isArray(d.journals)) return d.journals.find(j => (j.dayKey || j.date) === op.date);
          return d.journals[op.date];
        };
        const entry = findEntry(data);
        if (!entry || !entry.stories) return false;
        const story = entry.stories.find(s => s.id === op.storyID);
        if (!story) return false;
        if (!story.momentOverrides) story.momentOverrides = [];
        let ov = story.momentOverrides.find(o =>
          (o.momentID && o.momentID === op.momentID) ||
          (o.excerptKey && o.excerptKey === op.excerptKey));
        if (ov) {
          ov.momentID = op.momentID;
          if (op.interactionType) { ov.interactionType = op.interactionType; ov.typeLocked = true; }
          if (op.clearDirection) { ov.direction = null; ov.directionLocked = true; }
          else if (op.direction) { ov.direction = op.direction; ov.directionLocked = true; }
        } else {
          story.momentOverrides.push({
            momentID: op.momentID,
            excerptKey: op.excerptKey,
            interactionType: op.interactionType || null,
            direction: op.clearDirection ? null : (op.direction || null),
            typeLocked: !!op.interactionType,
            directionLocked: !!op.direction || op.clearDirection,
          });
        }
        if (!story.momentAnchors) story.momentAnchors = [];
        let anchor = story.momentAnchors.find(a => a.id === op.momentID);
        if (anchor) {
          anchor.excerpt = op.excerpt;
          if (!anchor.legacyKey) anchor.legacyKey = op.excerptKey;
        } else {
          story.momentAnchors.push({ id: op.momentID, excerpt: op.excerpt, legacyKey: op.excerptKey });
        }
        return true;
      }
      case "deleteJournalEntry": {
        if (!data.journals) return true;
        if (Array.isArray(data.journals)) {
          data.journals = data.journals.filter(j => (j.dayKey || j.date) !== op.date);
        } else {
          delete data.journals[op.date];
        }
        return true;
      }
      case "updateContact": {
        if (!Array.isArray(data.contacts)) return false;
        const c = data.contacts.find(x =>
          String(x.id || x.contactId || x.name) === String(op.contactId));
        if (!c) return false;
        Object.assign(c, op.updates || {});
        return true;
      }
      case "addContact": {
        if (!Array.isArray(data.contacts)) data.contacts = [];
        const contact = op.contact || {};
        if (!contact.id) contact.id = "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        if (!contact.createdAt) contact.createdAt = new Date().toISOString();
        data.contacts.push(contact);
        return true;
      }
      case "deleteContact": {
        if (!Array.isArray(data.contacts)) return false;
        const before = data.contacts.length;
        data.contacts = data.contacts.filter(x =>
          String(x.id || x.contactId || x.name) !== String(op.contactId));
        return data.contacts.length < before;
      }
      case "addShiftNote": {
        if (!Array.isArray(data.contacts)) return false;
        const c = data.contacts.find(x =>
          String(x.id || x.contactId || x.name) === String(op.contactId));
        if (!c) return false;
        if (!Array.isArray(c.shiftNotes)) c.shiftNotes = [];
        const note = op.note || {};
        if (!note.id) note.id = "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        c.shiftNotes.push(note);
        return true;
      }
      case "deleteShiftNote": {
        if (!Array.isArray(data.contacts)) return false;
        const c = data.contacts.find(x =>
          String(x.id || x.contactId || x.name) === String(op.contactId));
        if (!c || !Array.isArray(c.shiftNotes)) return false;
        c.shiftNotes = c.shiftNotes.filter(n => String(n.id) !== String(op.noteId));
        return true;
      }
      case "addComparison": {
        if (!Array.isArray(data.comparisons)) data.comparisons = [];
        const comp = op.comparison || {};
        if (!comp.id) comp.id = "cmp" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        data.comparisons.push(comp);
        return true;
      }
      case "updateComparison": {
        if (!Array.isArray(data.comparisons)) return false;
        const comp = data.comparisons.find(x => String(x.id) === String(op.comparisonId));
        if (!comp) return false;
        Object.assign(comp, op.updates || {});
        return true;
      }
      case "deleteComparison": {
        if (!Array.isArray(data.comparisons)) return false;
        data.comparisons = data.comparisons.filter(x => String(x.id) !== String(op.comparisonId));
        return true;
      }
      case "updateGoal": {
        if (!Array.isArray(data.goals)) return false;
        const g = data.goals.find(x =>
          String(x.id || x.goalId || x.title) === String(op.goalId));
        if (!g) return false;
        Object.assign(g, op.updates || {});
        return true;
      }
      case "addGoal": {
        // Port of AppStore.setGoal: deactivate all existing, insert new at 0.
        if (!Array.isArray(data.goals)) data.goals = [];
        const goal = op.goal || {};
        if (!goal.id) return false;
        for (const gg of data.goals) gg.isActive = false;
        data.goals.unshift({
          id: String(goal.id),
          metric: goal.metric || "revenue",
          period: goal.period || "day",
          target: Number(goal.target) || 0,
          createdAt: goal.createdAt || new Date().toISOString(),
          isActive: true,
        });
        return true;
      }
      case "deleteGoal": {
        if (!Array.isArray(data.goals)) return false;
        const before = data.goals.length;
        data.goals = data.goals.filter(gg =>
          String(gg.id || gg.goalId) !== String(op.goalId));
        return data.goals.length < before;
      }
      case "pasteSalesReport": {
        // Port of iOS PastedSaleApplier: replaces previously pasted tickets
        // for the day (no doubles), groups lines by transaction ID into
        // one ticket per customer, stores the raw report for re-parsing.
        // (day is guaranteed to exist: applyOp creates it for pasteSalesReport
        // via the addTicket/addLine/setDayNote path — but paste needs it too,
        // so ensure it here.)
        let pday = data.days.find(d => d.id === op.dayId);
        if (!pday) {
          pday = { id: op.dayId, tickets: [], note: "" };
          data.days.push(pday);
          data.days.sort((a, b) => a.id < b.id ? -1 : 1);
        }
        const day = pday;
        const TXN_RE = /^\d{2,4}-[A-Za-z]{2}-\d{4,}$/;
        day.tickets = (day.tickets || []).filter(t =>
          t.customerNote !== "Pasted from the system" && !TXN_RE.test(t.customerNote || ""));
        const order = [], buckets = {};
        for (const line of (op.lines || [])) {
          const key = line.transactionID || "";
          if (!(key in buckets)) { order.push(key); buckets[key] = []; }
          buckets[key].push(line);
        }
        const now = new Date();
        const isToday = op.dayId === iso(now);
        order.forEach((key, index) => {
          const group = buckets[key];
          const note = key === "" ? "Pasted from the system" : key;
          // Remembered brand corrections auto-fill blank brands on paste —
          // matches the iOS app, which applies them at paste time too.
          const corrections = (data.profile && data.profile.brandCorrections) || [];
          const lines = group.map(l => {
            let brand = (l.brand && String(l.brand).trim()) ? l.brand : "";
            if (!brand) {
              const pkey = String(l.product || "").replace(/^[ \t]+|[ \t]+$/g, "").toLowerCase();
              const corr = corrections.find(c => String(c.productKey || "").toLowerCase() === pkey);
              if (corr && corr.brand) brand = corr.brand;
            }
            return normalizeLine({
              product: l.product, brand,
              unitPrice: l.price, quantity: l.quantity,
              kind: l.kind || "inDepartment",
              isReturn: !!l.isReturn, sku: l.sku || null, isExchange: !!l.isExchange,
            });
          });
          // Same timestamps as PastedSaleApplier: today counts back a
          // minute per customer from now; other days start at noon.
          let time;
          if (isToday) {
            time = new Date(now.getTime() - index * 60000);
          } else {
            const d = new Date(op.dayId + "T12:00:00");
            time = new Date(d.getTime() + index * 60000);
          }
          day.tickets.push({
            id: AppDataSanitizer.uuid(),
            time: SB.isoSeconds(time), customerNote: note, lines,
          });
        });
        day.rawReport = op.rawReport || "";
        day.reportParseVersion = op.parseVersion || 1;
        return true;
      }
      case "applyBrandCorrection": {
        // Global. Brands every unlabeled line whose productKey matches,
        // across all days; remembers the fix at the front of
        // profile.brandCorrections; clears the skip. Blank brand = no-op.
        const key = String(op.productKey || "").toLowerCase();
        const brand = String(op.brand || "").trim();
        if (!key || !brand) return false;
        const trimWS = s => String(s == null ? "" : s).replace(/^[ \t]+|[ \t]+$/g, "");
        const pkey = name => trimWS(name).toLowerCase();
        let productName = "";
        for (const d of (data.days || [])) {
          let changed = false;
          for (const t of (d.tickets || [])) {
            for (const l of (t.lines || [])) {
              if (!trimWS(l.brand || "") && pkey(l.product) === key) {
                if (!productName) productName = String(l.product || "");
                l.brand = brand;
                changed = true;
              }
            }
          }
          if (changed) { d.rawReport = ""; delete d.reportParseVersion; }
        }
        if (!data.profile) data.profile = {};
        if (!Array.isArray(data.profile.brandCorrections)) data.profile.brandCorrections = [];
        data.profile.brandCorrections = data.profile.brandCorrections.filter(
          c => String(c.productKey || "").toLowerCase() !== key);
        data.profile.brandCorrections.unshift({
          productKey: key, product: productName || key, brand,
          correctedAt: new Date().toISOString(),
        });
        if (Array.isArray(data.profile.skippedBrandCorrections)) {
          data.profile.skippedBrandCorrections = data.profile.skippedBrandCorrections.filter(
            k => String(k).toLowerCase() !== key);
        }
        return true;
      }
      case "skipBrandCorrection": {
        // Global. Parks the productKey in skippedBrandCorrections ("don't know").
        const key = String(op.productKey || "").toLowerCase();
        if (!key) return false;
        if (!data.profile) data.profile = {};
        if (!Array.isArray(data.profile.skippedBrandCorrections)) data.profile.skippedBrandCorrections = [];
        if (!data.profile.skippedBrandCorrections.some(k => String(k).toLowerCase() === key)) {
          data.profile.skippedBrandCorrections.push(op.productKey);
        }
        return true;
      }
      case "renameBrand": {
        // Global. Case-insensitive rename of a brand across every history
        // line AND every saved BrandCorrection.
        const from = String(op.from || "").trim().toLowerCase();
        const to = String(op.to || "").trim();
        if (!from || !to || from === to.toLowerCase()) return false;
        const trimWS = s => String(s == null ? "" : s).replace(/^[ \t]+|[ \t]+$/g, "");
        for (const d of (data.days || [])) {
          let changed = false;
          for (const t of (d.tickets || [])) {
            for (const l of (t.lines || [])) {
              if (trimWS(l.brand || "").toLowerCase() === from) {
                l.brand = to;
                changed = true;
              }
            }
          }
          if (changed) { d.rawReport = ""; delete d.reportParseVersion; }
        }
        if (data.profile && Array.isArray(data.profile.brandCorrections)) {
          for (const c of data.profile.brandCorrections) {
            if (trimWS(c.brand || "").toLowerCase() === from) c.brand = to;
          }
        }
        return true;
      }
      case "setHolidayDates": {
        // iOS keeps holiday dates on AppData (top level), not on the profile.
        // Older dashboards wrote profile.holidayDates — drop that stray copy.
        data.holidayDates = Array.from(new Set((op.dates || []).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)))).sort();
        if (data.profile && "holidayDates" in data.profile) delete data.profile.holidayDates;
        return true;
      }
      default:
        return false;
    }
  }

  function normalizeLine(l) {
    return {
      ...(l.id ? { id: l.id } : {}),
      product: String(l.product || "Item"),
      brand: l.brand || "",
      ...(l.sku ? { sku: String(l.sku) } : {}),
      unitPrice: Number(l.unitPrice) || 0,
      quantity: Math.max(1, parseInt(l.quantity, 10) || 1),
      kind: l.kind || "inDepartment",
      isReturn: Boolean(l.isReturn || l.is_return),
      isExchange: Boolean(l.isExchange || l.is_exchange),
    };
  }


  // ---------- conflict resolution (optimistic concurrency) ----------
  // When you edit offline, we snapshot exactly what the target record looked
  // like *before* your edit. On replay, if the server's copy no longer
  // matches the snapshot, the phone (or another dashboard) changed it first —
  // the server wins and your stale edit is skipped. Each op is checked
  // independently, so unrelated edits always apply. No iOS changes needed:
  // the phone doesn't have to do anything differently.
  function stableStringify(v) {
    if (v === undefined) return "\u0000undefined";
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
    const keys = Object.keys(v).sort();
    return "{" + keys.map(k => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
  }
  function clone(o) {
    return o === undefined ? undefined : JSON.parse(JSON.stringify(o));
  }
  // ---- Conflict-safe replay (2.0.9) ----
  // Each queued op remembers the record it touches as it was BEFORE the edit
  // (base) and AFTER it (after). On reconnect the queue is replayed onto the
  // freshest blob:
  //  - record unchanged since base  -> the op is applied normally;
  //  - record changed on the phone  -> 3-way field merge: fields only the
  //    dashboard changed are kept, fields the phone changed win, arrays of
  //    records merge by id, a phone edit beats a dashboard delete, and a
  //    phone delete beats a dashboard edit. Any field we had to drop is
  //    reported ("changed on your phone").
  // Records are located by id (tickets by their UUID, not by position), so
  // tickets the phone inserted never shift an edit onto the wrong ticket.
  function deepEq(a, b) { return stableStringify(a) === stableStringify(b); }
  function isObj(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
  function keyOf(v) { return (isObj(v) && v.id != null) ? String(v.id) : null; }

  function merge3(base, mine, theirs, st) {
    if (deepEq(mine, theirs)) return clone(mine);
    if (deepEq(mine, base)) return clone(theirs);
    if (deepEq(theirs, base)) return clone(mine);
    // Both sides changed this value.
    if (isObj(base) && isObj(mine) && isObj(theirs)) {
      const out = {};
      const keys = new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)]);
      for (const k of keys) {
        const v = merge3(base[k], mine[k], theirs[k], st);
        if (v !== undefined) out[k] = v;
      }
      return out;
    }
    if (Array.isArray(base) && Array.isArray(mine) && Array.isArray(theirs)) {
      const all = [...base, ...mine, ...theirs];
      if (all.length && all.every(x => keyOf(x) !== null)) return mergeById(base, mine, theirs, st);
      if (all.every(x => x === null || typeof x !== "object")) {
        // Sets of primitives (e.g. holiday dates): apply our adds/removes.
        const out = theirs.filter(x => !(base.includes(x) && !mine.includes(x)));
        mine.forEach(x => { if (!base.includes(x) && !out.includes(x)) out.push(x); });
        return out;
      }
    }
    if (mine === undefined) { st.conflicts++; return clone(theirs); }   // we deleted, phone edited: keep phone
    if (theirs === undefined) { st.conflicts++; return undefined; }     // phone deleted, we edited: stays deleted
    st.conflicts++;
    return clone(theirs);                                                 // same field changed on both: phone wins
  }

  function mergeById(base, mine, theirs, st) {
    const idx = arr => { const m = new Map(); arr.forEach(x => m.set(keyOf(x), x)); return m; };
    const B = idx(base), M = idx(mine), T = idx(theirs);
    const out = [];
    for (const t of theirs) {
      const k = keyOf(t);
      if (B.has(k) && !M.has(k)) {             // we deleted it
        if (deepEq(t, B.get(k))) continue;     // phone didn't touch it: delete
        st.conflicts++; out.push(clone(t));    // phone edited after our delete: keep phone's
        continue;
      }
      out.push(M.has(k) ? merge3(B.get(k), M.get(k), t, st) : clone(t));
    }
    for (const m of mine) {
      const k = keyOf(m);
      if (T.has(k)) continue;
      if (!B.has(k)) out.push(clone(m));       // we added it
      else if (!deepEq(m, B.get(k))) st.conflicts++;  // phone deleted, we edited: stays deleted
    }
    return out.filter(x => x !== undefined);
  }

  // Locate the record an op mutates: {kind, id, get(), set(v)}; null for
  // pure appends (two appends never conflict).
  function opScope(data, op) {
    if (!data) return null;
    const days = () => (Array.isArray(data.days) ? data.days : (data.days = []));
    const findDay = () => days().find(d => d.id === op.dayId);
    const inArray = (arrName, pred, kind, id, parent) => ({
      kind, id,
      get: () => { const arr = (parent ? parent() : data) || {}; const a = arr[arrName]; return Array.isArray(a) ? a.find(pred) : undefined; },
      set: v => {
        const host = parent ? parent() : data;
        if (!host) return;
        if (!Array.isArray(host[arrName])) host[arrName] = [];
        const a = host[arrName], i = a.findIndex(pred);
        if (v === undefined) { if (i >= 0) a.splice(i, 1); }
        else if (i >= 0) a[i] = v; else a.push(v);
      },
    });
    const findJournalHost = () => data.journals;
    const journalPred = j => (j.dayKey || j.date || j.id) === op.date;
    const findContact = () => (Array.isArray(data.contacts) ? data.contacts.find(x =>
      String(x.id || x.contactId || x.name) === String(op.contactId)) : undefined);
    const prop = (key, kind) => ({ kind, id: key, get: () => data[key], set: v => { if (v === undefined) delete data[key]; else data[key] = v; } });
    switch (op.type) {
      case "addLine": case "updateLine": case "deleteLine": case "deleteTicket": {
        if (!op.ticketId) {
          const d = findDay();
          const t = d && Array.isArray(d.tickets) ? d.tickets[op.ticketIndex] : undefined;
          if (t && t.id) op.ticketId = String(t.id);
        }
        const tid = op.ticketId;
        return inArray("tickets", t => String(t.id) === String(tid), "ticket", op.dayId + "#" + tid, findDay);
      }
      case "updateDay": case "setDayNote": case "clearDayTickets":
        return inArray("days", d => d.id === op.dayId, "day", op.dayId);
      case "pasteSalesReport": {
        // Legacy snapshot check: only the pasted tickets are ours.
        const day = findDay();
        const TXN_RE = /^\d{2,4}-[A-Za-z]{2}-\d{4,}$/;
        const pasted = day && Array.isArray(day.tickets)
          ? day.tickets.filter(t => t.customerNote === "Pasted from the system" || TXN_RE.test(t.customerNote || ""))
          : undefined;
        const snap = pasted === undefined ? undefined : { tickets: pasted, rawReport: day.rawReport, reportParseVersion: day.reportParseVersion };
        return { kind: "day-pasted", id: op.dayId, legacy: true, get: () => snap, set: () => {} };
      }
      case "addTicket": case "addShift": case "addContact": case "addComparison":
        return null;
      case "setJournalEntry": case "setJournalEntryFull": case "deleteJournalEntry": {
        if (isObj(data.journals)) return { kind: "journal", id: op.date, get: () => data.journals[op.date],
          set: v => { if (v === undefined) delete data.journals[op.date]; else data.journals[op.date] = v; } };
        return inArray("journals", journalPred, "journal", op.date);
      }
      case "updateMomentOverride": {
        const entry = () => { const h = findJournalHost(); return Array.isArray(h) ? h.find(journalPred) : (h ? h[op.date] : undefined); };
        return inArray("stories", x => x.id === op.storyID, "story", op.date + "#" + op.storyID, entry);
      }
      case "updateShift": case "deleteShift":
        return inArray("shifts", x => x.id === op.shiftId, "shift", op.shiftId);
      case "updateContact": case "deleteContact": case "addShiftNote":
        return inArray("contacts", x => String(x.id || x.contactId || x.name) === String(op.contactId), "contact", op.contactId);
      case "deleteShiftNote":
        return inArray("shiftNotes", x => String(x.id) === String(op.noteId), "shiftnote", op.contactId + "#" + op.noteId, findContact);
      case "updateComparison": case "deleteComparison":
        return inArray("comparisons", x => String(x.id) === String(op.comparisonId), "comparison", op.comparisonId);
      case "updateGoal": case "deleteGoal":
        return inArray("goals", x => String(x.id || x.goalId || x.title) === String(op.goalId), "goal", op.goalId);
      case "addGoal":
        return prop("goals", "goals");
      case "setHolidayDates":
        return prop("holidayDates", "holidays");
      case "updateProfile":
        return prop("profile", "profile");
      case "applyBrandCorrection": case "skipBrandCorrection": case "renameBrand": {
        // Touches lines across many days: replayed as an operation (idempotent
        // rename), checked against the profile like before.
        const snap = clone(data.profile);
        return { kind: "profile-brand", id: "profile", legacy: true, get: () => snap, set: () => {} };
      }
      default:
        return null;
    }
  }

  /// Apply one queued op onto the fresh server blob. Returns
  /// {applied, conflicts, skipped}.
  function replayOp(backup, op) {
    const scope = op.base ? opScope(backup.data, op) : null;
    if (!op.base || !scope) return { applied: applyOp(backup, op), conflicts: 0 };
    if (scope.legacy || !op.base.v2) {
      // Old-format queue entries (pre-2.0.9) and multi-record ops: all or nothing.
      const fresh = stableStringify(clone(scope.get()));
      if (op.base.snap !== undefined && fresh !== op.base.snap) return { applied: false, skipped: true, conflicts: 1 };
      return { applied: applyOp(backup, op), conflicts: 0 };
    }
    const fresh = clone(scope.get());
    const baseObj = op.base.obj === null ? undefined : op.base.obj;
    const afterObj = op.base.after === null ? undefined : op.base.after;
    if (deepEq(fresh, baseObj)) {
      // Untouched on the phone: apply normally (keeps side effects), with
      // the ticket index re-pointed at the same ticket by id.
      if (op.ticketId) {
        const day = (backup.data.days || []).find(d => d.id === op.dayId);
        const i = day && Array.isArray(day.tickets) ? day.tickets.findIndex(t => String(t.id) === String(op.ticketId)) : -1;
        if (i >= 0) op.ticketIndex = i;
      }
      return { applied: applyOp(backup, op), conflicts: 0 };
    }
    const st = { conflicts: 0 };
    const merged = merge3(baseObj, afterObj, fresh, st);
    scope.set(merged === undefined ? undefined : merged);
    return { applied: true, conflicts: st.conflicts };
  }

  function notifySkipped(skipped) {
    try {
      console.warn("[sync] skipped stale offline edits (server version is newer):", skipped);
      let el = document.getElementById("sync-conflict-note");
      if (!el) {
        el = document.createElement("div");
        el.id = "sync-conflict-note";
        el.style.cssText = "position:fixed;bottom:18px;left:50%;transform:translateX(-50%);z-index:9999;" +
          "padding:10px 18px;border-radius:10px;font-size:14px;color:#fff;background:rgba(20,20,22,.92);" +
          "box-shadow:0 4px 18px rgba(0,0,0,.3);max-width:90vw;text-align:center;";
        document.body.appendChild(el);
      }
      el.textContent = "Some offline changes were skipped because they were changed on your phone.";
      el.style.display = "block";
      clearTimeout(notifySkipped._t);
      notifySkipped._t = setTimeout(() => { el.style.display = "none"; }, 7000);
    } catch (e) {}
  }

  // Queue a write: apply to the local blob immediately (optimistic UI),
  // store the op for later sync, and push now if online.
  async function queueWrite(op) {
    let backup = await getLocalBackup();
    if (!backup) {
      // No local copy yet — pull it first.
      await syncBackup();
      backup = await getLocalBackup();
    }
    if (!backup || !backup.data) throw new Error("No backup data — sync first.");
    // Conflict snapshot: remember exactly what the target looked like before
    // our edit, so replay can tell whether the phone changed it first.
    // Pure appends (new tickets, shifts, contacts...) carry no snapshot —
    // two appends never conflict.
    op.ts = Date.now();
    let scope = null;
    try {
      scope = opScope(backup.data, op);
      if (scope) {
        const before = clone(scope.get());
        op.base = { kind: scope.kind, id: scope.id, snap: stableStringify(before) };
        if (!scope.legacy) { op.base.v2 = true; op.base.obj = before === undefined ? null : before; }
      }
    } catch (e) { scope = null; /* snapshot failure must never block the edit */ }
    if (!applyOp(backup, op)) throw new Error("Couldn't apply that change.");
    try {
      if (scope && op.base && "obj" in op.base) {
        const after = clone(opScope(backup.data, op).get());
        op.base.after = after === undefined ? null : after;
      }
    } catch (e) { if (op.base) { delete op.base.obj; delete op.base.v2; } }
    backup.cachedAt = Date.now();
    backup.dirty = true;
    await MBDB.kvSet("backup", backup);
    await MBDB.queueWrite(op);
    // Try to push immediately if we're online.
    if (navigator.onLine) {
      processWriteQueue()
        .then(res => { if (res && res.skipped && res.skipped.length) notifySkipped(res.skipped); })
        .catch(e => console.warn("write sync failed:", e.message));
    }
    return true;
  }

  // Push all queued ops: fetch the newest blob, rebase every queued op onto
  // it (replayOp), then write with optimistic concurrency (only if nobody
  // wrote since our fetch). A race -> refetch, rebase again (up to 5 tries).
  var pushing = null;
  async function processWriteQueue() {
    if (pushing) return pushing;
    pushing = (async () => {
      if (!navigator.onLine) return { pushed: 0, offline: true };
      const queued = await MBDB.getWriteQueue().catch(() => []);
      if (!queued.length) return { pushed: 0 };
      let lastErr = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        const { data, updated_at } = await SB.getBackup();
        if (!data && updated_at === null && attempt === 0 && !queued.length) return { pushed: 0 };
        const backup = { data: data || {}, updated_at, cachedAt: Date.now() };
        const skipped = [];
        for (const q of queued) {
          // Queue entries keep JSON-safe base snapshots; undefined came back as absent.
          const op = clone(q.op || {});
          let r;
          try { r = replayOp(backup, op); } catch (e) { r = { applied: false, conflicts: 1, skipped: true }; }
          if (r.conflicts) skipped.push({ type: op.type, id: (op.base && op.base.id) || "", ts: op.ts || q.ts || 0, partial: !r.skipped });
        }
        // themePreference is phone-owned: always write back exactly what the
        // server copy has, whatever the merge did.
        if (backup.data.profile) {
          const ph = data && data.profile ? data.profile.themePreference : undefined;
          if (ph === undefined) delete backup.data.profile.themePreference;
          else backup.data.profile.themePreference = ph;
        }
        try {
          const savedAt = await SB.saveBackup(backup.data, updated_at === undefined ? null : updated_at);
          await MBDB.clearWriteQueue(queued.map(q => q.id));
          backup.updated_at = savedAt;
          backup.dirty = false;
          await MBDB.kvSet("backup", backup);
          await MBDB.kvSet("backupUpdatedAt", savedAt);
          pushOfflineCopy(backup).catch(() => {});
          try { window.dispatchEvent(new CustomEvent("mb:data-changed")); } catch (e) {}
          return { pushed: queued.length, skipped, attempts: attempt + 1 };
        } catch (e) {
          if (e && e.conflict) { lastErr = e; await new Promise(r => setTimeout(r, 150 * (attempt + 1))); continue; }
          throw e;
        }
      }
      throw lastErr || new Error("Couldn't save — the backup kept changing. Will retry.");
    })();
    try { return await pushing; } finally { pushing = null; }
  }

  // ---- Server-side offline copy (per user, on this dashboard's server) ----
  var lastCopyKey = null;
  async function pushOfflineCopy(backup) {
    backup = backup || await getLocalBackup();
    if (!backup || !backup.data) return;
    let profile = null;
    try { profile = await MBDB.kvGet("profileRow"); } catch (e) {}
    const key = String(backup.updated_at) + "|" + (profile ? stableStringify(profile).length : 0);
    if (key === lastCopyKey) return;
    const res = await fetch("/api/offline-copy", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backup: { data: backup.data, updated_at: backup.updated_at }, profile }) });
    if (res.ok) lastCopyKey = key;
  }
  /// New browser, or Supabase unreachable: seed from this user's server copy.
  async function seedFromServerCopy(opts) {
    const have = await getLocalBackup();
    if (have && have.data && !(opts && opts.force)) return false;
    try {
      const res = await fetch("/api/offline-copy", { cache: "no-store" });
      if (!res.ok) return false;
      const copy = await res.json();
      if (!copy || !copy.backup || !copy.backup.data) return false;
      await MBDB.kvSet("backup", { data: copy.backup.data, updated_at: copy.backup.updated_at, cachedAt: Date.now(), fromServerCopy: true });
      await MBDB.kvSet("backupUpdatedAt", copy.backup.updated_at);
      if (copy.profile) { try { await MBDB.kvSet("profileRow", copy.profile); } catch (e) {} }
      await MBDB.kvSet("fullSyncDone", true);
      return true;
    } catch (e) { return false; }
  }

})();
