"use strict";
/* ============ sb.js — direct Supabase client for the Micro Buddy dashboard ============
 * The browser is a full Supabase client, just like the phone app. The QR
 * pairing hands over the user's Supabase session (access_token +
 * refresh_token), stored in localStorage. All reads/writes go through the
 * same RLS rules as the phone.
 *
 *  - user_backups.data  the AppData blob (days, shifts, goals, profile...).
 *                        Downloaded on login, cached in IndexedDB, edited
 *                        locally, written back when online.
 *  - profiles           the account row the phone shows: username,
 *                        first/last name, buddy name and profile_photo
 *                        (a base64 data URL). SB.getProfile() / updateProfile().
 *
 * Everything written back is first passed through AppDataSanitizer so the
 * phone can always decode it (Swift's .iso8601 date strategy rejects
 * fractional seconds, and WorkDay / SaleTicket have required keys).
 */
const SB = (() => {
  let SUPABASE_URL = "https://tgarraczeevyrjfxzkkf.supabase.co";
  let ANON_KEY = null; // fetched from /api/config (public)

  const LS_KEY = "mb_supabase_session";
  const PROFILE_KV = "profileRow";

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

  // JWT payloads are base64url — plain atob() chokes on "-" / "_", which made
  // every call look "expired" and refresh (racing the rotating refresh token).
  function jwtPayload(token) {
    try {
      let b = String(token).split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      while (b.length % 4) b += "=";
      return JSON.parse(atob(b));
    } catch (e) { return null; }
  }

  function isExpired(session) {
    if (!session || !session.access_token) return true;
    const p = jwtPayload(session.access_token);
    if (!p || !p.exp) return true;
    return (p.exp * 1000) < (Date.now() + 60000); // refresh 60s early
  }

  function userIdOf(session) {
    if (session && session.user_id) return session.user_id;
    const p = session && jwtPayload(session.access_token);
    return (p && p.sub) || "";
  }

  // One refresh at a time: Supabase rotates refresh tokens, so two parallel
  // refreshes with the same token would sign the dashboard out.
  let refreshing = null;
  function refreshSession(session) {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const res = await fetch(SUPABASE_URL + "/auth/v1/token?grant_type=refresh_token", {
        method: "POST",
        headers: { "apikey": ANON_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: session.refresh_token }),
      });
      if (!res.ok) {
        // Another tab may have rotated it already — use theirs if it's fresh.
        const latest = getSession();
        if (latest && latest.refresh_token !== session.refresh_token && !isExpired(latest)) return latest;
        const err = new Error("Session expired — please re-pair.");
        err.isAuth = true;
        throw err;
      }
      const data = await res.json();
      const next = {
        user_id: userIdOf(session) || (data.user && data.user.id) || "",
        email: session.email || (data.user && data.user.email) || "",
        access_token: data.access_token,
        refresh_token: data.refresh_token || session.refresh_token,
      };
      setSession(next);
      return next;
    })();
    return refreshing.finally(() => { refreshing = null; });
  }

  async function getValidSession() {
    await config();
    let session = getSession();
    if (!session) {
      const err = new Error("Not paired — scan the QR code.");
      err.isAuth = true;
      throw err;
    }
    if (isExpired(session)) session = await refreshSession(session);
    if (!session.user_id) session.user_id = userIdOf(session);
    return session;
  }

  async function rawRest(method, path, body, session, prefer) {
    return fetch(SUPABASE_URL + "/rest/v1/" + path, {
      method,
      headers: {
        "apikey": ANON_KEY,
        "Authorization": "Bearer " + session.access_token,
        "Content-Type": "application/json",
        "Prefer": prefer || "return=representation",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  async function rest(method, path, body, session, prefer) {
    session = session || await getValidSession();
    let res = await rawRest(method, path, body, session, prefer);
    if (res.status === 401) {
      // Token might have expired mid-flight — refresh once and retry.
      session = await refreshSession(session);
      res = await rawRest(method, path, body, session, prefer);
      if (res.status === 401) {
        const err = new Error("Session expired — please re-pair.");
        err.isAuth = true;
        throw err;
      }
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      const err = new Error("Supabase " + res.status + (detail ? ": " + detail : ""));
      err.status = res.status;
      throw err;
    }
    const text = (await res.text()).trim();
    return text ? JSON.parse(text) : null;
  }

  // Second-precision ISO-8601 ("2026-10-09T19:00:00Z"). The phone parses
  // updated_at and every date in the blob with ISO8601DateFormatter /
  // .iso8601, which return nil on fractional seconds.
  function isoSeconds(d) {
    return (d || new Date()).toISOString().replace(/\.\d+Z$/, "Z");
  }

  // ---- backup blob ----

  async function getBackup() {
    const session = await getValidSession();
    const rows = await rest("GET",
      "user_backups?user_id=eq." + encodeURIComponent(session.user_id) +
      "&select=data,updated_at&order=updated_at.desc&limit=1", undefined, session);
    if (!rows || !rows.length) return { data: null, updated_at: null, session };
    return { data: rows[0].data || {}, updated_at: rows[0].updated_at, session };
  }

  async function saveBackup(data) {
    const session = await getValidSession();
    const now = isoSeconds();
    if (typeof AppDataSanitizer !== "undefined") AppDataSanitizer.sanitize(data);
    const updated = await rest("PATCH",
      "user_backups?user_id=eq." + encodeURIComponent(session.user_id),
      { data, updated_at: now }, session);
    if (!updated || !updated.length) {
      await rest("POST", "user_backups",
        { user_id: session.user_id, data, updated_at: now }, session);
    }
    return now;
  }

  // ---- account profile (public.profiles) ----

  /// The phone stores profile_photo as a data URL, but decodes it by taking
  /// whatever follows the last comma — so tolerate a bare base64 string too.
  function photoURL(raw) {
    const s = String(raw || "").trim();
    if (!s) return "";
    if (/^data:image\//i.test(s)) return s;
    if (/^https?:\/\//i.test(s)) return s;
    const b64 = s.includes(",") ? s.slice(s.lastIndexOf(",") + 1) : s;
    if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) return "";
    const mime = b64.startsWith("iVBOR") ? "image/png" : "image/jpeg";
    return "data:" + mime + ";base64," + b64.replace(/\s+/g, "");
  }

  function normalizeProfile(row) {
    if (!row) return null;
    const first = String(row.first_name || "").trim();
    const last = String(row.last_name || "").trim();
    const full = [first, last].filter(Boolean).join(" ");
    const initials = ((first[0] || "") + (last[0] || "")).toUpperCase() ||
      String(row.username || "").slice(0, 2).toUpperCase();
    return {
      id: row.id,
      username: String(row.username || ""),
      firstName: first,
      lastName: last,
      fullName: full,
      buddyName: String(row.buddy_name || "").trim(),
      photo: photoURL(row.profile_photo),
      rawPhoto: row.profile_photo || null,
      initials,
    };
  }

  let profileMem = null;

  /// The signed-in user's profile row (cached in IndexedDB for offline).
  /// opts.force skips the in-memory copy.
  async function getProfile(opts) {
    opts = opts || {};
    if (profileMem && !opts.force) return profileMem;
    if (navigator.onLine) {
      try {
        const session = await getValidSession();
        const rows = await rest("GET",
          "profiles?id=eq." + encodeURIComponent(session.user_id) +
          "&select=id,username,first_name,last_name,buddy_name,profile_photo",
          undefined, session);
        const row = rows && rows[0];
        if (row) {
          try { await MBDB.kvSet(PROFILE_KV, row); } catch (e) {}
          profileMem = normalizeProfile(row);
          notify();
          return profileMem;
        }
      } catch (e) {
        if (e && e.isAuth) throw e;
        /* fall back to the cached row */
      }
    }
    try {
      const cached = await MBDB.kvGet(PROFILE_KV);
      if (cached) { profileMem = normalizeProfile(cached); return profileMem; }
    } catch (e) {}
    return null;
  }

  function cachedProfile() { return profileMem; }

  /// PATCH the profile row. Usernames are stored lowercase and the unique
  /// index is the availability check: HTTP 409 -> err.code = "taken".
  async function updateProfile(fields) {
    const session = await getValidSession();
    const body = {};
    if (fields.username != null) body.username = String(fields.username).trim().replace(/^@/, "").toLowerCase();
    if (fields.firstName != null) body.first_name = String(fields.firstName).trim();
    if (fields.lastName != null) body.last_name = String(fields.lastName).trim();
    if (fields.buddyName != null) body.buddy_name = String(fields.buddyName).trim();
    if (fields.profilePhoto !== undefined) body.profile_photo = fields.profilePhoto;
    if (body.username != null && !/^[a-z0-9_.]{3,20}$/.test(body.username)) {
      const err = new Error("Usernames are 3–20 letters, numbers, dots or underscores.");
      err.code = "invalid";
      throw err;
    }
    let rows;
    try {
      rows = await rest("PATCH",
        "profiles?id=eq." + encodeURIComponent(session.user_id) + "&select=*", body, session);
    } catch (e) {
      if (e.status === 409) {
        const err = new Error("That username is taken.");
        err.code = "taken";
        throw err;
      }
      throw e;
    }
    const row = rows && rows[0];
    if (row) {
      try { await MBDB.kvSet(PROFILE_KV, row); } catch (e) {}
      profileMem = normalizeProfile(row);
      notify();
    }
    return profileMem;
  }

  // Listeners re-render avatars/greetings when the profile changes.
  const listeners = new Set();
  function onProfile(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function notify() { listeners.forEach(fn => { try { fn(profileMem); } catch (e) {} }); }

  function clearProfileCache() { profileMem = null; }

  return {
    getSession, setSession, getValidSession, rest, getBackup, saveBackup,
    getProfile, cachedProfile, updateProfile, onProfile, photoURL, clearProfileCache,
    isoSeconds, get SUPABASE_URL() { return SUPABASE_URL; },
  };
})();

/* ============ AppDataSanitizer ============
 * Makes the blob decodable by the iPhone app before it is written back:
 *  - every ISO date loses fractional seconds (Swift .iso8601 rejects them);
 *  - WorkDay gets its required keys (date, tickets, scheduledHours,
 *    lunchMinutes, note) — a day first created on the dashboard used to be
 *    just {id, tickets}, which made the phone's restore fail outright;
 *  - SaleTicket gets an id (UUID) and a real time; SaleLine gets a valid kind.
 */
const AppDataSanitizer = (() => {
  const FRAC_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.\d+(Z|[+-]\d{2}:?\d{2})$/;
  const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:?\d{2})$/;
  const KINDS = new Set(["inDepartment", "outOfDepartment", "servicePlan"]);
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function uuid() {
    const b = new Uint8Array(16);
    (self.crypto || window.crypto).getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map(x => x.toString(16).padStart(2, "0")).join("");
    return (h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" +
      h.slice(16, 20) + "-" + h.slice(20)).toUpperCase();
  }

  function stripFractions(v) {
    if (typeof v === "string") {
      const m = FRAC_RE.exec(v);
      return m ? m[1] + m[2] : v;
    }
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = stripFractions(v[i]); return v; }
    if (v && typeof v === "object") { for (const k of Object.keys(v)) v[k] = stripFractions(v[k]); return v; }
    return v;
  }

  // Minutes east of UTC for an IANA zone at an instant.
  function tzOffsetMin(tz, ms) {
    try {
      const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23",
        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const p = {};
      f.formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; });
      const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
      return Math.round((asUTC - ms) / 60000);
    } catch (e) { return -new Date(ms).getTimezoneOffset(); }
  }

  /// Local wall-clock time on a day key in the user's zone, as ISO (seconds).
  function zonedISO(key, tz, hour, minute) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(key || "");
    if (!m) return SB.isoSeconds(new Date());
    const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], hour || 0, minute || 0);
    let off = tzOffsetMin(tz, guess);
    let ms = guess - off * 60000;
    const off2 = tzOffsetMin(tz, ms);
    if (off2 !== off) ms = guess - off2 * 60000;
    return SB.isoSeconds(new Date(ms));
  }

  function validISO(v) { return typeof v === "string" && ISO_RE.test(v); }

  function shiftHoursOn(data, key, tz) {
    let h = 0;
    for (const s of (data.shifts || [])) {
      const start = Date.parse(s.start), end = Date.parse(s.end);
      if (isNaN(start) || isNaN(end)) continue;
      const k = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
        .format(new Date(start));
      if (k === key) h += Math.max(0, (end - start) / 3600000);
    }
    return h;
  }

  function sanitize(data) {
    if (!data || typeof data !== "object") return data;
    stripFractions(data);
    const tz = data.timeZoneIdentifier ||
      (Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Los_Angeles");
    if (Array.isArray(data.days)) {
      for (const day of data.days) {
        if (!day || typeof day !== "object") continue;
        day.id = String(day.id || "");
        if (!validISO(day.date)) day.date = zonedISO(day.id, tz, 0, 0);
        if (!Array.isArray(day.tickets)) day.tickets = [];
        if (typeof day.scheduledHours !== "number" || isNaN(day.scheduledHours)) {
          day.scheduledHours = shiftHoursOn(data, day.id, tz);
        }
        if (typeof day.lunchMinutes !== "number" || isNaN(day.lunchMinutes)) {
          const h = day.scheduledHours;
          day.lunchMinutes = h < 5 ? 0 : (h >= 11 ? 90 : 60);
        }
        day.lunchMinutes = Math.round(day.lunchMinutes);
        if (typeof day.note !== "string") day.note = day.note == null ? "" : String(day.note);
        ["lunchStart", "secondLunchStart"].forEach(k => {
          if (day[k] != null && !validISO(day[k])) delete day[k];
        });
        if (day.rawReport === null) delete day.rawReport;
        if (day.reportParseVersion === null) delete day.reportParseVersion;
        day.tickets.forEach((t, i) => {
          if (!UUID_RE.test(String(t.id || ""))) t.id = uuid();
          if (!validISO(t.time)) t.time = zonedISO(day.id, tz, 12, i);
          if (typeof t.customerNote !== "string") t.customerNote = t.customerNote == null ? "" : String(t.customerNote);
          if (!Array.isArray(t.lines)) t.lines = [];
          t.lines.forEach(l => {
            if (!UUID_RE.test(String(l.id || ""))) l.id = uuid();
            l.product = String(l.product == null ? "Item" : l.product);
            l.brand = String(l.brand == null ? "" : l.brand);
            l.unitPrice = Number(l.unitPrice) || 0;
            l.quantity = Math.max(1, parseInt(l.quantity, 10) || 1);
            if (!KINDS.has(l.kind)) l.kind = "inDepartment";
            l.isReturn = !!l.isReturn;
            l.isExchange = !!l.isExchange;
            if (l.sku === null || l.sku === "") delete l.sku;
          });
        });
      }
    }
    // Shifts: Shift.init(from:) requires id/start/end/title/location;
    // coworkers decode as [{name, start?, end?}] (plain strings break it).
    if (Array.isArray(data.shifts)) {
      data.shifts = data.shifts.filter(s => s && validISO(s.start) && validISO(s.end));
      data.shifts.forEach(s => {
        s.id = String(s.id || uuid());
        s.title = typeof s.title === "string" ? s.title : (s.title == null ? "Shift" : String(s.title));
        s.location = typeof s.location === "string" ? s.location : (s.location == null ? "" : String(s.location));
        if (s.coworkers != null) {
          s.coworkers = (Array.isArray(s.coworkers) ? s.coworkers : [])
            .map(c => typeof c === "string" ? { name: c } : c)
            .filter(c => c && typeof c.name === "string" && c.name.trim());
          s.coworkers.forEach(c => {
            ["start", "end"].forEach(k => { if (c[k] != null && typeof c[k] !== "string") delete c[k]; });
          });
        }
      });
    }
    // Goal uses synthesized Codable: every field must be present.
    (Array.isArray(data.goals) ? data.goals : []).forEach(g => {
      if (!g || typeof g !== "object") return;
      if (!validISO(g.createdAt)) g.createdAt = SB.isoSeconds(new Date());
      g.isActive = g.isActive !== false;
      g.target = Number(g.target) || 0;
      if (typeof g.metric !== "string") g.metric = "revenue";
      if (typeof g.period !== "string") g.period = "day";
    });
    // Holiday dates live at the top level (AppData.holidayDates).
    if (data.holidayDates != null && !Array.isArray(data.holidayDates)) data.holidayDates = [];
    // Goals / comparisons decode their id as UUID.
    ["goals", "comparisons"].forEach(k => {
      (Array.isArray(data[k]) ? data[k] : []).forEach(x => {
        if (x && typeof x === "object" && !UUID_RE.test(String(x.id || ""))) x.id = uuid();
      });
    });
    // Contacts too — and they are referenced elsewhere (mentions, shifts,
    // comparisons), so remap every exact reference to a fixed id.
    const remap = {};
    (Array.isArray(data.contacts) ? data.contacts : []).forEach(c => {
      if (c && typeof c === "object" && !UUID_RE.test(String(c.id || ""))) {
        const fresh = uuid();
        if (c.id) remap[String(c.id)] = fresh;
        c.id = fresh;
      }
    });
    if (Object.keys(remap).length) {
      const walk = v => {
        if (typeof v === "string") return Object.prototype.hasOwnProperty.call(remap, v) ? remap[v] : v;
        if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = walk(v[i]); return v; }
        if (v && typeof v === "object") { for (const k of Object.keys(v)) v[k] = walk(v[k]); return v; }
        return v;
      };
      walk(data);
    }
    return data;
  }

  return { sanitize, uuid, zonedISO };
})();
