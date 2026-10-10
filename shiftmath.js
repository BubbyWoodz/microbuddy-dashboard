/* ShiftMath — ports of iOS shift/coworker logic (Batches 16, 24, 29, 31).
 *   TimeParse            ViewModels/BuddyViewModel.swift (meridiem-aware, "a.m."/"p.m.")
 *   Shift worked times   Models/Shift.swift (actualStart/actualEnd override, isRemoved tombstone)
 *   overlap/exact/closes Models/Shift.swift (resolvedBounds, sameHalfDistance)
 *   ScheduleVault        Models/ScheduleVault.swift (identity, overlaps, timedKeys)
 *   ScheduleNames        Models/ScheduleMirror.swift (legalName, display)
 *   ScheduleMirrorRules  Models/ScheduleMirror.swift (exact / same end / within an hour)
 */
const ShiftMath = (() => {
  // ---------- TimeParse ----------
  const SEPS = [" until ", " till ", " to ", " - ", " – ", " — ", "–", "—", "-"];
  function normalized(raw) {
    if (raw == null) return null;
    let t = String(raw).trim().toLowerCase();
    if (!t) return null;
    t = t.split("a.m.").join("am").split("p.m.").join("pm").split("a.m").join("am").split("p.m").join("pm");
    while (t.includes("  ")) t = t.split("  ").join(" ");
    return t;
  }
  function clockSide(raw) {
    let text = String(raw).replace(/^[ \t]+|[ \t]+$/g, "");
    if (!text) return null;
    let offset = 0, mer = false, i;
    if ((i = text.indexOf("am")) >= 0) { mer = true; text = text.slice(0, i) + text.slice(i + 2); }
    else if ((i = text.indexOf("pm")) >= 0) { mer = true; offset = 720; text = text.slice(0, i) + text.slice(i + 2); }
    else if (text.endsWith("a")) { mer = true; text = text.slice(0, -1); }
    else if (text.endsWith("p")) { mer = true; offset = 720; text = text.slice(0, -1); }
    text = text.replace(/^[ .:,\-]+|[ .:,\-]+$/g, "");
    const parts = text.split(":").filter(p => p !== "");
    const hs = (parts[0] || "").trim();
    if (!/^[+-]?\d+$/.test(hs)) return null;
    const hour = parseInt(hs, 10);
    let minute = 0;
    if (parts.length > 1) { const ms = parts[1].slice(0, 2); minute = /^\d+$/.test(ms) ? parseInt(ms, 10) : 0; }
    if (!mer && (hour > 12 || hour === 0)) return { minutes: hour * 60 + minute, isAmbiguous: false };
    return { minutes: (hour % 12) * 60 + minute + offset, isAmbiguous: !mer };
  }
  function spanIn(text) {
    for (const sep of SEPS) {
      const at = text.indexOf(sep);
      if (at < 0) continue;
      const s = clockSide(text.slice(0, at)), e = clockSide(text.slice(at + sep.length));
      if (s && e) return { start: s, end: e };
    }
    return null;
  }
  function span(raw) { const t = normalized(raw); return t ? spanIn(t) : null; }
  function clock(raw) { const t = normalized(raw); if (!t || spanIn(t)) return null; return clockSide(t); }
  function minutes(raw) { const r = span(raw); if (r) return r.start.minutes; const c = clock(raw); return c ? c.minutes : null; }
  function interval(start, end) {
    const sc = clock(start), ec = clock(end);
    if (sc && ec) return { start: sc, end: ec };
    const rs = span(start);
    if (rs) return ec ? { start: rs.start, end: ec } : rs;
    const re = span(end);
    if (re) return sc ? { start: sc, end: re.end } : re;
    return null;
  }

  // ---------- Shift ----------
  function toDate(v) {
    if (v == null || v === "") return null;
    if (v instanceof Date) return v;
    if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v);
    const d = new Date(String(v));
    return isNaN(d.getTime()) ? null : d;
  }
  const isRemoved = sh => !!(sh && sh.isRemoved);
  const active = shifts => (shifts || []).filter(s => s && !s.isRemoved);
  const workedStart = sh => toDate(sh.actualStart) || toDate(sh.start);
  const workedEnd = sh => toDate(sh.actualEnd) || toDate(sh.end);
  const hasActualHours = sh => !!(sh && (sh.actualStart || sh.actualEnd));
  function hours(sh) {
    const s = workedStart(sh), e = workedEnd(sh);
    if (!s || !e) return 0;
    return Math.max(0, (e - s) / 3600000);
  }
  const clockMin = d => d.getHours() * 60 + d.getMinutes();
  function wrappedWindow(sh) {
    const s = workedStart(sh), e = workedEnd(sh);
    if (!s || !e) return null;
    const us = clockMin(s); let ue = clockMin(e);
    if (ue <= us) ue += 1440;
    return { start: us, end: ue };
  }
  function reading(value, lo, hi) {
    const c = [value, value + 720, value + 1440, value - 720];
    const inside = c.find(x => x >= lo && x <= hi);
    if (inside !== undefined) return inside;
    return c.reduce((a, b) => Math.abs(b - lo) < Math.abs(a - lo) ? b : a, value);
  }
  const resolved = (ck, lo, hi) => ck.isAmbiguous ? reading(ck.minutes, lo, hi) : ck.minutes;
  function wrapped(s, e) { if (e < s) e += 1440; return { start: s, end: e }; }
  function resolvedBounds(cw, us, ue) {
    const iv = interval(cw && cw.start, cw && cw.end);
    if (iv) return wrapped(resolved(iv.start, us, ue), resolved(iv.end, us, ue + 60));
    const sc = clock(cw && cw.start), ec = clock(cw && cw.end);
    if (!sc && !ec) return null;
    return wrapped(sc ? resolved(sc, us, ue) : us, ec ? resolved(ec, us, ue + 60) : ue);
  }
  function overlapHours(sh, cw) {
    const w = wrappedWindow(sh); if (!w) return null;
    const b = resolvedBounds(cw, w.start, w.end); if (!b) return null;
    return Math.max(0, Math.min(w.end, b.end) - Math.max(w.start, b.start)) / 60;
  }
  function hoursText(h) {
    const tm = Math.round(h * 60), hh = Math.floor(tm / 60), mm = tm % 60;
    if (hh === 0) return mm + "m";
    return mm === 0 ? hh + "h" : hh + "h " + mm + "m";
  }
  function overlapSummary(sh, cw) {
    const h = overlapHours(sh, cw);
    if (h == null || h <= 0.05) return null;
    return hoursText(h);
  }
  function isExactShift(sh, cw) {
    const w = wrappedWindow(sh); if (!w) return false;
    const b = resolvedBounds(cw, w.start, w.end); if (!b) return false;
    return Math.abs(b.start - w.start) <= 2 && Math.abs(b.end - w.end) <= 2;
  }
  function closesWith(sh, cw) {
    const e = workedEnd(sh); if (!e) return false;
    const ue = clockMin(e);
    const iv = interval(cw && cw.start, cw && cw.end);
    const ck = iv ? iv.end : clock(cw && cw.end);
    if (!ck) return false;
    const r = resolved(ck, ue - 60, ue + 60);
    return Math.min(...[0, 1440, -1440].map(o => Math.abs(r + o - ue))) <= 60;
  }

  // ---------- Names ----------
  function personNormalized(raw) {
    const t = String(raw || "").replace(/^[ \t]+|[ \t]+$/g, "");
    const c = t.indexOf(",");
    if (c < 0) return t;
    const last = t.slice(0, c).trim(), first = t.slice(c + 1).trim();
    return (!first || !last) ? t : first + " " + last;
  }
  function titled(raw) {
    const t = String(raw || "").trim();
    if (!t || t.length === 1) return "";
    return t[0].toUpperCase() + t.slice(1).toLowerCase();
  }
  function legalName(raw) {
    const t = String(raw || "").trim();
    if (!t) return "";
    let first, last;
    const c = t.indexOf(",");
    if (c >= 0) { last = t.slice(0, c).trim(); first = (t.slice(c + 1).trim().split(/\s+/)[0]) || ""; }
    else { const tk = t.split(/\s+/).filter(Boolean); first = tk[0] || ""; last = tk.length > 1 ? tk[tk.length - 1] : ""; }
    const f = titled(first), l = titled(last);
    if (!f) return l;
    if (!l || f.toLowerCase() === l.toLowerCase()) return f;
    return f + " " + l;
  }
  const displayName = raw => legalName(personNormalized(raw)).trim();
  function identity(raw) {
    const parts = displayName(raw).toLowerCase().split(/\s+/).filter(Boolean);
    if (parts.length === 2) return parts.sort().join(" ");
    return parts.join(" ");
  }
  function displayForMirror(employeeName, contacts) {
    const legal = legalName(employeeName);
    const needle = legal.trim().toLowerCase();
    if (needle) {
      const c = (contacts || []).find(ct => {
        const named = ((ct.firstName || "") + " " + (ct.lastName || "")).trim().toLowerCase();
        return named === needle || legalName(ct.fullName || "").toLowerCase() === needle;
      });
      if (c) {
        const nick = String(c.nickname || "").trim(); if (nick) return nick;
        const named = ((c.firstName || "") + " " + (c.lastName || "")).trim(); if (named) return named;
      }
    }
    return legal || "Coworker";
  }

  // ---------- Day keys ----------
  function dayKey(d) {
    const x = toDate(d); if (!x) return "";
    return x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0");
  }
  const shiftDayKey = sh => dayKey(sh && sh.start); // Shift.dayKey uses posted start

  // ---------- ScheduleVault ----------
  const blank = s => { const t = String(s == null ? "" : s).trim(); return t ? t : null; };
  function hasTimes(e) {
    const s = blank(e.start), en = blank(e.end);
    if (interval(s, en)) return true;
    return !!(clock(s) || clock(en));
  }
  function vaultOverlaps(entries, shifts) {
    const act = active(shifts), hits = [];
    for (const e of (entries || [])) {
      if (!e || !e.name) continue;
      const cw = { name: e.name, start: blank(e.start), end: blank(e.end) };
      const key = String(e.dateKey || "").slice(0, 10);
      let total = 0, best = null;
      for (const sh of act.filter(s => shiftDayKey(s) === key)) {
        const h = overlapHours(sh, cw);
        if (h == null || !(h > 0)) continue;
        total += h;
        if (!best || h > best.h) best = { sh, h };
      }
      if (!(total > 0) || !best) continue;
      hits.push({ name: e.name, identity: identity(e.name), dateKey: key, hours: total, coworker: cw, shift: best.sh });
    }
    return hits;
  }
  function vaultTimedKeys(entries, shifts) {
    const days = new Set(active(shifts).map(shiftDayKey));
    const keys = new Set();
    for (const e of (entries || [])) {
      const key = String(e.dateKey || "").slice(0, 10);
      if (days.has(key) && hasTimes(e)) keys.add(identity(e.name) + "|" + key);
    }
    return keys;
  }

  // ---------- Mirror rules (visible Working With) ----------
  function mirrorBounds(start, end, user) {
    const iv = interval(start, end); if (!iv) return null;
    const sLo = user ? user.start : 0, sHi = user ? user.end : 1440;
    const eLo = user ? user.start : 0, eHi = user ? user.end + 60 : 1500;
    let s = resolved(iv.start, sLo, sHi), e = resolved(iv.end, eLo, eHi);
    if (e < s) e += 1440;
    return { start: s, end: e };
  }
  function mirrorRule(userStart, userEnd, theirStart, theirEnd) {
    const u = mirrorBounds(userStart, userEnd, null); if (!u) return null;
    const t = mirrorBounds(theirStart, theirEnd, u); if (!t) return null;
    const sd = Math.abs(t.start - u.start), ed = Math.abs(t.end - u.end);
    if (sd <= 2 && ed <= 2) return "exact";
    if (ed <= 2) return "same_end";
    if (sd <= 60 && ed <= 60) return "within_hour";
    return null;
  }
  function clockLabel(d) {
    const x = toDate(d); if (!x) return "";
    let h = x.getHours(); const m = x.getMinutes(), ap = h < 12 ? "AM" : "PM";
    h = h % 12 || 12;
    return h + ":" + String(m).padStart(2, "0") + " " + ap;
  }


  // ---------- ShiftLedger (Batch 29) ----------
  const ms = v => { const d = toDate(v); return d ? d.getTime() : NaN; };
  const isManual = sh => !!sh.isManual;
  const stableUKGId = sh => isManual(sh) ? null : (sh.ukgIdentifier || sh.id);
  const ivOverlap = (a1, a2, b1, b2) => a1 < b2 && b1 < a2;
  const wS = sh => ms(sh.actualStart || sh.start), wE = sh => ms(sh.actualEnd || sh.end);
  const shiftsOverlap = (a, b) => ivOverlap(wS(a), wE(a), wS(b), wE(b)) || ivOverlap(ms(a.start), ms(a.end), ms(b.start), ms(b.end));
  /// First active shift whose worked window overlaps start..end (ignoring id).
  function ledgerOverlap(start, end, shifts, ignoringId) {
    const s = ms(start), e = ms(end);
    if (!(e > s)) return null;
    return active(shifts).filter(x => x.id !== ignoringId)
      .sort((a, b) => ms(a.start) - ms(b.start))
      .find(x => ivOverlap(s, e, wS(x), wE(x))) || null;
  }
  function overlapMessage(sh) {
    const a = workedStart(sh), b = workedEnd(sh);
    const t = d => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    const day = toDate(sh.start).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    return "You already have a shift " + t(a) + "\u2013" + t(b) + " on " + day + ".";
  }
  /// Updates for an in-place edit: UKG edits land in actualStart/actualEnd so
  /// the posted schedule stays; manual edits rewrite the row's own times.
  function editUpdates(sh, startISO, endISO, title) {
    if (!sh || sh.isRemoved || !(ms(endISO) > ms(startISO))) return null;
    const u = { isEdited: true };
    if (isManual(sh)) { u.start = startISO; u.end = endISO; u.actualStart = null; u.actualEnd = null; }
    else { u.actualStart = startISO; u.actualEnd = endISO; }
    const t = String(title || "").trim();
    if (t) u.title = t;
    return u;
  }
  function payableHours(dayKeyStr, shifts) {
    return active(shifts).filter(x => shiftDayKey(x) === dayKeyStr).reduce((a, x) => a + hours(x), 0);
  }
  function disclosedRemovals(dayKeyStr, shifts) {
    const day = (shifts || []).filter(x => shiftDayKey(x) === dayKeyStr);
    const act = day.filter(x => !x.isRemoved);
    return day.filter(r => r.isRemoved && !act.some(a => shiftsOverlap(r, a)));
  }
  const hasActual = sh => !!(sh.actualStart || sh.actualEnd);
  function identifies(ex, inc) {
    const incId = stableUKGId(inc) || inc.id;
    if (ex.id === inc.id || ex.id === incId) return true;
    const st = stableUKGId(ex);
    return !!st && (st === inc.id || st === incId);
  }
  function applyingFeed(inc, ex) {
    if (isManual(ex)) return ex;
    const u = Object.assign({}, ex);
    const legacy = ex.isEdited && !hasActual(ex) && (ms(ex.start) !== ms(inc.start) || ms(ex.end) !== ms(inc.end));
    if (legacy) { u.actualStart = ex.start; u.actualEnd = ex.end; }
    u.start = inc.start; u.end = inc.end; u.location = inc.location;
    if (!ex.isEdited && !hasActual(ex) && !legacy) u.title = inc.title;
    u.ukgIdentifier = stableUKGId(ex) || stableUKGId(inc) || inc.id;
    u.id = ex.id; u.isManual = false; u.coworkers = ex.coworkers || [];
    u.isEdited = !!(ex.isEdited || hasActual(u));
    u.isRemoved = !!ex.isRemoved;
    return u;
  }
  function shouldPrefer(c, cur) {
    if (hasActual(c) && !hasActual(cur)) return true;
    if (c.isEdited && !cur.isEdited && !hasActual(cur)) return true;
    if (isManual(c) && !isManual(cur) && !cur.isEdited && !hasActual(cur)) return true;
    return false;
  }
  function sameIdentity(a, b) {
    if (a.id === b.id) return true;
    if (isManual(a) || isManual(b)) return false;
    const l = stableUKGId(a), r = stableUKGId(b);
    if (l && r && l === r) return true;
    return l === b.id || r === a.id;
  }
  function uuid4() { return (typeof AppDataSanitizer !== "undefined") ? AppDataSanitizer.uuid() : String(Date.now()) + Math.random().toString(16).slice(2); }
  function preferred(l, r) {
    let kept = Object.assign({}, l), other = Object.assign({}, r);
    if (shouldPrefer(r, l)) { kept = Object.assign({}, r); other = Object.assign({}, l); }
    if (kept.isEdited && !hasActual(kept) && !other.isEdited && !isManual(other)) {
      kept.actualStart = kept.start; kept.actualEnd = kept.end; kept.start = other.start; kept.end = other.end;
    }
    if (!kept.actualStart && other.actualStart) kept.actualStart = other.actualStart;
    if (!kept.actualEnd && other.actualEnd) kept.actualEnd = other.actualEnd;
    if (other.isEdited) kept.isEdited = true;
    if (!kept.ukgIdentifier && stableUKGId(other)) kept.ukgIdentifier = stableUKGId(other);
    kept.coworkers = (kept.coworkers && kept.coworkers.length) ? kept.coworkers : (other.coworkers || []);
    let tomb = null;
    if (!isManual(other) && isManual(kept)) {
      tomb = Object.assign({}, other, { isRemoved: true, ukgIdentifier: stableUKGId(other) });
      if (tomb.id === kept.id) tomb.id = stableUKGId(other) || uuid4();
    }
    if (isManual(kept)) delete kept.ukgIdentifier; // a manual row never carries a UKG id (Shift.init)
    return { row: kept, tomb };
  }
  function collapsing(shifts) {
    const kept = [];
    const removed = shifts.filter(x => x.isRemoved);
    for (const sh of shifts.filter(x => !x.isRemoved).sort((a, b) => ms(a.start) - ms(b.start))) {
      const i = kept.findIndex(k => !k.isRemoved && (sameIdentity(k, sh) || shiftsOverlap(k, sh)));
      if (i >= 0) { const f = preferred(kept[i], sh); kept[i] = f.row; if (f.tomb) kept.push(f.tomb); }
      else kept.push(sh);
    }
    const ids = new Set(kept.map(k => k.id));
    const tombs = removed.filter(r => !ids.has(r.id));
    return [...kept.filter(k => !k.isRemoved), ...tombs, ...kept.filter(k => k.isRemoved)]
      .sort((a, b) => ms(a.start) - ms(b.start));
  }
  /// ShiftLedger.merge: fold a parsed ICS list into the local log. Posted
  /// times update; actual hours and tombstones never do.
  function ledgerMerge(local, fetched, now) {
    const merged = (local || []).map(x => Object.assign({}, x));
    for (const inc of fetched) {
      let i = merged.findIndex(e => identifies(e, inc));
      if (i < 0) i = merged.findIndex(e => !e.isRemoved && !isManual(e) && ms(e.start) === ms(inc.start) && ms(e.end) === ms(inc.end));
      if (i < 0) i = merged.findIndex(e => e.isRemoved && !isManual(e) && shiftsOverlap(e, inc));
      if (i < 0) i = merged.findIndex(e => !e.isRemoved && !isManual(e) && shiftsOverlap(e, inc));
      if (i >= 0) { merged[i] = applyingFeed(inc, merged[i]); continue; }
      if (merged.some(e => !e.isRemoved && shiftsOverlap(e, inc))) continue;
      merged.push(Object.assign({}, inc, { isManual: false, isRemoved: false, ukgIdentifier: stableUKGId(inc) || inc.id }));
    }
    const today = new Date(now || Date.now()); today.setHours(0, 0, 0, 0);
    const out = merged.filter(sh => {
      if (isManual(sh) || sh.isRemoved || sh.isEdited || hasActual(sh)) return true;
      const sd = toDate(sh.start); sd.setHours(0, 0, 0, 0);
      if (!(sd > today)) return true;
      return fetched.some(f => identifies(sh, f));
    });
    return collapsing(out);
  }

  return {
    ShiftLedger: { overlap: ledgerOverlap, overlapMessage, editUpdates, payableHours, disclosedRemovals, merge: ledgerMerge, stableUKGId },
    TimeParse: { clock, span, interval, minutes },
    toDate, isRemoved, active, workedStart, workedEnd, hasActualHours, hours,
    overlapHours, overlapSummary, isExactShift, closesWith, hoursText,
    personNormalized, legalName, displayName, identity, displayForMirror,
    dayKey, shiftDayKey, vaultOverlaps, vaultTimedKeys, mirrorRule, clockLabel,
  };
})();
if (typeof module !== "undefined") module.exports = ShiftMath;

