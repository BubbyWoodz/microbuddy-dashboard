"use strict";
/* ============ schedule.js — Schedule tab for the Micro Buddy dashboard ============
 *
 * Faithful port of the iOS app's Schedule tab:
 *   ios-micro-buddy/MicroBuddy/Views/ScheduleView.swift
 *   ios-micro-buddy/MicroBuddy/Models/Shift.swift
 *   ios-micro-buddy/MicroBuddy/Models/StoreHours.swift
 *   ios-micro-buddy/MicroBuddy/Services/ICSService.swift
 *   ios-micro-buddy/MicroBuddy/Views/ScheduleSettingsView.swift
 *   ios-micro-buddy/MicroBuddy/Views/HolidayHoursView.swift
 *
 * Detailed specs: /tmp/mbapp/schedule-spec-ics.md, /tmp/mbapp/schedule-spec-ui.md
 *
 * Data:
 *   Shifts: data.shifts[] in the backup blob. {id,start,end,title,location,
 *     isManual,isEdited,coworkers:[{name,start?,end?}]}. Dates are ISO8601.
 *   Lunch: on the WorkDay: data.days[dayKey].{lunchMinutes,lunchStart,
 *     secondLunchStart}. lunchStart/secondLunchStart are ISO8601.
 *     Auto minutes: <5h→0, 5–<11h→60, ≥11h→90. User picks times only.
 *   ICS URL: data.profile.icsURL. Reminders: data.profile.reminders.
 *   Holidays: data.holidayDates (["yyyy-MM-dd"], top level like iOS AppData).
 *
 * All edits go through SyncEngine.queueWrite (offline-first op queue).
 *
 * Parent wiring (dashboard.html):
 *   <script src="/schedule.js"></script>
 *   // in loadTab: if (tab === "schedule") { ScheduleUI.open(); return; }
 *   ScheduleUI.onViewDay = (dayKey) => DayDetailUI.open(dayKey);
 *
 * NEW OP TYPES this module queues (parent must add to sync.js applyOp):
 *   { type:"addShift", shift:{id,start,end,title,location,isManual,isEdited,coworkers} }
 *   { type:"updateShift", shiftId, updates:{...} }  // set isEdited:true on hand edits
 *   { type:"deleteShift", shiftId }
 *   { type:"updateProfile", updates:{icsURL?,reminders?,holidayDates?,lastSyncedAt?} }
 * Lunch uses the EXISTING updateDay op:
 *   { type:"updateDay", dayId, updates:{lunchMinutes,lunchStart,secondLunchStart} }
 * ===================================================================================== */
