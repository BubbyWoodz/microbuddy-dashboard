"use strict";
/* ============ daydetail.js — Day Detail View for the Micro Buddy dashboard ============
 *
 * Faithful port of ios-micro-buddy/MicroBuddy/Views/DayDetailView.swift —
 * the app's "everything page" for a single day.
 *
 * Layout order (matches the app exactly):
 *   1. Hero totals (commission, revenue, items/plans/customers/CPH/per-hour)
 *   2. Hours card (worked hours, scheduled, lunch, premium pills) → hours sheet
 *   3. Pay breakdown (PayEngine — open floor, premiums, OT, total, CA take-home)
 *   4. Transactions (tickets, expandable, edit/delete per line)
 *   5. Returns (pure return lines)
 *   6. Exchanges (exchange tickets, net, credit pills)
 *   7. Coworker comparisons (saved head-to-heads)
 *   8. Journal (entry card + LINKED TO THIS DAY chips, or blank-page invite)
 *
 * All pay math goes through PayEngine (exact port of the iOS math).
 * All edits go through SyncEngine.queueWrite (offline-first op queue).
 *
 * Parent wiring (dashboard.html):
 *   <script src="/payengine.js"></script>
 *   <script src="/daydetail.js"></script>
 *   DayDetailUI.onAddTicket  = (dayKey) => openSaleModalFor(dayKey);
 *   DayDetailUI.onEditLine   = (dayKey, ticketIndex, lineIndex) => ...;
 *   DayDetailUI.onEditJournal= (dayKey) => openJournalEditor(dayKey);
 *   DayDetailUI.onCompare    = (dayKey) => openCompare(dayKey);
 *   DayDetailUI.open("2026-09-28");
 *
 * NEW OP TYPES this module queues (parent must add to sync.js applyOp):
 *   { type:"updateDay", dayId, updates:{scheduledHours,lunchMinutes,lunchStart,secondLunchStart} }
 *   { type:"deleteTicket", dayId, ticketIndex }
 *   { type:"clearDayTickets", dayId }
 * If they are missing, queueWrite throws and the UI shows "Couldn't save".
 * ===================================================================================== */