/* GearUI — GearCheckoutSection port (Batch 27). Today and future days are
 * editable (saved as you type, debounced); past days show what was recorded. */
const GearUI = (() => {
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function todayKey() { return ShiftMath.dayKey(new Date()); }
  // Unsaved typing survives a background re-render (a sync landing mid-edit).
  const drafts = {}; let focusedId = null, caret = null;
  const val = (dayKey, k, saved) => (dayKey + "|" + k) in drafts ? drafts[dayKey + "|" + k] : (saved || "");
  function html(dayKey, day, opts) {
    const closed = dayKey < todayKey();
    const head = (opts && opts.heading === false) ? "" : '<div class="label gear-head">Gear checkout</div>';
    const ek = day && day.ekeyNumber, wk = day && day.walkieNumber;
    if (closed) {
      const rows = (!ek && !wk) ? '<div class="muted small">No gear recorded</div>' :
        (ek ? '<div class="gear-row" aria-label="E-key ' + esc(ek) + '"><span>E-key</span><b>' + esc(ek) + "</b></div>" : "") +
        (wk ? '<div class="gear-row" aria-label="Walkie ' + esc(wk) + '"><span>Walkie</span><b>' + esc(wk) + "</b></div>" : "");
      return '<div class="gear" data-gear="' + esc(dayKey) + '">' + head + rows + "</div>";
    }
    return '<div class="gear" data-gear="' + esc(dayKey) + '">' + head +
      '<div class="field-row2"><div class="field"><label for="gear-ek-' + dayKey + '">E-key</label><input type="text" id="gear-ek-' + dayKey + '" data-gear-k="ekeyNumber" value="' + esc(val(dayKey, "ekeyNumber", ek)) + '" placeholder="E-key — e.g. EK-047" autocomplete="off" autocapitalize="off" spellcheck="false"></div>' +
      '<div class="field"><label for="gear-wk-' + dayKey + '">Walkie</label><input type="text" id="gear-wk-' + dayKey + '" data-gear-k="walkieNumber" value="' + esc(val(dayKey, "walkieNumber", wk)) + '" placeholder="Walkie — e.g. WK-03" autocomplete="off" autocapitalize="off" spellcheck="false"></div></div></div>';
  }
  function bind(root) {
    (root || document).querySelectorAll(".gear[data-gear] input[data-gear-k]").forEach(inp => {
      const dk = inp.closest(".gear").dataset.gear;
      const save = () => {
        const wrap = inp.closest(".gear");
        const op = { type: "setGear", dayId: wrap.dataset.gear };
        wrap.querySelectorAll("input[data-gear-k]").forEach(i => { op[i.dataset.gearK] = i.value; });
        wrap.querySelectorAll("input[data-gear-k]").forEach(i => { delete drafts[op.dayId + "|" + i.dataset.gearK]; });
        SyncEngine.queueWrite(op).catch(e => console.warn("gear save failed", e));
      };
      inp.addEventListener("input", () => { drafts[dk + "|" + inp.dataset.gearK] = inp.value; caret = inp.selectionStart; });
      inp.addEventListener("focus", () => { focusedId = inp.id; });
      inp.addEventListener("blur", () => { if (inp.isConnected) focusedId = null; });
      if (focusedId === inp.id && document.activeElement !== inp) { inp.focus(); try { if (caret != null) inp.setSelectionRange(caret, caret); } catch (e) {} }
      // Commit on leave/Enter whenever there's an unsaved draft (a re-rendered
      // field never fires "change", so don't rely on it).
      const commit = () => { if ((dk + "|" + inp.dataset.gearK) in drafts) { inp.value = inp.value.trim(); save(); } };
      inp.addEventListener("change", commit);
      inp.addEventListener("blur", commit);
      inp.addEventListener("keydown", e => { if (e.key === "Enter") inp.blur(); });
    });
  }
  return { html, bind };
})();
if (typeof module !== "undefined") module.exports.GearUI = GearUI;
