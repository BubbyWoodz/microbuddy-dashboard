"use strict";
/* ============ home-widgets.js — Home tab: greeting + payday recap + 5 reorderable widgets ============
 *
 * Port of HomeView.swift + HomeLayout.swift (BubbyWoodz/micro-buddy, branch main).
 *
 * The 5 widgets (exact titles/subtitles from HomeLayout.swift):
 *   goal            "Goal"                  "Your active sales goal and progress"
 *   payPeriod       "Pay period"            "This period's est. take-home and pre-tax pay"
 *   monthSoFar      "Month so far"          "Top items, brands, plans, and biggest sale"
 *   commissionMonth "Commission this month" "Commission total and per-hour this month"
 *   topDays         "Top 5 days"            "Your five best days, ranked by commission"
 *
 * App behaviors ported:
 *  - Widget order/visibility from profile.homeWidgetOrder / profile.homeWidgetsOff
 *    (default order: goal, payPeriod, monthSoFar, commissionMonth, topDays).
 *    Greeting + payday recap are fixed — they never move or hide.
 *  - Goal widget: only renders while there is an active goal; progress bar,
 *    "{remaining} to go · {pct}% there", "Goal crushed. Keep stacking." at 100%.
 *  - Pay period widget: biweekly period anchored to the Sep 18 2026 payday;
 *    CA users see est. take-home as the hero with pre-tax secondary (only when
 *    totalPay > 0.005); minimum-wage floor row; top-up/surplus status line.
 *  - Month widgets: this-month StatsSummary (empty days filtered, like the app).
 *  - Top 5 days: ranked by commission, rank rows with proportional bars,
 *    tapping a row opens that day.
 *  - Payday recap: finished period's take-home, shown payday through 3 days
 *    after, dismissible ("Got it — new period starts now"), dismissal persisted
 *    in localStorage per period.
 *  - Greeting: time-of-day greeting, display name (nickname else first name),
 *    department pill, next-shift pill, profile-photo avatar (initials fallback)
 *    that opens Settings.
 *
 * All pay math goes through PayEngine (never approximated). Goal progress and
 * value labels go through GoalsUI. Month summaries go through StatsUI.
 *
 * Depends on globals (loaded before this script in dashboard.html):
 *   PayEngine, GoalsUI, StatsUI, SyncEngine, esc
 * Script order: after payengine.js, goals.js, stats.js, sync.js.
 *
 * Wiring (parent):
 *   <script src="/home-widgets.js"></script>
 *   HomeWidgetsUI.onNavigate = (tab, arg) => {
 *     if (tab === "day") return openDayDetail(arg);      // arg = day key
 *     if (tab === "settings") return openSettingsDrawer();
 *     switchTab(tab);                                    // "goals" | "stats" | "schedule"
 *   };
 *   await HomeWidgetsUI.open(document.getElementById("home-body"));
 *   // or with your own data:
 *   HomeWidgetsUI.render(el, { days, shifts, profile });
 *
 * Sync: no new ops. homeWidgetOrder / homeWidgetsOff ride the existing
 * updateProfile op (profile hub edits them).
 */
