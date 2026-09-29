"use strict";
/* ============ buddy-actions.js — Buddy structured actions for the dashboard ============
 *
 * Port of the iOS app's Buddy action system:
 *   - MicroBuddy/ViewModels/BuddyViewModel.swift  (actionSchema, apply(actions:),
 *     personalizedPrompts, confirmCrew/confirmSchedule, matchCrew, TimeParse)
 *   - MicroBuddy/Services/AIService.swift          (BuddyAction, BuddyResponse,
 *     CrewProposal, ScheduleProposal, CrewMember, PersonName)
 *   - MicroBuddy/Views/BuddyView.swift             (CrewProposalCard, ScheduleProposalCard)
 *
 * What it does:
 *  1. parseResponse(rawText) — leniently extracts {"reply","actions"} from the
 *     model's raw text (handles code fences, leading/trailing prose).
 *  2. applyActions(actions) — executes each action against the local backup via
 *     SyncEngine.queueWrite (offline-safe). Direct actions apply immediately;
 *     propose_crew / read_roster / propose_schedule become pending proposals.
 *  3. Proposal cards — inline Confirm / Decline cards, exactly like the app.
 *     Nothing saves until the user confirms once.
 *  4. quickPrompts() — 4 context-aware pills, scored like personalizedPrompts.
 *
 * Action types (same names + fields as the app's actionSchema):
 *   add_sale, set_lunch, set_hours, set_goal, set_department_rule,
 *   remove_department_rule, set_coworkers, propose_crew, propose_schedule,
 *   read_roster, add_note, add_coworkers
 *
 * Integration (buddy.js):
 *   - send(): const parsed = BuddyActions.parseResponse(data.reply);
 *             const result = await BuddyActions.applyActions(parsed.actions);
 *             render reply + result.applied lines; BuddyActions.renderProposalCards(result, sessionId)
 *   - open(): BuddyActions.renderPills() above the input
 *   - renderMessages(): BuddyActions.attachPendingCards(sessionId) at the end
 *
 * Server side (microbuddy.py build_buddy_system_prompt): see
 * BUDDY_ACTIONS_SERVER.md for the prompt text the model needs.
 */
