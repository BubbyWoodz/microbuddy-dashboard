"use strict";
/* ============ home-widgets.js — Home tab: greeting + payday recap + 5 widgets ============
 *
 * Port of HomeView.swift + HomeLayout.swift, laid out on a 12-column desktop grid.
 *
 * Widgets (titles/subtitles from HomeLayout.swift), order + visibility from
 * profile.homeWidgetOrder / profile.homeWidgetsOff:
 *   goal · payPeriod · monthSoFar · commissionMonth · topDays
 * Small widgets (goal, payPeriod, commissionMonth) share a row; big widgets
 * (monthSoFar, topDays) sit side by side 7/5, or full width when alone.
 *
 * Greeting (HomeView.greeting): time-of-day line, profile.displayName (nickname
 * else first name, "Welcome" when empty), department pill, next-shift pill.
 * Avatar (HomeView.settingsAvatar): public.profiles.profile_photo (base64 data
 * URL) via SB.getProfile(); else initials on navy; else a person glyph when the
 * profile has no first name. Clicking it opens Settings.
 *
 * All pay math goes through PayEngine. No emoji — icons are inline SVG (icons.js).
 */
const HomeWidgetsUI = (() => {
  const I = (n, o) => (typeof Icon === "function" ? Icon(n, o) : "");

  const WIDGETS = [
    { id: "goal",            title: "Goal",                  subtitle: "Your active sales goal and progress",          icon: "target", size: "s" },
    { id: "payPeriod",       title: "Pay period",            subtitle: "This period's est. take-home and pre-tax pay", icon: "wallet", size: "s" },
    { id: "monthSoFar",      title: "Month so far",          subtitle: "Top items, brands, plans, and biggest sale",   icon: "calendar", size: "b" },
    { id: "commissionMonth", title: "Commission this month", subtitle: "Commission total and per-hour this month",     icon: "dollar", size: "s" },
    { id: "topDays",         title: "Top 5 days",            subtitle: "Your five best days, ranked by commission",    icon: "trophy", size: "b" },
  ];
  const BY_ID = Object.fromEntries(WIDGETS.map(w => [w.id, w]));
  const DEFAULT_ORDER = WIDGETS.map(w => w.id);

  const GOAL_METRICS = {
    revenue:    { title: "Money Sold",        icon: "dollar" },
    commission: { title: "Commission Earned", icon: "cash" },
    moneyMade:  { title: "Money Made",        icon: "sparkles" },
    plans:      { title: "Plans Sold",        icon: "shield" },
    cph:        { title: "CPH Reached",       icon: "users" },
  };
  const GOAL_PERIODS = { day: "Every Day", week: "This Week", payPeriod: "This Pay Period", month: "This Month" };
  const DEPT_TITLES = { gsa: "GSA", systems: "Systems", byo: "BYO", ce: "CE", warehouse: "Warehouse" };
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const DAYS_SHORT = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const DAYS_FULL = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

  // Double.currency / compactCurrency (Components.swift)
  function fmtCurrency(v) {
    const n = Number(v) || 0, neg = n < 0, a = Math.abs(n);
    const body = (Math.round(a) === a && a >= 100)
      ? Math.round(a).toLocaleString("en-US")
      : a.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (neg ? "-$" : "$") + body;
  }
  function fmtCompact(v) {
    const n = Number(v) || 0;
    if (Math.abs(n) >= 1000) return (n < 0 ? "-$" : "$") + (Math.abs(n) / 1000).toFixed(1) + "k";
    return fmtCurrency(n);
  }
  const shortDay = date => DAYS_SHORT[date.getUTCDay()] + ", " + MONTHS[date.getUTCMonth()] + " " + date.getUTCDate();
  const weekdayFull = date => DAYS_FULL[date.getUTCDay()];
  function timeOnly(date) {
    let h = date.getHours() % 12; if (h === 0) h = 12;
    return h + ":" + String(date.getMinutes()).padStart(2, "0") + " " + (date.getHours() < 12 ? "AM" : "PM");
  }
  const timeRange = (a, b) => timeOnly(a) + " \u2013 " + timeOnly(b);
  function todayKeyLocal() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function parseDayKey(key) {
    const k = String(key || "").slice(0, 10);
    const p = PayEngine.parseKey(k);
    return isNaN(p) ? null : p;
  }
  const dayKeyOf = day => day.id || (day.date ? PayEngine.dayKey(day.date) : "");

  function normalizeData(data) {
    const d = data || {};
    const days = Array.isArray(d.days) ? d.days : (d.days ? Object.values(d.days) : []);
    const shifts = (Array.isArray(d.shifts) ? d.shifts : []).filter(s => s && !s.isRemoved);
    const profile = d.profile || {};
    const table = d.table || PayEngine.tableForProfile(profile);
    const holidays = d.holidayDates || profile.holidayDates || [];
    const premiumByDay = d.premiumByDay || PayEngine.premiumsByDay(shifts, holidays);
    return { days, shifts, profile, table, premiumByDay, goals: d.goals, raw: d };
  }

  function widgetOrder(profile) {
    const saved = Array.isArray(profile.homeWidgetOrder) ? profile.homeWidgetOrder : null;
    const order = (saved && saved.length) ? saved.filter(id => DEFAULT_ORDER.includes(id)) : DEFAULT_ORDER.slice();
    for (const id of DEFAULT_ORDER) if (!order.includes(id)) order.push(id);
    const off = new Set(Array.isArray(profile.homeWidgetsOff) ? profile.homeWidgetsOff : []);
    return order.filter(id => !off.has(id));
  }

  // ---- Shared pieces ----
  const chip = (text, cls) => `<span class="chip ${cls || ""}">${esc(text)}</span>`;
  function head(w, right) {
    return `<div class="widget-head"><span class="label">${I(w.icon, { size: 14 })}${esc(w.title)}</span><span class="spacer"></span>${right || ""}</div>`;
  }
  function empty(icon, title, msg) {
    return `<div class="empty-state"><div class="empty-ico">${I(icon, { size: 30 })}</div><div class="t">${esc(title)}</div><p>${esc(msg)}</p></div>`;
  }

  // ---- Greeting ----
  function greetingText() {
    const h = new Date().getHours();
    if (h >= 5 && h < 12) return "Good morning,";
    if (h >= 12 && h < 17) return "Good afternoon,";
    if (h >= 17 && h < 22) return "Good evening,";
    return "Good night,";
  }
  function displayName(profile) {
    const nick = String(profile.nickname || "").trim();
    if (nick) return nick;
    return String(profile.name || "").trim().split(/\s+/)[0] || "";
  }
  function nextShift(shifts) {
    const now = Date.now();
    return shifts.filter(s => s && s.start && s.end && new Date(s.end).getTime() > now)
      .sort((a, b) => new Date(a.start) - new Date(b.start))[0] || null;
  }
  function nextShiftText(shift) {
    const start = new Date(shift.start), end = new Date(shift.end), now = new Date();
    const sod = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const dayDiff = Math.round((sod(start) - sod(now)) / 86400000);
    if (dayDiff === 0) return "Today \u00B7 " + timeRange(start, end);
    if (dayDiff === 1) return "Tomorrow \u00B7 " + timeOnly(start);
    return shortDay(new Date(Date.UTC(start.getFullYear(), start.getMonth(), start.getDate()))) + " \u00B7 " + timeOnly(start);
  }

  /// Avatar exactly like HomeView.settingsAvatar: photo -> initials -> glyph.
  function avatarHTML(profile, size) {
    const sz = size || 44;
    const sb = (typeof SB !== "undefined" && SB.cachedProfile) ? SB.cachedProfile() : null;
    const photo = sb && sb.photo;
    const style = `width:${sz}px;height:${sz}px`;
    if (photo) return `<span class="avatar" style="${style}"><img src="${esc(photo)}" alt="Profile photo"></span>`;
    const name = String(profile.name || "").trim() || (sb && sb.fullName) || "";
    const first = name.split(/\s+/)[0] || "";
    if (!first) return `<span class="avatar placeholder" style="${style}">${I("user", { size: Math.round(sz * 0.55) })}</span>`;
    const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0].toUpperCase()).join("");
    return `<span class="avatar initials" style="${style};font-size:${Math.round(sz * 0.36)}px">${esc(initials)}</span>`;
  }

  function quickStatsHTML(d) {
    const tk = todayKeyLocal();
    const today = d.days.find(x => dayKeyOf(x) === tk);
    const comToday = today ? PayEngine.dayCommission(today, d.table) : 0;
    const period = PayEngine.payPeriodContaining(tk);
    const pay = PayEngine.periodSummary(period, d.days, d.premiumByDay, d.table);
    const take = PayEngine.periodTakeHome(pay, d.profile);
    const { s } = monthSummary(d);
    const q = (label, value, cls, nav) =>
      `<button class="quick-stat" data-nav="${nav}"><span class="label">${esc(label)}</span><span class="v ${cls || ""}">${esc(value)}</span></button>`;
    return `<div class="quick">` +
      q("Today", fmtCurrency(comToday), comToday < -0.005 ? "red" : "money", "sales") +
      q(take ? "Period take-home" : "Period pay", fmtCurrency(take ? take.net : pay.totalPay), "money", "pay") +
      q("This month", fmtCurrency(s.commission), s.commission < -0.005 ? "red" : "money", "stats") +
      q("An hour", fmtCurrency(s.commissionPerHour), "amber", "stats") +
      `</div>`;
  }

  function greetingHTML(d) {
    const profile = d.profile;
    const shift = nextShift((d.shifts || []).filter(s => s && !s.isRemoved));
    const name = displayName(profile);
    return `<div class="panel col-12 home-greet">` +
      `<div class="greet-text"><div class="hi">${esc(greetingText())}</div>` +
      `<div class="name">${esc(name || "Welcome")}</div>` +
      `<div class="pills">${chip(DEPT_TITLES[profile.department] || "GSA", "filled")}` +
      (shift ? `<span class="chip navy">${I("clock", { size: 13 })}${esc(nextShiftText(shift))}</span>` : "") + `</div></div>` +
      quickStatsHTML(d) + `</div>`;
  }

  // ---- Payday recap ----
  function paydayRecapHTML(d) {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const period = PayEngine.payPeriodBlock(todayKeyLocal()) // block: the recap is the period before the current block;
    const finished = PayEngine.previousPeriod(period);
    const pd = PayEngine.parseKey(finished.payday);
    const paydayStart = new Date(pd.getUTCFullYear(), pd.getUTCMonth(), pd.getUTCDate());
    const diffDays = Math.round((todayStart - paydayStart) / 86400000);
    if (diffDays < 0 || diffDays > 3) return "";
    const pay = PayEngine.periodSummary(finished, d.days, d.premiumByDay, d.table);
    if (!pay.days.length) return "";
    const scope = d.profile.username || "local";
    const dismissKey = "mb-payday-recap-" + scope + "-" + finished.payday;
    try { if (localStorage.getItem(dismissKey) === "1") return ""; } catch (e) {}
    const best = pay.days.reduce((a, b) => (b.total > a.total ? b : a));
    const bk = best && best.day ? parseDayKey(dayKeyOf(best.day)) : null;
    const n = pay.days.length;
    let caption = n + " day" + (n === 1 ? "" : "s") + " logged \u00B7 commission " + fmtCurrency(pay.commission);
    if (bk) caption += " \u00B7 best day " + weekdayFull(bk) + " (" + fmtCurrency(best.total) + ")";
    const take = PayEngine.periodTakeHome(pay, d.profile);
    return `<div class="panel col-12" data-payday-card data-dismiss-key="${esc(dismissKey)}">` +
      `<div class="widget-head"><span class="label amber">${I("cash", { size: 14 })}Payday</span><span class="spacer"></span>${chip(PayEngine.periodLabel(finished), "amber")}</div>` +
      `<div style="display:flex;align-items:flex-end;gap:24px;flex-wrap:wrap">` +
      `<div><div class="hero-num lg money">${esc(fmtCurrency(take ? take.net : pay.totalPay))}</div>` +
      `<div class="caption">${take ? "est. take-home · " + esc(fmtCurrency(pay.totalPay)) + " pre-tax · " : ""}${esc(caption)}</div></div>` +
      `<span class="spacer"></span><button class="btn tint" data-payday-dismiss>${I("check")} Got it \u2014 new period starts now</button></div></div>`;
  }

  // ---- Goal ----
  function goalWidgetHTML(d) {
    const goals = GoalsUI.getGoals({ data: d.raw });
    const active = goals.find(g => g.isActive);
    if (!active) return "";
    const p = GoalsUI.goalProgress(active, d.days, { table: d.table, premiumByDay: d.premiumByDay });
    const m = GOAL_METRICS[active.metric] || GOAL_METRICS.revenue;
    const remaining = Math.max(0, active.target - p.current);
    const isDone = p.fraction >= 1;
    const pct = Math.round(Math.min(1, p.fraction) * 100);
    return `<div class="panel clickable" data-nav="goals" data-widget="goal" role="button" tabindex="0">` +
      `<div class="widget-head"><span class="label">${I(m.icon, { size: 14 })}${esc(m.title)}</span><span class="spacer"></span>${chip(GOAL_PERIODS[active.period] || "Every Day", "amber")}</div>` +
      `<div style="display:flex;align-items:baseline;gap:8px"><span class="hero-num ${isDone ? "money" : ""}">${esc(GoalsUI.valueLabel(active.metric, p.current))}</span>` +
      `<span class="muted" style="font-weight:600">of ${esc(GoalsUI.valueLabel(active.metric, active.target))}</span></div>` +
      `<div class="bar" style="margin-top:12px;height:10px"><i style="width:${pct}%;background:${isDone ? "var(--money)" : "var(--accent)"}"></i></div>` +
      `<div class="caption ${isDone ? "money" : ""}" style="margin-top:8px">` +
      (isDone ? "Goal crushed. Keep stacking." : esc(GoalsUI.valueLabel(active.metric, remaining)) + " to go \u00B7 " + pct + "% there") + `</div></div>`;
  }

  // ---- Pay period ----
  function payPeriodWidgetHTML(d) {
    const profile = d.profile;
    const period = PayEngine.payPeriodContaining(todayKeyLocal());
    const pay = PayEngine.periodSummary(period, d.days, d.premiumByDay, d.table);
    // CA associates: estimated take-home is the headline (CATaxEstimate);
    // periodTakeHome falls back to the default 10.5% income-tax estimate.
    const est = PayEngine.periodTakeHome(pay, profile);
    let html = `<div class="panel clickable" data-nav="pay" data-widget="payPeriod" role="button" tabindex="0">` +
      head(BY_ID.payPeriod, chip(PayEngine.paydayLabel(period), "money"));
    if (est) {
      html += `<div style="display:flex;align-items:flex-end;gap:14px"><div class="grow"><div class="caption">${esc(PayEngine.periodLabel(period))}</div>` +
        `<div class="hero-num money">${esc(fmtCurrency(est.net))}</div><div class="caption">est. take-home</div></div>` +
        `<div style="text-align:right"><div class="label">Pre-tax</div><div class="hero-num md money" style="opacity:.75">${esc(fmtCurrency(pay.totalPay))}</div></div></div>`;
    } else {
      html += `<div style="display:flex;align-items:baseline;gap:8px"><span class="sec-title">${esc(PayEngine.periodLabel(period))}</span><span class="spacer"></span>` +
        `<span class="hero-num md money">${esc(fmtCurrency(pay.totalPay))}</span></div>`;
    }
    if (!pay.days.length) {
      html += `<div class="caption" style="margin-top:8px">No days logged in this period yet.</div>`;
    } else {
      const parts = ["Commission " + fmtCurrency(pay.commission), "base " + fmtCurrency(pay.basePay)];
      if (pay.premiumPay > 0.005) parts.push("open/close " + fmtCurrency(pay.premiumPay));
      if (pay.overtimePay > 0.005) parts.push("overtime " + fmtCurrency(pay.overtimePay));
      if (pay.topUp > 0.005) parts.push("top-up " + fmtCurrency(pay.topUp));
      html += `<div class="caption" style="margin-top:8px">${esc(parts.join(" + "))}</div>`;
      if (!est) {
        html += `<div class="kv-row"><span class="k">Minimum-wage floor</span><span class="sub">${pay.openHours.toFixed(1)} open hrs \u00D7 ${esc(fmtCurrency(PayEngine.MINIMUM_WAGE))}${pay.overtimePay > 0.005 ? " + OT premium" : ""}</span><span class="v">${esc(fmtCurrency(pay.floor))}</span></div>`;
      }
      const status = pay.topUp > 0.005
        ? (est ? "Company tops up " + fmtCurrency(pay.topUp) + " \u2014 under the floor."
               : pay.days.length + " day" + (pay.days.length === 1 ? "" : "s") + " in \u2014 period average is under minimum wage, so the company tops up " + fmtCurrency(pay.topUp) + ".")
        : (est ? fmtCurrency(pay.surplus) + " above the floor \u2014 strong period."
               : fmtCurrency(pay.surplus) + " above the minimum-wage floor so far \u2014 strong period.");
      html += `<div class="caption ${pay.topUp > 0.005 ? "red" : "money"}" style="margin-top:8px;font-weight:700">${esc(status)}</div>`;
    }
    return html + `</div>`;
  }

  // ---- Month summary helpers ----
  function monthSummary(d) {
    const monthDays = StatsUI._filterByRange(d.days, "month");
    const s = StatsUI._computeSummary(monthDays, d.table, d.premiumByDay, "month");
    return { monthDays, s };
  }
  const allLines = day => (day.tickets || []).flatMap(t => t.lines || []);
  const dayRevenue = day => allLines(day).reduce((s, l) => s + PayEngine.lineRevenue(l), 0);
  const dayItems = day => allLines(day).reduce((s, l) => s + (l.isReturn || l.isExchange || l.kind === "servicePlan" ? 0 : (l.quantity || 0)), 0);

  // ---- Month so far ----
  function monthSoFarWidgetHTML(d) {
    const { monthDays, s } = monthSummary(d);
    let html = `<div class="panel" data-widget="monthSoFar"><div class="sec-head"><div class="grow"><div class="sec-title">Month so far</div>` +
      `<div class="sec-sub">Everything logged this month</div></div><button class="link-btn" data-nav="stats">Stats ${I("chevron-right", { size: 14 })}</button></div>`;
    if (!monthDays.length) {
      return html + empty("cart", "No sales logged yet", "Head to the Sales tab and add today's first ticket \u2014 your stats build from there.") + `</div>`;
    }
    const tp = s.topProducts[0], tb = s.topBrands[0], bt = s.biggestTicketByMoney;
    let btValue = "\u2014", btCaption = "", btKey = "";
    if (bt && bt.ticket) {
      btValue = fmtCurrency((bt.ticket.lines || []).reduce((x, l) => x + PayEngine.lineRevenue(l), 0));
      const items = (bt.ticket.lines || []).reduce((x, l) => x + (l.isReturn ? 0 : (l.quantity || 0)), 0);
      const dk = bt.day ? parseDayKey(dayKeyOf(bt.day)) : null;
      btCaption = (dk ? shortDay(dk) : "") + " \u00B7 " + items + " items";
      btKey = bt.day ? dayKeyOf(bt.day) : "";
    }
    const tile = (icon, title, value, caption, nav, arg) =>
      `<div class="tile left${nav ? " clickable" : ""}"${nav ? ` data-nav="${nav}" data-arg="${esc(arg || "")}" role="button" tabindex="0"` : ""}>` +
      `<div class="t">${I(icon, { size: 14 })}${esc(title)}</div><div class="big" title="${esc(value)}">${esc(value)}</div><div class="c">${esc(caption)}</div></div>`;
    html += `<div class="tiles c2">` +
      tile("box", "Most sold item", tp ? tp.name : "\u2014", tp ? tp.count + " sold \u00B7 " + fmtCompact(tp.value) : "") +
      tile("tag", "Most sold brand", tb ? tb.name : "\u2014", tb ? tb.count + " sold \u00B7 " + fmtCompact(tb.value) : "") +
      tile("shield", "Plans this month", String(s.plansSold), s.plansSold > 0 ? fmtCompact(s.plansRevenue) + " in plans" : "service plans sold") +
      tile("receipt", "Biggest sale (money)", btValue, btCaption, btKey ? "day" : "", btKey) +
      `</div><div class="tiles c4" style="margin-top:10px">` +
      `<div class="tile"><div class="v">${esc(fmtCompact(s.revenue))}</div><div class="l">Money sold</div></div>` +
      `<div class="tile"><div class="v navy">${s.items}</div><div class="l">Items</div></div>` +
      `<div class="tile"><div class="v">${s.ticketCount}</div><div class="l">Customers</div></div>` +
      `<div class="tile"><div class="v amber">${s.hours > 0 ? s.customersPerHour.toFixed(1) : "\u2014"}</div><div class="l">CPH</div></div></div>`;
    return html + `</div>`;
  }

  // ---- Commission this month ----
  function commissionMonthWidgetHTML(d) {
    const { s } = monthSummary(d);
    let caption = fmtCompact(s.revenue) + " sold \u00B7 " + s.days.length + " day" + (s.days.length === 1 ? "" : "s");
    const extras = s.basePay + s.premiumPay;
    if (extras > 0.005) caption += " \u00B7 +" + fmtCurrency(extras) + " base & min wage";
    return `<div class="panel clickable" data-nav="stats" data-widget="commissionMonth" role="button" tabindex="0">` +
      head(BY_ID.commissionMonth) +
      `<div style="display:flex;align-items:flex-end;gap:14px"><div class="grow">` +
      `<div class="hero-num ${s.commission < -0.005 ? "red" : "money"}">${esc(fmtCurrency(s.commission))}</div>` +
      `<div class="caption">${esc(caption)}</div></div>` +
      `<div style="text-align:right"><div class="label">An Hour</div><div class="hero-num md amber">${esc(fmtCurrency(s.commissionPerHour))}</div><div class="caption">per hour</div></div></div></div>`;
  }

  // ---- Top 5 days ----
  function topDaysWidgetHTML(d) {
    const { monthDays, s } = monthSummary(d);
    let html = `<div class="panel" data-widget="topDays"><div class="sec-head"><div class="grow"><div class="sec-title">Top 5 days</div>` +
      `<div class="sec-sub">Ranked by commission, this month</div></div></div>`;
    if (!monthDays.length) return html + empty("calendar", "Nothing to rank yet", "Log a couple of days and your best ones show up here.") + `</div>`;
    const top = s.topDays.slice(0, 5);
    const best = top.length ? PayEngine.dayCommission(top[0], d.table) : 1;
    html += `<div class="rank-list">`;
    top.forEach((day, i) => {
      const comm = PayEngine.dayCommission(day, d.table);
      const dk = parseDayKey(dayKeyOf(day));
      const frac = best > 0 ? Math.max(0.02, comm / best) : 0;
      html += `<div class="rank clickable" data-nav="day" data-arg="${esc(dayKeyOf(day))}" role="button" tabindex="0">` +
        `<span class="n${i < 3 ? " top" : ""}">${i + 1}</span><span class="name">${esc(dk ? shortDay(dk) : dayKeyOf(day))}</span>` +
        `<span class="val money">${esc(fmtCurrency(comm))}</span>` +
        `<div class="bar money"><i style="width:${Math.round(frac * 100)}%;${i < 3 ? "" : "background:var(--navy-bright)"}"></i></div>` +
        `<span class="sub">${esc(fmtCompact(dayRevenue(day)))} sold \u00B7 ${dayItems(day)} items \u00B7 ${PayEngine.workedHours(day).toFixed(1)} hrs</span></div>`;
    });
    return html + `</div></div>`;
  }

  const WIDGET_HTML = {
    goal: goalWidgetHTML, payPeriod: payPeriodWidgetHTML, monthSoFar: monthSoFarWidgetHTML,
    commissionMonth: commissionMonthWidgetHTML, topDays: topDaysWidgetHTML,
  };

  /// Lay the visible widgets onto the 12-col grid: consecutive small widgets
  /// split a row evenly; big widgets pair 7/5 or go full width alone.
  function layout(order, d) {
    const rendered = order.map(id => ({ id, size: BY_ID[id].size, html: WIDGET_HTML[id](d) })).filter(w => w.html);
    let out = "";
    let i = 0;
    while (i < rendered.length) {
      const run = [rendered[i]];
      while (i + run.length < rendered.length && rendered[i + run.length].size === rendered[i].size && run.length < (rendered[i].size === "s" ? 3 : 2)) {
        run.push(rendered[i + run.length]);
      }
      if (run[0].size === "s") {
        const span = 12 / run.length;
        run.forEach(w => { out += `<div class="col-${span} stack">${w.html}</div>`; });
      } else if (run.length === 2) {
        out += `<div class="col-7 stack">${run[0].html}</div><div class="col-5 stack">${run[1].html}</div>`;
      } else {
        out += `<div class="col-12 stack">${run[0].html}</div>`;
      }
      i += run.length;
    }
    return out;
  }

  // ---- Navigation ----
  let onNavigate = null;
  function navigate(tab, arg) { if (typeof onNavigate === "function") onNavigate(tab, arg); }

  let lastContainer = null, lastData = null;
  function render(container, data) {
    const el = typeof container === "string" ? document.querySelector(container) : container;
    if (!el) return;
    const d = normalizeData(data);
    lastContainer = el; lastData = data;
    el.innerHTML = `<div class="grid">` + greetingHTML(d) + paydayRecapHTML(d) + layout(widgetOrder(d.profile), d) + `</div>`;
    el.querySelectorAll("[data-nav]").forEach(n => {
      n.addEventListener("click", e => {
        if (e.target.closest("[data-payday-dismiss]")) return;
        const inner = e.target.closest("[data-nav]");
        if (inner !== n) return; // let the innermost target win
        e.stopPropagation();
        navigate(n.getAttribute("data-nav"), n.getAttribute("data-arg"));
      });
      n.addEventListener("keydown", e => {
        if (n.tagName === "BUTTON") return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); navigate(n.getAttribute("data-nav"), n.getAttribute("data-arg")); }
      });
    });
    const dismissBtn = el.querySelector("[data-payday-dismiss]");
    if (dismissBtn) dismissBtn.addEventListener("click", e => {
      e.stopPropagation();
      const card = el.querySelector("[data-payday-card]");
      const key = card ? card.getAttribute("data-dismiss-key") : null;
      try { if (key) localStorage.setItem(key, "1"); } catch (err) {}
      if (card) card.remove();
    });
  }

  async function open(container) {
    const backup = await SyncEngine.getLocalBackup().catch(() => null);
    render(container, (backup && backup.data) || {});
  }
  function rerender() { if (lastContainer) render(lastContainer, lastData); }

  return {
    render, open, rerender, avatarHTML, displayName, greetingText,
    set onNavigate(fn) { onNavigate = fn; },
    get onNavigate() { return onNavigate; },
    _fmtCurrency: fmtCurrency, _fmtCompact: fmtCompact, _widgetOrder: widgetOrder,
    _shortDay: shortDay, _normalize: normalizeData,
  };
})();