const HomeWidgetsUI = (() => {
  // ---- App constants (HomeLayout.swift) ----
  const WIDGETS = [
    { id: "goal",            title: "Goal",                  subtitle: "Your active sales goal and progress",              symbol: "\uD83C\uDFAF" },
    { id: "payPeriod",       title: "Pay period",            subtitle: "This period's est. take-home and pre-tax pay",     symbol: "\uD83D\uDCB5" },
    { id: "monthSoFar",      title: "Month so far",          subtitle: "Top items, brands, plans, and biggest sale",       symbol: "\uD83D\uDCC5" },
    { id: "commissionMonth",  title: "Commission this month", subtitle: "Commission total and per-hour this month",         symbol: "\uD83D\uDCB0" },
    { id: "topDays",         title: "Top 5 days",            subtitle: "Your five best days, ranked by commission",        symbol: "\uD83C\uDFC6" },
  ];
  const DEFAULT_ORDER = WIDGETS.map(w => w.id);

  // Goal metric/period titles (Goal.swift) — mirror of GoalsUI's METRICS/PERIODS,
  // kept local so this module never reaches into GoalsUI internals.
  const GOAL_METRICS = {
    revenue:    { title: "Money Sold",      symbol: "\uD83D\uDCB0" },
    commission: { title: "Commission Earned", symbol: "\uD83D\uDCB5" },
    moneyMade:  { title: "Money Made",      symbol: "\u2728" },
    plans:      { title: "Plans Sold",      symbol: "\uD83D\uDEE1\uFE0F" },
    cph:        { title: "CPH Reached",     symbol: "\uD83D\uDC65" },
  };
  const GOAL_PERIODS = {
    day:       { title: "Every Day" },
    week:      { title: "This Week" },
    payPeriod: { title: "This Pay Period" },
    month:     { title: "This Month" },
  };
  const DEPT_TITLES = { gsa: "GSA", systems: "Systems", byo: "BYO", ce: "CE", warehouse: "Warehouse" };

  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const DAYS_SHORT = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const DAYS_FULL = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

  // ---- Exact formatting ports (Double.currency / compactCurrency, Components.swift) ----
  // "$1,234" for whole dollars >= $100, "$12.34" when cents matter.
  function fmtCurrency(v) {
    const n = Number(v) || 0;
    const neg = n < 0;
    const a = Math.abs(n);
    const body = (Math.round(a) === a && a >= 100)
      ? Math.round(a).toLocaleString("en-US")
      : a.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (neg ? "-$" : "$") + body;
  }
  // "$1.2k" when |v| >= 1000 (lowercase k, like the app), else fmtCurrency.
  function fmtCompact(v) {
    const n = Number(v) || 0;
    if (Math.abs(n) >= 1000) return "$" + (n / 1000).toFixed(1) + "k";
    return fmtCurrency(n);
  }
  // "EEE, MMM d" — "Mon, Sep 28"
  function shortDay(date) {
    return DAYS_SHORT[date.getUTCDay()] + ", " + MONTHS[date.getUTCMonth()] + " " + date.getUTCDate();
  }
  // "EEEE" — "Wednesday"
  function weekdayFull(date) {
    return DAYS_FULL[date.getUTCDay()];
  }
  // "h:mm a" — "10:00 AM"
  function timeOnly(date) {
    let h = date.getHours() % 12;
    if (h === 0) h = 12;
    const m = String(date.getMinutes()).padStart(2, "0");
    return h + ":" + m + " " + (date.getHours() < 12 ? "AM" : "PM");
  }
  // Shift.timeRange — "10:00 AM – 6:30 PM" (en dash, like the app)
  function timeRange(a, b) {
    return timeOnly(a) + " \u2013 " + timeOnly(b);
  }
  // Local "yyyy-MM-dd" (device calendar, like the app — NOT UTC).
  function todayKeyLocal() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function parseDayKey(key) {
    const k = String(key || "").slice(0, 10);
    const p = PayEngine.parseKey(k);
    return isNaN(p) ? null : p;
  }
  function dayKeyOf(day) {
    return day.id || day.date;
  }

  // ---- Data normalization ----
  function normalizeData(data) {
    const d = data || {};
    const rawDays = d.days;
    const days = Array.isArray(rawDays) ? rawDays : (rawDays ? Object.values(rawDays) : []);
    const shifts = Array.isArray(d.shifts) ? d.shifts : [];
    const profile = d.profile || {};
    const table = d.table || PayEngine.tableForProfile(profile);
    const holidays = profile.holidayDates || d.holidayDates || [];
    const premiumByDay = d.premiumByDay || PayEngine.premiumsByDay(shifts, holidays);
    return { days, shifts, profile, table, premiumByDay, goals: d.goals };
  }

  // HomeLayout order: saved order wins, unknown ids dropped, new widgets appended.
  function widgetOrder(profile) {
    const saved = Array.isArray(profile.homeWidgetOrder) ? profile.homeWidgetOrder : null;
    let order = (saved && saved.length)
      ? saved.filter(id => DEFAULT_ORDER.includes(id))
      : DEFAULT_ORDER.slice();
    for (const id of DEFAULT_ORDER) if (!order.includes(id)) order.push(id);
    const off = new Set(Array.isArray(profile.homeWidgetsOff) ? profile.homeWidgetsOff : []);
    return order.filter(id => !off.has(id));
  }

  // ---- Shared pieces ----
  function pillHTML(text, color) {
    return '<span class="pill" style="background:var(--' + color + '-dim,rgba(0,0,0,.06));color:var(--' + color + ',#666)">' +
      esc(text) + "</span>";
  }
  function heroStatHTML(label, value, caption, tintVar) {
    return '<div class="hw-hero"><div class="hw-hero-label">' + esc(label).toUpperCase() + "</div>" +
      '<div class="hw-hero-value" style="color:var(--' + tintVar + ')">' + esc(value) + "</div>" +
      (caption ? '<div class="hw-hero-caption">' + esc(caption) + "</div>" : "") + "</div>";
  }
  function emptyStateHTML(symbol, title, message) {
    return '<div class="hw-empty"><div class="hw-empty-symbol">' + symbol + "</div>" +
      '<div class="hw-empty-title">' + esc(title) + "</div>" +
      '<div class="hw-empty-msg">' + esc(message) + "</div></div>";
  }
  function sectionHeadHTML(title, subtitle) {
    return '<div class="hw-sec-head"><div class="hw-sec-title">' + esc(title) + "</div>" +
      '<div class="hw-sec-sub">' + esc(subtitle) + "</div></div>";
  }

  // ---- Greeting (HomeView.greeting — fixed, never moves) ----
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
    const first = String(profile.name || "").trim().split(/\s+/)[0];
    return first || "Welcome";
  }
  function avatarInitials(profile) {
    const parts = String(profile.name || "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
    const letters = parts.map(p => p[0].toUpperCase()).join("");
    return letters || "?";
  }
  function nextShift(shifts) {
    const now = Date.now();
    return shifts
      .filter(s => s && s.start && s.end && new Date(s.end).getTime() > now)
      .sort((a, b) => new Date(a.start) - new Date(b.start))[0] || null;
  }
  function nextShiftText(shift) {
    const start = new Date(shift.start), end = new Date(shift.end);
    const now = new Date();
    const sod = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const dayDiff = Math.round((sod(start) - sod(now)) / 86400000);
    if (dayDiff === 0) return "Today \u00B7 " + timeRange(start, end);
    if (dayDiff === 1) return "Tomorrow \u00B7 " + timeOnly(start);
    return shortDay(new Date(Date.UTC(start.getFullYear(), start.getMonth(), start.getDate()))) + " \u00B7 " + timeOnly(start);
  }
  function greetingHTML(d) {
    const profile = d.profile;
    const shift = nextShift(d.shifts);
    const photo = profile.profilePhoto;
    const avatar = photo
      ? '<img src="' + photo + '" class="hw-avatar" alt="Profile">'
      : '<div class="hw-avatar hw-avatar-initials">' + esc(avatarInitials(profile)) + "</div>";
    return '<div class="hw-greet">' +
      '<div class="hw-greet-text"><div class="hw-greet-hi">' + esc(greetingText()) + "</div>" +
      '<div class="hw-greet-name">' + esc(displayName(profile)) + "</div>" +
      '<div class="hw-pills">' + pillHTML(DEPT_TITLES[profile.department] || "GSA", "accent") +
      (shift ? pillHTML(nextShiftText(shift), "blue") : "") + "</div></div>" +
      '<button class="hw-avatar-btn" data-nav="settings" title="Settings" aria-label="Settings">' + avatar + "</button>" +
      "</div>";
  }

  // ---- Payday recap (PaydayRecapService — fixed card, payday through +3 days) ----
  function paydayRecapHTML(d) {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const period = PayEngine.payPeriodContaining(todayKeyLocal());
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
    let bestLabel = null;
    const bk = best && best.day ? parseDayKey(dayKeyOf(best.day)) : null;
    if (bk) bestLabel = weekdayFull(bk);
    const n = pay.days.length;
    let caption = n + " day" + (n === 1 ? "" : "s") + " logged \u00B7 commission " + fmtCurrency(pay.commission);
    if (bestLabel) caption += " \u00B7 best day " + bestLabel + " (" + fmtCurrency(best.total) + ")";
    return '<div class="card hw-card" data-payday-card data-dismiss-key="' + esc(dismissKey) + '">' +
      '<div class="hw-row"><span class="hw-label">\uD83D\uDCB5 Payday</span>' +
      '<span class="hw-spacer"></span>' + pillHTML(PayEngine.periodLabel(finished), "amber") + "</div>" +
      '<div class="hw-payday-total">' + esc(fmtCurrency(pay.totalPay)) + "</div>" +
      '<div class="hw-footnote">' + esc(caption) + "</div>" +
      '<button class="hw-gotit" data-payday-dismiss>Got it \u2014 new period starts now</button>' +
      "</div>";
  }

  // ---- Widget 1: Goal ----
  function goalWidgetHTML(d) {
    const goals = GoalsUI.getGoals({ data: d });
    const active = goals.find(g => g.isActive);
    if (!active) return ""; // app: goal widget only shows while there's an active goal
    const p = GoalsUI.goalProgress(active, d.days);
    const m = GOAL_METRICS[active.metric] || GOAL_METRICS.revenue;
    const periodTitle = (GOAL_PERIODS[active.period] || GOAL_PERIODS.day).title;
    const remaining = Math.max(0, active.target - p.current);
    const isDone = p.fraction >= 1;
    const pct = Math.round(p.fraction * 100);
    const barTint = isDone ? "accent" : "blue"; // app: mint when done, accent otherwise
    return '<div class="card hw-card" data-nav="goals" data-widget="goal" role="button" tabindex="0">' +
      '<div class="hw-row"><span class="hw-label">' + m.symbol + " " + esc(m.title) + "</span>" +
      '<span class="hw-spacer"></span>' + pillHTML(periodTitle, "amber") + "</div>" +
      '<div class="hw-goal-hero"><span class="hw-goal-current" style="color:' +
      (isDone ? "var(--accent)" : "var(--text,#1c1c1e)") + '">' +
      esc(GoalsUI.valueLabel(active.metric, p.current)) + '</span> <span class="hw-goal-of">of ' +
      esc(GoalsUI.valueLabel(active.metric, active.target)) + "</span></div>" +
      '<div class="hw-progress"><div class="hw-bar" style="width:' + pct + "%;background:var(--" + barTint + ')"></div></div>' +
      '<div class="hw-footnote" style="color:' + (isDone ? "var(--accent)" : "var(--muted,#8e8e93)") + '">' +
      (isDone ? "Goal crushed. Keep stacking."
              : esc(GoalsUI.valueLabel(active.metric, remaining)) + " to go \u00B7 " + pct + "% there") +
      "</div></div>";
  }

  // ---- Widget 2: Pay period ----
  function payPeriodWidgetHTML(d) {
    const profile = d.profile;
    const period = PayEngine.payPeriodContaining(todayKeyLocal());
    const pay = PayEngine.periodSummary(period, d.days, d.premiumByDay, d.table);
    // CA associates see the estimated post-tax number as the headline; everyone
    // else keeps the pre-tax total. Taxes only apply to positive pay.
    const est = (PayEngine.isCalifornia(profile) && pay.totalPay > 0.005)
      ? PayEngine.taxBreakdown(pay.totalPay, profile.incomeTaxEstimate)
      : null;
    let html = '<div class="card hw-card" data-nav="stats" data-widget="payPeriod" role="button" tabindex="0">' +
      '<div class="hw-row"><span class="hw-label">\uD83D\uDCB5 Pay period</span>' +
      '<span class="hw-spacer"></span>' + pillHTML(PayEngine.paydayLabel(period), "accent") + "</div>";
    if (est) {
      // Compact side-by-side: take-home as the hero number, pre-tax secondary.
      html += '<div class="hw-split">' +
        heroStatHTML(PayEngine.periodLabel(period), fmtCurrency(est.net), "est. take-home", "accent") +
        '<div class="hw-side"><div class="hw-side-label">Pre-tax</div>' +
        '<div class="hw-side-value">' + esc(fmtCurrency(pay.totalPay)) + "</div></div></div>";
    } else {
      html += '<div class="hw-row hw-baseline"><span class="hw-period-label">' +
        esc(PayEngine.periodLabel(period)) + '</span><span class="hw-spacer"></span>' +
        '<span class="hw-period-total">' + esc(fmtCurrency(pay.totalPay)) + "</span></div>";
    }
    if (!pay.days.length) {
      html += '<div class="hw-caption">No days logged in this period yet.</div>';
    } else {
      const parts = ["Commission " + fmtCurrency(pay.commission), "base " + fmtCurrency(pay.basePay)];
      if (pay.premiumPay > 0.005) parts.push("open/close " + fmtCurrency(pay.premiumPay));
      if (pay.overtimePay > 0.005) parts.push("overtime " + fmtCurrency(pay.overtimePay));
      if (pay.topUp > 0.005) parts.push("top-up " + fmtCurrency(pay.topUp));
      html += '<div class="hw-caption">' + esc(parts.join(" + ")) + "</div>";
      if (!est) {
        const otNote = pay.overtimePay > 0.005 ? " + OT premium" : "";
        html += '<div class="hw-row"><span class="hw-caption hw-semib">Minimum-wage floor</span>' +
          '<span class="hw-spacer"></span>' +
          '<span class="hw-caption">' + pay.openHours.toFixed(1) + " open hrs \u00D7 " +
          esc(fmtCurrency(PayEngine.MINIMUM_WAGE)) + esc(otNote) + '</span> <span class="hw-bold">' +
          esc(fmtCurrency(pay.floor)) + "</span></div>";
      }
      let status;
      if (pay.topUp > 0.005) {
        status = est
          ? "Company tops up " + fmtCurrency(pay.topUp) + " \u2014 under the floor."
          : pay.days.length + " day" + (pay.days.length === 1 ? "" : "s") + " in \u2014 period average is under minimum wage, so the company tops up " + fmtCurrency(pay.topUp) + ".";
      } else {
        status = est
          ? fmtCurrency(pay.surplus) + " above the floor \u2014 strong period."
          : fmtCurrency(pay.surplus) + " above the minimum-wage floor so far \u2014 strong period.";
      }
      html += '<div class="hw-status" style="color:' +
        (pay.topUp > 0.005 ? "var(--red)" : "var(--accent)") + '">' + esc(status) + "</div>";
    }
    return html + "</div>";
  }

  // ---- Shared: this-month summary (StatsEngine.summary, range .thisMonth) ----
  function monthSummary(d) {
    const monthDays = StatsUI._filterByRange(d.days, "month");
    const s = StatsUI._computeSummary(monthDays, d.table, d.premiumByDay, "month");
    return { monthDays, s };
  }
  function allLines(day) {
    const out = [];
    for (const t of (day.tickets || [])) for (const l of (t.lines || [])) out.push(l);
    return out;
  }
  function dayRevenue(day) {
    return allLines(day).reduce((s, l) => s + PayEngine.lineRevenue(l), 0);
  }
  function dayItems(day) {
    return allLines(day).reduce((s, l) => s + (l.isReturn ? 0 : (l.quantity || 0)), 0);
  }

  // ---- Widget 3: Month so far ----
  function monthSoFarWidgetHTML(d) {
    const w = WIDGETS[2];
    const { monthDays, s } = monthSummary(d);
    let html = '<div class="card hw-card" data-nav="stats" data-widget="monthSoFar" role="button" tabindex="0">' +
      sectionHeadHTML(w.title, "Everything logged this month");
    if (!monthDays.length) {
      html += emptyStateHTML("\uD83D\uDED2",
        "No sales logged yet",
        "Head to the Sales tab and add today's first ticket \u2014 your stats build from there.");
    } else {
      const tp = s.topProducts[0], tb = s.topBrands[0];
      const bt = s.biggestTicketByMoney;
      let btValue = "\u2014", btCaption = "";
      if (bt && bt.ticket) {
        btValue = fmtCurrency((bt.ticket.lines || []).reduce((x, l) => x + PayEngine.lineRevenue(l), 0));
        const items = (bt.ticket.lines || []).reduce((x, l) => x + (l.isReturn ? 0 : (l.quantity || 0)), 0);
        const dk = bt.day ? parseDayKey(dayKeyOf(bt.day)) : null;
        btCaption = (dk ? shortDay(dk) : "") + " \u00B7 " + items + " items";
      }
      const tile = (title, value, caption) =>
        '<div class="hw-tile"><div class="hw-tile-title">' + esc(title) + "</div>" +
        '<div class="hw-tile-value">' + esc(value) + "</div>" +
        '<div class="hw-tile-caption">' + esc(caption) + "</div></div>";
      html += '<div class="hw-tiles">' +
        tile("Most sold item", tp ? tp.name : "\u2014",
             tp ? tp.count + " sold \u00B7 " + fmtCompact(tp.value) : "") +
        tile("Most sold brand", tb ? tb.name : "\u2014",
             tb ? tb.count + " sold \u00B7 " + fmtCompact(tb.value) : "") +
        tile("Plans this month", String(s.plansSold),
             s.plansSold > 0 ? fmtCompact(s.plansRevenue) + " in plans" : "service plans sold") +
        tile("Biggest sale (money)", btValue, btCaption) +
        "</div>";
    }
    return html + "</div>";
  }

  // ---- Widget 4: Commission this month ----
  function commissionMonthWidgetHTML(d) {
    const { s } = monthSummary(d);
    const tint = s.commission < -0.005 ? "red" : "accent";
    let caption = fmtCompact(s.revenue) + " sold \u00B7 " + s.days.length + " day" + (s.days.length === 1 ? "" : "s");
    const extras = s.basePay + s.premiumPay;
    if (extras > 0.005) caption += " \u00B7 +" + fmtCurrency(extras) + " base & min wage";
    return '<div class="card hw-card" data-nav="stats" data-widget="commissionMonth" role="button" tabindex="0">' +
      '<div class="hw-split">' +
      heroStatHTML("Commission this month", fmtCurrency(s.commission), caption, tint) +
      '<div class="hw-side"><div class="hw-side-label">An Hour</div>' +
      '<div class="hw-side-value hw-amber">' + esc(fmtCurrency(s.commissionPerHour)) + "</div>" +
      '<div class="hw-side-label">per hour</div></div>' +
      "</div></div>";
  }

  // ---- Widget 5: Top 5 days ----
  function topDaysWidgetHTML(d) {
    const w = WIDGETS[4];
    const { monthDays, s } = monthSummary(d);
    let html = '<div class="card hw-card" data-widget="topDays">' +
      sectionHeadHTML(w.title, "Ranked by commission, this month");
    if (!monthDays.length) {
      html += emptyStateHTML("\uD83D\uDCC5",
        "Nothing to rank yet",
        "Log a couple of days and your best ones show up here.");
    } else {
      const top = s.topDays.slice(0, 5);
      const best = top.length ? PayEngine.dayCommission(top[0], d.table) : 1;
      html += '<div class="hw-ranks">';
      top.forEach((day, i) => {
        const comm = PayEngine.dayCommission(day, d.table);
        const dk = parseDayKey(dayKeyOf(day));
        const frac = best > 0 ? Math.max(0.02, comm / best) : 0;
        const tint = i < 3 ? "accent" : "blue";
        html += '<div class="hw-rank" data-nav="day" data-arg="' + esc(dayKeyOf(day)) + '" role="button" tabindex="0">' +
          '<span class="hw-rank-num" style="color:' + (i < 3 ? "var(--amber)" : "var(--muted,#8e8e93)") + '">' + (i + 1) + "</span>" +
          '<span class="hw-rank-main"><span class="hw-rank-top"><span class="hw-rank-title">' +
          esc(dk ? shortDay(dk) : dayKeyOf(day)) + '</span><span class="hw-spacer"></span>' +
          '<span class="hw-rank-value">' + esc(fmtCurrency(comm)) + "</span></span>" +
          '<span class="hw-rank-bar"><span class="hw-rank-fill" style="width:' + Math.round(frac * 100) +
          "%;background:var(--" + tint + ')"></span></span>' +
          '<span class="hw-rank-sub">' + esc(fmtCompact(dayRevenue(day))) + " sold \u00B7 " +
          dayItems(day) + " items \u00B7 " + PayEngine.workedHours(day).toFixed(1) + " hrs</span></span></div>";
      });
      html += "</div>";
    }
    return html + "</div>";
  }

  const WIDGET_HTML = {
    goal: goalWidgetHTML,
    payPeriod: payPeriodWidgetHTML,
    monthSoFar: monthSoFarWidgetHTML,
    commissionMonth: commissionMonthWidgetHTML,
    topDays: topDaysWidgetHTML,
  };

  // ---- Navigation ----
  let onNavigate = null;
  function navigate(tab, arg) {
    if (typeof onNavigate === "function") { onNavigate(tab, arg); return; }
    // Fallbacks when the parent hasn't wired the hook.
    if (tab === "settings") {
      const gear = document.getElementById("settings-gear");
      if (gear) { gear.click(); return; }
    }
  }

  // ---- Public API ----
  let lastContainer = null, lastData = null;
  function render(container, data) {
    const el = typeof container === "string" ? document.querySelector(container) : container;
    if (!el) return;
    ensureCSS();
    const d = normalizeData(data);
    lastContainer = el; lastData = data;
    const order = widgetOrder(d.profile);
    let html = greetingHTML(d) + paydayRecapHTML(d);
    for (const id of order) {
      const fn = WIDGET_HTML[id];
      if (fn) html += fn(d);
    }
    el.innerHTML = html;
    el.querySelectorAll("[data-nav]").forEach(n => {
      n.addEventListener("click", e => {
        if (e.target.closest("[data-payday-dismiss]")) return;
        navigate(n.getAttribute("data-nav"), n.getAttribute("data-arg"));
      });
      n.addEventListener("keydown", e => {
        if (n.tagName === "BUTTON") return; // native button already fires click on Enter/Space
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); navigate(n.getAttribute("data-nav"), n.getAttribute("data-arg")); }
      });
    });
    const dismissBtn = el.querySelector("[data-payday-dismiss]");
    if (dismissBtn) dismissBtn.addEventListener("click", e => {
      e.stopPropagation();
      const card = el.querySelector("[data-payday-card]");
      const key = card ? card.getAttribute("data-dismiss-key") : null;
      try { if (key) localStorage.setItem(key, "1"); } catch (err) {}
      if (card) card.style.display = "none";
    });
  }

  // Convenience: load the cached backup blob and render (mirrors GoalsUI.open).
  async function open(container) {
    const backup = await SyncEngine.getLocalBackup().catch(() => null);
    const data = (backup && backup.data) || {};
    render(container, data);
  }

  function rerender() {
    if (lastContainer) render(lastContainer, lastData);
  }

  // ---- Module CSS (theme variables with fallbacks; works across all 6 themes) ----
  let cssInjected = false;
  function ensureCSS() {
    if (cssInjected || document.getElementById("home-widgets-css")) { cssInjected = true; return; }
    cssInjected = true;
    const css =
      ".hw-greet{display:flex;align-items:flex-start;gap:12px;padding:6px 2px 14px}" +
      ".hw-greet-text{flex:1;min-width:0}" +
      ".hw-greet-hi{font-size:15px;font-weight:600;color:var(--muted,#8e8e93)}" +
      ".hw-greet-name{font-size:34px;font-weight:800;letter-spacing:-.5px;color:var(--text,#1c1c1e);line-height:1.1;margin:2px 0 8px}" +
      ".hw-pills{display:flex;gap:8px;flex-wrap:wrap}" +
      ".hw-avatar-btn{background:none;border:none;padding:0;cursor:pointer;border-radius:50%}" +
      ".hw-avatar{width:44px;height:44px;border-radius:50%;object-fit:cover;display:block;border:1.5px solid var(--accent,#34d399)}" +
      ".hw-avatar-initials{display:flex;align-items:center;justify-content:center;font-weight:800;font-size:15px;color:#fff;background:#1c2a4a;border:1.5px solid var(--accent,#34d399)}" +
      ".hw-card{margin-bottom:14px;padding:16px;cursor:pointer}" +
      ".hw-card[data-payday-card]{cursor:default}" +
      ".hw-card[data-widget=topDays]{cursor:default}" +
      ".hw-row{display:flex;align-items:center;gap:8px}" +
      ".hw-baseline{align-items:baseline;margin-top:6px}" +
      ".hw-spacer{flex:1}" +
      ".hw-label{font-size:12px;font-weight:700;color:var(--muted,#8e8e93);text-transform:uppercase;letter-spacing:.4px}" +
      ".hw-caption{font-size:12px;color:var(--muted,#8e8e93);margin-top:8px}" +
      ".hw-semib{font-weight:600}" +
      ".hw-bold{font-size:14px;font-weight:700;color:var(--text,#1c1c1e)}" +
      ".hw-footnote{font-size:13px;font-weight:500;color:var(--muted,#8e8e93);margin-top:8px}" +
      ".hw-status{font-size:13px;font-weight:600;margin-top:8px}" +
      ".hw-hero{flex:1;min-width:0}" +
      ".hw-hero-label{font-size:12px;font-weight:600;color:var(--muted,#8e8e93)}" +
      ".hw-hero-value{font-size:34px;font-weight:800;letter-spacing:-.5px;line-height:1.15;color:var(--accent,#34d399)}" +
      ".hw-hero-caption{font-size:13px;color:var(--muted,#8e8e93);margin-top:2px}" +
      ".hw-split{display:flex;align-items:center;gap:14px;margin-top:6px}" +
      ".hw-side{text-align:right;flex-shrink:0}" +
      ".hw-side-label{font-size:10px;font-weight:700;color:var(--muted,#8e8e93)}" +
      ".hw-side-value{font-size:20px;font-weight:800;color:var(--accent,#34d399);opacity:.75}" +
      ".hw-side-value.hw-amber{color:var(--amber,#fbbf24);opacity:1}" +
      ".hw-period-label{font-size:18px;font-weight:800;color:var(--text,#1c1c1e)}" +
      ".hw-period-total{font-size:20px;font-weight:800;color:var(--accent,#34d399)}" +
      ".hw-payday-total{font-size:34px;font-weight:800;color:var(--accent,#34d399);margin-top:6px}" +
      ".hw-gotit{margin-top:10px;width:100%;padding:10px;border:none;border-radius:999px;background:var(--card2,#eef0f4);color:var(--text,#1c1c1e);font-size:14px;font-weight:700;cursor:pointer}" +
      ".hw-goal-hero{margin-top:6px;display:flex;align-items:baseline;gap:8px}" +
      ".hw-goal-current{font-size:34px;font-weight:800;letter-spacing:-.5px}" +
      ".hw-goal-of{font-size:15px;font-weight:600;color:var(--muted,#8e8e93)}" +
      ".hw-progress{height:10px;border-radius:5px;background:var(--card2,#e8ebf1);margin-top:10px;overflow:hidden}" +
      ".hw-bar{height:100%;border-radius:5px;transition:width .3s}" +
      ".hw-sec-head{margin-bottom:10px}" +
      ".hw-sec-title{font-size:17px;font-weight:800;color:var(--text,#1c1c1e)}" +
      ".hw-sec-sub{font-size:13px;color:var(--muted,#8e8e93);margin-top:2px}" +
      ".hw-tiles{display:grid;grid-template-columns:1fr 1fr;gap:10px}" +
      ".hw-tile{background:var(--card2,#f2f4f8);border-radius:10px;padding:12px;min-width:0}" +
      ".hw-tile-title{font-size:11px;font-weight:700;color:var(--muted,#8e8e93);text-transform:uppercase;letter-spacing:.4px}" +
      ".hw-tile-value{font-size:16px;font-weight:800;color:var(--text,#1c1c1e);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".hw-tile-caption{font-size:12px;color:var(--muted,#8e8e93);margin-top:2px}" +
      ".hw-empty{text-align:center;padding:28px 16px}" +
      ".hw-empty-symbol{font-size:32px;margin-bottom:8px}" +
      ".hw-empty-title{font-weight:700;margin-bottom:4px;color:var(--text,#1c1c1e)}" +
      ".hw-empty-msg{font-size:13px;color:var(--muted,#8e8e93)}" +
      ".hw-ranks{display:flex;flex-direction:column;gap:10px}" +
      ".hw-rank{display:flex;gap:12px;align-items:flex-start;cursor:pointer;padding:4px 2px}" +
      ".hw-rank-num{font-size:12px;font-weight:800;width:20px;flex-shrink:0;padding-top:2px}" +
      ".hw-rank-main{flex:1;min-width:0}" +
      ".hw-rank-top{display:flex;align-items:baseline;gap:8px}" +
      ".hw-rank-title{font-size:14px;font-weight:600;color:var(--text,#1c1c1e)}" +
      ".hw-rank-value{font-size:14px;font-weight:700;color:var(--text,#1c1c1e)}" +
      ".hw-rank-bar{height:6px;border-radius:3px;background:var(--card2,#e8ebf1);margin-top:6px;overflow:hidden}" +
      ".hw-rank-fill{display:block;height:100%;border-radius:3px;opacity:.85;min-width:4px}" +
      ".hw-rank-sub{font-size:12px;color:var(--muted,#8e8e93);margin-top:4px;display:block}";
    const style = document.createElement("style");
    style.id = "home-widgets-css";
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  return {
    render,
    open,
    rerender,
    // Parent wiring: HomeWidgetsUI.onNavigate = (tab, arg) => {...}
    //   tab: "goals" | "stats" | "schedule" | "settings" | "day" (arg = day key)
    set onNavigate(fn) { onNavigate = fn; },
    get onNavigate() { return onNavigate; },
    // Exposed for testing / reuse.
    _fmtCurrency: fmtCurrency,
    _fmtCompact: fmtCompact,
    _widgetOrder: widgetOrder,
    _shortDay: shortDay,
    _normalize: normalizeData,
  };
})();
