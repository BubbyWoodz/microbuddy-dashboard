"use strict";
/* ============ sales.js — Sales tab (port of SalesView.swift, desktop layout) ============
 * Everything is computed from the backup blob (the phone's source of truth)
 * with PayEngine — no MCP round-trips, so it works offline and matches iOS.
 *
 *   Mirrors the iPhone Sales tab:
 *   Top row : Log today's sales  |  Find a product (text + min/max $)
 *   Below   : search results (while searching) or a grid of day cards by month
 *   The pay-period breakdown is no longer on this page; SalesUI.renderPay(el)
 *   draws it into a sheet when Home's Pay period widget is clicked.
 *
 * Parent wiring (dashboard.html):
 *   SalesUI.onOpenDay  = (dayKey, ticketId?) => DayDetailUI.open(dayKey, {highlightTicketId})
 *   SalesUI.onAddSale  = (dayKey) => openSaleModal(dayKey)
 *   SalesUI.onPaste    = (dayKey) => openSaleModal(dayKey, "paste")
 *   SalesUI.render(el)
 * Uses globals: money, num, esc, Icon, SyncEngine, PayEngine.
 * ====================================================================================== */
const SalesUI = (() => {
  const I = (n, o) => (typeof Icon === "function" ? Icon(n, o) : "");
  const hooks = { onOpenDay: null, onAddSale: null, onPaste: null };
  const state = {
    query: "", min: "", max: "",
    period: null, // {start,end,payday}
    data: null,
  };
  let host = null;

  // ---- helpers ----
  function localKey(d) {
    const x = d || new Date();
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  }
  const keyOf = d => d.id || (d.date ? PayEngine.dayKey(d.date) : "");
  const localDate = k => { const [y, m, d] = String(k).split("-").map(Number); return new Date(y, m - 1, d); };
  const lines = d => (d.tickets || []).flatMap(t => t.lines || []);
  const lineRev = l => PayEngine.lineRevenue({ isReturn: !!l.isReturn, unitPrice: Number(l.unitPrice) || 0, quantity: Number(l.quantity) || 0 });
  const dayRevenue = d => lines(d).reduce((s, l) => s + lineRev(l), 0);
  const itemsSold = d => (d.tickets || []).reduce((s, t) => s + (t.lines || [])
    .filter(l => !l.isReturn && !l.isExchange && l.kind !== "servicePlan").reduce((a, l) => a + (Number(l.quantity) || 0), 0), 0);
  const returnLines = d => lines(d).filter(l => l.isReturn);
  const returnsTotal = d => Math.abs(returnLines(d).reduce((s, l) => s + lineRev(l), 0));
  const KIND_SHORT = { inDepartment: "In Dept", outOfDepartment: "Out of Dept", servicePlan: "Service" };
  function compact(n) {
    const v = Number(n) || 0, a = Math.abs(v), s = v < 0 ? "-" : "";
    if (a >= 1000000) return `${s}$${(a / 1e6).toFixed(1)}M`;
    if (a >= 1000) return `${s}$${(a / 1000).toFixed(1)}k`;
    return money(v);
  }
  const fmtLong = k => localDate(k).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric" });
  const fmtSold = k => localDate(k).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  const fmtShort = k => localDate(k).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

  async function loadData() {
    const backup = await SyncEngine.getLocalBackup();
    const data = (backup && backup.data) || {};
    const profile = data.profile || {};
    const shifts = (data.shifts || []).filter(s => s && !s.isRemoved);
    const holidayDates = data.holidayDates || profile.holidayDates || [];
    state.data = {
      raw: data, profile, shifts, holidayDates,
      table: PayEngine.tableForProfile(profile),
      premiumByDay: PayEngine.premiumsByDay(shifts, holidayDates),
      days: (data.days || []).slice().sort((a, b) => keyOf(a) < keyOf(b) ? 1 : -1),
    };
    if (!state.period) state.period = PayEngine.payPeriodContaining(localKey());
  }

  // ---- Today ----
  function todayHTML() {
    const { days, table, premiumByDay } = state.data;
    const tk = localKey();
    const today = days.find(d => keyOf(d) === tk);
    const head = `<div class="sec-head"><div class="grow"><div class="sec-title">Today</div>` +
      `<div class="sec-sub">${esc(localDate(tk).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }))}</div></div>` +
      (today && !PayEngine.isEmptyDay(today) ? `<button class="link-btn" data-open="${tk}">${I("edit", { size: 16 })} Edit</button>` : "") + `</div>`;
    if (!today || PayEngine.isEmptyDay(today)) {
      return `<div class="panel">${head}<div class="empty-state" style="padding:14px 6px 4px">` +
        `<div class="empty-ico navy">${I("cart", { size: 34 })}</div><div class="t">Log today's sales</div>` +
        `<p>Add each ticket as you go, or dump them all in at the end of your shift. You can always edit later.</p>` +
        `<div class="btn-row" style="justify-content:center;margin-top:12px">` +
        `<button class="btn primary" data-add="${tk}">${I("plus")} Input today's sales</button>` +
        `<button class="btn ghost" data-paste="${tk}">${I("clipboard")} Paste a whole screen</button></div>` +
        `<div class="caption" style="margin-top:10px">Copied a whole screen from the system? Paste it and Buddy turns it into ticket lines.</div></div></div>`;
    }
    const com = PayEngine.dayCommission(today, table);
    const rev = dayRevenue(today);
    const prem = (premiumByDay[tk] || {}).totalHours || 0;
    const wh = PayEngine.workedHours(today);
    const open = Math.max(0, wh - prem);
    const cph = open > 0.005 ? com / open : 0;
    const ret = returnLines(today);
    return `<div class="panel">${head}<div style="display:flex;align-items:flex-start;gap:16px">` +
      `<div class="grow"><div class="label">Commission today</div>` +
      `<div class="hero-num lg ${com < -0.005 ? "red" : "money"}">${money(com)}</div>` +
      `<div class="caption ${rev < -0.005 ? "red" : ""}">${money(rev)} sold · ${num(itemsSold(today))} items</div></div>` +
      `<div style="text-align:right">` +
      ((Number(today.scheduledHours) || 0) === 0
        ? `<div class="sec-title" style="font-size:17px">Day off</div><div class="caption">commission only</div>`
        : `<div class="sec-title" style="font-size:17px">${wh.toFixed(1)} hrs</div><div class="caption">${Number(today.lunchMinutes) || 0}m lunch</div>` +
          `<div class="amber" style="font-weight:800;font-size:13px">${money(cph)}/hr</div>`) +
      `</div></div>` +
      (ret.length ? `<div class="kv-row" style="margin-top:8px"><span class="k accent">${I("return", { size: 16 })} ${ret.length} returns</span><span class="v red">-${money(returnsTotal(today))}</span></div>` : "") +
      `<div class="btn-row" style="margin-top:14px"><button class="btn primary" style="flex:1" data-add="${tk}">${I("plus")} Add another ticket</button>` +
      `<button class="btn ghost" style="flex:1" data-paste="${tk}">${I("clipboard")} Paste a whole screen</button></div></div>`;
  }

  // ---- Search ----
  function searchHTML() {
    const active = state.query || state.min || state.max;
    return `<div class="panel sales-search"><div class="sec-head"><div class="grow"><div class="sec-title">Find a product</div>` +
      `<div class="sec-sub">Search everything you've sold by product, brand or price</div></div>` +
      (active ? `<button class="link-btn" id="sales-clear">${I("close", { size: 16 })} Clear</button>` : "") + `</div>` +
      `<div class="search-box">${I("search")}` +
      `<input id="sales-q" type="search" placeholder="Product or brand, e.g. Keychron" value="${esc(state.query)}" autocomplete="off"></div>` +
      `<div class="field-row" style="margin-top:12px">` +
      `<div class="field"><label for="sales-min">Min price</label><div class="input-prefix"><span>$</span><input id="sales-min" inputmode="decimal" placeholder="0" value="${esc(state.min)}"></div></div>` +
      `<div class="field"><label for="sales-max">Max price</label><div class="input-prefix"><span>$</span><input id="sales-max" inputmode="decimal" placeholder="Any" value="${esc(state.max)}"></div></div></div></div>`;
  }

  function searchResults() {
    const needle = state.query.trim().toLowerCase();
    const min = state.min !== "" && !isNaN(parseFloat(state.min)) ? parseFloat(state.min) : null;
    const max = state.max !== "" && !isNaN(parseFloat(state.max)) ? parseFloat(state.max) : null;
    const out = [];
    for (const day of state.data.days) {
      for (const t of (day.tickets || [])) {
        for (const l of (t.lines || [])) {
          const okText = !needle || String(l.product || "").toLowerCase().includes(needle) || String(l.brand || "").toLowerCase().includes(needle);
          const p = Number(l.unitPrice) || 0;
          if (okText && (min == null || p >= min) && (max == null || p <= max)) out.push({ day, ticket: t, line: l });
        }
      }
    }
    return out;
  }

  function resultsHTML() {
    const res = searchResults();
    const total = res.reduce((s, r) => s + lineRev(r.line), 0);
    let html = `<div class="panel"><div class="sec-head"><div class="grow"><div class="sec-title">Results</div>` +
      `<div class="sec-sub">${res.length} matching line${res.length === 1 ? "" : "s"} · ${money(total)} · click one to open its day</div></div></div>`;
    if (!res.length) {
      return html + `<div class="empty-state"><div class="empty-ico">${I("search", { size: 30 })}</div><div class="t">Nothing found</div>` +
        `<p>Try a different product, brand, or price range.</p></div></div>`;
    }
    html += `<div class="table-wrap"><table class="tbl"><thead><tr><th></th><th>Product</th><th>Brand</th><th>Date sold</th><th class="r">Qty</th><th class="r">Price</th></tr></thead><tbody>`;
    for (const r of res.slice(0, 200)) {
      const l = r.line, k = keyOf(r.day);
      html += `<tr class="clickable" data-open="${esc(k)}" data-ticket="${esc(r.ticket.id || "")}">` +
        `<td style="width:28px" class="${l.isReturn ? "accent" : "navy"}">${I(l.isReturn ? "return" : "box", { size: 16 })}</td>` +
        `<td><b>${esc(l.product || "")}</b></td><td class="muted">${esc(l.brand || KIND_SHORT[l.kind] || "")}</td>` +
        `<td class="muted">${esc(fmtSold(k))}</td><td class="r">${num(l.quantity || 0)}</td>` +
        `<td class="r ${l.isReturn ? "red" : ""}" style="font-weight:800">${l.isReturn ? "-" : ""}${money(Number(l.unitPrice) || 0)}</td></tr>`;
    }
    html += `</tbody></table></div>`;
    if (res.length > 200) html += `<div class="foot">Showing the first 200 of ${res.length}.</div>`;
    return html + `</div>`;
  }

  // ---- Every day you logged: month groups of compact day cards ----
  // iOS Double.currency: whole dollars when the value is whole and >= $100,
  // otherwise two decimals. iOS compactCurrency: "$X.Yk" from $1,000 up.
  function iosCurrency(n) {
    const v = Number(n) || 0;
    const whole = Math.round(v) === v && Math.abs(v) >= 100;
    return v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 });
  }
  function iosCompactCurrency(n) {
    const v = Number(n) || 0;
    if (Math.abs(v) >= 1000) return (v < 0 ? "-$" : "$") + (Math.abs(v) / 1000).toFixed(1) + "k";
    return iosCurrency(v);
  }
  function dayCardHTML(d) {
    const { table } = state.data;
    const k = keyOf(d), dt = localDate(k);
    const com = PayEngine.dayCommission(d, table), rt = returnsTotal(d);
    const off = (Number(d.scheduledHours) || 0) === 0;
    // Same text as the iPhone's SalesView day row:
    //   "<sold> sold · <N> items · <h.h>h"  (or "Day off" in place of hours)
    // Each piece is an unbreakable chunk; lines may only wrap between chunks
    // (after a " · "), never mid-word and never with an ellipsis.
    const parts = [`${iosCompactCurrency(dayRevenue(d))} sold`, `${itemsSold(d)} items`,
      off ? "Day off" : PayEngine.workedHours(d).toFixed(1) + "h"];
    const meta = parts.map((p, i) => `<span class="dc-seg">${esc(p)}${i < parts.length - 1 ? " \u00B7" : ""}</span>`).join(" ");
    return `<button class="day-card" data-open="${esc(k)}" title="Open ${esc(fmtLong(k))}">` +
      `<span class="date-badge"><span class="m">${esc(dt.toLocaleDateString("en-US", { month: "short" }).toUpperCase())}</span><span class="d">${dt.getDate()}</span></span>` +
      `<span class="dc-body"><span class="dc-top"><span class="dc-dow">${esc(dt.toLocaleDateString("en-US", { weekday: "long" }))}</span>` +
      `<span class="dc-com ${com < -0.005 ? "red" : "money"}">${money(com)}</span></span>` +
      `<span class="dc-meta">${meta}</span>` +
      (rt > 0 ? `<span class="dc-ret">${I("return", { size: 12 })}<span>-${esc(money(rt))} returns</span></span>` : "") +
      `</span></button>`;
  }

  function daysHTML() {
    const { days, table } = state.data;
    const logged = days.filter(d => !PayEngine.isEmptyDay(d));
    if (!logged.length) {
      return `<div class="panel"><div class="empty-state"><div class="empty-ico">${I("calendar", { size: 30 })}</div><div class="t">Your history starts today</div>` +
        `<p>Every day you log shows up here with its sales and stats.</p></div></div>`;
    }
    const groups = [];
    for (const d of logged) {
      const dt = localDate(keyOf(d));
      const month = dt.toLocaleDateString("en-US", { month: "long", year: "numeric" });
      if (!groups.length || groups[groups.length - 1].month !== month) groups.push({ month, days: [] });
      groups[groups.length - 1].days.push(d);
    }
    let html = `<div class="sales-days">`;
    for (const g of groups) {
      const com = g.days.reduce((s, d) => s + PayEngine.dayCommission(d, table), 0);
      html += `<div class="month-head"><span class="canvas-title">${esc(g.month)}</span>` +
        `<span class="mh-sub">${g.days.length} day${g.days.length === 1 ? "" : "s"} · ${money(com)} commission</span></div>` +
        `<div class="day-cards">${g.days.map(dayCardHTML).join("")}</div>`;
    }
    return html + `</div>`;
  }

  // ---- Pay ----
  function periodSummary(period) {
    const { days, premiumByDay, table, profile } = state.data;
    const s = PayEngine.periodSummary(period, days, premiumByDay, table);
    return { s, tax: PayEngine.periodTakeHome(s, profile) };
  }

  function payPanelHTML() {
    const p = state.period;
    const { s, tax } = periodSummary(p);
    const isCurrent = PayEngine.periodContains(p, localKey());
    let html = `<div class="panel"><div class="sec-head"><div class="grow"><div class="sec-title">Pay period</div>` +
      `<div class="sec-sub">${esc(PayEngine.periodLabel(p))} · ${esc(PayEngine.paydayLabel(p))}${isCurrent ? " · current" : ""}</div></div>` +
      `<button class="icon-btn" data-period="-1" aria-label="Previous period">${I("chevron-left")}</button>` +
      `<button class="icon-btn" data-period="0" aria-label="Current period"${isCurrent ? " disabled" : ""}>${I("calendar-check")}</button>` +
      `<button class="icon-btn" data-period="1" aria-label="Next period">${I("chevron-right")}</button></div>`;
    html += `<div class="label">${tax ? "Estimated take-home" : "Total pay"}</div>` +
      `<div class="hero-num lg money">${money(tax ? tax.net : s.totalPay)}</div>` +
      `<div class="caption">${tax ? money(s.totalPay) + " gross · " : ""}${s.days.length} day${s.days.length === 1 ? "" : "s"} logged · ${s.openHours.toFixed(1)} open hrs</div>`;
    html += `<div style="margin-top:12px">` +
      `<div class="kv-row"><span class="k">Commission</span><span class="v money">${money(s.commission)}</span></div>` +
      `<div class="kv-row"><span class="k">Base pay</span><span class="sub">$${PayEngine.BASE_HOURLY_RATE.toFixed(2)}/hr open hours</span><span class="v">${money(s.basePay)}</span></div>` +
      (s.premiumPay > 0.005 ? `<div class="kv-row"><span class="k">Min-wage premium</span><span class="sub">before open / after close</span><span class="v">${money(s.premiumPay)}</span></div>` : "") +
      (s.overtimePay > 0.005 ? `<div class="kv-row"><span class="k">Overtime</span><span class="sub">${(s.overtimeHours15 + s.overtimeHours2).toFixed(1)} hrs</span><span class="v">${money(s.overtimePay)}</span></div>` : "") +
      (s.topUp > 0.005 ? `<div class="kv-row"><span class="k amber">Min-wage top-up</span><span class="sub">company covers the shortfall</span><span class="v amber">${money(s.topUp)}</span></div>` : "") +
      `<div class="kv-row total"><span class="k">Gross</span><span class="v">${money(s.totalPay)}</span></div>`;
    if (tax) {
      html += `<div class="kv-row"><span class="k muted">Social Security</span><span class="v red">-${money(tax.socialSecurity)}</span></div>` +
        `<div class="kv-row"><span class="k muted">Medicare</span><span class="v red">-${money(tax.medicare)}</span></div>` +
        `<div class="kv-row"><span class="k muted">CA SDI</span><span class="v red">-${money(tax.sdi)}</span></div>` +
        `<div class="kv-row"><span class="k muted">Income tax (est.)</span><span class="v red">-${money(tax.incomeTax)}</span></div>` +
        `<div class="kv-row total"><span class="k">Take-home</span><span class="v money">${money(tax.net)}</span></div>`;
    }
    html += `</div>`;
    if (s.isCoveredBySurplus) html += `<div class="foot">${s.shortDays.length} short day${s.shortDays.length === 1 ? "" : "s"} covered by the period's surplus — no top-up needed.</div>`;
    return html + `</div>`;
  }

  function payTableHTML() {
    const p = state.period;
    const { s } = periodSummary(p);
    const { profile } = state.data;
    let html = `<div class="panel"><div class="sec-head"><div class="grow"><div class="sec-title">${esc(PayEngine.periodLabel(p))}</div>` +
      `<div class="sec-sub">Every logged day in this period, split like the phone's pay math</div></div>` +
      `<button class="icon-btn" data-period="-1" aria-label="Previous period">${I("chevron-left")}</button>` +
      `<button class="icon-btn" data-period="1" aria-label="Next period">${I("chevron-right")}</button></div>`;
    if (!s.days.length) {
      return html + `<div class="empty-state"><div class="empty-ico">${I("wallet", { size: 30 })}</div><div class="t">Nothing logged in this period</div>` +
        `<p>Only days with logged sales count toward pay.</p></div></div>`;
    }
    html += `<div class="table-wrap"><table class="tbl"><thead><tr><th>Day</th><th class="r">Hours</th><th class="r">Commission</th><th class="r">Base</th><th class="r">Premium</th><th class="r">Overtime</th><th class="r">vs. min wage</th><th class="r">Total</th>` +
      (PayEngine.isCalifornia(profile) ? `<th class="r">Take-home</th>` : "") + `</tr></thead><tbody>`;
    for (const dp of s.days) {
      const k = keyOf(dp.day);
      const th = PayEngine.dayTakeHome(dp, profile);
      html += `<tr class="clickable" data-open="${esc(k)}"><td><b>${esc(fmtShort(k))}</b></td>` +
        `<td class="r">${PayEngine.workedHours(dp.day).toFixed(1)}</td>` +
        `<td class="r money">${money(dp.commission)}</td><td class="r">${money(dp.basePay)}</td>` +
        `<td class="r">${dp.premiumPay > 0.005 ? money(dp.premiumPay) : "—"}</td>` +
        `<td class="r">${dp.overtimePay > 0.005 ? money(dp.overtimePay) : "—"}</td>` +
        `<td class="r ${dp.isShort ? "red" : "money"}">${dp.isShort ? "-" + money(dp.deficit) : "+" + money(dp.surplus)}</td>` +
        `<td class="r" style="font-weight:800">${money(dp.total)}</td>` +
        (PayEngine.isCalifornia(profile) ? `<td class="r money">${th ? money(th.net) : "—"}</td>` : "") + `</tr>`;
    }
    html += `<tr><td><b>Total</b></td><td class="r">${s.days.reduce((a, d) => a + PayEngine.workedHours(d.day), 0).toFixed(1)}</td>` +
      `<td class="r money"><b>${money(s.commission)}</b></td><td class="r"><b>${money(s.basePay)}</b></td><td class="r"><b>${money(s.premiumPay)}</b></td>` +
      `<td class="r"><b>${money(s.overtimePay)}</b></td><td class="r">${s.topUp > 0.005 ? `<span class="amber">top-up ${money(s.topUp)}</span>` : "—"}</td>` +
      `<td class="r"><b>${money(s.totalPay)}</b></td>${PayEngine.isCalifornia(profile) ? `<td class="r"></td>` : ""}</tr>`;
    return html + `</tbody></table></div></div>`;
  }

  // ---- Render ----
  const isSearching = () => !!(state.query || state.min || state.max);

  function paint() {
    if (!host) return;
    host.innerHTML = `<div class="page-head"><div><h2>Sales</h2></div></div>` +
      `<div class="grid sales-top"><div class="col-6">${todayHTML()}</div><div class="col-6">${searchHTML()}</div></div>` +
      `<div id="sales-main">${isSearching() ? resultsHTML() : daysHTML()}</div>`;
    bind();
  }

  function repaintMain() {
    const m = host && host.querySelector("#sales-main");
    if (!m) return paint();
    m.innerHTML = isSearching() ? resultsHTML() : daysHTML();
    bindOpen(m);
    // Show/hide the Clear link without repainting the inputs (keeps focus).
    const head = host.querySelector(".sales-search .sec-head");
    const clr = host.querySelector("#sales-clear");
    if (isSearching() && !clr && head) {
      head.insertAdjacentHTML("beforeend", `<button class="link-btn" id="sales-clear">${I("close", { size: 16 })} Clear</button>`);
      host.querySelector("#sales-clear").addEventListener("click", clearSearch);
    } else if (!isSearching() && clr) clr.remove();
  }

  function openDay(k, ticket) { if (hooks.onOpenDay) hooks.onOpenDay(k, ticket || null); }
  function bindOpen(scope) {
    scope.querySelectorAll("[data-open]").forEach(el => el.addEventListener("click", () => openDay(el.dataset.open, el.dataset.ticket)));
  }
  function clearSearch() { state.query = state.min = state.max = ""; paint(); }

  function bind() {
    host.querySelectorAll("[data-add]").forEach(b => b.addEventListener("click", () => hooks.onAddSale && hooks.onAddSale(b.dataset.add)));
    host.querySelectorAll("[data-paste]").forEach(b => b.addEventListener("click", () => hooks.onPaste && hooks.onPaste(b.dataset.paste)));
    const q = host.querySelector("#sales-q"), mn = host.querySelector("#sales-min"), mx = host.querySelector("#sales-max");
    const onInput = () => { state.query = q.value; state.min = mn.value.trim(); state.max = mx.value.trim(); repaintMain(); };
    [q, mn, mx].forEach(el => el && el.addEventListener("input", onInput));
    const clr = host.querySelector("#sales-clear");
    if (clr) clr.addEventListener("click", clearSearch);
    bindOpen(host);
  }

  // ---- Pay period sheet (opened from Home's Pay period widget) ----
  function renderPay(el) {
    if (!el) return;
    const draw = () => {
      el.innerHTML = `<div class="stack">${payPanelHTML()}${payTableHTML()}</div>`;
      el.querySelectorAll("[data-period]").forEach(b => b.addEventListener("click", () => {
        const dir = Number(b.dataset.period);
        state.period = dir === 0 ? PayEngine.payPeriodContaining(localKey())
          : dir < 0 ? PayEngine.previousPeriod(state.period) : PayEngine.nextPeriod(state.period);
        draw();
      }));
      el.querySelectorAll("[data-open]").forEach(r => r.addEventListener("click", () => {
        const sheet = el.closest(".modal-overlay"); if (sheet) sheet.hidden = true;
        openDay(r.dataset.open);
      }));
    };
    const go = () => { state.period = PayEngine.payPeriodContaining(localKey()); draw(); };
    if (state.data) go(); else loadData().then(go).catch(e => { el.innerHTML = `<div class="empty">${esc(e.message || "Couldn't load pay")}</div>`; });
  }

  async function render(el) {
    host = el || host;
    if (!host) return;
    if (!state.data) host.innerHTML = `<div class="spinner">Loading sales…</div>`;
    try { await loadData(); }
    catch (e) {
      host.innerHTML = `<div class="panel"><div class="empty-state"><div class="empty-ico">${I("alert", { size: 30 })}</div><div class="t">Couldn't load sales</div><p>${esc(e.message || "")}</p></div></div>`;
      return;
    }
    // Keep focus/caret in the search box across background refreshes.
    const focused = document.activeElement && document.activeElement.id;
    paint();
    if (focused && /^sales-(q|min|max)$/.test(focused)) {
      const f = host.querySelector("#" + focused);
      if (f) { f.focus(); const v = f.value; f.value = ""; f.value = v; }
    }
  }

  return {
    render,
    refresh: () => render(),
    set onOpenDay(fn) { hooks.onOpenDay = fn; },
    set onAddSale(fn) { hooks.onAddSale = fn; },
    set onPaste(fn) { hooks.onPaste = fn; },
    renderPay,
    _state: state,
  };
})();
