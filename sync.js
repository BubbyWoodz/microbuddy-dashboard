"use strict";
/* ============ sync.js — offline-first sync engine for Micro Buddy PWA ============
 * Strategy:
 *  - First login  -> fullSync(): downloads ALL days, every day's detail,
 *                    stats, pay and schedule into IndexedDB.
 *  - Later opens  -> incrementalSync(): re-fetches the canonical paths to
 *                    refresh anything that changed (cheap, idempotent).
 *  - Every api() call also caches its response, and falls back to cache
 *    when the network is unavailable.
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

  function updateOnlineBadge() {
    if (!statusEl) return;
    const online = navigator.onLine;
    statusEl.className = "pill " + (online ? "live" : "offline-pill");
    statusEl.textContent = syncing ? "Syncing…" : (online ? "● Online" : "● Offline");
  }

  function setSyncing(v, label) {
    syncing = v;
    if (statusEl) {
      statusEl.className = "pill " + (v ? "syncing-pill" : (navigator.onLine ? "live" : "offline-pill"));
      statusEl.textContent = v ? (label || "Syncing…") : (navigator.onLine ? "● Online" : "● Offline");
    }
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

  // ---- canonical sync paths ----
  function canonicalPaths() {
    const t = todayISO();
    return [
      { path: "/api/days?start=" + WIDE_START + "&end=" + t + "&limit=" + DAY_LIMIT, kind: "days" },
      { path: "/api/day-summary?date=" + t, kind: "today" },
      { path: "/api/stats?start=" + firstOfMonthISO() + "&end=" + t, kind: "stats-mtd" },
      { path: "/api/stats?start=" + firstOfYearISO() + "&end=" + t, kind: "stats-ytd" },
      { path: "/api/take-home?start=" + firstOfMonthISO() + "&end=" + t, kind: "pay-mtd" },
      { path: "/api/schedule?start=" + t + "&end=" + daysAheadISO(60), kind: "schedule" },
    ];
  }

  async function fetchAndCache(path, kind) {
    const data = await netGet(path);
    await MBDB.putCache(path, data, kind).catch(() => {});
    return data;
  }

  // Fetch every day's summary + tickets. Bounded concurrency, gentle pacing.
  async function syncDayDetails(dates, onProgress) {
    let done = 0;
    const queue = dates.slice();
    async function worker() {
      while (queue.length) {
        const date = queue.shift();
        try {
          await fetchAndCache("/api/day-summary?date=" + date, "day-summary");
          await fetchAndCache("/api/day-sales?date=" + date, "day-sales");
        } catch (e) {
          // Keep going — a single bad day shouldn't kill the sync.
          console.warn("sync: day failed", date, e.message);
        }
        done++;
        if (onProgress) onProgress(done, dates.length);
        await new Promise(r => setTimeout(r, STAGGER_MS));
      }
    }
    const workers = [];
    for (let i = 0; i < Math.min(CONCURRENCY, dates.length); i++) workers.push(worker());
    await Promise.all(workers);
  }

  async function fullSync(onProgress) {
    if (syncing) return;
    if (!navigator.onLine) throw new Error("Can't do the first sync offline — connect to Wi-Fi.");
    setSyncing(true, "Downloading all data…");
    try {
      const paths = canonicalPaths();
      let step = 0;
      for (const p of paths) {
        step++;
        setSyncing(true, "Syncing (" + step + "/" + paths.length + ")…");
        if (onProgress) onProgress("fetch", step, paths.length);
        await fetchAndCache(p.path, p.kind);
      }
      // Expand per-day details from the days list we just cached.
      const daysEntry = await MBDB.getCache(paths[0].path);
      const days = ((daysEntry && daysEntry.data && daysEntry.data.days) || [])
        .map(d => d.date).filter(Boolean).sort();
      setSyncing(true, "Syncing day details (0/" + days.length + ")…");
      await syncDayDetails(days, (done, total) =>
        setSyncing(true, "Syncing day details (" + done + "/" + total + ")…"));
      await MBDB.kvSet("lastSync", Date.now());
      await MBDB.kvSet("fullSyncDone", true);
      await refreshLastSyncLabel();
    } finally {
      setSyncing(false);
      refreshLastSyncLabel();
    }
  }

  async function incrementalSync() {
    if (syncing || !navigator.onLine) return;
    const last = await MBDB.kvGet("lastSync").catch(() => 0);
    // Don't re-sync more often than every 15 minutes unless forced.
    if (last && Date.now() - last < 15 * 60 * 1000) return;
    setSyncing(true);
    try {
      const paths = canonicalPaths();
      for (const p of paths) {
        try { await fetchAndCache(p.path, p.kind); }
        catch (e) { console.warn("incremental sync: path failed", p.path, e.message); }
      }
      // Refresh details for the most recent 14 days (covers new entries/edits).
      const t = todayISO();
      const recent = [];
      for (let i = 0; i < 14; i++) {
        const d = new Date(); d.setDate(d.getDate() - i);
        recent.push(iso(d));
      }
      await syncDayDetails(recent, null);
      await MBDB.kvSet("lastSync", Date.now());
      await refreshLastSyncLabel();
    } finally {
      setSyncing(false);
      refreshLastSyncLabel();
    }
  }

  async function needsFullSync() {
    const done = await MBDB.kvGet("fullSyncDone").catch(() => false);
    return !done;
  }

  // ---- preferences sync (theme only — AI config is server-only) ----
  // Called right after Apple sign-in, before the data sync. The server
  // prefers the shared iPhone theme (Supabase user_preferences) when it's
  // reachable; otherwise it returns the dashboard's locally saved theme.
  // The winning theme is applied immediately and cached for offline use.
  async function syncPreferences() {
    let theme = "dark";
    if (navigator.onLine) {
      try {
        const res = await fetch("/api/preferences");
        if (res.status === 401) {
          const err = new Error("Not signed in");
          err.isAuth = true;
          throw err;
        }
        if (res.ok) {
          const prefs = await res.json();
          if (prefs && typeof prefs.theme === "string") theme = prefs.theme;
          // Cache ONLY the theme. ai_config must never touch the device.
          await MBDB.kvSet("theme", theme).catch(() => {});
        }
      } catch (e) {
        if (e && e.isAuth) throw e;
        // Offline / error: fall back to the locally cached theme.
        const cached = await MBDB.kvGet("theme").catch(() => null);
        if (cached) theme = cached;
      }
    } else {
      const cached = await MBDB.kvGet("theme").catch(() => null);
      if (cached) theme = cached;
    }
    applyTheme(theme);
    return theme;
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
    const meta = document.querySelector('meta[name="theme-color"]');
    const colors = { dark: "#0d1017", light: "#f4f5f7", win95: "#008080", modern: "#1e6f9f", terminal: "#000000", auto: "#0d1017" };
    if (meta) meta.setAttribute("content", colors[applied] || colors.dark);
    return t; // return the preference (auto stays auto), not the resolved theme
  }

  // Push a theme change: apply instantly, cache locally, sync to the blob
  // (two-way with the app) via the setThemePreference op.
  async function setTheme(theme) {
    const t = applyTheme(theme);
    MBDB.kvSet("theme", t).catch(() => {});
    try {
      await queueWrite({ type: "setThemePreference", theme: t });
    } catch (e) {
      console.warn("sync: couldn't save theme to blob:", e.message);
    }
    return t;
  }

  // Read the theme from the blob (set by the app or another dashboard).
  async function syncThemeFromBlob() {
    try {
      const backup = await getLocalBackup();
      const theme = backup && backup.data &&
        (backup.data.themePreference || (backup.data.profile || {}).themePreference);
      if (theme) {
        const current = document.documentElement.getAttribute("data-theme");
        // Only apply if different to avoid flicker.
        const valid = ["auto", "light", "dark", "terminal", "modern", "win95"];
        if (valid.includes(theme)) {
          applyTheme(theme);
          MBDB.kvSet("theme", theme).catch(() => {});
        }
      }
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
    syncPreferences, applyTheme, setTheme, syncChat,
    syncBackup, queueWrite, processWriteQueue, getLocalBackup,
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
      day = { id: dayId, tickets: [] };
      data.days.push(day);
      data.days.sort((a, b) => a.id < b.id ? -1 : 1);
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
      "setThemePreference",
      "applyBrandCorrection", "skipBrandCorrection", "renameBrand",
    ]);
    const needsDay = !GLOBAL_OP_TYPES.has(op.type);
    if (needsDay) {
      if (!day) return false;
      if (!Array.isArray(day.tickets)) day.tickets = [];
    }

    switch (op.type) {
      case "addTicket": {
        day.tickets.push({
          time: op.ticket.time || "",
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
        t.lines[op.lineIndex] = normalizeLine(op.line);
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
        // Shallow-merge into data.profile (icsURL, reminders, holidayDates, lastSyncedAt, …).
        if (!data.profile) data.profile = {};
        Object.assign(data.profile, op.updates || {});
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
          pday = { id: op.dayId, tickets: [] };
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
        const isToday = op.dayId === now.toISOString().slice(0, 10);
        order.forEach((key, index) => {
          const group = buckets[key];
          const note = key === "" ? "Pasted from the system" : key;
          // NOTE: blank brands stay blank here — matches the iOS app, which
          // does not auto-apply remembered brand corrections at paste time.
          const lines = group.map(l => {
            const brand = (l.brand && String(l.brand).trim()) ? l.brand : "";
            return normalizeLine({
              product: l.product, brand,
              unitPrice: l.price, quantity: l.quantity,
              kind: l.kind || "inDepartment",
              isReturn: !!l.isReturn, sku: l.sku || null, isExchange: !!l.isExchange,
            });
          });
          let time;
          if (isToday) {
            time = new Date(now.getTime() - index * 60000).toISOString();
          } else {
            const d = new Date(op.dayId + "T12:00:00");
            time = new Date(d.getTime() + index * 60000).toISOString();
          }
          day.tickets.push({
            id: "ticket-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
            time, customerNote: note, lines,
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
      case "setThemePreference": {
        // Two-way theme sync: stored in the blob so the app and dashboard
        // stay on the same theme. Valid: auto, light, dark, terminal, modern, win95.
        const valid = ["auto", "light", "dark", "terminal", "modern", "win95"];
        const theme = valid.includes(op.theme) ? op.theme : "auto";
        if (!data.profile) data.profile = {};
        data.profile.themePreference = theme;
        // Also at top level for easy access.
        data.themePreference = theme;
        return true;
      }
      default:
        return false;
    }
  }

  function normalizeLine(l) {
    return {
      product: String(l.product || "Item"),
      brand: l.brand || "",
      sku: l.sku || "",
      unitPrice: Number(l.unitPrice) || 0,
      quantity: Math.max(1, parseInt(l.quantity, 10) || 1),
      kind: l.kind || "inDepartment",
      isReturn: Boolean(l.isReturn || l.is_return),
      isExchange: Boolean(l.isExchange || l.is_exchange),
    };
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
    if (!applyOp(backup, op)) throw new Error("Couldn't apply that change.");
    backup.cachedAt = Date.now();
    backup.dirty = true;
    await MBDB.kvSet("backup", backup);
    await MBDB.queueWrite(op);
    // Try to push immediately if we're online.
    if (navigator.onLine) {
      processWriteQueue().catch(e => console.warn("write sync failed:", e.message));
    }
    return true;
  }

  // Push all queued ops to Supabase: re-read the server blob, apply our ops
  // in order (ours win on the fields we touched), PUT it back.
  async function processWriteQueue() {
    if (!navigator.onLine) return { pushed: 0, offline: true };
    const queued = await MBDB.getWriteQueue().catch(() => []);
    if (!queued.length) return { pushed: 0 };
    const { data, updated_at } = await SB.getBackup();
    if (!data) throw new Error("No backup on server.");
    const backup = { data, updated_at, cachedAt: Date.now() };
    const appliedIds = [];
    for (const q of queued) {
      if (applyOp(backup, q.op)) appliedIds.push(q.id);
    }
    if (appliedIds.length) {
      await SB.saveBackup(backup.data);
      await MBDB.clearWriteQueue(appliedIds);
      backup.dirty = false;
      await MBDB.kvSet("backup", backup);
    }
    return { pushed: appliedIds.length };
  }

  // Export the public API.
  return {
    bindUI,
    fetchCached,
    syncPreferences,
    applyTheme,
    setTheme,
    syncThemeFromBlob,
    syncChat,
    getLocalBackup,
    syncBackup,
    queueWrite,
    applyOp,
    processWriteQueue,
  };
})();