const BuddyActions = (() => {

  // ---------------- self-contained styles ----------------
  // dashboard.html can't be edited from here, so the action UI ships its own
  // CSS, injected once. Uses the app's theme variables (--card, --accent…).

  const ACTION_CSS = [
    ".chat-pills{display:flex;gap:8px;flex-wrap:wrap;padding:8px 12px 0}",
    ".pill-btn{background:var(--card2);border:1px solid var(--border);color:var(--text);",
    " border-radius:999px;padding:7px 14px;font-size:13px;cursor:pointer;white-space:nowrap}",
    ".pill-btn:active{transform:scale(.96)}",
    ".proposal-wrap{display:flex;flex-direction:column;gap:10px;margin:6px 0}",
    ".proposal-card{border:1px solid var(--accent);border-radius:var(--radius);padding:14px}",
    ".proposal-title{font-size:13px;font-weight:700;color:var(--muted);margin-bottom:10px}",
    ".proposal-sub{font-size:12px;font-weight:700;color:var(--blue);margin:8px 0 6px}",
    ".proposal-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}",
    ".proposal-chip{background:var(--blue-dim);color:var(--text);border-radius:999px;",
    " padding:5px 10px;font-size:12px;font-weight:600}",
    ".proposal-day{margin:8px 0}",
    ".proposal-dayhead{font-size:13px;font-weight:700;margin-bottom:4px}",
    ".proposal-row{display:flex;justify-content:space-between;gap:8px;padding:5px 0;",
    " border-bottom:1px solid var(--border);font-size:13px}",
    ".proposal-row:last-child{border-bottom:none}",
    ".proposal-actions{display:flex;flex-direction:column;gap:8px;margin-top:12px}",
    ".proposal-actions .btn{width:100%}",
    ".proposal-status{margin-top:12px;font-size:13px;font-weight:700}",
    ".proposal-status.ok{color:var(--accent)}",
    ".proposal-status.muted{color:var(--muted)}",
  ].join("\n");

  function injectStyles() {
    try {
      if (document.getElementById("buddy-actions-css")) return;
      const el = document.createElement("style");
      el.id = "buddy-actions-css";
      el.textContent = ACTION_CSS;
      document.head.appendChild(el);
    } catch (e) {}
  }
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", injectStyles);
    } else {
      injectStyles();
    }
  }

  // ---------------- small helpers ----------------

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function fmtMoney(n) {
    const v = Number(n);
    if (!isFinite(v)) return "$0.00";
    return (v < 0 ? "-$" : "$") + Math.abs(v).toFixed(2);
  }

  function pad(n) { return String(n).padStart(2, "0"); }

  function dayKeyOf(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function parseDayKey(key) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || "").trim());
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  function dayName(key) {
    const d = parseDayKey(key);
    if (!d) return key;
    return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  }

  function uid(prefix) {
    return (prefix || "p") + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  // ---------------- ports from the app ----------------

  /// TimeParse.minutes — "10:00 AM", "6:30p", "14:00" → minutes since midnight.
  /// (BuddyViewModel.swift, bottom of file)
  function timeMinutes(raw) {
    if (raw == null) return null;
    let text = String(raw).trim().toLowerCase();
    if (!text) return null;
    let offset = 0;
    const amIdx = text.indexOf("am");
    const pmIdx = text.indexOf("pm");
    if (amIdx !== -1) { text = text.slice(0, amIdx) + text.slice(amIdx + 2); }
    else if (pmIdx !== -1) { offset = 720; text = text.slice(0, pmIdx) + text.slice(pmIdx + 2); }
    else if (text.endsWith("a")) { text = text.slice(0, -1); }
    else if (text.endsWith("p")) { offset = 720; text = text.slice(0, -1); }
    text = text.replace(/[ .:,\-]+$/g, "").trim();
    const parts = text.split(":");
    const hour = parseInt((parts[0] || "").trim(), 10);
    if (isNaN(hour)) return null;
    const minute = parts.length > 1 ? (parseInt(parts[1].slice(0, 2), 10) || 0) : 0;
    if (offset === 0 && hour > 12) return hour * 60 + minute;
    return (hour % 12) * 60 + minute + offset;
  }

  /// PersonName.normalized — "RIVERA, ALEX" → "ALEX RIVERA".
  /// (AIService.swift)
  function normalizeName(raw) {
    const trimmed = String(raw || "").trim();
    const comma = trimmed.indexOf(",");
    if (comma === -1) return trimmed;
    const last = trimmed.slice(0, comma).trim();
    const first = trimmed.slice(comma + 1).trim();
    if (!first || !last) return trimmed;
    return first + " " + last;
  }

  /// PersonName.swapped — "Alex Smith" → "Smith Alex" (two tokens only).
  function swappedName(raw) {
    const parts = String(raw || "").trim().split(/\s+/).filter(Boolean);
    if (parts.length !== 2) return null;
    return parts[1] + " " + parts[0];
  }

  /// BuddyViewModel.matchCrew — who overlaps the user's shift (same hours or
  /// within an hour). Returns {matched:[{member,reason}], excluded:[member]}.
  function matchCrew(members, userShift) {
    const us = new Date(userShift.start), ue = new Date(userShift.end);
    const userStart = us.getHours() * 60 + us.getMinutes();
    const userEnd = ue.getHours() * 60 + ue.getMinutes();
    const matched = [], excluded = [];
    for (const member of members) {
      const start = timeMinutes(member.start), end = timeMinutes(member.end);
      if (start == null || end == null) { excluded.push(member); continue; }
      const startLag = start - userStart;
      const endDiff = end - userEnd;
      if (start === userStart && end === userEnd) {
        matched.push({ member, reason: "Same hours" });
      } else if (startLag >= 0 && startLag <= 60 && Math.abs(endDiff) <= 60) {
        let reason;
        if (startLag > 0 && endDiff < 0) reason = "Later start, off " + (-endDiff) + "m early";
        else if (startLag > 0) reason = "Starts " + startLag + "m later";
        else if (endDiff < 0) reason = "Leaves " + (-endDiff) + "m early";
        else reason = "Stays " + endDiff + "m late";
        matched.push({ member, reason });
      } else {
        excluded.push(member);
      }
    }
    return { matched, excluded };
  }

  function crewListing(crew) {
    return crew.map(m => (m.end ? m.name + " off at " + m.end : m.name)).join(", ");
  }

  // ---------------- response parsing ----------------

  /// Lenient BuddyResponse decode: the model should return ONLY JSON, but in
  /// practice it may wrap it in fences or add prose. Extract the first {...}
  /// that parses and has a "reply" (or "actions") key.
  function parseResponse(raw) {
    const text = String(raw || "");
    const empty = { reply: text, actions: [] };
    // Strip code fences first.
    let cleaned = text.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "");
    const start = cleaned.indexOf("{");
    if (start === -1) return empty;
    // Try progressively shorter suffixes to find a parseable object.
    for (let end = cleaned.length; end > start; end--) {
      const slice = cleaned.slice(start, end);
      if (!slice.trim().endsWith("}")) continue;
      try {
        const obj = JSON.parse(slice);
        if (obj && typeof obj === "object" && ("reply" in obj || "actions" in obj)) {
          return {
            reply: typeof obj.reply === "string" ? obj.reply : text,
            actions: Array.isArray(obj.actions) ? obj.actions : [],
          };
        }
      } catch (e) { /* keep scanning */ }
      // Only try plausible brace boundaries to stay cheap.
      if (end - start > 60000) break;
    }
    return empty;
  }

  // ---------------- backup access ----------------

  async function getData() {
    const backup = await SyncEngine.getLocalBackup().catch(() => null);
    return (backup && backup.data) || {};
  }

  function ensureDay(data, dayId) {
    if (!Array.isArray(data.days)) data.days = [];
    let day = data.days.find(d => d.id === dayId);
    if (!day) {
      day = { id: dayId, tickets: [] };
      data.days.push(day);
      data.days.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }
    if (!Array.isArray(day.tickets)) day.tickets = [];
    return day;
  }

  function shiftForDay(data, dayId) {
    if (!Array.isArray(data.shifts)) return null;
    return data.shifts.find(s => {
      try { return dayKeyOf(new Date(s.start)) === dayId; } catch (e) { return false; }
    }) || null;
  }

  function contactMatching(data, name) {
    if (!Array.isArray(data.contacts)) return null;
    const key = String(name || "").trim().toLowerCase();
    const flipped = swappedName(key);
    return data.contacts.find(c => {
      const n = (((c.firstName || "") + " " + (c.lastName || "")).trim() || c.name || "").toLowerCase();
      return n === key || (flipped && n === flipped);
    }) || null;
  }

  function ownNameKeys(profile) {
    const keys = new Set();
    const raw = String((profile && profile.name) || "").trim().toLowerCase();
    if (raw) {
      keys.add(raw);
      const f = swappedName(raw);
      if (f) keys.add(f);
    }
    return keys;
  }

  // ---------------- action application ----------------

  /// Applies one BuddyAction. Returns a human-readable "applied" line, or null
  /// when the action was a no-op. Proposals are collected, not applied.
  async function applyOne(action, data, profile, collect) {
    const type = action && action.type;
    if (!type) return null;
    const q = (op) => SyncEngine.queueWrite(op);

    switch (type) {
      case "add_sale": {
        const date = parseDayKey(action.date) || new Date();
        const dayId = dayKeyOf(date);
        const product = String(action.product || "Item").trim() || "Item";
        const price = Number(action.price);
        if (!(price > 0)) return null;
        const kind = ["inDepartment", "outOfDepartment", "servicePlan"].includes(action.kind)
          ? action.kind : "inDepartment";
        const line = {
          product,
          brand: String(action.brand || ""),
          sku: action.sku ? String(action.sku) : undefined,
          unitPrice: price,
          quantity: Math.max(1, parseInt(action.quantity, 10) || 1),
          kind,
          isReturn: !!action.isReturn,
        };
        const day = ensureDay(data, dayId);
        if (day.tickets.length) {
          await q({ type: "addLine", dayId, ticketIndex: day.tickets.length - 1, line });
        } else {
          await q({ type: "addTicket", dayId, ticket: { time: "", customerNote: "", lines: [line] } });
        }
        let commTxt = "";
        try {
          const table = PayEngine.tableFor(profile);
          commTxt = " → " + fmtMoney(PayEngine.lineCommission(line, table)) + " commission";
        } catch (e) {}
        return "Logged " + product + " " + fmtMoney(price) + " ×" + line.quantity + commTxt;
      }

      case "set_lunch": {
        const date = parseDayKey(action.date) || new Date();
        const dayId = dayKeyOf(date);
        const minutes = parseInt(action.minutes, 10);
        await q({ type: "updateDay", dayId, updates: { lunchMinutes: isNaN(minutes) ? 30 : minutes } });
        return "Lunch set to " + (isNaN(minutes) ? 30 : minutes) + "m on " + dayId;
      }

      case "set_hours": {
        const date = parseDayKey(action.date) || new Date();
        const dayId = dayKeyOf(date);
        const hours = Number(action.hours);
        if (!(hours >= 0)) return null;
        await q({ type: "updateDay", dayId, updates: { scheduledHours: hours } });
        return "Hours set to " + hours.toFixed(1) + " on " + dayId;
      }

      case "set_goal": {
        const metric = ["revenue", "commission", "moneyMade", "plans", "cph"].includes(action.metric)
          ? action.metric : "revenue";
        const period = ["day", "week", "payPeriod", "month"].includes(action.period)
          ? action.period : "day";
        const target = Number(action.target);
        if (!(target > 0)) return null;
        await q({
          type: "addGoal",
          goal: { id: uid("g"), metric, period, target, createdAt: new Date().toISOString(), isActive: true },
        });
        return "Goal set: " + fmtMoney(target) + " " + metric + " · " + period;
      }

      case "set_department_rule": {
        const pattern = String(action.pattern || "").trim();
        if (!pattern) return null;
        const kind = ["inDepartment", "outOfDepartment", "servicePlan"].includes(action.kind)
          ? action.kind : "inDepartment";
        const rules = Array.isArray(profile.departmentRules) ? profile.departmentRules.slice() : [];
        const needle = pattern.toLowerCase();
        const existing = rules.find(r => String(r.pattern || "").trim().toLowerCase() === needle);
        if (existing) {
          existing.kind = kind; existing.source = "buddy"; existing.hits = (existing.hits || 0) + 1;
        } else {
          rules.push({ id: uid("r"), pattern, kind, source: "buddy", hits: 1, createdAt: new Date().toISOString() });
        }
        await q({ type: "updateProfile", updates: { departmentRules: rules } });
        return "Remembered: " + pattern + " → " + kind;
      }

      case "remove_department_rule": {
        const needle = String(action.pattern || "").trim().toLowerCase();
        if (!needle || !Array.isArray(profile.departmentRules)) return null;
        const before = profile.departmentRules.length;
        const rules = profile.departmentRules.filter(r =>
          String(r.pattern || "").trim().toLowerCase() !== needle);
        if (rules.length === before) return null;
        await q({ type: "updateProfile", updates: { departmentRules: rules } });
        return "Forgot rule: " + action.pattern;
      }

      case "add_note": {
        const date = parseDayKey(action.date) || new Date();
        const dayId = dayKeyOf(date);
        const text = String(action.note || "").trim();
        if (!text) return null;
        const day = ensureDay(data, dayId);
        const cur = String(day.note || "").trim();
        await q({ type: "setDayNote", dayId, note: cur ? cur + "\n" + text : text });
        return "Note added on " + dayId;
      }

      case "set_coworkers": {
        const date = parseDayKey(action.date) || new Date();
        const dayId = dayKeyOf(date);
        const shift = shiftForDay(data, dayId);
        if (!shift) return "No shift on " + dayId + " to set coworkers for";
        let crew;
        if (Array.isArray(action.crew) && action.crew.length) {
          crew = action.crew.map(m => ({
            name: normalizeName(m.name), start: m.start || null, end: m.end || null,
          }));
        } else {
          crew = (Array.isArray(action.names) ? action.names : []).map(n => ({ name: normalizeName(n) }));
        }
        await q({ type: "updateShift", shiftId: shift.id, updates: { coworkers: crew, isEdited: true } });
        return crew.length ? "Crew on " + dayId + ": " + crewListing(crew) : "Cleared the crew on " + dayId;
      }

      case "add_coworkers": {
        const userKey = String((profile && profile.name) || "").trim().toLowerCase();
        const seen = new Set(), names = [];
        for (const raw of (Array.isArray(action.names) ? action.names : [])) {
          const name = normalizeName(raw);
          if (!name) continue;
          const key = name.toLowerCase(), flipped = swappedName(key) || key;
          if (seen.has(key) || seen.has(flipped)) continue;
          if (userKey && (key === userKey || flipped === userKey)) continue;
          seen.add(key); names.push(name);
        }
        if (!names.length) return null;
        const added = [], skipped = [];
        for (const name of names) {
          if (contactMatching(data, name)) { skipped.push(name); continue; }
          const parts = name.split(/\s+/);
          await q({
            type: "addContact",
            contact: { firstName: parts[0] || name, lastName: parts.slice(1).join(" ") || "" },
          });
          added.push(name);
        }
        if (!added.length) return "Everyone listed is already in your Coworkers — nothing added";
        let line = "Added " + added.length + " to Coworkers: " + added.join(", ");
        if (skipped.length) line += " · already saved: " + skipped.join(", ");
        return line;
      }

      case "propose_crew":
      case "read_roster": {
        // Build day entries (read_roster and propose_crew share the shape).
        let dayEntries = (Array.isArray(action.days) ? action.days : [])
          .filter(d => d && Array.isArray(d.crew) && d.crew.length);
        if (!dayEntries.length && Array.isArray(action.crew) && action.crew.length) {
          const key = String(action.date || action.dateKey || "").trim() || dayKeyOf(new Date());
          dayEntries = [{ dateKey: key, crew: action.crew }];
        }
        dayEntries = dayEntries.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d.dateKey || ""));
        if (!dayEntries.length) {
          return type === "read_roster"
            ? "No dated schedule panels were found in those screenshots"
            : null;
        }
        // Clean: drop the user, dedupe, track genuinely new contacts.
        const ownKeys = ownNameKeys(profile);
        const contactSeen = new Set(), newContacts = [];
        const cleanDays = [];
        for (const day of dayEntries) {
          const daySeen = new Set(), members = [];
          for (const m of day.crew) {
            const name = normalizeName(m.name);
            const key = name.toLowerCase();
            if (!key || key.includes("my schedule")) continue;
            const flipped = swappedName(key) || key;
            if (ownKeys.has(key) || ownKeys.has(flipped)) continue;
            if (daySeen.has(key) || daySeen.has(flipped)) continue;
            daySeen.add(key);
            if (!contactSeen.has(key) && !contactSeen.has(flipped)) {
              contactSeen.add(key);
              if (!contactMatching(data, name)) newContacts.push(name);
            }
            members.push({ name, start: m.start || null, end: m.end || null });
          }
          if (members.length) cleanDays.push({ dateKey: day.dateKey, crew: members });
        }
        if (!cleanDays.length) return "Every panel matched you or was unreadable — nothing to preview";
        newContacts.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
        collect.proposals.push({
          id: uid("cp"), kind: "crew", status: "pending",
          dateKey: cleanDays[0].dateKey, days: cleanDays, newContacts,
          source: type, createdAt: Date.now(),
        });
        const people = cleanDays.reduce((n, d) => n + d.crew.length, 0);
        let summary = type === "read_roster"
          ? "Preview ready — " + newContacts.length + " new coworker" + (newContacts.length === 1 ? "" : "s")
          : "Crew proposal ready";
        if (newContacts.length) summary += ": " + newContacts.join(", ");
        summary += " · " + people + " people across " + cleanDays.length +
          " day" + (cleanDays.length === 1 ? "" : "s");
        return summary;
      }

      case "propose_schedule": {
        const rawPlans = (Array.isArray(action.schedule) ? action.schedule : []).filter(day => {
          const key = String((day && day.dateKey) || "").trim();
          return key.length === 10 && /^\d{4}-\d{2}-\d{2}$/.test(key) &&
            (day.start || day.end || day.lunchStart ||
              (Array.isArray(day.crew) && day.crew.some(m => String((m && m.name) || "").trim())));
        });
        if (!rawPlans.length) return null;
        const ownKeys = ownNameKeys(profile);
        const contactSeen = new Set(), newContacts = [];
        const cleanPlans = [];
        for (const day of rawPlans) {
          const daySeen = new Set(), members = [];
          for (const m of (day.crew || [])) {
            const name = normalizeName(m.name);
            const key = name.toLowerCase();
            if (!key || key.includes("my schedule")) continue;
            const flipped = swappedName(key) || key;
            if (ownKeys.has(key) || ownKeys.has(flipped)) continue;
            if (daySeen.has(key) || daySeen.has(flipped)) continue;
            daySeen.add(key);
            if (!contactSeen.has(key) && !contactSeen.has(flipped)) {
              contactSeen.add(key);
              if (!contactMatching(data, name)) newContacts.push(name);
            }
            members.push({ name, start: m.start || null, end: m.end || null });
          }
          cleanPlans.push({
            dateKey: day.dateKey, start: day.start || null, end: day.end || null,
            lunchStart: day.lunchStart || null, lunchEnd: day.lunchEnd || null, crew: members,
          });
        }
        if (!cleanPlans.length) return "Those dates weren't readable — nothing to preview";
        newContacts.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
        collect.schedules.push({
          id: uid("sp"), kind: "schedule", status: "pending",
          days: cleanPlans, newContacts, createdAt: Date.now(),
        });
        const crewCount = cleanPlans.reduce((n, d) => n + d.crew.length, 0);
        let summary = "Schedule draft ready — " + cleanPlans.length +
          " day" + (cleanPlans.length === 1 ? "" : "s");
        if (crewCount) summary += ", " + crewCount + " " + (crewCount === 1 ? "person" : "people");
        if (newContacts.length) summary += " · new coworkers: " + newContacts.join(", ");
        return summary;
      }

      default:
        return null;
    }
  }

  async function applyActions(actions) {
    const applied = [], proposals = [], schedules = [];
    if (!Array.isArray(actions) || !actions.length) return { applied, proposals, schedules };
    const collect = { proposals, schedules };
    for (const action of actions) {
      // Fresh read per action: queueWrite applies optimistically, so each
      // action sees the previous one's effects (e.g. consecutive add_sales
      // land as lines on the same ticket).
      const data = await getData();
      const profile = data.profile || {};
      try {
        const line = await applyOne(action, data, profile, collect);
        if (line) applied.push(line);
      } catch (e) {
        applied.push("Couldn't apply " + ((action && action.type) || "action") + ": " + e.message);
      }
    }
    for (const p of proposals) await ProposalStore.save(p);
    for (const s of schedules) await ProposalStore.save(s);
    return { applied, proposals, schedules };
  }

  // ---------------- proposal store + confirm/decline ----------------

  const ProposalStore = (() => {
    const mem = new Map();
    let hydrated = false;

    async function hydrate() {
      if (hydrated) return;
      hydrated = true;
      try {
        const saved = await MBDB.kvGet("buddyProposals").catch(() => null);
        if (Array.isArray(saved)) for (const p of saved) if (p && p.id) mem.set(p.id, p);
      } catch (e) {}
    }

    async function persist() {
      try { await MBDB.kvSet("buddyProposals", Array.from(mem.values())); } catch (e) {}
    }

    return {
      async save(p) { await hydrate(); mem.set(p.id, p); persist(); },
      async get(id) { await hydrate(); return mem.get(id) || null; },
      async setStatus(id, status) {
        await hydrate();
        const p = mem.get(id);
        if (p) { p.status = status; persist(); }
        return p || null;
      },
      async pendingForSession() {
        await hydrate();
        return Array.from(mem.values()).filter(p => p.status === "pending");
      },
      async pending() { await hydrate(); return Array.from(mem.values()).filter(p => p.status === "pending"); },
    };
  })();

  function confirmLabelCrew(p) {
    const contacts = p.newContacts.length;
    let crew = 0;
    // Count would-be-matched members against real shifts (best effort).
    return { contacts };
  }

  /// Confirm a crew/roster proposal: add new contacts, then save crew per day
  /// for people matching the user's shift hours (matchCrew). Port of
  /// BuddyViewModel.confirmCrew.
  async function confirmCrewProposal(id) {
    const p = await ProposalStore.get(id);
    if (!p || p.status !== "pending") return null;
    const data = await getData();
    const lines = [];
    const added = [];
    for (const name of p.newContacts) {
      if (contactMatching(data, name)) continue;
      const parts = name.split(/\s+/);
      await SyncEngine.queueWrite({
        type: "addContact",
        contact: { firstName: parts[0] || name, lastName: parts.slice(1).join(" ") || "" },
      });
      added.push(name);
    }
    lines.push(added.length
      ? "Added " + added.length + " to Coworkers: " + added.join(", ")
      : "Coworkers: nothing new to add.");
    for (const day of p.days) {
      const shift = shiftForDay(data, day.dateKey);
      if (!shift) {
        lines.push(dayName(day.dateKey) + ": no shift on your schedule, so nothing was saved — add that shift first.");
        continue;
      }
      const result = matchCrew(day.crew, shift);
      const crew = result.matched.map(r => ({ name: r.member.name, start: r.member.start, end: r.member.end }));
      if (crew.length) {
        await SyncEngine.queueWrite({
          type: "updateShift", shiftId: shift.id,
          updates: { coworkers: crew, isEdited: true },
        });
      }
      let line = crew.length
        ? dayName(day.dateKey) + ": crew saved — " + crew.map(c => c.name).join(", ") + "."
        : dayName(day.dateKey) + ": nobody matched your hours, so I didn't save anyone.";
      if (result.excluded.length) {
        line += " Skipped (different hours): " + result.excluded.map(m => m.name).join(", ") + ".";
      }
      lines.push(line);
    }
    await ProposalStore.setStatus(id, "confirmed");
    return lines.join("\n");
  }

  async function declineCrewProposal(id) {
    await ProposalStore.setStatus(id, "declined");
    return "No problem — nothing was saved.";
  }

  /// Confirm a schedule proposal: create/update each day's shift, set the
  /// lunch window, save crew exactly as printed, add new contacts. Port of
  /// BuddyViewModel.confirmSchedule.
  async function confirmScheduleProposal(id) {
    const p = await ProposalStore.get(id);
    if (!p || p.status !== "pending") return null;
    const data = await getData();
    const lines = [];
    const added = [];
    for (const name of p.newContacts) {
      if (contactMatching(data, name)) continue;
      const parts = name.split(/\s+/);
      await SyncEngine.queueWrite({
        type: "addContact",
        contact: { firstName: parts[0] || name, lastName: parts.slice(1).join(" ") || "" },
      });
      added.push(name);
    }
    lines.push(added.length
      ? "Added " + added.length + " to Coworkers: " + added.join(", ")
      : "Coworkers: nothing new to add.");

    for (const day of p.days) {
      const base = parseDayKey(day.dateKey);
      if (!base) { lines.push(day.dateKey + ": couldn't read that date, skipped."); continue; }
      const startMin = timeMinutes(day.start), endMin = timeMinutes(day.end);
      let shift = shiftForDay(data, day.dateKey);
      if (startMin != null && endMin != null) {
        const start = new Date(base.getTime() + startMin * 60000);
        let endMs = base.getTime() + endMin * 60000;
        if (endMin <= startMin) endMs += 86400000;
        const end = new Date(endMs);
        if (shift) {
          await SyncEngine.queueWrite({
            type: "updateShift", shiftId: shift.id,
            updates: { start: start.toISOString(), end: end.toISOString(), isEdited: true },
          });
          shift = Object.assign({}, shift, { start: start.toISOString(), end: end.toISOString() });
        } else {
          const ns = {
            id: uid("sh"), start: start.toISOString(), end: end.toISOString(),
            title: "", location: "", isManual: true, isEdited: false, coworkers: [],
          };
          await SyncEngine.queueWrite({ type: "addShift", shift: ns });
          shift = ns;
        }
      }
      if (day.crew.length && shift) {
        const crew = day.crew.map(m => ({ name: m.name, start: m.start, end: m.end }));
        await SyncEngine.queueWrite({
          type: "updateShift", shiftId: shift.id,
          updates: { coworkers: crew, isEdited: true },
        });
      }
      const lunchStartMin = timeMinutes(day.lunchStart);
      if (lunchStartMin != null) {
        const lunchStart = new Date(base.getTime() + lunchStartMin * 60000);
        const updates = { lunchStart: lunchStart.toISOString(), secondLunchStart: null };
        const lunchEndMin = timeMinutes(day.lunchEnd);
        if (lunchEndMin != null) {
          let mins = lunchEndMin - lunchStartMin;
          if (mins <= 0) mins += 1440;
          updates.lunchMinutes = mins;
        }
        await SyncEngine.queueWrite({ type: "updateDay", dayId: day.dateKey, updates });
      }
      const pieces = [];
      if (day.start && day.end && startMin != null && endMin != null) pieces.push(day.start + "–" + day.end);
      if (day.lunchStart) pieces.push("lunch " + day.lunchStart + (day.lunchEnd ? "–" + day.lunchEnd : ""));
      if (day.crew.length) pieces.push("crew: " + crewListing(day.crew));
      lines.push(pieces.length
        ? dayName(day.dateKey) + ": " + pieces.join(" · ")
        : dayName(day.dateKey) + ": nothing readable to save");
    }
    await ProposalStore.setStatus(id, "confirmed");
    return lines.join("\n");
  }

  async function declineScheduleProposal(id) {
    await ProposalStore.setStatus(id, "declined");
    return "No problem — nothing was saved.";
  }

  // ---------------- proposal cards ----------------

  function cardShell(title, innerHTML, id, kind, status) {
    const statusHTML = status === "confirmed"
      ? '<div class="proposal-status ok">✓ Saved</div>'
      : status === "declined"
        ? '<div class="proposal-status muted">Not saved</div>'
        : '<div class="proposal-actions">' +
          '<button class="btn" data-proposal-confirm="' + esc(id) + '" data-proposal-kind="' + esc(kind) + '">Confirm</button>' +
          '<button class="btn ghost" data-proposal-decline="' + esc(id) + '" data-proposal-kind="' + esc(kind) + '">Don\'t save anything</button>' +
          "</div>";
    return '<div class="proposal-card panel" data-proposal-card="' + esc(id) + '">' +
      '<div class="proposal-title">' + esc(title) + "</div>" + innerHTML + statusHTML + "</div>";
  }

  function newContactsHTML(names) {
    if (!names.length) return "";
    return '<div class="proposal-sub">New to your Coworkers</div>' +
      '<div class="proposal-chips">' +
      names.map(n => '<span class="proposal-chip">' + esc(n) + "</span>").join("") + "</div>";
  }

  function crewDayHTML(day) {
    const rows = day.crew.map(m =>
      '<div class="proposal-row"><span>' + esc(m.name) + "</span>" +
      (m.start || m.end
        ? '<span class="li-sub">' + esc([m.start, m.end].filter(Boolean).join(" – ")) + "</span>"
        : "") + "</div>"
    ).join("");
    return '<div class="proposal-day"><div class="proposal-dayhead">' + esc(dayName(day.dateKey)) + "</div>" + rows + "</div>";
  }

  function crewCardHTML(p) {
    const title = p.source === "read_roster"
      ? "Schedule import · " + p.days.length + " day" + (p.days.length === 1 ? "" : "s")
      : "Crew proposal · " + dayName(p.dateKey);
    const inner = newContactsHTML(p.newContacts) +
      p.days.map(crewDayHTML).join("") +
      '<div class="li-sub" style="margin-top:6px">Only people matching your shift hours will be saved.</div>';
    return cardShell(title, inner, p.id, "crew", p.status);
  }

  function scheduleCardHTML(p) {
    const title = "Schedule import · " + p.days.length + " day" + (p.days.length === 1 ? "" : "s");
    const inner = newContactsHTML(p.newContacts) + p.days.map(day => {
      const bits = [];
      if (day.start || day.end) bits.push(esc([day.start, day.end].filter(Boolean).join("–")));
      if (day.lunchStart) bits.push("lunch " + esc(day.lunchStart + (day.lunchEnd ? "–" + day.lunchEnd : "")));
      return '<div class="proposal-day"><div class="proposal-dayhead">' + esc(dayName(day.dateKey)) +
        (bits.length ? ' <span class="li-sub">' + bits.join(" · ") + "</span>" : "") + "</div>" +
        day.crew.map(m => '<div class="proposal-row"><span>' + esc(m.name) + "</span>" +
          (m.start || m.end ? '<span class="li-sub">' + esc([m.start, m.end].filter(Boolean).join(" – ")) + "</span>" : "") +
          "</div>").join("") + "</div>";
    }).join("");
    return cardShell(title, inner, p.id, "schedule", p.status);
  }

  function cardHTML(p) {
    return p.kind === "schedule" ? scheduleCardHTML(p) : crewCardHTML(p);
  }

  /// Render freshly-created proposal cards; returns the HTML string.
  /// buddy.js inserts it after the assistant message bubble.
  function renderProposalCards(result) {
    const all = (result.proposals || []).concat(result.schedules || []);
    return all.map(cardHTML).join("");
  }

  /// Bind Confirm/Decline clicks inside a container (event delegation).
  /// onDone(kind, id, message) — buddy.js appends the follow-up message.
  function bindCardActions(container, onDone) {
    if (!container || container._buddyActionsBound) return;
    container._buddyActionsBound = true;
    container.addEventListener("click", async e => {
      const confirmBtn = e.target.closest("[data-proposal-confirm]");
      const declineBtn = e.target.closest("[data-proposal-decline]");
      const btn = confirmBtn || declineBtn;
      if (!btn) return;
      const id = btn.dataset.proposalConfirm || btn.dataset.proposalDecline;
      const kind = btn.dataset.proposalKind;
      btn.disabled = true;
      try {
        let message;
        if (confirmBtn) {
          message = kind === "schedule"
            ? await confirmScheduleProposal(id)
            : await confirmCrewProposal(id);
        } else {
          message = kind === "schedule"
            ? await declineScheduleProposal(id)
            : await declineCrewProposal(id);
        }
        // Swap the card to its final state.
        const p = await ProposalStore.get(id);
        const card = container.querySelector('[data-proposal-card="' + id + '"]');
        if (p && card) card.outerHTML = cardHTML(p);
        if (onDone && message) onDone(kind, id, message, !!confirmBtn);
      } catch (err) {
        btn.disabled = false;
        if (onDone) onDone(kind, id, "Couldn't save that: " + err.message, false);
      }
    });
  }

  /// Re-attach cards for still-pending proposals (after history re-render).
  /// buddy.js calls this at the end of renderMessages().
  async function attachPendingCards(sessionId) {
    const box = document.getElementById("chat-messages");
    if (!box) return;
    const pending = await ProposalStore.pending();
    if (!pending.length) return;
    // Only show proposals created in this browser; they're ephemeral cards.
    // Append them after the last assistant message.
    const msgs = box.querySelectorAll(".chat-msg.assistant");
    const anchor = msgs.length ? msgs[msgs.length - 1] : null;
    const wrap = document.createElement("div");
    wrap.className = "proposal-wrap";
    wrap.innerHTML = pending.map(cardHTML).join("");
    if (anchor) anchor.after(wrap);
    else box.appendChild(wrap);
    box.scrollTop = box.scrollHeight;
  }

  // ---------------- quick prompts ----------------

  /// Port of BuddyViewModel.personalizedPrompts — 4 pills scored by time of
  /// day, shift state, goals, and recent ask history.
  async function quickPrompts() {
    const now = new Date();
    const hour = now.getHours();
    const data = await getData().catch(() => ({}));
    const days = Array.isArray(data.days) ? data.days : [];
    const shifts = Array.isArray(data.shifts) ? data.shifts : [];
    const goals = Array.isArray(data.goals) ? data.goals : [];
    const todayKey = dayKeyOf(now);
    const yest = new Date(now.getTime() - 86400000);
    const yesterdayKey = dayKeyOf(yest);

    const today = days.find(d => d.id === todayKey);
    const todayLogged = !!(today && Array.isArray(today.tickets) && today.tickets.length);
    const todayShifts = shifts
      .filter(s => { try { return dayKeyOf(new Date(s.start)) === todayKey; } catch (e) { return false; } })
      .sort((a, b) => new Date(a.start) - new Date(b.start));
    const isOnShift = todayShifts.some(s => new Date(s.start) <= now && new Date(s.end) >= now);
    const nextShift = shifts
      .filter(s => { try { return new Date(s.end) > now; } catch (e) { return false; } })
      .sort((a, b) => new Date(a.start) - new Date(b.start))[0] || null;
    const hasActiveGoal = goals.some(g => g.isActive);
    const yesterday = days.find(d => d.id === yesterdayKey);
    const yesterdayLogged = !!(yesterday && Array.isArray(yesterday.tickets) && yesterday.tickets.length);
    const workedYesterday = shifts.some(s => {
      try { return dayKeyOf(new Date(s.start)) === yesterdayKey; } catch (e) { return false; }
    });
    const isTomorrow = nextShift && dayKeyOf(new Date(new Date(nextShift.start).getTime() + 86400000)) === dayKeyOf(new Date(now.getTime() + 86400000));

    // Recent asks: last 12 user messages across sessions.
    let recentAsks = [];
    try {
      const sessions = await MBDB.kvGet("chatSessions").catch(() => []) || [];
      for (const s of sessions.slice(0, 6)) {
        const msgs = await MBDB.getChatHistory(s.id, 24).catch(() => []);
        for (const m of msgs) if (m.role === "user") recentAsks.push(String(m.content || "").toLowerCase());
      }
      recentAsks = recentAsks.slice(-12);
    } catch (e) {}
    const asked = (...keywords) =>
      recentAsks.some(ask => keywords.some(k => ask.includes(k)));
    const topicScore = (topic) => {
      switch (topic) {
        case "logging": return asked("log", "sold", "sale") ? 3 : 0;
        case "pay": return asked("pay", "hour", "made", "money", "period") ? 3 : 0;
        case "schedule": return asked("shift", "schedule", "work", "tomorrow", "clock") ? 3 : 0;
        case "crew": return asked("who", "crew", "coworker", "working with") ? 3 : 0;
        case "goal": return asked("goal") ? 3 : 0;
        case "stats": return asked("best", "top", "cph", "stat") ? 3 : 0;
        default: return 0;
      }
    };

    const candidates = [];
    const add = (text, score, topic) => candidates.push({ text, score: score + topicScore(topic) });

    if (todayLogged) {
      add("How did I do today?", (isOnShift || hour >= 17) ? 9 : 7, "stats");
    } else if (isOnShift) {
      add("Log today's sales", 9, "logging");
    } else if (todayShifts.length && hour < 12) {
      add("What time do I clock in today?", 8, "schedule");
      add("Log today's sales", 5, "logging");
    } else {
      add("Log today's sales", hour >= 16 ? 9 : 6, "logging");
    }
    if (workedYesterday && !yesterdayLogged) add("Log yesterday's sales", 5, "logging");
    if (nextShift) {
      if (isTomorrow) add("What time do I work tomorrow?", 8, "schedule");
      else if (!todayShifts.length) add("When is my next shift?", 6, "schedule");
      const crew = Array.isArray(nextShift.coworkers) ? nextShift.coworkers : [];
      if (crew.length) add("Who am I working with next?", 7, "crew");
    }
    if (hasActiveGoal) add("How close am I to my goal?", 8, "goal");
    else add("Set a $3k weekly goal", 7, "goal");
    add("How's my pay period looking?", 6, "pay");
    add("What did I make an hour this week?", 5, "pay");
    add("Best day this month?", 5, "stats");
    add("Who are my top brands this month?", 4, "stats");

    const fresh = candidates.filter(c =>
      !recentAsks.some(ask => ask.includes(c.text.toLowerCase())));
    const ranked = (fresh.length ? fresh : candidates).sort((a, b) => b.score - a.score);
    const picked = [];
    for (const c of ranked) {
      if (!picked.includes(c.text)) picked.push(c.text);
      if (picked.length === 4) break;
    }
    return picked;
  }

  /// Render the pills row. buddy.js calls this in open(); onPill(text) sends it.
  async function renderPills(onPill) {
    const box = document.getElementById("chat-pills");
    if (!box) return;
    let pills = [];
    try { pills = await quickPrompts(); } catch (e) {}
    if (!pills.length) { box.innerHTML = ""; return; }
    box.innerHTML = pills.map(p =>
      '<button class="pill-btn" data-pill="' + esc(p) + '">' + esc(p) + "</button>"
    ).join("");
    box.querySelectorAll("[data-pill]").forEach(btn => {
      btn.addEventListener("click", () => { if (onPill) onPill(btn.dataset.pill); });
    });
  }

  // ---------------- public API ----------------

  return {
    parseResponse,
    applyActions,
    renderProposalCards,
    bindCardActions,
    attachPendingCards,
    confirmCrewProposal,
    declineCrewProposal,
    confirmScheduleProposal,
    declineScheduleProposal,
    quickPrompts,
    renderPills,
    // ports (exported for testing)
    _timeMinutes: timeMinutes,
    _normalizeName: normalizeName,
    _swappedName: swappedName,
    _matchCrew: matchCrew,
  };
})();