const ScheduleUI = (() => {

  const esc = s => String(s == null ? "" : s)
    .replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const hooks = { onViewDay: null };

  function pad(n) { return String(n).padStart(2, "0"); }
  function dayKeyOf(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function parseDayKey(key) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(key || "");
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date();
  }
  function fmtTime(d) { return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); }
  function fmtTimeRange(a, b) {
    const s = new Date(a), e = new Date(b);
    return isNaN(s) || isNaN(e) ? "" : fmtTime(s) + " – " + fmtTime(e);
  }
  function startOfWeek(d) {
    const c = new Date(d); c.setHours(0, 0, 0, 0);
    c.setDate(c.getDate() - c.getDay()); return c;
  }
  function startOfDay(d) { const c = new Date(d); c.setHours(0, 0, 0, 0); return c; }
  function uuid() { return AppDataSanitizer.uuid(); }
  function spinner(msg) { return '<div class="spinner">' + esc(msg || "Loading…") + "</div>"; }

  // ---------------------------------------------------------------------------
  // StoreHours port — Mon–Sat 10–9, Sun 11–6, holidays borrow Sunday hours.
  // ---------------------------------------------------------------------------

  let holidayDates = [];

  function isSundayHours(date) {
    return date.getDay() === 0 || holidayDates.includes(dayKeyOf(date));
  }
  function openAndClose(date) {
    const sun = isSundayHours(date);
    const open = new Date(date); open.setHours(sun ? 11 : 10, 0, 0, 0);
    const close = new Date(date); close.setHours(sun ? 18 : 21, 0, 0, 0);
    return { open, close };
  }
  function isOpeningShift(sh) { const w = ShiftMath.workedStart(sh); return !sh.isRemoved && w < openAndClose(w).open; }
  function isClosingShift(sh) { const w = ShiftMath.workedEnd(sh); return !sh.isRemoved && w > openAndClose(w).close; }

  // ---------------------------------------------------------------------------
  // Shift.swift port — overlap math
  // ---------------------------------------------------------------------------

  function shiftHours(sh) { return ShiftMath.hours(sh); } // actual hours win (Batch 29)
  function shiftDayKey(sh) { return dayKeyOf(new Date(sh.start)); }

  function timeParseMinutes(str) {
    if (!str) return null;
    const t = String(str).trim().toLowerCase().replace(/\s+/g, "");
    let m = /^(\d{1,2})(?::(\d{2}))?([ap])\.?m?\.?$/.exec(t);
    if (m) {
      let h = +m[1]; const min = +(m[2] || 0);
      if (m[3] === "p" && h < 12) h += 12;
      if (m[3] === "a" && h === 12) h = 0;
      return h * 60 + min;
    }
    m = /^(\d{1,2}):(\d{2})$/.exec(t);
    return m ? (+m[1]) * 60 + (+m[2]) : null;
  }
  function reading(value, lo, hi) {
    const c = [value, value + 720, value + 1440, value - 720];
    const inside = c.find(x => x >= lo && x <= hi);
    if (inside !== undefined) return inside;
    return c.reduce((a, b) => Math.abs(b - lo) < Math.abs(a - lo) ? b : a, value);
  }
  function overlapHours(sh, cw) { return ShiftMath.overlapHours(sh, cw); }
  function overlapSummary(sh, cw) {
    const h = overlapHours(sh, cw);
    if (h == null || h <= 0.05) return null;
    const tm = Math.round(h * 60), hh = Math.floor(tm / 60), mm = tm % 60;
    if (hh === 0) return mm + "m";
    return mm === 0 ? hh + "h" : hh + "h " + mm + "m";
  }

  // ---------------------------------------------------------------------------
  // WorkDay lunch — auto minutes: <5h→0, 5–<11h→60, ≥11h→90.
  // ---------------------------------------------------------------------------

  function autoLunchMinutes(h) { return PayEngine.lunchMinutesFor(h, PayEngine.profileLunchDefault(profile)); }

  // lunchSummary port — "60m lunch at 12:30 PM", "60m lunch & 30m second lunch
  // at 12:30 PM & 5:00 PM", "no lunch".
  function lunchSummary(day) {
    if (!day || !(day.lunchMinutes > 0)) return "no lunch";
    const mins = day.lunchMinutes;
    const t1 = day.lunchStart ? fmtTime(new Date(day.lunchStart)) : null;
    const t2 = day.secondLunchStart ? fmtTime(new Date(day.secondLunchStart)) : null;
    if (mins >= 90 && t2) return "60m lunch & 30m second lunch at " + t1 + " & " + t2;
    if (t1) return mins + "m lunch at " + t1;
    return mins + "m lunch";
  }

  // ---------------------------------------------------------------------------
  // Blob access
  // ---------------------------------------------------------------------------

  async function getBlobData() {
    const b = await SyncEngine.getLocalBackup().catch(() => null);
    return (b && b.data) || {};
  }
  async function getShifts() {
    const d = await getBlobData();
    const s = Array.isArray(d.shifts) ? d.shifts : [];
    return s.slice().sort((a, b) => new Date(a.start) - new Date(b.start));
  }
  async function getProfile() { return (await getBlobData()).profile || {}; }
  // data.days is an ARRAY of WorkDay (keyed by id) — index it by day key.
  function indexDays(list) {
    const map = {};
    (Array.isArray(list) ? list : Object.values(list || {})).forEach(d => { if (d && d.id) map[d.id] = d; });
    return map;
  }
  async function getDay(dayKey) { return indexDays((await getBlobData()).days)[dayKey] || null; }
  async function getDays() { return indexDays((await getBlobData()).days); }
  const I = (n, o) => (typeof Icon === "function" ? Icon(n, o) : "");
  async function getContacts() {
    const d = await getBlobData();
    return Array.isArray(d.contacts) ? d.contacts : [];
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  let weekStart = startOfWeek(new Date());
  let selectedDayKey = dayKeyOf(new Date());
  let shifts = [];      // active shifts (removal tombstones filtered out)
  let vault = [];       // private coworker schedule vault (Batch 31)
  let contactsCache = [];
  let allShifts = [];   // everything in the blob, tombstones included (ICS merge, overlap guard)
  let profile = {};
  let days = {};
  let table = null;
  let syncing = false;
  let syncMessage = "";

  const DEFAULT_REMINDERS = {
    leaveForWorkEnabled: true, leaveForWorkMinutesBefore: 45,
    shiftStartEnabled: true, shiftStartMinutesBefore: 15,
    logSalesEnabled: true, logSalesMinutesAfter: 10,
    paydayRecapEnabled: true, buddyNudgeEnabled: true, buddyOnShiftEnabled: true,
  };
  function reminders() { return Object.assign({}, DEFAULT_REMINDERS, profile.reminders || {}); }

  // ---------------------------------------------------------------------------
  // Week strip — month title, Today button, 7 chips, Prev/Next
  // ---------------------------------------------------------------------------

  function weekStripHTML() {
    const todayKey = dayKeyOf(new Date());
    const monthTitle = weekStart.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    const chips = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart); d.setDate(d.getDate() + i);
      const key = dayKeyOf(d);
      const dayShifts = shifts.filter(sh => shiftDayKey(sh) === key);
      const isSel = key === selectedDayKey, isToday = key === todayKey;
      const logged = days[key] && Array.isArray(days[key].tickets) && days[key].tickets.length;
      const meta = dayShifts.length
        ? fmtTime(new Date(dayShifts[0].start)).replace(":00", "").replace(/\s/g, "").toLowerCase() + "–" +
          fmtTime(new Date(dayShifts[dayShifts.length - 1].end)).replace(":00", "").replace(/\s/g, "").toLowerCase()
        : "Off";
      chips.push(
        '<button class="week-chip' + (isSel ? " selected" : "") + (isToday ? " today" : "") +
        '" data-day="' + key + '">' +
        '<span class="wc-dow">' + d.toLocaleDateString(undefined, { weekday: "short" }).toUpperCase() + "</span>" +
        '<span class="wc-num">' + d.getDate() + "</span>" +
        '<span class="wc-meta">' + esc(meta) + "</span>" +
        '<span class="wc-dots">' + (dayShifts.length ? '<span class="wc-dot"></span>' : "") +
        (logged ? '<span class="wc-dot money"></span>' : "") + "</span>" +
        "</button>"
      );
    }
    return (
      '<div class="week-head"><button class="icon-btn" id="wk-prev" aria-label="Previous week">' + I("chevron-left") + "</button>" +
      '<div class="week-month">' + esc(monthTitle) + "</div>" +
      '<button class="icon-btn" id="wk-next" aria-label="Next week">' + I("chevron-right") + "</button>" +
      '<span class="spacer"></span><button class="btn ghost sm" id="wk-today">Today</button></div>' +
      '<div class="week-strip">' + chips.join("") + "</div>"
    );
  }

  // ---------------------------------------------------------------------------
  // Shift cards
  // ---------------------------------------------------------------------------

  function shiftPills(sh) {
    const out = [];
    if (isOpeningShift(sh)) out.push('<span class="pill amber">Opening</span>');
    if (isClosingShift(sh)) out.push('<span class="pill navy">Closing</span>');
    out.push('<span class="pill navy">' + shiftHours(sh).toFixed(1) + " h</span>");
    if (sh.isManual) out.push('<span class="pill manual">Manual</span>');
    return out.join("");
  }

  function shiftCardHTML(sh) {
    // The app always shows the full card (header, lunch editor, crew row) —
    // the card itself is not a button. Pencil opens the edit sheet.
    let h = '<div class="shift-card" data-shift="' + esc(sh.id) + '">';
    h += '<div class="shift-head"><div class="shift-head-main">' +
      '<div class="s-time">' + esc(fmtTimeRange(ShiftMath.workedStart(sh), ShiftMath.workedEnd(sh))) + "</div>" +
      (ShiftMath.hasActualHours(sh) ? '<div class="li-sub">Posted ' + esc(fmtTimeRange(sh.start, sh.end)) + " · you worked the hours above</div>" : "") +
      '<div class="s-title">' + esc(sh.title || "Shift") +
      (sh.location ? " · " + esc(sh.location) : "") + "</div>" +
      "</div>" +
      '<div class="shift-head-side"><div class="s-pills">' + shiftPills(sh) + "</div>" +
      '<button class="icon-btn" data-act="edit-shift" title="Edit shift and lunch break times" aria-label="Edit shift">' + I("edit") + '</button>' +
      "</div></div>";
    h += '<div class="shift-divider"></div>';
    h += '<div class="shift-lunch" data-lunch-day="' + shiftDayKey(sh) + '" data-lunch-shift="' + esc(sh.id) + '"></div>';
    h += '<div class="shift-divider"></div>';
    h += '<div class="shift-crew" data-crew-shift="' + esc(sh.id) + '"></div>';
    if (sh.isManual) {
      h += '<button class="btn ghost danger sm" data-act="delete-shift">' + I("trash") + ' Remove shift</button>';
    }
    return h + "</div>";
  }

  // ---------------------------------------------------------------------------
  // Lunch editor — LunchTimesEditor port.
  // Times on the WorkDay. Auto minutes from shift hours. States:
  //  empty → "Add time" pill (seeds mid-shift, saves immediately, opens picker)
  //  picker → saves on every change
  //  locked → read-only pills + "Locked — edit with the pencil above"
  // ---------------------------------------------------------------------------

  // Tracks shifts whose lunch was just seeded this session (stays editable).
  const lunchJustSeeded = new Set();

  async function renderLunchEditor(el) {
    const dayKey = el.dataset.lunchDay;
    const shiftId = el.dataset.lunchShift;
    const sh = shifts.find(s => s.id === shiftId);
    if (!sh) { el.innerHTML = ""; return; }
    const hrs = shiftHours(sh);
    const mins = autoLunchMinutes(hrs);
    const day = days[dayKey] || {};
    const t1 = day.lunchStart, t2 = day.secondLunchStart;
    const locked = !!(t1 && !lunchJustSeeded.has(shiftId));

    let h = '<div class="lunch-editor">';
    if (mins === 0) {
      h += '<div class="li-sub">Under 5 hours — no lunch break.</div>';
    } else {
      const two = hrs >= 11;
      if (!locked) {
        h += lunchPickerRow("Lunch at", t1, dayKey, "lunchStart", mins, hrs, sh);
        if (two) h += lunchPickerRow("Second lunch at", t2, dayKey, "secondLunchStart", mins, hrs, sh);
        h += '<div class="li-sub">' + lunchFooter(hrs) + "</div>";
      } else {
        h += '<div class="lunch-row"><span>Lunch at</span>' +
          '<span class="pill time-pill">' + I("lock", { size: 13 }) + ' ' + esc(fmtTime(new Date(t1))) + "</span></div>";
        if (two && t2) {
          h += '<div class="lunch-row"><span>Second lunch at</span>' +
            '<span class="pill time-pill">' + I("lock", { size: 13 }) + ' ' + esc(fmtTime(new Date(t2))) + "</span></div>";
        }
        h += '<div class="li-sub">' + I("lock", { size: 13 }) + ' Locked — edit with the pencil above</div>';
      }
    }
    el.innerHTML = h + "</div>";

    if (mins > 0 && !locked) {
      bindLunchInput(el, dayKey, "lunchStart", mins, sh, "lunch-pick-1");
      if (hrs >= 11) bindLunchInput(el, dayKey, "secondLunchStart", mins, sh, "lunch-pick-2");
      const addBtn = el.querySelector("[data-lunch-add]");
      if (addBtn) addBtn.onclick = () => seedLunch(sh, dayKey, mins);
    }
  }

  function lunchFooter(hrs) {
    const h = Math.round(hrs);
    const m = autoLunchMinutes(hrs);
    if (hrs >= 11) return h + "h shift — lunch plus a second meal, " + m + " minutes total deducted.";
    if (!m) return h + "h shift — no lunch deducted.";
    return h + "h shift — one " + m + "-minute lunch auto-deducted.";
  }

  function lunchPickerRow(label, iso, dayKey, field, mins, hrs, sh) {
    if (!iso) {
      return '<div class="lunch-row"><span>' + esc(label) + "</span>" +
        '<button class="pill add-pill" data-lunch-add>' + I("plus", { size: 13 }) + ' Add time</button></div>';
    }
    const d = new Date(iso);
    const v = pad(d.getHours()) + ":" + pad(d.getMinutes());
    return '<div class="lunch-row"><span>' + esc(label) + "</span>" +
      '<input type="time" class="time-input" data-lunch-field="' + field + '" value="' + v + '"></div>';
  }

  // "Add time": seed the picker at mid-shift and SAVE IMMEDIATELY, then the
  // row stays editable for this session (spec §5).
  async function seedLunch(sh, dayKey, mins) {
    const start = new Date(sh.start);
    const mid = new Date(start.getTime() + shiftHours(sh) * 30 * 6e4);
    mid.setSeconds(0, 0);
    lunchJustSeeded.add(sh.id);
    try {
      await SyncEngine.queueWrite({
        type: "updateDay", dayId: dayKey,
        updates: { lunchMinutes: mins, lunchStart: SB.isoSeconds(mid) },
      });
      days[dayKey] = Object.assign({}, days[dayKey], { lunchMinutes: mins, lunchStart: SB.isoSeconds(mid) });
      refresh();
    } catch (e) { alert("Couldn't save lunch time."); }
  }

  function bindLunchInput(el, dayKey, field, mins, sh, tag) {
    const input = el.querySelector('[data-lunch-field="' + field + '"]');
    if (!input) return;
    input.addEventListener("change", async () => {
      const v = input.value;
      if (!v) return;
      const [hh, mm] = v.split(":").map(Number);
      const d = parseDayKey(dayKey);
      d.setHours(hh, mm, 0, 0);
      const updates = { lunchMinutes: mins };
      updates[field] = SB.isoSeconds(d);
      // Shortening below 5h clears the break; below 11h clears second lunch.
      const hrs = shiftHours(sh);
      if (hrs < 5) { updates.lunchMinutes = 0; updates.lunchStart = null; updates.secondLunchStart = null; }
      else if (hrs < 11 && field === "secondLunchStart") { updates.secondLunchStart = null; }
      try {
        await SyncEngine.queueWrite({ type: "updateDay", dayId: dayKey, updates });
        days[dayKey] = Object.assign({}, days[dayKey], updates);
        // stay in this session's editable mode
      } catch (e) { alert("Couldn't save lunch time."); }
    });
  }

  // ---------------------------------------------------------------------------
  // Crew editor — CoworkersRow + "Working With" sheet port.
  // Card row: up to 4 with overlap summaries, +N more, Add/Edit button.
  // Sheet: search "Add a name…", 4 suggestions, hours step
  // (Same as me / Their hours), "Add to your Coworkers?" alert.
  // ---------------------------------------------------------------------------

  function crewRowHTML(sh) {
    const crew = Array.isArray(sh.coworkers) ? sh.coworkers : [];
    let h = '<div class="crew-editor"><div class="crew-head"><span class="section-title">Working with</span>' +
      '<button class="btn ghost sm" data-crew-open>' + (crew.length ? I("edit", { size: 14 }) + " Edit" : I("plus", { size: 14 }) + " Add") + "</button></div>";
    if (!crew.length) {
      h += '<button class="li-sub crew-empty" data-crew-open>Who\'s on this shift with you? Tap to add people.</button>';
    } else {
      const shown = crew.slice(0, 6);
      h += '<div class="crew-list">';
      shown.forEach(c => {
        const nm = typeof c === "string" ? c : (c.name || "");
        const obj = typeof c === "string" ? { name: nm } : c;
        const ov = overlapSummary(sh, obj);
        h += '<button class="crew-row" data-crew-open>' +
          crewAvatar(nm, 34) +
          '<span class="crew-name">' + esc(nm) + "</span>" +
          (ov ? '<span class="li-sub">' + esc(ov) + "</span>" : "") +
          "</button>";
      });
      h += "</div>";
      if (crew.length > 6) h += '<button class="link-btn" data-crew-open style="margin-top:8px">+' + (crew.length - 6) + " more</button>";
    }
    return h + "</div>";
  }

  /// Coworker photo when the name matches a saved coworker, else initials.
  function crewAvatar(name, size) {
    if (window.CoworkersUI && CoworkersUI.avatarForName) return CoworkersUI.avatarForName(name, size);
    return '<span class="avatar">' + esc(initials(name)) + "</span>";
  }

  function initials(name) {
    return String(name || "").trim().split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase() || "?";
  }

  // ---- Auto Working With (Batch 24, ScheduleView.refreshMirror) ----
  const mirrorCache = {}; // shift id + times -> {path, coworkers, asOf}
  function mirrorFreshness(asOf) {
    if (!asOf) return "";
    const d = new Date(String(asOf).slice(0, 10) + "T12:00:00Z");
    return isNaN(d) ? "" : "schedule as of " + d.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  }
  async function loadMirror(sh) {
    const key = sh.id + "|" + sh.start + "|" + sh.end;
    if (mirrorCache[key]) return mirrorCache[key];
    const r = await SB.mcpTool("get_coworkers", {
      date: ShiftMath.shiftDayKey(sh), shift_start: ShiftMath.clockLabel(sh.start),
      shift_end: ShiftMath.clockLabel(sh.end), self_name: profile.name || "" });
    let snap;
    if (!r.ok) snap = { path: "manual" };
    else if (r.payload.status === "unavailable" || r.payload.status === "stale") snap = { path: "unavailable", asOf: r.payload.as_of };
    else snap = { path: "automatic", coworkers: r.payload.coworkers || [], asOf: r.payload.as_of };
    if (r.ok || r.reason === "unconfigured") mirrorCache[key] = snap; // transport errors retry next render
    return snap;
  }
  function mirrorHTML(sh, snap) {
    const foot = '<div class="li-sub">Working With shows General Sales floor coworkers.</div>';
    const fresh = mirrorFreshness(snap.asOf);
    if (snap.path === "unavailable") return '<div class="crew-auto"><div class="label">Working With</div><div class="amber">schedule unavailable</div>' + (fresh ? '<div class="li-sub">' + esc(fresh) + "</div>" : "") + foot + "</div>";
    const crew = snap.coworkers || [];
    let h = '<div class="crew-auto"><div class="label">Working With · automatic</div>' + (fresh ? '<div class="li-sub navy">' + esc(fresh) + "</div>" : "");
    if (!crew.length) h += '<div class="li-sub">Nobody on General Sales shares this shift.</div>';
    crew.forEach(m => {
      const name = ShiftMath.displayForMirror(m.employee_name, contactsCache);
      const ov = ShiftMath.overlapSummary(sh, { name, start: m.start, end: m.end });
      h += '<div class="list-item"><div class="li-main">' + esc(name) + '<div class="li-sub">' + esc((m.start || "") + " – " + (m.end || "")) + (ov ? " · " + esc(ov) + " together" : "") + "</div></div></div>";
    });
    return h + foot + "</div>";
  }

  function renderCrewEditor(el) {
    const sh = shifts.find(s => s.id === el.dataset.crewShift);
    if (sh && usesScheduleMirror()) {
      el.innerHTML = '<div class="li-sub">Loading Working With…</div>';
      loadMirror(sh).then(snap => {
        if (snap.path === "manual") { el.innerHTML = crewRowHTML(sh); bindCrew(el, sh); }
        else el.innerHTML = mirrorHTML(sh, snap); // automatic never mixes in hand-typed names
      });
      return;
    }
    el.innerHTML = sh ? crewRowHTML(sh) : "";
    bindCrew(el, sh);
  }
  function bindCrew(el, sh) {
    el.querySelectorAll("[data-crew-open]").forEach(b => {
      b.onclick = ev => { ev.stopPropagation(); openCrewSheet(sh); };
    });
  }

  // "Working With" sheet
  let crewSheet = null;

  function openCrewSheet(sh) {
    closeCrewSheet();
    const crew = Array.isArray(sh.coworkers) ? sh.coworkers.slice() : [];
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML =
      '<div class="modal-card sheet"><div class="sheet-head"><h3>Working With</h3>' +
      '<button class="btn ghost sm" id="cw-done">Done</button></div>' +
      '<div class="li-sub">' + esc(sh.title || "Shift") + " · " + esc(fmtTimeRange(sh.start, sh.end)) + "</div>" +
      '<div class="crew-add"><input type="search" id="cw-q" placeholder="Add a name…" autocomplete="off">' +
      '<button class="btn ghost" id="cw-submit" disabled aria-label="Add">' + I("plus") + '</button></div>' +
      '<div class="crew-results" id="cw-r"></div>' +
      '<div id="cw-hours-step"></div>' +
      '<div class="crew-list" id="cw-list"></div></div>';
    document.body.appendChild(overlay);
    crewSheet = { overlay, sh, crew, pending: null };

    const renderList = () => {
      const list = overlay.querySelector("#cw-list");
      if (!crew.length) {
        list.innerHTML = '<div class="empty-state"><div class="li-sub">Nobody added yet</div>' +
          '<div class="li-sub">Start typing a name — pick from your Coworkers or add someone new.</div></div>';
        return;
      }
      list.innerHTML = crew.map((c, i) => {
        const nm = typeof c === "string" ? c : c.name;
        const obj = typeof c === "string" ? { name: nm } : c;
        const ov = overlapSummary(sh, obj);
        const sub = (obj.start || obj.end)
          ? esc((obj.start || "") + (obj.end ? "–" + obj.end : "") + (ov ? " · " + ov + " of your shift" : ""))
          : (ov ? esc(ov + " of your shift") : "");
        return '<div class="crew-row">' + crewAvatar(nm, 34) +
          '<span><b>' + esc(nm) + "</b>" + (sub ? '<br><span class="li-sub">' + sub + "</span>" : "") + "</span>" +
          '<button class="icon-btn danger" data-cw-del="' + i + '" aria-label="Remove">' + I("minus") + '</button></div>';
      }).join("");
      list.querySelectorAll("[data-cw-del]").forEach(b => {
        b.onclick = () => { crew.splice(+b.dataset.cwDel, 1); saveCrew(); renderList(); };
      });
    };

    const saveCrew = async () => {
      try {
        await SyncEngine.queueWrite({ type: "updateShift", shiftId: sh.id, updates: { coworkers: crew } });
        sh.coworkers = crew;
      } catch (e) { alert("Couldn't save crew."); }
    };
    crewSheet.saveCrew = saveCrew;
    crewSheet.renderList = renderList;

    const q = overlay.querySelector("#cw-q");
    const submit = overlay.querySelector("#cw-submit");
    q.addEventListener("input", () => {
      submit.disabled = !q.value.trim();
      renderSuggestions(q.value);
    });
    submit.onclick = () => submitCrewName(q.value);
    q.addEventListener("keydown", e => { if (e.key === "Enter" && q.value.trim()) submitCrewName(q.value); });
    overlay.querySelector("#cw-done").onclick = async () => { await saveCrew(); closeCrewSheet(); refresh(); };
    overlay.addEventListener("click", e => { if (e.target === overlay) closeCrewSheet(); });

    renderList();
    renderSuggestions("");
    setTimeout(() => q.focus(), 50);
  }

  function closeCrewSheet() {
    if (crewSheet) { crewSheet.overlay.remove(); crewSheet = null; }
  }

  async function renderSuggestions(query) {
    if (!crewSheet) return;
    const r = crewSheet.overlay.querySelector("#cw-r");
    const q = query.trim().toLowerCase();
    if (q.length < 1) { r.innerHTML = ""; return; }
    const contacts = await getContacts();
    const onCrew = new Set(crewSheet.crew.map(c =>
      (typeof c === "string" ? c : c.name || "").toLowerCase()));
    const matches = contacts
      .filter(c => c.name && !onCrew.has(c.name.toLowerCase()) &&
        (c.name.toLowerCase().includes(q) || (c.organization || "").toLowerCase().includes(q)))
      .slice(0, 4);
    r.innerHTML = matches.map(c =>
      '<button class="crew-result" data-cw-pick="' + esc(c.name) + '">' +
      crewAvatar(c.name, 34) +
      '<span>' + esc(c.name) + (c.phone ? '<br><span class="li-sub">' + esc(c.phone) + "</span>" : "") + "</span>" +
      '<span class="navy">' + I("plus") + '</span></button>'
    ).join("");
    r.querySelectorAll("[data-cw-pick]").forEach(b => {
      b.onclick = () => startHoursStep({ name: b.dataset.cwPick });
    });
  }

  async function submitCrewName(raw) {
    const name = raw.trim();
    if (!name || !crewSheet) return;
    const contacts = await getContacts();
    const exact = contacts.find(c => c.name && c.name.toLowerCase() === name.toLowerCase());
    if (exact) { startHoursStep({ name: exact.name }); return; }
    const q = name.toLowerCase();
    const sugg = contacts.find(c => c.name &&
      (c.name.toLowerCase().includes(q) || (c.organization || "").toLowerCase().includes(q)));
    if (sugg) { startHoursStep({ name: sugg.name }); return; }
    // "Add to your Coworkers?" alert
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = '<div class="modal-card"><h3>Add to your Coworkers?</h3>' +
      '<p>Save ' + esc(name) + ' to your Coworkers list, or just put them on this shift.</p>' +
      '<div class="btn-row"><button class="btn primary" id="cw-as">Add &amp; save</button>' +
      '<button class="btn" id="cw-just">Just this shift</button>' +
      '<button class="btn ghost" id="cw-cancel">Cancel</button></div></div>';
    document.body.appendChild(overlay);
    overlay.querySelector("#cw-cancel").onclick = () => overlay.remove();
    overlay.querySelector("#cw-just").onclick = () => { overlay.remove(); startHoursStep({ name }); };
    overlay.querySelector("#cw-as").onclick = async () => {
      overlay.remove();
      const parts = name.split(/\s+/);
      const contact = {
        id: uuid(), firstName: parts[0] || "", lastName: parts.slice(1).join(" "),
        name, createdAt: SB.isoSeconds(new Date()),
      };
      try {
        // addContact op may not exist yet — fall back to shift-only.
        await SyncEngine.queueWrite({ type: "addContact", contact }).catch(() => null);
      } catch (e) {}
      startHoursStep({ name });
    };
  }

  // Hours step: "Same as me" / "Their hours"
  function startHoursStep(person) {
    if (!crewSheet) return;
    const sh = crewSheet.sh;
    const step = crewSheet.overlay.querySelector("#cw-hours-step");
    const range = fmtTimeRange(sh.start, sh.end);
    step.innerHTML =
      '<div class="panel"><b>' + esc(person.name) + '</b><div class="li-sub">What hours do they work?</div>' +
      '<div class="seg-row">' +
      '<button class="seg-btn selected" data-hmode="same">Same as me</button>' +
      '<button class="seg-btn" data-hmode="theirs">Their hours</button></div>' +
      '<div class="li-sub" id="cw-same-label">' + I("clock", { size: 13 }) + ' Same shift as you: ' + esc(range) + "</div>" +
      '<div id="cw-their-times" hidden><div class="field-row2">' +
      '<div class="field"><label>Starts</label><input type="time" id="cw-ts" value="' +
      pad(new Date(sh.start).getHours()) + ":" + pad(new Date(sh.start).getMinutes()) + '"></div>' +
      '<div class="field"><label>Ends</label><input type="time" id="cw-te" value="' +
      pad(new Date(sh.end).getHours()) + ":" + pad(new Date(sh.end).getMinutes()) + '"></div>' +
      "</div></div>" +
      '<div class="btn-row"><button class="btn primary" id="cw-add2">Add to shift</button>' +
      '<button class="btn ghost" id="cw-x" aria-label="Cancel">' + I("close") + '</button></div></div>';

    let mode = "same";
    step.querySelectorAll("[data-hmode]").forEach(b => {
      b.onclick = () => {
        mode = b.dataset.hmode;
        step.querySelectorAll("[data-hmode]").forEach(x =>
          x.classList.toggle("selected", x === b));
        step.querySelector("#cw-their-times").hidden = mode !== "theirs";
        step.querySelector("#cw-same-label").style.display = mode === "same" ? "" : "none";
      };
    });
    step.querySelector("#cw-x").onclick = () => { step.innerHTML = ""; crewSheet.pending = null; };
    step.querySelector("#cw-add2").onclick = async () => {
      const entry = { name: person.name };
      if (mode === "theirs") {
        const ts = step.querySelector("#cw-ts").value, te = step.querySelector("#cw-te").value;
        if (ts) entry.start = fmtTime(parseTimeOnDay(ts, sh.start));
        if (te) entry.end = fmtTime(parseTimeOnDay(te, sh.start));
      } else {
        entry.start = fmtTime(new Date(sh.start));
        entry.end = fmtTime(new Date(sh.end));
      }
      if (crewSheet.crew.some(c =>
        (typeof c === "string" ? c : c.name || "").toLowerCase() === person.name.toLowerCase())) {
        step.innerHTML = ""; return;
      }
      crewSheet.crew.push(entry);
      await crewSheet.saveCrew();
      crewSheet.renderList();
      step.innerHTML = "";
      crewSheet.overlay.querySelector("#cw-q").value = "";
      crewSheet.overlay.querySelector("#cw-r").innerHTML = "";
    };
  }

  function parseTimeOnDay(hhmm, refISO) {
    const [h, m] = hhmm.split(":").map(Number);
    const d = new Date(refISO);
    d.setHours(h, m, 0, 0);
    return d;
  }

  // ---------------------------------------------------------------------------
  // Manual shift add/edit sheet — ManualShiftView port.
  // New defaults: 10:00 AM – 6:00 PM. Edit: "Your times win…".
  // ---------------------------------------------------------------------------

  function openShiftEditor(existing) {
    const isNew = !existing;
    let s, e;
    if (existing) { s = ShiftMath.workedStart(existing); e = ShiftMath.workedEnd(existing); }
    else {
      // Default on selected day (or today): 10:00 AM – 6:00 PM.
      s = parseDayKey(selectedDayKey); s.setHours(10, 0, 0, 0);
      e = parseDayKey(selectedDayKey); e.setHours(18, 0, 0, 0);
    }
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML =
      '<div class="modal-card"><h3>' + (isNew ? "Add Shift" : "Edit Shift") + "</h3>" +
      '<div class="field"><label>Date</label><input type="date" id="se-date" value="' + dayKeyOf(s) + '"></div>' +
      '<div class="field-row2">' +
      '<div class="field"><label>Starts</label><input type="time" id="se-start" value="' +
      pad(s.getHours()) + ":" + pad(s.getMinutes()) + '"></div>' +
      '<div class="field"><label>Ends</label><input type="time" id="se-end" value="' +
      pad(e.getHours()) + ":" + pad(e.getMinutes()) + '"></div>' +
      "</div>" +
      '<div class="field"><label>Title</label><input type="text" id="se-title" placeholder="Shift" value="' +
      esc(existing ? existing.title || "" : "") + '"></div>' +
      '<div class="field"><label>Location</label><input type="text" id="se-loc" value="' +
      esc(existing ? existing.location || "" : "") + '"></div>' +
      (isNew ? "" : existing.isManual
        ? '<div class="li-sub">Your times win — a UKG re-sync keeps this edit.</div>'
        : '<div class="li-sub">These are the hours you actually worked. The posted UKG schedule (' + esc(fmtTimeRange(existing.start, existing.end)) + ') stays on record, and pay uses your hours.</div>') +
      '<div class="form-status" id="se-err" hidden></div>' +
      '<div class="btn-row">' +
      '<button class="btn primary" id="se-save">' + (isNew ? "Add shift" : "Save changes") + "</button>" +
      '<button class="btn ghost" id="se-cancel">Cancel</button>' +
      "</div></div>";
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector("#se-cancel").onclick = close;
    overlay.addEventListener("click", ev => { if (ev.target === overlay) close(); });
    overlay.querySelector("#se-save").onclick = async () => {
      const d = overlay.querySelector("#se-date").value;
      const st = overlay.querySelector("#se-start").value;
      const en = overlay.querySelector("#se-end").value;
      const err = overlay.querySelector("#se-err");
      const start = new Date(d + "T" + st + ":00"), end = new Date(d + "T" + en + ":00");
      if (!d || !st || !en || isNaN(start) || isNaN(end) || end <= start) {
        err.textContent = "End time must come after the start.";
        err.hidden = false;
        return;
      }
      const title = overlay.querySelector("#se-title").value.trim() || "Shift";
      const location = overlay.querySelector("#se-loc").value.trim();
      // Overlap guard (ShiftLedger.overlap): never double-book a shift.
      const clash = ShiftMath.ShiftLedger.overlap(start, end, allShifts, isNew ? null : existing.id);
      if (clash) {
        err.textContent = ShiftMath.ShiftLedger.overlapMessage(clash) + " Edit or remove that shift first.";
        err.hidden = false;
        return;
      }
      try {
        if (isNew) {
          await SyncEngine.queueWrite({
            type: "addShift",
            shift: {
              id: uuid(), start: SB.isoSeconds(start), end: SB.isoSeconds(end),
              title, location, isManual: true, isEdited: false, coworkers: [],
            },
          });
        } else {
          await SyncEngine.queueWrite({
            type: "updateShift", shiftId: existing.id,
            updates: {
              start: SB.isoSeconds(start), end: SB.isoSeconds(end),
              title, location, isEdited: true,
            },
          });
        }
        close();
        await reload();
      } catch (ex) { alert("Couldn't save shift."); }
    };
  }

  async function deleteShiftFlow(sh) {
    const msg = sh.isManual
      ? "Delete this shift?\n\n" + fmtTimeRange(ShiftMath.workedStart(sh), ShiftMath.workedEnd(sh)) + " — this also deletes the lunch and crew saved on it."
      : "Mark this shift as missed?\n\n" + fmtTimeRange(sh.start, sh.end) + " — it stops counting toward pay, and a calendar re-sync won't bring it back. You can restore it from the day.";
    if (!confirm(msg)) return;
    try {
      await SyncEngine.queueWrite({ type: "deleteShift", shiftId: sh.id });
      await reload();
    } catch (e) { alert("Couldn't delete shift."); }
  }

  // ---------------------------------------------------------------------------
  // ICS sync — ICSService.swift port + exact mergeShifts
  // ---------------------------------------------------------------------------

  function normalizeICSURL(raw) {
    let u = String(raw || "").trim();
    if (/^webcal:\/\//i.test(u)) u = u.replace(/^webcal:\/\//i, "https://");
    try {
      const p = new URL(u);
      return /^https?:$/.test(p.protocol) ? u : null;
    } catch (e) { return null; }
  }

  function icsClean(s) {
    return String(s || "").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\n/gi, " ").trim();
  }

  function icsDate(value, params) {
    const v = String(value || "").trim();
    if (!v) return null;
    if (/Z$/i.test(v)) {
      const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/i.exec(v);
      return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null;
    }
    const tm = /TZID=([^;:]+)/i.exec(params || "");
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(v);
    if (m) {
      const Y = +m[1], Mo = +m[2] - 1, D = +m[3], h = +m[4], mi = +m[5], s = +m[6];
      if (tm) {
        const tz = tm[1];
        try {
          const asUTC = Date.UTC(Y, Mo, D, h, mi, s);
          const inTz = new Date(new Date(asUTC).toLocaleString("en-US", { timeZone: tz }));
          const inUTC = new Date(new Date(asUTC).toLocaleString("en-US", { timeZone: "UTC" }));
          return new Date(asUTC + (inUTC - inTz));
        } catch (e) { /* unknown TZ → device-local */ }
      }
      return new Date(Y, Mo, D, h, mi, s);
    }
    const d8 = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
    return d8 ? new Date(+d8[1], +d8[2] - 1, +d8[3]) : null;
  }

  function parseICS(text) {
    const unfolded = String(text || "")
      .replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").replace(/\r\n/g, "\n");
    const events = [];
    let cur = null;
    for (const line of unfolded.split("\n")) {
      if (line === "BEGIN:VEVENT") { cur = {}; continue; }
      if (line === "END:VEVENT") { if (cur) events.push(cur); cur = null; continue; }
      if (!cur) continue;
      const ci = line.indexOf(":");
      if (ci < 0) continue;
      const rawKey = line.slice(0, ci), val = line.slice(ci + 1);
      const key = rawKey.split(";")[0];
      cur[key] = val;
      if (key === "DTSTART" || key === "DTEND") cur[key + "_PARAMS"] = rawKey;
    }
    const out = [];
    for (const ev of events) {
      const start = icsDate(ev.DTSTART, ev.DTSTART_PARAMS);
      const end = icsDate(ev.DTEND, ev.DTEND_PARAMS);
      if (!start || !end) continue;
      out.push({
        id: (ev.UID || "").trim() || uuid(),
        start: SB.isoSeconds(start), end: SB.isoSeconds(end),
        title: icsClean(ev.SUMMARY) || "Shift",
        location: icsClean(ev.LOCATION),
        isManual: false, isEdited: false, coworkers: [],
      });
    }
    out.sort((a, b) => new Date(a.start) - new Date(b.start));
    return out;
  }

  // Port of ShiftLedger.merge (Batch 29): posted times update; actual
  // hours, hand edits and removal tombstones survive; no duplicates.
  function mergeShifts(local, fetched) {
    return { merged: ShiftMath.ShiftLedger.merge(local, fetched, new Date()), fetchedCount: fetched.length };
  }

  async function syncCalendar(quiet) {
    const url = (profile.icsURL || "").trim();
    if (!url) { if (!quiet) { syncMessage = "Add your UKG calendar link first."; refresh(); } return; }
    const norm = normalizeICSURL(url);
    if (!norm) { if (!quiet) { syncMessage = "That doesn't look like a valid calendar link."; refresh(); } return; }
    if (syncing) return;
    syncing = true;
    if (!quiet) { syncMessage = ""; refresh(); }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      let res;
      try { res = await fetch(norm, { signal: ctrl.signal }); }
      finally { clearTimeout(timer); }
      if (!res.ok) throw new Error("Couldn't reach the calendar: server responded " + res.status + ".");
      const fetched = parseICS(await res.text());
      if (!fetched.length) throw new Error("The calendar loaded but had no shifts in it.");
      const { merged } = mergeShifts(allShifts, fetched);
      for (const s of allShifts.filter(x => !merged.some(m => m.id === x.id))) {
        await SyncEngine.queueWrite({ type: "deleteShift", shiftId: s.id, hard: true });
      }
      for (const m of merged) {
        const prev = allShifts.find(s => s.id === m.id);
        if (prev) {
          if (JSON.stringify(prev) === JSON.stringify(m)) continue;
          const upd = Object.assign({}, m);
          // A key the ledger dropped must be cleared, not left behind.
          ["actualStart", "actualEnd", "ukgIdentifier"].forEach(k => { if (!(k in upd) && (k in prev)) upd[k] = null; });
          await SyncEngine.queueWrite({ type: "updateShift", shiftId: m.id, updates: upd, feed: true });
        } else {
          await SyncEngine.queueWrite({ type: "addShift", shift: m });
        }
      }
      allShifts = merged; shifts = merged.filter(x => !x.isRemoved);
      const nowISO = SB.isoSeconds(new Date());
      await SyncEngine.queueWrite({
        type: "updateProfile", updates: { icsURL: url, lastSyncedAt: nowISO },
      }).catch(() => {});
      profile.icsURL = url; profile.lastSyncedAt = nowISO;
      syncMessage = "Synced " + fetched.length + " shifts.";
      refreshReminders();
    } catch (e) {
      if (!quiet) syncMessage = e.message || "Sync failed.";
    } finally {
      syncing = false;
      if (!quiet) refresh();
    }
  }

  // ---------------------------------------------------------------------------
  // Reminders — Notification API, per-shift fire times
  // ---------------------------------------------------------------------------

  function reminderStatus() {
    return ("Notification" in window) ? Notification.permission : "unsupported";
  }
  async function ensureNotificationPermission() {
    if (!("Notification" in window)) return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") return false;
    try { return (await Notification.requestPermission()) === "granted"; }
    catch (e) { return false; }
  }

  function computeReminders() {
    const r = reminders(), now = Date.now(), out = [];
    const upcoming = shifts.filter(s => new Date(s.end).getTime() > now - 36e5)
      .sort((a, b) => new Date(a.start) - new Date(b.start)).slice(0, 30);
    for (const sh of upcoming) {
      const start = new Date(sh.start).getTime(), end = new Date(sh.end).getTime();
      const label = (sh.title || "Shift") + " " + fmtTimeRange(sh.start, sh.end);
      if (r.leaveForWorkEnabled)
        out.push({ at: new Date(start - r.leaveForWorkMinutesBefore * 6e4),
          title: "Leave for work", body: label + " — time to head out." });
      if (r.shiftStartEnabled)
        out.push({ at: new Date(start - r.shiftStartMinutesBefore * 6e4),
          title: "Shift starting", body: label + " — clock in soon." });
      if (r.logSalesEnabled) {
        const mins = r.logSalesMinutesAfter;
        out.push({ at: new Date(end + mins * 6e4), title: "Log your sales",
          body: mins === 0 ? "Shift over — log the day." : "Shift ended " + mins + "m ago — log the day." });
      }
    }
    return out.filter(x => x.at.getTime() > now).sort((a, b) => a.at - b.at);
  }

  let reminderTimers = [];
  function refreshReminders() {
    reminderTimers.forEach(clearTimeout); reminderTimers = [];
    if (reminderStatus() !== "granted") return;
    const horizon = Date.now() + 12 * 36e5; // best-effort while page is open
    for (const rm of computeReminders()) {
      const t = rm.at.getTime();
      if (t > horizon) break;
      reminderTimers.push(setTimeout(() => {
        try { new Notification(rm.title, { body: rm.body }); } catch (e) {}
      }, Math.max(0, t - Date.now())));
    }
  }

  // ---------------------------------------------------------------------------
  // "Coming up" — next 8 shifts
  // ---------------------------------------------------------------------------

  function crewLine(sh) {
    const crew = (sh.coworkers || []).map(c => typeof c === "string" ? c : c.name).filter(Boolean);
    if (!crew.length) return "";
    const shown = crew.slice(0, 4).join(", ");
    return "With " + shown + (crew.length > 4 ? " +" + (crew.length - 4) + " more" : "");
  }

  function comingUpHTML() {
    const now = Date.now();
    const next = shifts.filter(s => new Date(s.end).getTime() > now)
      .sort((a, b) => new Date(a.start) - new Date(b.start)).slice(0, 10);
    let h = '<div class="sec-head"><div class="grow"><div class="sec-title">Coming up</div><div class="sec-sub">Your next shifts</div></div></div>';
    if (!next.length) {
      return h + '<div class="empty-state"><div class="empty-ico">' + I("calendar", { size: 30 }) + '</div><div class="t">No upcoming shifts</div>' +
        '<p>Link your UKG calendar in Settings &gt; Workday to fill this in.</p></div>';
    }
    h += '<div class="coming-up">';
    next.forEach(sh => {
      const d = new Date(sh.start);
      const day = days[shiftDayKey(sh)] || {};
      const lunch = lunchSummary(day);
      h += '<button class="coming-row' + (shiftDayKey(sh) === selectedDayKey ? " selected" : "") + '" data-jump-week="' + dayKeyOf(d) + '" data-shift="' + esc(sh.id) + '">' +
        '<span class="cu-date"><span class="cu-mon">' +
        d.toLocaleDateString(undefined, { month: "short" }).toUpperCase() + "</span>" +
        '<span class="cu-day">' + d.getDate() + "</span></span>" +
        '<span class="cu-main"><span class="cu-dow">' +
        d.toLocaleDateString(undefined, { weekday: "long" }) + "</span>" +
        '<span class="cu-time">' + esc(fmtTimeRange(sh.start, sh.end)) + "</span>" +
        (crewLine(sh) ? '<span class="cu-crew">' + I("users", { size: 12 }) + " " + esc(crewLine(sh)) + "</span>" : "") +
        (lunch !== "no lunch" ? '<span class="li-sub amber">' + esc(lunch) + "</span>" : "") +
        '</span><span class="cu-hours">' + shiftHours(sh).toFixed(1) + "h</span></button>";
    });
    return h + "</div>";
  }

  // ---------------------------------------------------------------------------
  // Selected-day section — date header, shifts, View-day link
  // ---------------------------------------------------------------------------

  function selectedDayHTML() {
    const d = parseDayKey(selectedDayKey);
    const dayShifts = shifts.filter(sh => shiftDayKey(sh) === selectedDayKey)
      .sort((a, b) => new Date(a.start) - new Date(b.start));
    let h = '<div class="sec-head"><div class="grow"><div class="sec-title">' +
      esc(d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })) + "</div>" +
      '<div class="sec-sub">' + (dayShifts.length
        ? dayShifts.length + " shift" + (dayShifts.length > 1 ? "s" : "")
        : "No shift scheduled") + "</div></div>" +
      '<button class="btn ghost sm" id="sel-add">' + I("plus", { size: 14 }) + " Add shift</button></div>";
    if (!dayShifts.length) {
      h += '<div class="empty-state"><div class="empty-ico">' + I("moon", { size: 30 }) + '</div><div class="t">Day off</div>' +
        '<p>Nothing scheduled. Enjoy it — or add a shift manually.</p></div>';
    } else {
      h += dayShifts.map(shiftCardHTML).join("");
    }
    // Removal tombstones (ShiftLedger.disclosedRemovals): say so, offer Restore.
    for (const r of ShiftMath.ShiftLedger.disclosedRemovals(selectedDayKey, allShifts)) {
      h += '<div class="shift-card removed" data-shift="' + esc(r.id) + '"><div class="shift-head"><div class="shift-head-main">' +
        '<div class="s-time">' + esc(fmtTimeRange(r.start, r.end)) + '</div><div class="s-title">Marked missed · not counted toward pay</div></div>' +
        '<div class="shift-head-side"><button class="btn ghost sm" data-act="restore-shift" data-restore="' + esc(r.id) + '">Restore</button></div></div></div>';
    }
    // Gear checkout (Batch 27) — same place as the app's Schedule day.
    if (dayShifts.length) h += '<div class="panel gear-panel">' + GearUI.html(selectedDayKey, days[selectedDayKey]) + "</div>";
    // "View day" link when the day has logged sales (WorkDay keyed by id).
    const day = days[selectedDayKey];
    if (day && Array.isArray(day.tickets) && day.tickets.length) {
      const commission = PayEngine.dayCommission(day, table || PayEngine.tableForProfile(profile));
      h += '<button class="view-day-row" data-view-day="' + selectedDayKey + '">' +
        '<span>' + I("cash", { size: 16 }) + ' <b class="' + (commission < -0.005 ? "red" : "money") + '">' + esc(money(commission)) + '</b> earned · ' +
        day.tickets.length + " ticket" + (day.tickets.length === 1 ? "" : "s") + "</span>" +
        '<span class="navy">View day ' + I("chevron-right", { size: 14 }) + "</span></button>";
    }
    return h;
  }

  // ---------------------------------------------------------------------------
  // Workday settings — UKG calendar, holidays, reminders.
  // Rendered inside Settings > Workday (not on the Schedule page).
  // ---------------------------------------------------------------------------

  const LEAVE_OPTS = [20, 30, 45, 60, 90];
  const START_OPTS = [5, 10, 15, 30];
  const LOG_OPTS = [0, 10, 30, 60];
  let settingsBox = null;
  let settingsSection = "schedule"; // Settings > Workday > Schedule | Reminders

  function lastSyncText() {
    if (!(profile.icsURL || "").trim()) return "No calendar linked yet";
    if (!profile.lastSyncedAt) return "Never synced";
    const d = new Date(profile.lastSyncedAt);
    return "Last synced " + d.toLocaleDateString(undefined, { weekday: "short" }) +
      " at " + fmtTime(d) + " · " + shifts.length + " shifts";
  }

  /// One-line summaries for the Workday hub rows.
  function remindersSummary() {
    const r = reminders();
    const n = ["leaveForWorkEnabled", "shiftStartEnabled", "logSalesEnabled", "paydayRecapEnabled", "buddyNudgeEnabled"].filter(k => r[k]).length;
    return n ? n + " reminder" + (n === 1 ? "" : "s") + " on" : "All reminders off";
  }

  // UserProfile.canEnableAutoWorkingWith / usesScheduleMirror (ScheduleMirror.swift).
  function canAutoWorkingWith() {
    return !!String(profile.icsURL || "").trim() && /^(tustin)$/i.test(String(profile.icsStore || "").trim());
  }
  function usesScheduleMirror() { return canAutoWorkingWith() && !!profile.autoWorkingWith; }
  function renderSettingsAgain() { try { if (settingsBox) renderSettings(settingsBox, settingsSection); } catch (e) {} }

  function settingsHTML() {
    const icsURL = profile.icsURL || "";
    let h = '<div class="grid">';
    h += '<div class="panel col-6"><div class="sec-head"><div class="grow"><div class="sec-title">UKG calendar</div>' +
      '<div class="sec-sub">Paste your iCal subscription link</div></div></div>' +
      '<div class="field"><input type="url" id="ics-url" value="' + esc(icsURL) +
      '" placeholder="https://…/schedule.ics" autocomplete="off" spellcheck="false"></div>' +
      '<div class="btn-row" style="margin-top:10px"><button class="btn primary" id="ics-sync"' +
      (syncing || !icsURL.trim() ? " disabled" : "") + ">" + I("refresh") + " " +
      (syncing ? "Syncing…" : "Sync schedule now") + "</button></div>" +
      (syncMessage ? '<div class="form-status">' + esc(syncMessage) + "</div>" : "") +
      '<div class="kv-row"><span class="k muted">' + I("clock", { size: 14 }) + " " + esc(lastSyncText()) + "</span></div>" +
      '<div class="hint">Lunch is automatic: none under 5h, your default lunch (' + PayEngine.profileLunchDefault(profile) + ' min) on 5–11h shifts, ' +
      "and a 60-minute lunch plus a 30-minute second meal on 11h+ shifts. Set the times on each shift in Schedule.</div></div>";
    // Auto Working With (Batch 24) — only when the UKG feed says Tustin.
    const eligible = canAutoWorkingWith();
    const on = eligible && !!profile.autoWorkingWith;
    h += '<div class="panel col-6"><div class="switch-row"><div class="grow"><div class="sec-title">Auto Working With</div>' +
      '<div class="sec-sub">' + esc(!eligible ? "Auto Working With is only available at Tustin." : on ? "Coworkers come from the Tustin schedule." : "Off. You add coworkers by hand.") + "</div></div>" +
      '<label class="switch"><input type="checkbox" id="auto-ww" role="switch" aria-label="Auto Working With"' + (on ? " checked" : "") + (eligible ? "" : " disabled") + '><span></span></label></div></div>';

    const nHol = holidayDates.length;
    h += '<div class="panel col-6"><div class="sec-head"><div class="grow"><div class="sec-title">Holiday hours</div>' +
      '<div class="sec-sub">' + (nHol ? nHol + " date" + (nHol === 1 ? "" : "s") + " with Sunday hours" : "Weekdays that open 11 AM–6 PM") +
      '</div></div></div><div id="hol-editor"></div></div>';

    h += "</div>";
    return h;
  }

  function remindersHTML() {
    const r = reminders();
    let h = '<div class="grid">';
    h += '<div class="panel col-12"><div class="sec-head"><div class="grow"><div class="sec-title">Reminders</div>' +
      '<div class="sec-sub">Browser notifications while this dashboard is open</div></div>' +
      '<button class="btn primary sm" id="rem-save">' + I("check", { size: 14 }) + ' Save reminders</button></div>';
    const perm = reminderStatus();
    if (perm === "denied") {
      h += '<div class="warn-banner">Notifications are off. Turn them on in your browser settings to get reminders.</div>';
    } else if (perm === "default") {
      h += '<div class="btn-row" style="margin-bottom:10px"><button class="btn ghost sm" id="notif-enable">' + I("bell", { size: 14 }) + ' Enable notifications</button></div>';
    } else if (perm === "unsupported") {
      h += '<div class="warn-banner">This browser does not support notifications.</div>';
    }
    h += '<div class="grid" style="gap:0 var(--gap)"><div class="col-6">';
    h += reminderRowHTML("leaveForWorkEnabled", "Leave for work", "Heads-up before you need to head out",
      r, "leaveForWorkMinutesBefore", LEAVE_OPTS, "before");
    h += reminderRowHTML("shiftStartEnabled", "Shift starting", "A nudge right before you clock in",
      r, "shiftStartMinutesBefore", START_OPTS, "before");
    h += reminderRowHTML("logSalesEnabled", "Log your sales", "After your shift ends, log the day",
      r, "logSalesMinutesAfter", LOG_OPTS, "after");
    h += '</div><div class="col-6"><div class="label" style="margin:10px 0 2px">Proactive</div>' +
      '<div class="sec-sub">Buddy speaks up on his own</div>';
    h += simpleToggleRow("paydayRecapEnabled", "Payday recap", "Payday morning: what the finished period paid you", r);
    h += simpleToggleRow("buddyNudgeEnabled", "Weekly nudge", "Monday morning: how last week went vs the week before", r);
    h += "</div></div></div></div>";
    return h;
  }

  function reminderRowHTML(toggleKey, title, sub, r, minKey, opts, suffix) {
    const on = !!r[toggleKey];
    let h = '<div class="rem-row"><div class="switch-row"><span class="grow"><b>' + esc(title) +
      '</b><br><span class="li-sub">' + esc(sub) + "</span></span>" +
      '<label class="switch"><input type="checkbox" data-rem-toggle="' + toggleKey + '"' + (on ? " checked" : "") + "><span></span></label></div>";
    h += '<div class="opt-pills"' + (on ? "" : " hidden") + ' data-rem-pills="' + toggleKey + '">' + opts.map(o =>
      '<button class="opt-pill' + (r[minKey] === o ? " active" : "") +
      '" data-rem-min="' + minKey + '" data-val="' + o + '">' +
      (o === 0 && suffix === "after" ? "Right away" : o + "m " + suffix) + "</button>"
    ).join("") + "</div>";
    return h + "</div>";
  }

  function simpleToggleRow(key, title, sub, r) {
    return '<div class="rem-row"><div class="switch-row"><span class="grow"><b>' + esc(title) +
      '</b><br><span class="li-sub">' + esc(sub) + "</span></span>" +
      '<label class="switch"><input type="checkbox" data-rem-toggle="' + key + '"' +
      (r[key] ? " checked" : "") + "><span></span></label></div></div>";
  }

  function bindSettings(box) {
    const icsInput = box.querySelector("#ics-url");
    if (icsInput) icsInput.addEventListener("change", async () => {
      const v = icsInput.value.trim();
      try {
        await SyncEngine.queueWrite({ type: "updateProfile", updates: { icsURL: v } });
        profile.icsURL = v; syncMessage = "";
      } catch (e) { alert("Couldn't save calendar link."); }
      refresh();
    });
    const aww = box.querySelector("#auto-ww");
    if (aww) aww.onchange = async () => {
      if (!canAutoWorkingWith()) { aww.checked = false; return; }
      profile.autoWorkingWith = aww.checked;
      try { await SyncEngine.queueWrite({ type: "updateProfile", updates: { autoWorkingWith: aww.checked } }); } catch (e) {}
      renderSettingsAgain();
    };
    const syncBtn = box.querySelector("#ics-sync");
    if (syncBtn) syncBtn.onclick = () => syncCalendar(false);
    const notifBtn = box.querySelector("#notif-enable");
    if (notifBtn) notifBtn.onclick = async () => { await ensureNotificationPermission(); refresh(); };
    box.querySelectorAll("[data-rem-toggle]").forEach(t => {
      t.onchange = () => {
        const pills = box.querySelector('[data-rem-pills="' + t.dataset.remToggle + '"]');
        if (pills) pills.hidden = !t.checked;
      };
    });
    box.querySelectorAll("[data-rem-min]").forEach(pill => {
      pill.onclick = () => {
        const key = pill.dataset.remMin;
        box.querySelectorAll('[data-rem-min="' + key + '"]').forEach(p =>
          p.classList.toggle("active", p === pill));
      };
    });
    const saveBtn = box.querySelector("#rem-save");
    if (saveBtn) saveBtn.onclick = () => saveReminders(box);
    const hol = box.querySelector("#hol-editor");
    if (hol) renderHolidayEditor(hol);
  }

  async function saveReminders(box) {
    const r = Object.assign({}, reminders());
    box.querySelectorAll("[data-rem-toggle]").forEach(t => { r[t.dataset.remToggle] = t.checked; });
    box.querySelectorAll("[data-rem-min].active").forEach(p => { r[p.dataset.remMin] = +p.dataset.val; });
    try {
      await SyncEngine.queueWrite({ type: "updateProfile", updates: { reminders: r } });
      profile.reminders = r;
      if (await ensureNotificationPermission()) refreshReminders();
      if (typeof window.toast === "function") window.toast("Reminders saved"); else alert("Reminders saved.");
      refresh();
    } catch (e) { alert("Couldn't save reminders."); }
  }

  // ---------------------------------------------------------------------------
  // Holiday hours editor — HolidayHoursView port
  // ---------------------------------------------------------------------------

  function renderHolidayEditor(el) {
    const sorted = holidayDates.slice().sort();
    let h = '<div class="crew-add"><input type="date" id="hol-date"> ' +
      '<button class="btn primary sm" id="hol-add">' + I("plus", { size: 14 }) + ' Add holiday</button></div>';
    if (!sorted.length) {
      h += '<div class="hint">Certain holidays — like the Fourth of July — run Sunday hours ' +
        "on a weekday. Add each date and the app treats it like a Sunday.</div>";
    }
    h += '<div class="list">';
    sorted.forEach(dk => {
      const d = parseDayKey(dk);
      h += '<div class="list-item"><div class="li-main">' +
        esc(d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })) +
        '<div class="li-sub">11 AM–6 PM</div></div>' +
        '<button class="icon-btn danger" data-hol-remove="' + dk + '" title="Remove" aria-label="Remove">' + I("trash") + "</button></div>";
    });
    h += '</div><div class="hint">Sunday runs 11 AM–6 PM and every other day stays ' +
      "10 AM–9 PM — these dates just borrow the Sunday hours. Opening and closing pay follow automatically.</div>";
    el.innerHTML = h;

    const dateInput = el.querySelector("#hol-date");
    const addBtn = el.querySelector("#hol-add");
    const checkDup = () => {
      const v = dateInput.value;
      const dup = v && holidayDates.includes(v);
      addBtn.disabled = !v || dup;
      addBtn.innerHTML = dup ? I("check", { size: 14 }) + " Already saved" : I("plus", { size: 14 }) + " Add holiday";
    };
    dateInput.addEventListener("change", checkDup);
    checkDup();
    addBtn.onclick = () => {
      const v = dateInput.value;
      if (!v || holidayDates.includes(v)) return;
      updateHolidays(holidayDates.concat([v]).sort());
    };
    el.querySelectorAll("[data-hol-remove]").forEach(b => {
      b.onclick = () => updateHolidays(holidayDates.filter(x => x !== b.dataset.holRemove));
    });
  }

  async function updateHolidays(next) {
    try {
      await SyncEngine.queueWrite({ type: "setHolidayDates", dates: next });
      holidayDates = next;
      refresh();
    } catch (e) { alert("Couldn't save holidays."); }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  async function reload() {
    const data = await getBlobData();
    allShifts = (Array.isArray(data.shifts) ? data.shifts : [])
      .slice().sort((a, b) => new Date(a.start) - new Date(b.start));
    shifts = allShifts.filter(sh => !sh.isRemoved);
    vault = Array.isArray(data.scheduleVault) ? data.scheduleVault : [];
    contactsCache = Array.isArray(data.contacts) ? data.contacts : [];
    profile = data.profile || {};
    days = indexDays(data.days);
    table = PayEngine.tableForProfile(profile);
    holidayDates = Array.isArray(data.holidayDates) ? data.holidayDates.slice()
      : (Array.isArray(profile.holidayDates) ? profile.holidayDates.slice() : []);
    refresh();
  }

  function weekSummary() {
    let hrs = 0, n = 0;
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart); d.setDate(d.getDate() + i);
      const k = dayKeyOf(d);
      shifts.filter(sh => shiftDayKey(sh) === k).forEach(sh => { hrs += shiftHours(sh); n++; });
    }
    return n + " shift" + (n === 1 ? "" : "s") + " · " + hrs.toFixed(1) + " hrs this week";
  }

  function refresh() {
    const box = document.getElementById("sched-body");
    if (box) {
      let h = '<div class="page-head"><div><h2>Schedule</h2><div class="page-sub">' + esc(lastSyncText()) + "</div></div>" +
        '<div class="spacer"></div>' +
        '<button class="btn ghost" id="tb-settings">' + I("gear") + " Workday settings</button>" +
        '<button class="btn ghost" id="tb-sync"' + (syncing || !(profile.icsURL || "").trim() ? " disabled" : "") + ">" + I("refresh") + " " + (syncing ? "Syncing…" : "Sync now") + "</button>" +
        '<button class="btn primary" id="tb-add">' + I("plus") + " Add shift</button></div>";
      h += '<div class="grid">' +
        '<div class="panel col-12">' + weekStripHTML() + '<div class="caption" style="margin-top:8px">' + esc(weekSummary()) + "</div></div>" +
        '<div class="panel col-7" id="sched-day">' + selectedDayHTML() + "</div>" +
        '<div class="panel col-5" id="sched-coming">' + comingUpHTML() + "</div></div>";
      box.innerHTML = h;
      bindSchedule(box);
    }
    if (settingsBox && document.body.contains(settingsBox)) {
      settingsBox.innerHTML = settingsSection === "reminders" ? remindersHTML() : settingsHTML();
      bindSettings(settingsBox);
    }
    refreshReminders();
  }

  function bindSchedule(box) {
    box.querySelector("#tb-sync").onclick = () => syncCalendar(false);
    box.querySelector("#tb-add").onclick = () => openShiftEditor(null);
    box.querySelector("#tb-settings").onclick = () => { if (hooks.onOpenSettings) hooks.onOpenSettings(); };
    const selAdd = box.querySelector("#sel-add");
    if (selAdd) selAdd.onclick = () => openShiftEditor(null);

    box.querySelector("#wk-prev").onclick = () => {
      const d = parseDayKey(selectedDayKey); d.setDate(d.getDate() - 7);
      weekStart = startOfWeek(d); selectedDayKey = dayKeyOf(d); refresh();
    };
    box.querySelector("#wk-next").onclick = () => {
      const d = parseDayKey(selectedDayKey); d.setDate(d.getDate() + 7);
      weekStart = startOfWeek(d); selectedDayKey = dayKeyOf(d); refresh();
    };
    box.querySelector("#wk-today").onclick = () => {
      weekStart = startOfWeek(new Date()); selectedDayKey = dayKeyOf(new Date()); refresh();
    };
    box.querySelectorAll(".week-chip").forEach(chip => {
      chip.onclick = () => { selectedDayKey = chip.dataset.day; refresh(); };
    });

    box.querySelectorAll(".shift-card").forEach(card => {
      const id = card.dataset.shift;
      const sh = shifts.find(s => s.id === id);
      if (!sh) return;
      const ed = card.querySelector('[data-act="edit-shift"]');
      if (ed) ed.onclick = ev => { ev.stopPropagation(); openShiftEditor(sh); };
      const del = card.querySelector('[data-act="delete-shift"]');
      if (del) del.onclick = ev => { ev.stopPropagation(); deleteShiftFlow(sh); };
    });
    box.querySelectorAll("[data-restore]").forEach(b => {
      b.onclick = async () => {
        const r = allShifts.find(x => x.id === b.dataset.restore);
        if (!r) return;
        const clash = ShiftMath.ShiftLedger.overlap(r.start, r.end, allShifts, r.id);
        if (clash) { alert(ShiftMath.ShiftLedger.overlapMessage(clash) + " Remove it first to restore this one."); return; }
        try { await SyncEngine.queueWrite({ type: "restoreShift", shiftId: r.id }); await reload(); }
        catch (e) { alert("Couldn't restore that shift."); }
      };
    });
    GearUI.bind(box);
    box.querySelectorAll(".shift-lunch").forEach(renderLunchEditor);
    box.querySelectorAll(".shift-crew").forEach(renderCrewEditor);

    box.querySelectorAll("[data-view-day]").forEach(b => {
      b.onclick = () => { if (hooks.onViewDay) hooks.onViewDay(b.dataset.viewDay); };
    });

    box.querySelectorAll("[data-jump-week]").forEach(btn => {
      btn.onclick = () => {
        const d = parseDayKey(btn.dataset.jumpWeek);
        weekStart = startOfWeek(d);
        selectedDayKey = btn.dataset.jumpWeek;
        const jumpId = btn.dataset.shift;
        refresh();
        setTimeout(() => {
          const el = box.querySelector('.shift-card[data-shift="' + CSS.escape(jumpId) + '"]');
          if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 1600); }
        }, 50);
      };
    });
  }

  async function open() {
    const box = document.getElementById("sched-body");
    if (box && !box.children.length) box.innerHTML = spinner("Loading schedule…");
    try { await reload(); }
    catch (e) { if (box) box.innerHTML = '<div class="panel error-box">Couldn\'t load schedule: ' + esc(e.message || "") + "</div>"; }
  }

  /// Settings > Workday: calendar link, holidays, reminders.
  async function renderSettings(el, section) {
    settingsBox = el;
    settingsSection = section === "reminders" ? "reminders" : "schedule";
    el.innerHTML = spinner("Loading workday settings…");
    try { await reload(); }
    catch (e) { el.innerHTML = '<div class="panel error-box">Couldn\'t load: ' + esc(e.message || "") + "</div>"; }
  }

  return {
    open,
    refresh,
    reload,
    renderSettings,
    lastSyncText: () => lastSyncText(),
    remindersSummary: () => remindersSummary(),
    parseICS,
    mergeShifts,
    normalizeICSURL,
    autoLunchMinutes,
    lunchSummary,
    overlapSummary,
    isOpeningShift,
    isClosingShift,
    computeReminders,
    set onViewDay(fn) { hooks.onViewDay = fn; },
    set onOpenSettings(fn) { hooks.onOpenSettings = fn; },
  };
})();