const DayDetailUI = (() => {

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  const esc = s => String(s == null ? "" : s)
    .replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const money = n => {
    const v = Number(n);
    return (v < 0 ? "-$" : "$") + Math.abs(isNaN(v) ? 0 : v).toFixed(2);
  };

  function parseDayKey(key) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(key || "");
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date();
  }

  function fmtShortDay(key) {
    return parseDayKey(key).toLocaleDateString(undefined,
      { weekday: "short", month: "short", day: "numeric" });
  }

  function fmtLongDay(key) {
    return parseDayKey(key).toLocaleDateString(undefined,
      { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  }

  function fmtTimeOnly(t) {
    if (!t) return "";
    const d = new Date(t);
    if (isNaN(d)) return String(t);
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  function fmtClock(d) { // Date -> "h:mm AM"
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  // ---------------------------------------------------------------------------
  // WorkDay computed properties — port of WorkDay.swift
  // ---------------------------------------------------------------------------

  function lineRevenue(l) {
    return (l.isReturn ? -1 : 1) * (Number(l.unitPrice) || 0) * (Number(l.quantity) || 0);
  }
  function ticketRevenue(t) {
    return (t.lines || []).reduce((s, l) => s + lineRevenue(l), 0);
  }
  function dayRevenue(day) {
    return (day.tickets || []).reduce((s, t) => s + ticketRevenue(t), 0);
  }
  function ticketItemCount(t) { // SaleTicket.itemCount
    return (t.lines || [])
      .filter(l => !l.isReturn && !l.isExchange && l.kind !== "servicePlan")
      .reduce((s, l) => s + (Number(l.quantity) || 0), 0);
  }
  function isExchangeTicket(t) { return (t.lines || []).some(l => l.isExchange); }
  function ticketHasReturns(t) { return (t.lines || []).some(l => l.isReturn); }
  function dayLines(day) { return (day.tickets || []).flatMap(t => t.lines || []); }
  function pureReturnLines(day) {
    return dayLines(day).filter(l => l.isReturn && !l.isExchange);
  }
  function exchangeTickets(day) {
    return (day.tickets || []).filter(isExchangeTicket);
  }
  function customerCount(day) {
    return (day.tickets || []).filter(t => !isExchangeTicket(t)).length;
  }
  function itemsSold(day) {
    return (day.tickets || []).reduce((s, t) => s + ticketItemCount(t), 0);
  }
  function plansSold(day) {
    return dayLines(day)
      .filter(l => l.kind === "servicePlan" && !l.isReturn && !l.isExchange)
      .reduce((s, l) => s + (Number(l.quantity) || 0), 0);
  }
  function workedHours(day) { return PayEngine.workedHours(day); }
  function customersPerHour(day) {
    const wh = workedHours(day);
    return wh > 0 ? customerCount(day) / wh : 0;
  }
  function commissionPerHour(day, table, premiumHours) {
    const open = Math.max(0, workedHours(day) - premiumHours);
    if (open <= 0.005) return 0;
    return PayEngine.dayCommission(day, table) / open;
  }
  function lunchSummary(day) { // WorkDay.lunchSummary
    const lm = day.lunchMinutes || 0;
    if (lm <= 0) return "no lunch";
    const breaks = (day.scheduledHours || 0) >= 11 ? 2 : 1;
    const base = breaks === 2 ? "60m lunch & 30m second lunch" : lm + "m lunch";
    if (!day.lunchStart) return base;
    let text = base + " at " + fmtTimeOnly(day.lunchStart);
    if (breaks === 2 && day.secondLunchStart) text += " & " + fmtTimeOnly(day.secondLunchStart);
    return text;
  }
  function autoLunchMinutes(scheduledHours) { // WorkDay.autoLunchMinutes
    return scheduledHours < 5 ? 0 : (scheduledHours >= 11 ? 90 : 60);
  }

  // ---------------------------------------------------------------------------
  // State + parent hooks
  // ---------------------------------------------------------------------------

  let overlay = null, styleEl = null;
  let ctx = null; // { dayKey, day, data, profile, shifts, holidayDates, table, highlightTicketId }

  // Parent-wired actions. Defaults no-op so the module never crashes unwired.
  const hooks = {
    onAddTicket: null,   // (dayKey) => void
    onEditLine: null,    // (dayKey, ticketIndex, lineIndex) => void
    onEditJournal: null, // (dayKey) => void
    onCompare: null,     // (dayKey) => void
  };

  function toast(msg) {
    let t = document.getElementById("dd-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "dd-toast";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove("show"), 2600);
  }

  // ---------------------------------------------------------------------------
  // Styles (scoped, theme-aware via CSS variables)
  // ---------------------------------------------------------------------------

  function ensureStyles() {
    if (styleEl) return;
    styleEl = document.createElement("style");
    styleEl.textContent = `
#dd-overlay { position: fixed; inset: 0; z-index: 1003; background: var(--bg);
  display: flex; flex-direction: column; }
#dd-overlay.hidden { display: none; }
#dd-head { position: sticky; top: 0; z-index: 5; display: flex; align-items: center;
  gap: 8px; padding: 12px 12px 10px; background: var(--bg);
  border-bottom: 1px solid var(--border); }
#dd-back { background: none; border: none; color: var(--text); font-size: 26px;
  cursor: pointer; padding: 2px 10px; line-height: 1; }
#dd-title { flex: 1; text-align: center; font-size: 17px; font-weight: 700; }
#dd-menu-btn { background: var(--card2); border: 1px solid var(--border); color: var(--text);
  border-radius: 10px; padding: 6px 12px; font-size: 16px; cursor: pointer; }
#dd-menu { position: absolute; top: 56px; right: 12px; z-index: 20; background: var(--bg2);
  border: 1px solid var(--border); border-radius: 12px; min-width: 210px;
  box-shadow: 0 8px 30px rgba(0,0,0,.35); overflow: hidden; }
#dd-menu.hidden { display: none; }
#dd-menu button { display: flex; align-items: center; gap: 10px; width: 100%;
  background: none; border: none; color: var(--text); font-size: 15px;
  padding: 12px 14px; cursor: pointer; text-align: left; }
#dd-menu button:active { background: var(--card2); }
#dd-menu button.danger { color: var(--red); }
#dd-menu .sep { height: 1px; background: var(--border); }
#dd-body { flex: 1; overflow-y: auto; padding: 12px 16px 40px; }
#dd-col { max-width: 640px; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }
.dd-card { background: var(--card); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 16px; }
.dd-hero { text-align: center; padding: 20px 16px 16px; }
.dd-hero .lbl { font-size: 13px; color: var(--muted); text-transform: uppercase;
  letter-spacing: .08em; font-weight: 600; }
.dd-hero .big { font-size: 44px; font-weight: 800; letter-spacing: -.5px; margin: 4px 0; }
.dd-hero .cap { font-size: 13.5px; color: var(--muted); }
.dd-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(90px, 1fr));
  gap: 8px; margin-top: 14px; }
.dd-mini { background: var(--card2); border-radius: 12px; padding: 10px 6px; text-align: center; }
.dd-mini .v { font-size: 17px; font-weight: 800; }
.dd-mini .l { font-size: 10.5px; color: var(--muted); text-transform: uppercase;
  letter-spacing: .05em; font-weight: 600; margin-top: 2px; }
.dd-sec-h { font-size: 15px; font-weight: 700; margin: 2px 0 0; }
.dd-sec-sub { font-size: 13px; color: var(--muted); margin-top: 2px; }
.dd-row { display: flex; align-items: center; gap: 10px; padding: 10px 0;
  border-bottom: 1px solid var(--border); }
.dd-row:last-child { border-bottom: none; }
.dd-row .grow { flex: 1; min-width: 0; }
.dd-row .t1 { font-size: 15px; font-weight: 600; }
.dd-row .t2 { font-size: 12.5px; color: var(--muted); margin-top: 1px; }
.dd-row .amt { font-size: 15px; font-weight: 700; white-space: nowrap; }
.dd-pill { display: inline-block; font-size: 11.5px; font-weight: 700; padding: 3px 10px;
  border-radius: 999px; }
.dd-foot { font-size: 12px; color: var(--muted); line-height: 1.5; }
.dd-topoff { border-left: 3px solid var(--amber); }
.dd-topoff .h { display: flex; align-items: center; gap: 6px; font-size: 12.5px;
  font-weight: 700; color: var(--amber); margin-bottom: 6px; }
.dd-ticket { background: var(--card); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 14px; margin-bottom: 10px;
  transition: box-shadow .4s, border-color .4s; }
.dd-ticket.flash { border-color: var(--blue); box-shadow: 0 0 0 3px var(--blue-dim); }
.dd-ticket .th { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.dd-ticket .tm { font-size: 12.5px; font-weight: 700; color: var(--muted); }
.dd-ticket .rev { margin-left: auto; font-size: 16px; font-weight: 800; }
.dd-line { display: flex; align-items: center; gap: 8px; padding: 5px 0; font-size: 14px; }
.dd-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.dd-line .p { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dd-line .q { color: var(--muted); font-size: 12.5px; }
.dd-line .c { font-size: 12.5px; font-weight: 700; }
.dd-line .x { background: none; border: none; cursor: pointer; font-size: 13px; padding: 2px 6px; }
.dd-ticket .acts { display: flex; gap: 14px; align-items: center; margin-top: 8px;
  padding-top: 8px; border-top: 1px solid var(--border); }
.dd-link { background: none; border: none; cursor: pointer; font-size: 13px;
  font-weight: 600; color: var(--blue); padding: 0; }
.dd-link.danger { color: var(--red); }
.dd-note { font-size: 12.5px; color: var(--muted); font-style: italic; margin-top: 6px; }
.dd-empty { text-align: center; padding: 22px 12px; color: var(--muted); font-size: 14px; }
.dd-chiprow { display: flex; gap: 8px; overflow-x: auto; padding: 4px 0 2px; }
.dd-hours { display: flex; gap: 12px; align-items: center; width: 100%;
  background: none; border: none; color: var(--text); cursor: pointer; padding: 0;
  font: inherit; text-align: left; }
.dd-hours .ic { font-size: 22px; }
#dd-sheet, #dd-share { position: fixed; inset: 0; z-index: 1004;
  background: rgba(0,0,0,.55); display: flex; align-items: flex-end; justify-content: center; }
#dd-sheet.hidden, #dd-share.hidden { display: none; }
#dd-sheet .sheet-card, #dd-share .sheet-card { background: var(--bg2);
  border: 1px solid var(--border); border-radius: 16px 16px 0 0; width: 100%;
  max-width: 520px; max-height: 88vh; overflow-y: auto; padding: 20px; }
@media (min-width: 700px) {
  #dd-sheet, #dd-share { align-items: center; padding: 24px; }
  #dd-sheet .sheet-card, #dd-share .sheet-card { border-radius: 16px; }
}
.dd-field { margin-bottom: 14px; }
.dd-field label { display: block; font-size: 12px; font-weight: 700; color: var(--muted);
  text-transform: uppercase; letter-spacing: .06em; margin-bottom: 6px; }
.dd-field input[type="number"], .dd-field input[type="time"], .dd-field input[type="text"] {
  width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px;
  background: var(--card); color: var(--text); font-size: 17px; }
.dd-breakrow { display: flex; align-items: center; justify-content: space-between;
  padding: 8px 0; }
.dd-breakrow .t { font-size: 15px; font-weight: 600; }
.dd-addtime { background: var(--card2); border: 1px solid var(--border); color: var(--accent);
  border-radius: 999px; padding: 8px 14px; font-size: 14px; font-weight: 700; cursor: pointer; }
#dd-toast { position: fixed; bottom: 26px; left: 50%; transform: translateX(-50%) translateY(20px);
  background: var(--card2); color: var(--text); border: 1px solid var(--border);
  border-radius: 10px; padding: 10px 18px; font-size: 14px; z-index: 2000;
  opacity: 0; pointer-events: none; transition: opacity .25s, transform .25s; }
#dd-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
.dd-share-canvas { width: 100%; border-radius: 12px; border: 1px solid var(--border); }
.dd-journal { cursor: pointer; }
.dd-journal .jt { font-size: 15.5px; font-weight: 700; margin-bottom: 4px; }
.dd-journal .jx { font-size: 14px; color: var(--muted); line-height: 1.5; }
.dd-blank { display: flex; gap: 12px; align-items: center; width: 100%; background: none;
  border: none; color: var(--text); font: inherit; cursor: pointer; padding: 0; text-align: left; }
.dd-blank .ic { font-size: 26px; }
.dd-cmp { margin-bottom: 10px; cursor: pointer; }
.dd-cmp .vs { font-size: 15px; font-weight: 700; }
.dd-cmp .sc { font-size: 13px; color: var(--muted); margin-top: 2px; }
.dd-cmp-detail { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border);
  display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.dd-cmp-detail .side { background: var(--card2); border-radius: 10px; padding: 10px; font-size: 13px; }
.dd-cmp-detail .side h4 { margin: 0 0 6px; font-size: 13px; }
`;
    document.head.appendChild(styleEl);
  }

  // ---------------------------------------------------------------------------
  // Overlay shell
  // ---------------------------------------------------------------------------

  function ensureOverlay() {
    ensureStyles();
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.id = "dd-overlay";
    overlay.className = "hidden";
    overlay.innerHTML = `
      <div id="dd-head">
        <button id="dd-back" aria-label="Back">‹</button>
        <div id="dd-title"></div>
        <button id="dd-menu-btn" aria-label="Day actions">⋯</button>
        <div id="dd-menu" class="hidden">
          <button data-act="add">＋&nbsp; Add sale</button>
          <button data-act="compare">⇄&nbsp; Compare sales</button>
          <button data-act="share">⤴&nbsp; Share day</button>
          <div class="sep"></div>
          <button data-act="clear" class="danger">🗑&nbsp; Delete all sales</button>
        </div>
      </div>
      <div id="dd-body"><div id="dd-col"></div></div>
      <div id="dd-sheet" class="hidden"><div class="sheet-card" id="dd-sheet-card"></div></div>
      <div id="dd-share" class="hidden"><div class="sheet-card" id="dd-share-card"></div></div>`;
    document.body.appendChild(overlay);
    overlay.querySelector("#dd-back").addEventListener("click", close);
    const menuBtn = overlay.querySelector("#dd-menu-btn");
    const menu = overlay.querySelector("#dd-menu");
    menuBtn.addEventListener("click", e => { e.stopPropagation(); menu.classList.toggle("hidden"); });
    document.addEventListener("click", () => menu.classList.add("hidden"));
    menu.addEventListener("click", e => {
      const act = e.target.closest("button")?.dataset.act;
      menu.classList.add("hidden");
      if (act === "add") hooks.onAddTicket ? hooks.onAddTicket(ctx.dayKey) : toast("Add-sale not wired yet");
      else if (act === "compare") hooks.onCompare ? hooks.onCompare(ctx.dayKey) : toast("Compare not wired yet");
      else if (act === "share") openShare();
      else if (act === "clear") confirmClearAll();
    });
    overlay.querySelector("#dd-sheet").addEventListener("click", e => {
      if (e.target.id === "dd-sheet") closeSheet();
    });
    overlay.querySelector("#dd-share").addEventListener("click", e => {
      if (e.target.id === "dd-share") closeShare();
    });
  }

  function col() { return overlay.querySelector("#dd-col"); }

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------

  async function loadContext(dayKey) {
    const backup = await SyncEngine.getLocalBackup();
    if (!backup || !backup.data) throw new Error("No backup data — sync first.");
    const data = backup.data;
    const day = (data.days || []).find(d => d.id === dayKey || d.date === dayKey);
    if (!day) throw new Error("Day not found in history.");
    if (!Array.isArray(day.tickets)) day.tickets = [];
    return {
      dayKey,
      day,
      data,
      profile: data.profile || {},
      shifts: data.shifts || [],
      holidayDates: data.holidayDates || [],
      table: PayEngine.tableForProfile(data.profile || {}),
      highlightTicketId: null,
    };
  }

  function journalFor(data, dayKey) {
    const j = data.journals;
    if (!j) return null;
    if (Array.isArray(j)) return j.find(e => (e.date || e.id || e.dayKey) === dayKey) || null;
    return j[dayKey] || null;
  }

  function comparisonsFor(data, dayKey) {
    const c = data.comparisons;
    if (!Array.isArray(c)) return [];
    return c.filter(x => (x.dayKey || x.date) === dayKey);
  }

  function contactName(data, id) {
    const c = (data.contacts || []).find(x =>
      String(x.id || "") === String(id) || (x.id && String(x.id).toLowerCase() === String(id).toLowerCase()));
    if (!c) return null;
    return c.preferredName || c.nickname || c.name || "Coworker";
  }

  // ---------------------------------------------------------------------------
  // Public: open / close / refresh
  // ---------------------------------------------------------------------------

  async function open(dayKey, opts) {
    ensureOverlay();
    overlay.querySelector("#dd-title").textContent = fmtShortDay(dayKey);
    overlay.querySelector("#dd-body").scrollTop = 0;
    col().innerHTML = `<div class="dd-empty">Loading…</div>`;
    overlay.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    try {
      ctx = await loadContext(dayKey);
    } catch (e) {
      col().innerHTML = `<div class="dd-card"><div class="dd-sec-h">Day not found</div>
        <div class="dd-sec-sub">This day is no longer in your history.</div></div>`;
      return;
    }
    if (opts && opts.highlightTicketId) ctx.highlightTicketId = String(opts.highlightTicketId);
    render();
    if (ctx.highlightTicketId) {
      setTimeout(() => {
        const el = overlay.querySelector(`[data-ticket-id="${esc(ctx.highlightTicketId)}"]`);
        if (el) {
          el.scrollIntoView({ block: "center", behavior: "smooth" });
          el.classList.add("flash");
          setTimeout(() => el.classList.remove("flash"), 2400);
        }
      }, 350);
    }
  }

  function close() {
    if (!overlay) return;
    overlay.classList.add("hidden");
    document.body.style.overflow = "";
    ctx = null;
  }

  async function refresh() {
    if (!ctx) return;
    const keepKey = ctx.dayKey, keepHl = ctx.highlightTicketId;
    try { ctx = await loadContext(keepKey); } catch (e) { toast("Couldn't reload day"); return; }
    ctx.highlightTicketId = keepHl;
    render();
  }

  // ---------------------------------------------------------------------------
  // Render: sections in app order
  // ---------------------------------------------------------------------------

  function render() {
    const c = col();
    const parts = [];
    parts.push(heroHTML());
    parts.push(hoursCardHTML());
    parts.push(paySectionHTML());
    parts.push(ticketsSectionHTML());
    const ret = pureReturnLines(ctx.day);
    if (ret.length) parts.push(returnsSectionHTML(ret));
    const ex = exchangeTickets(ctx.day);
    if (ex.length) parts.push(exchangesSectionHTML(ex));
    const saved = comparisonsFor(ctx.data, ctx.dayKey);
    if (saved.length) parts.push(comparisonsSectionHTML(saved));
    parts.push(journalSectionHTML());
    parts.push(`<div style="height:20px"></div>`);
    c.innerHTML = parts.join("");
    bindSectionEvents();
  }

  // ---- 1. Hero totals (DayDetailView.totals) ----
  function heroHTML() {
    const day = ctx.day, table = ctx.table;
    const commission = PayEngine.dayCommission(day, table);
    const revenue = dayRevenue(day);
    const tint = commission < -0.005 ? "var(--red)" : "var(--accent)";
    const revTint = revenue < -0.005 ? "var(--red)" : "var(--muted)";
    const wh = workedHours(day);
    const premium = PayEngine.dayPremium(ctx.shifts.filter(s =>
      PayEngine.dayKey(s.start) === ctx.dayKey), ctx.dayKey, ctx.holidayDates);
    const plans = plansSold(day);
    let minis = `
      <div class="dd-mini"><div class="v" style="color:var(--blue)">${itemsSold(day)}</div><div class="l">Items</div></div>`;
    if (plans > 0)
      minis += `<div class="dd-mini"><div class="v" style="color:var(--muted)">${plans}</div><div class="l">Plans</div></div>`;
    minis += `
      <div class="dd-mini"><div class="v" style="color:var(--accent)">${customerCount(day)}</div><div class="l">Customers</div></div>
      <div class="dd-mini"><div class="v">${wh > 0 ? customersPerHour(day).toFixed(1) : "—"}</div><div class="l">CPH</div></div>
      <div class="dd-mini"><div class="v" style="color:var(--amber)">${money(commissionPerHour(day, table, premium.totalHours))}</div><div class="l">An Hour</div></div>`;
    return `
      <div class="dd-card dd-hero">
        <div class="lbl">Commission</div>
        <div class="big" style="color:${tint}">${money(commission)}</div>
        <div class="cap" style="color:${revTint}">${money(revenue)} sold for the company</div>
        <div class="dd-grid">${minis}</div>
      </div>`;
  }

  // ---- 2. Hours card (DayDetailView.hoursCard) ----
  function hoursCardHTML() {
    const day = ctx.day;
    const premium = PayEngine.dayPremium(ctx.shifts.filter(s =>
      PayEngine.dayKey(s.start) === ctx.dayKey), ctx.dayKey, ctx.holidayDates);
    const isOff = (day.scheduledHours || 0) === 0;
    const title = isOff ? "Day off" : `${workedHours(day).toFixed(1)} hrs worked`;
    const sub = isOff
      ? "No shift — sticker sales & returns still count for commission"
      : `${(day.scheduledHours || 0).toFixed(1)}h scheduled · ${esc(lunchSummary(day))}`;
    let pills = "";
    if (premium.openingHours > 0) pills += `<span class="dd-pill" style="background:var(--amber-dim);color:var(--amber)">Opening shift</span>`;
    if (premium.closingHours > 0) pills += `<span class="dd-pill" style="background:var(--blue-dim);color:var(--blue)">Closing shift</span>`;
    return `
      <div class="dd-card">
        <button class="dd-hours" id="dd-hours-btn">
          <span class="ic">${isOff ? "📅" : "🕐"}</span>
          <span class="grow" style="flex:1">
            <div class="dd-sec-h">${esc(title)}</div>
            <div class="dd-sec-sub">${esc(sub)}</div>
            ${pills ? `<div style="margin-top:6px;display:flex;gap:6px">${pills}</div>` : ""}
          </span>
          <span style="color:var(--muted)">✎</span>
        </button>
      </div>`;
  }

  // ---- 3. Pay breakdown (DayDetailView.paySection) ----
  function paySectionHTML() {
    const day = ctx.day, profile = ctx.profile;
    const { pay, takeHome } = PayEngine.calculateDayPay(day, ctx.shifts, profile, ctx.holidayDates);
    const MW = PayEngine.MINIMUM_WAGE;
    const ot15 = PayEngine.overtimeHours15(day);
    const ot2 = PayEngine.overtimeHours2(day);
    const premium = pay.premium;
    const otInPremium = Math.min(ot15 + ot2, premium.closingHours);
    const rows = [];

    if (pay.openHours > 0) {
      const openFloorPay = pay.commission + pay.basePay;
      const cleared = pay.isShort
        ? `<span style="color:var(--red)">${money(pay.deficit)} under minimum wage</span>`
        : `<span style="color:var(--accent)">You cleared ${money(pay.surplus)} over minimum wage</span>`;
      rows.push(`
        <div class="dd-row">
          <span style="font-size:20px">🚶</span>
          <div class="grow"><div class="t1">Open floor</div>
            <div class="t2">Commission + base</div>
            <div class="t2" style="font-weight:600">${cleared}</div></div>
          <div class="amt" style="color:var(--accent)">${money(openFloorPay)}</div>
        </div>`);
    }
    if (premium.openingHours > 0) {
      rows.push(premiumRowHTML("🌅", "Opening shift", premium.openingHours, MW));
    }
    if (premium.closingHours - otInPremium > 0.005) {
      rows.push(premiumRowHTML("🌇", "Closing shift", premium.closingHours - otInPremium, MW));
    }
    if (ot15 > 0.005) rows.push(otRowHTML("⚡", "Overtime ×1.5", ot15, MW * 1.5));
    if (ot2 > 0.005) rows.push(otRowHTML("🐇", "Double time ×2", ot2, MW * 2));

    rows.push(`
      <div class="dd-row">
        <div class="grow"><div class="t1">Day total pay</div></div>
        <div class="amt" style="font-size:18px;color:${pay.total < -0.005 ? "var(--red)" : "var(--accent)"}">${money(pay.total)}</div>
      </div>`);

    if (takeHome) {
      const rate = (takeHome.combinedRate * 100);
      const taxStr = money(takeHome.totalTaxes); // always >= 0
      rows.push(`
        <div style="height:1px;background:var(--border);margin:4px 0"></div>
        <div class="dd-row">
          <div class="grow"><div class="t2">Est. taxes (~${rate.toFixed(2)}%)</div></div>
          <div class="amt" style="color:var(--amber)">−${taxStr}</div>
        </div>
        <div class="dd-row">
          <div class="grow"><div class="t1">Est. take-home</div></div>
          <div class="amt" style="font-size:18px;color:var(--accent)">${money(takeHome.net)}</div>
        </div>
        <div class="dd-foot">CA estimate: 8.95% payroll (SS + Medicare + SDI) + your income-tax %. Estimated — not exact withholding.</div>`);
    }

    let html = `
      <div class="dd-sec-h">Pay breakdown</div>
      <div class="dd-card">${rows.join("")}</div>`;

    if (PayEngine.hasOvertime(day)) {
      html += `<div class="dd-foot">CA daily overtime — hours worked past 8 pay 1.5× minimum wage, past 12 pay 2× (unpaid lunch doesn't count). OT hours that land while the store is closed pay the OT rate instead of the flat closed-store minimum wage.</div>`;
    }
    if (pay.isShort && (day.scheduledHours || 0) > 0) {
      html += topOffCardHTML(pay);
    }
    return html;
  }

  function premiumRowHTML(icon, name, hours, rate) {
    return `
      <div class="dd-row">
        <span style="font-size:20px">${icon}</span>
        <div class="grow"><div class="t1">${name} shift</div>
          <div class="t2">${hours.toFixed(1)} hrs × $${rate.toFixed(2)}</div></div>
        <div class="amt">${money(hours * rate)}</div>
      </div>`;
  }

  function otRowHTML(icon, name, hours, rate) {
    return `
      <div class="dd-row">
        <span style="font-size:20px">${icon}</span>
        <div class="grow"><div class="t1">${name}</div>
          <div class="t2">${hours.toFixed(1)} hrs × $${rate.toFixed(2)}</div></div>
        <div class="amt" style="color:var(--accent)">${money(hours * rate)}</div>
      </div>`;
  }

  // Top-off card: the min-wage floor applies across the whole pay period.
  function topOffCardHTML(pay) {
    let periodTopUp = 0, periodLabel = "";
    try {
      const period = PayEngine.payPeriodContaining(ctx.dayKey);
      periodLabel = PayEngine.periodLabel(period);
      const { summary } = PayEngine.calculatePeriodPay(
        period, ctx.data.days || [], ctx.shifts, ctx.profile, ctx.holidayDates);
      periodTopUp = summary.topUp || 0;
    } catch (e) { /* period math unavailable — generic message */ }
    const stillShort = periodTopUp > 0.005;
    const message = stillShort
      ? `This day fell ${money(pay.deficit)} short of minimum wage on open hours — and the whole period is still short, so the company tops you up ${money(periodTopUp)} for ${esc(periodLabel)} so far.`
      : `This day fell ${money(pay.deficit)} short of minimum wage on its own — surplus from your stronger days in ${esc(periodLabel)} covers it. No top-up needed.`;
    return `
      <div class="dd-card dd-topoff">
        <div class="h">⤵ TOP-OFF DAY</div>
        <div style="font-size:14px;font-weight:500;margin-bottom:6px">${message}</div>
        <div class="dd-foot">Micro Center applies the minimum-wage floor across the whole pay period, not day by day — good days offset short ones.</div>
      </div>`;
  }

  // ---- 4. Transactions (DayDetailView.ticketsSection) ----
  function ticketsSectionHTML() {
    const day = ctx.day;
    const n = customerCount(day);
    let inner;
    if (!day.tickets.length) {
      inner = `<div class="dd-card"><div class="dd-empty">🛒<br>No tickets yet<br>
        <span style="font-size:13px">Use ⋯ → Add sale to log one for this day.</span></div></div>`;
    } else {
      const sorted = [...day.tickets]
        .map((t, i) => ({ t, i }))
        .sort((a, b) => String(b.t.time || "") < String(a.t.time || "") ? -1 : 1);
      inner = sorted.map(({ t, i }) => ticketCardHTML(t, i)).join("");
    }
    return `
      <div class="dd-sec-h">Transactions</div>
      <div class="dd-sec-sub">${n} customer${n === 1 ? "" : "s"} served</div>
      <div>${inner}</div>`;
  }

  function ticketCardHTML(ticket, ticketIndex) {
    const table = ctx.table;
    const rev = ticketRevenue(ticket);
    const revTint = rev < 0 ? "var(--red)" : "var(--text)";
    let pills = "";
    if (isExchangeTicket(ticket))
      pills += `<span class="dd-pill" style="background:var(--amber-dim);color:var(--amber)">Exchange</span>`;
    else if (ticketHasReturns(ticket))
      pills += `<span class="dd-pill" style="background:var(--red-dim);color:var(--red)">Has returns</span>`;
    const tid = ticket.id || ("t" + ticketIndex);
    const lines = (ticket.lines || []).map((l, li) => {
      const comm = PayEngine.lineCommission(l, table);
      return `
        <div class="dd-line">
          <span class="dd-dot" style="background:${l.isReturn ? "var(--red)" : "var(--blue)"}"></span>
          <span class="p">${esc(l.product) || "—"}</span>
          <span class="q">×${l.quantity}</span>
          <button class="x" data-line-edit="${ticketIndex}:${li}" title="Edit line" style="color:var(--blue)">✎</button>
          <button class="x" data-line-del="${ticketIndex}:${li}" title="Delete line" style="color:var(--red)">✕</button>
          <span class="c" style="color:${l.isReturn ? "var(--red)" : "var(--accent)"}">${money(comm)}</span>
        </div>`;
    }).join("");
    return `
      <div class="dd-ticket" data-ticket-id="${esc(tid)}">
        <div class="th">
          <span class="tm">${esc(fmtTimeOnly(ticket.time))}</span>
          ${pills}
          <span class="rev" style="color:${revTint}">${money(rev)}</span>
        </div>
        ${lines}
        ${ticket.customerNote ? `<div class="dd-note">${esc(ticket.customerNote)}</div>` : ""}
        <div class="acts">
          <button class="dd-link" data-ticket-addline="${ticketIndex}">＋ Add line</button>
          <button class="dd-link danger" data-ticket-del="${ticketIndex}">🗑 Delete ticket</button>
          <span style="flex:1"></span>
          <span class="dd-sec-sub">${ticketItemCount(ticket)} items</span>
        </div>
      </div>`;
  }

  // ---- 5. Returns (DayDetailView.returnsSection) ----
  function returnsSectionHTML(ret) {
    const total = Math.abs(ret.reduce((s, l) => s + lineRevenue(l), 0));
    const rows = ret.map(l => `
      <div class="dd-line">
        <span style="font-size:16px">↩️</span>
        <div class="grow" style="flex:1;min-width:0">
          <div class="t1" style="font-size:14px">${esc(l.product) || "—"}</div>
          <div class="t2">${esc(l.brand || kindTitle(l.kind))} · ×${l.quantity}</div>
        </div>
        <span class="c" style="font-size:14px;font-weight:700;color:var(--red)">${money(lineRevenue(l))}</span>
      </div>`).join("");
    return `
      <div class="dd-sec-h">Returns</div>
      <div class="dd-sec-sub">${ret.length} item${ret.length === 1 ? "" : "s"} ·
        <span style="color:var(--red)">−${money(total).replace("-", "")}</span> off your day</div>
      <div class="dd-card">${rows}</div>`;
  }

  function kindTitle(kind) {
    return kind === "servicePlan" ? "Plan" : kind === "outOfDepartment" ? "Out of dept" : "In dept";
  }

  // ---- 6. Exchanges (DayDetailView.exchangesSection) ----
  function exchangesSectionHTML(tickets) {
    const net = tickets.reduce((s, t) => s + ticketRevenue(t), 0);
    const netTint = net > 0.005 ? "var(--accent)" : (net < -0.005 ? "var(--red)" : "var(--text)");
    const cards = [...tickets]
      .sort((a, b) => String(b.time || "") < String(a.time || "") ? -1 : 1)
      .map(t => {
        const tnet = ticketRevenue(t);
        const gotCredit = (t.lines || []).some(l => !l.isReturn);
        const lines = (t.lines || []).map(l => `
          <div class="dd-line">
            <span class="dd-dot" style="background:${l.isReturn ? "var(--red)" : "var(--accent)"}"></span>
            <span class="p">${esc(l.product) || "—"}</span>
            <span class="q">×${l.quantity}</span>
            <span class="c" style="color:${l.isReturn ? "var(--red)" : "var(--accent)"}">${money(lineRevenue(l))}</span>
          </div>`).join("");
        return `
          <div class="dd-ticket">
            <div class="th">
              <span class="tm">${esc(fmtTimeOnly(t.time))}</span>
              <span class="rev" style="color:${tnet > 0.005 ? "var(--accent)" : (tnet < -0.005 ? "var(--red)" : "var(--text)")}">${money(tnet)}</span>
            </div>
            ${lines}
            <div style="margin-top:8px"><span class="dd-pill" style="background:${gotCredit ? "var(--accent-dim)" : "var(--red-dim)"};color:${gotCredit ? "var(--accent)" : "var(--red)"}">
              ${gotCredit ? "Sale credited to you" : "Credit went to another associate"}</span></div>
            ${t.customerNote ? `<div class="dd-note">${esc(t.customerNote)}</div>` : ""}
          </div>`;
      }).join("");
    return `
      <div class="dd-sec-h">Exchanges</div>
      <div class="dd-sec-sub">${tickets.length} ticket${tickets.length === 1 ? "" : "s"} ·
        <span style="color:${netTint}">${money(net)}</span> net</div>
      <div>${cards}</div>`;
  }

  // ---- 7. Coworker comparisons (DayDetailView.comparisonsSection) ----
  function comparisonsSectionHTML(list) {
    const cards = list.map((c, i) => `
      <div class="dd-card dd-cmp" data-cmp="${i}">
        <div style="display:flex;align-items:center;gap:10px">
          <span style="font-size:18px">⇄</span>
          <div style="flex:1">
            <div class="vs">You vs ${esc(c.coworkerName || "Coworker")}</div>
            <div class="sc">${money((c.theirs || {}).revenue || 0)} vs your ${money((c.yours || {}).revenue || 0)}</div>
          </div>
          <span style="color:var(--muted)">›</span>
        </div>
        <div class="dd-cmp-detail hidden" id="dd-cmp-${i}" style="display:none">
          ${cmpSideHTML("You", c.yours)}${cmpSideHTML(esc(c.coworkerName || "Coworker"), c.theirs)}
        </div>
      </div>`).join("");
    return `
      <div class="dd-sec-h">Coworker comparisons</div>
      <div class="dd-sec-sub">Saved head-to-heads for this day</div>
      <div>${cards}</div>`;
  }

  function cmpSideHTML(name, side) {
    side = side || {};
    const avg = side.customers > 0 ? side.revenue / side.customers : 0;
    const cph = side.hours > 0 ? side.commission / side.hours : null;
    return `
      <div class="side">
        <h4>${name}</h4>
        <div>Revenue: <b>${money(side.revenue || 0)}</b></div>
        <div>Commission: <b>${money(side.commission || 0)}</b></div>
        <div>Items: ${side.items || 0} · Plans: ${side.plans || 0}</div>
        <div>Customers: ${side.customers || 0}</div>
        <div>Avg ticket: ${money(avg)}</div>
        ${cph !== null ? `<div>$/hr: ${money(cph)}</div>` : ""}
        ${(side.topProducts || []).length ? `<div style="margin-top:4px;color:var(--muted)">${(side.topProducts || []).map(esc).join("<br>")}</div>` : ""}
      </div>`;
  }

  // ---- 8. Journal (DayDetailView.journalSection) ----
  function journalSectionHTML() {
    const j = journalFor(ctx.data, ctx.dayKey);
    let head = `<div style="display:flex;align-items:baseline;gap:8px">
        <div class="dd-sec-h">Journal</div><span style="flex:1"></span>`;
    if (j) head += `<button class="dd-link" id="dd-journal-edit">✎ Edit</button>`;
    else head += `<div class="dd-sec-sub">A blank page for how the day went</div>`;
    head += `</div>`;

    let body;
    if (j) {
      const text = j.summary && String(j.summary).trim()
        ? String(j.summary)
        : String(j.text || j.content || "");
      const preview = text.length > 220 ? text.slice(0, 220) + "…" : text;
      body = `
        <div class="dd-card dd-journal" id="dd-journal-card">
          <div class="jt">${esc(j.title) || "Untitled entry"}</div>
          <div class="jx">${esc(preview)}</div>
          ${journalChipsHTML(j)}
        </div>`;
    } else {
      body = `
        <div class="dd-card">
          <button class="dd-blank" id="dd-journal-new">
            <span class="ic">📖</span>
            <span><div class="dd-sec-h" style="font-size:15px">Write today's journal</div>
            <div class="dd-sec-sub">What happened, who you helped, anything worth keeping.</div></span>
            <span style="flex:1"></span><span style="color:var(--muted)">›</span>
          </button>
        </div>`;
    }
    return head + body;
  }

  // LINKED TO THIS DAY chips — one pill per sale/person a story links to.
  function journalChipsHTML(journal) {
    const stories = journal.stories || [];
    if (!stories.length) return "";
    const seen = new Set(), chips = [];
    for (const s of stories) {
      const cid = s.resolvedContactID || s.contactId;
      if (cid && !seen.has(cid)) {
        seen.add(cid);
        const name = contactName(ctx.data, cid) || "Coworker";
        chips.push({ label: name, sale: false });
      }
      const tid = s.resolvedTicketID || s.ticketId;
      if (tid && !seen.has("sale-" + tid)) {
        seen.add("sale-" + tid);
        const label = s.saleLabel
          || (ctx.day.tickets || []).map(t => String(t.id) === String(tid) ? t : null)
              .find(Boolean)?.lines?.find(l => l.product)?.product
          || "Sale";
        chips.push({ label, sale: true });
      }
    }
    if (!chips.length) return "";
    return `<div class="dd-chiprow">` + chips.map(c =>
      `<span class="dd-pill" style="background:${c.sale ? "var(--accent-dim)" : "var(--blue-dim)"};color:${c.sale ? "var(--accent)" : "var(--blue)"}">${esc(c.label)}</span>`
    ).join("") + `</div>`;
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  function bindSectionEvents() {
    const q = s => overlay.querySelector(s);
    const qa = s => [...overlay.querySelectorAll(s)];

    const hb = q("#dd-hours-btn");
    if (hb) hb.addEventListener("click", openHoursSheet);

    qa("[data-line-edit]").forEach(b => b.addEventListener("click", () => {
      const [ti, li] = b.dataset.lineEdit.split(":").map(Number);
      if (hooks.onEditLine) hooks.onEditLine(ctx.dayKey, ti, li);
      else toast("Line editor not wired yet");
    }));

    qa("[data-line-del]").forEach(b => b.addEventListener("click", async () => {
      const [ti, li] = b.dataset.lineDel.split(":").map(Number);
      if (!confirm("Delete this line?")) return;
      try {
        await SyncEngine.queueWrite({ type: "deleteLine", dayId: ctx.dayKey, ticketIndex: ti, lineIndex: li });
        toast("Line deleted");
        refresh();
      } catch (e) { toast("Couldn't delete line"); }
    }));

    qa("[data-ticket-addline]").forEach(b => b.addEventListener("click", () => {
      const ti = Number(b.dataset.ticketAddline);
      if (hooks.onEditLine) hooks.onEditLine(ctx.dayKey, ti, -1); // -1 = new line
      else toast("Line editor not wired yet");
    }));

    qa("[data-ticket-del]").forEach(b => b.addEventListener("click", async () => {
      const ti = Number(b.dataset.ticketDel);
      if (!confirm("Delete this whole ticket and its lines?")) return;
      try {
        // NOTE: needs {type:"deleteTicket"} support in sync.js applyOp.
        await SyncEngine.queueWrite({ type: "deleteTicket", dayId: ctx.dayKey, ticketIndex: ti });
        toast("Ticket deleted");
        refresh();
      } catch (e) { toast("Couldn't delete ticket"); }
    }));

    qa("[data-cmp]").forEach(card => card.addEventListener("click", () => {
      const d = card.querySelector(".dd-cmp-detail");
      if (d) d.style.display = d.style.display === "none" ? "grid" : "none";
    }));

    const je = q("#dd-journal-edit"), jc = q("#dd-journal-card"), jn = q("#dd-journal-new");
    const goJournal = () => {
      if (hooks.onEditJournal) hooks.onEditJournal(ctx.dayKey);
      else toast("Journal editor not wired yet");
    };
    if (je) je.addEventListener("click", e => { e.stopPropagation(); goJournal(); });
    if (jc) jc.addEventListener("click", goJournal);
    if (jn) jn.addEventListener("click", goJournal);
  }

  async function confirmClearAll() {
    const n = (ctx.day.tickets || []).length;
    if (!n) { toast("No tickets to delete"); return; }
    if (!confirm(`Delete all ${n} transaction${n === 1 ? "" : "s"}? Hours, lunch, and the journal stay.`)) return;
    try {
      // NOTE: needs {type:"clearDayTickets"} support in sync.js applyOp.
      await SyncEngine.queueWrite({ type: "clearDayTickets", dayId: ctx.dayKey });
      toast("All sales deleted");
      refresh();
    } catch (e) { toast("Couldn't delete sales"); }
  }

  // ---------------------------------------------------------------------------
  // Hours & Lunch sheet — port of DayDetailView.hoursSheet
  // ---------------------------------------------------------------------------

  let sheetState = null; // { hoursText, lunchStart: "HH:MM"|null, secondLunchStart }

  function openHoursSheet() {
    const day = ctx.day;
    sheetState = {
      hoursText: (day.scheduledHours || 0).toFixed(2),
      lunchStart: toTimeInput(day.lunchStart),
      secondLunchStart: toTimeInput(day.secondLunchStart),
    };
    renderHoursSheet();
    overlay.querySelector("#dd-sheet").classList.remove("hidden");
  }

  function closeSheet() {
    overlay.querySelector("#dd-sheet").classList.add("hidden");
    sheetState = null;
  }

  function toTimeInput(t) {
    if (!t) return null;
    const d = new Date(t);
    if (isNaN(d)) return null;
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  function effectiveHours() {
    const v = parseFloat(sheetState.hoursText);
    return isNaN(v) ? (ctx.day.scheduledHours || 8) : v;
  }

  function renderHoursSheet() {
    const eh = effectiveHours();
    const card = overlay.querySelector("#dd-sheet-card");
    let lunchHTML;
    if (eh < 5) {
      lunchHTML = `<div class="dd-foot">Under 5 hours — no lunch break.</div>`;
    } else {
      lunchHTML = breakRowHTML("Lunch at", "lunchStart", sheetState.lunchStart);
      if (eh >= 11) lunchHTML += breakRowHTML("Second lunch at", "secondLunchStart", sheetState.secondLunchStart);
      lunchHTML += `<div class="dd-foot" style="margin-top:8px">${eh >= 11
        ? "Two breaks on a long shift — lunch minutes auto-set from your hours."
        : "One 60-minute lunch, auto-deducted — add the time you'll take it."}</div>`;
    }
    card.innerHTML = `
      <h2 style="margin:0 0 16px">Hours &amp; Lunch</h2>
      <div class="dd-field">
        <label>Hours scheduled</label>
        <input type="number" id="dd-h-input" step="0.25" min="0" value="${esc(sheetState.hoursText)}">
      </div>
      <div class="dd-field">
        <label>Lunch break</label>
        ${lunchHTML}
      </div>
      <div class="modal-actions" style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px">
        <button class="btn ghost" id="dd-h-cancel">Cancel</button>
        <button class="btn primary" id="dd-h-save">Save</button>
      </div>`;
    card.querySelector("#dd-h-input").addEventListener("input", e => {
      sheetState.hoursText = e.target.value;
      renderHoursSheet();
      const inp = card.querySelector("#dd-h-input");
      inp.focus();
      inp.setSelectionRange(inp.value.length, inp.value.length);
    });
    card.querySelectorAll("[data-break-add]").forEach(b => b.addEventListener("click", () => {
      // Seed: mid-shift, like the app's defaultBreakTime().
      const d = parseDayKey(ctx.dayKey);
      d.setHours(12, 0, 0, 0);
      sheetState[b.dataset.breakAdd] = toTimeInput(d.toISOString());
      renderHoursSheet();
    }));
    card.querySelectorAll("[data-break-time]").forEach(inp => inp.addEventListener("change", e => {
      sheetState[e.target.dataset.breakTime] = e.target.value || null;
    }));
    card.querySelector("#dd-h-cancel").addEventListener("click", closeSheet);
    card.querySelector("#dd-h-save").addEventListener("click", saveHoursSheet);
  }

  function breakRowHTML(title, key, val) {
    const ctrl = val
      ? `<input type="time" data-break-time="${key}" value="${esc(val)}">`
      : `<button class="dd-addtime" data-break-add="${key}">＋ Add time</button>`;
    return `<div class="dd-breakrow"><span class="t">${title}</span>${ctrl}</div>`;
  }

  function timeInputToISO(hhmm) {
    if (!hhmm) return null;
    const d = parseDayKey(ctx.dayKey);
    const [h, m] = hhmm.split(":").map(Number);
    d.setHours(h || 0, m || 0, 0, 0);
    return d.toISOString();
  }

  async function saveHoursSheet() {
    const day = ctx.day;
    const scheduledHours = parseFloat(sheetState.hoursText);
    const updates = {
      scheduledHours: isNaN(scheduledHours) ? (day.scheduledHours || 0) : scheduledHours,
      lunchMinutes: autoLunchMinutes(isNaN(scheduledHours) ? 0 : scheduledHours),
      lunchStart: null,
      secondLunchStart: null,
    };
    if (updates.lunchMinutes > 0 && sheetState.lunchStart)
      updates.lunchStart = timeInputToISO(sheetState.lunchStart);
    if ((updates.scheduledHours || 0) >= 11 && sheetState.secondLunchStart)
      updates.secondLunchStart = timeInputToISO(sheetState.secondLunchStart);
    try {
      // NOTE: needs {type:"updateDay"} support in sync.js applyOp.
      await SyncEngine.queueWrite({ type: "updateDay", dayId: ctx.dayKey, updates });
      toast("Hours saved");
      closeSheet();
      refresh();
    } catch (e) { toast("Couldn't save hours"); }
  }

  // ---------------------------------------------------------------------------
  // Share — summary card (canvas) + text
  // ---------------------------------------------------------------------------

  function shareText() {
    const day = ctx.day, table = ctx.table;
    const commission = PayEngine.dayCommission(day, table);
    const { pay, takeHome } = PayEngine.calculateDayPay(day, ctx.shifts, ctx.profile, ctx.holidayDates);
    const lines = [
      `${fmtLongDay(ctx.dayKey)} — Micro Buddy day summary`,
      `Commission: ${money(commission)}`,
      `Sold: ${money(dayRevenue(day))} · ${itemsSold(day)} items · ${customerCount(day)} customers`,
      `Worked: ${workedHours(day).toFixed(1)}h${(day.lunchMinutes || 0) ? ` (${day.lunchMinutes}m lunch)` : ""}`,
      `Day total pay: ${money(pay.total)}`,
    ];
    if (takeHome) lines.push(`Est. take-home: ${money(takeHome.net)}`);
    const plans = plansSold(day);
    if (plans) lines.push(`Service plans: ${plans}`);
    return lines.join("\n");
  }

  function openShare() {
    const card = overlay.querySelector("#dd-share-card");
    card.innerHTML = `
      <h2 style="margin:0 0 12px">Share day</h2>
      <canvas id="dd-share-canvas" class="dd-share-canvas" width="1200" height="630"></canvas>
      <pre id="dd-share-text" style="white-space:pre-wrap;font-size:13.5px;background:var(--card);
        border:1px solid var(--border);border-radius:10px;padding:12px;margin:12px 0">${esc(shareText())}</pre>
      <div class="modal-actions" style="display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap">
        <button class="btn ghost" id="dd-share-copy">Copy text</button>
        <button class="btn ghost" id="dd-share-dl">Download PNG</button>
        <button class="btn primary" id="dd-share-close">Done</button>
      </div>`;
    overlay.querySelector("#dd-share").classList.remove("hidden");
    drawShareCard(card.querySelector("#dd-share-canvas"));
    card.querySelector("#dd-share-copy").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(shareText()); toast("Summary copied"); }
      catch (e) { toast("Copy failed"); }
    });
    card.querySelector("#dd-share-dl").addEventListener("click", () => {
      const a = document.createElement("a");
      a.download = `microbuddy-${ctx.dayKey}.png`;
      a.href = card.querySelector("#dd-share-canvas").toDataURL("image/png");
      a.click();
    });
    card.querySelector("#dd-share-close").addEventListener("click", closeShare);
  }

  function closeShare() {
    overlay.querySelector("#dd-share").classList.add("hidden");
  }

  // Day share card — landscape summary (app renders DayShareCard 1920×1080).
  function drawShareCard(cv) {
    const g = cv.getContext("2d");
    const W = cv.width, H = cv.height;
    const cs = getComputedStyle(document.documentElement);
    const bg = cs.getPropertyValue("--bg").trim() || "#0d1017";
    const card = cs.getPropertyValue("--card").trim() || "#171c26";
    const text = cs.getPropertyValue("--text").trim() || "#e8ecf3";
    const muted = cs.getPropertyValue("--muted").trim() || "#8b94a7";
    const accent = cs.getPropertyValue("--accent").trim() || "#34d399";
    const blue = cs.getPropertyValue("--blue").trim() || "#60a5fa";

    const day = ctx.day, table = ctx.table;
    const commission = PayEngine.dayCommission(day, table);
    const { pay, takeHome } = PayEngine.calculateDayPay(day, ctx.shifts, ctx.profile, ctx.holidayDates);

    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    g.fillStyle = card;
    if (g.roundRect) { g.beginPath(); g.roundRect(40, 40, W - 80, H - 80, 28); g.fill(); }
    else g.fillRect(40, 40, W - 80, H - 80);

    g.textAlign = "center";
    g.fillStyle = muted; g.font = "600 30px system-ui";
    g.fillText(fmtLongDay(ctx.dayKey).toUpperCase(), W / 2, 130);
    g.fillStyle = commission < 0 ? "#f87171" : accent;
    g.font = "800 120px system-ui";
    g.fillText(money(commission), W / 2, 270);
    g.fillStyle = muted; g.font = "500 30px system-ui";
    g.fillText("COMMISSION", W / 2, 315);

    const stats = [
      ["SOLD", money(dayRevenue(day))],
      ["ITEMS", String(itemsSold(day))],
      ["CUSTOMERS", String(customerCount(day))],
      ["HOURS", workedHours(day).toFixed(1)],
      ["DAY PAY", money(pay.total)],
    ];
    if (takeHome) stats.push(["TAKE-HOME", money(takeHome.net)]);
    const n = stats.length, slotW = (W - 160) / n;
    stats.forEach(([lbl, val], i) => {
      const x = 80 + slotW * (i + 0.5);
      g.fillStyle = blue; g.font = "800 44px system-ui";
      g.fillText(val, x, 440);
      g.fillStyle = muted; g.font = "600 22px system-ui";
      g.fillText(lbl, x, 480);
    });

    g.fillStyle = muted; g.font = "600 26px system-ui";
    g.fillText("MICRO BUDDY", W / 2, H - 80);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  return {
    open,
    close,
    refresh,
    // Parent wiring — assign before/after open():
    set onAddTicket(fn) { hooks.onAddTicket = fn; },
    set onEditLine(fn) { hooks.onEditLine = fn; },
    set onEditJournal(fn) { hooks.onEditJournal = fn; },
    set onCompare(fn) { hooks.onCompare = fn; },
  };
})();
