"use strict";
/* ============ goals.js — Goals tab: full port of the iOS Goals feature ============
 *
 * Matches the app's Goal model exactly (Goal.swift):
 *   { id, metric, period, target, createdAt, isActive }
 *
 * GoalMetric: revenue ("Money Sold"), commission ("Commission Earned"),
 *             moneyMade ("Money Made"), plans ("Plans Sold"), cph ("CPH Reached")
 * GoalPeriod: day ("Every Day"), week ("This Week"),
 *             payPeriod ("This Pay Period"), month ("This Month")
 *
 * App behaviors ported:
 *  - setGoal: deactivates all others, inserts new at index 0 (ONE active goal)
 *  - activateGoal: only that goal is active
 *  - removeGoal: delete by id
 *  - goalProgress: period-filtered days → metric sum → (current, target, fraction)
 *  - Headline: "$500 · this week" (amount + lowercased period)
 *  - Goal widget text: "N to go · M% there", "GOAL HIT 🎉" at 100%
 *  - CPH target < 1 is clamped to 0 (invalid)
 *
 * Sync: all mutations go through SyncEngine.queueWrite.
 *   updateGoal exists in sync.js. New ops documented at the bottom:
 *   - addGoal    { type:"addGoal", goal:{...} }
 *   - deleteGoal { type:"deleteGoal", goalId }
 *   (activateGoal is implemented as updateGoal with {isActive} changes,
 *    or addGoal for the setGoal "deactivate others" semantics — see below.)
 *
 * Depends on globals from dashboard.html: $, esc, money, spinner, emptyBox,
 * showError, parseD, fmtD, daysAgoISO, iso, SyncEngine.
 */
const GoalsUI = (() => {
  // ---- App constants (Goal.swift) ----
  const METRICS = {
    revenue:    { title: "Money Sold",      symbol: "💰", isMoney: true,
                  placeholder: "3000", hint: "Total dollars sold" },
    commission: { title: "Commission Earned", symbol: "💵", isMoney: true,
                  placeholder: "300", hint: "Commission dollars earned" },
    moneyMade:  { title: "Money Made",      symbol: "✨", isMoney: true,
                  placeholder: "150", hint: "Take-home pay (commission + base)" },
    plans:      { title: "Plans Sold",      symbol: "🛡️", isMoney: false,
                  placeholder: "5", hint: "Service plans sold" },
    cph:        { title: "CPH Reached",     symbol: "👥", isMoney: false,
                  placeholder: "3", hint: "Customers per hour" },
  };
  const PERIODS = {
    day:      { title: "Every Day" },
    week:     { title: "This Week" },
    payPeriod:{ title: "This Pay Period" },
    month:    { title: "This Month" },
  };

  // Pay periods are biweekly, anchored to the Sep 18 2026 payday (PayPeriod.swift).
  const ANCHOR_PAYDAY = "2026-09-18";
  function payPeriodContaining(dateStr) {
    // dateStr: YYYY-MM-DD. Returns {start, end} as YYYY-MM-DD.
    const day = parseD(dateStr);
    const anchor = parseD(ANCHOR_PAYDAY);
    const deltaDays = Math.round((anchor - day) / 86400000);
    const periodsAway = Math.ceil((1 - deltaDays) / 14);
    const payday = new Date(anchor);
    payday.setDate(payday.getDate() + 14 * periodsAway);
    const start = new Date(payday); start.setDate(start.getDate() - 14);
    const end = new Date(payday); end.setDate(end.getDate() - 1);
    return { start: iso(start), end: iso(end) };
  }

  // ---- Data access ----
  function getGoals(backup) {
    const g = backup && backup.data && backup.data.goals;
    if (!g) return [];
    const arr = Array.isArray(g) ? g : Object.values(g);
    return arr.map(x => normalizeGoal(x)).filter(Boolean);
  }

  function normalizeGoal(x) {
    if (!x) return null;
    const metric = METRICS[x.metric] ? x.metric : "revenue";
    const period = PERIODS[x.period] ? x.period : "day";
    return {
      id: String(x.id || x.goalId || ""),
      metric,
      period,
      target: Number(x.target || 0),
      createdAt: x.createdAt || x.created_at || new Date().toISOString(),
      isActive: x.isActive !== false,
      raw: x,
    };
  }

  function getDays(backup) {
    const d = backup && backup.data && backup.data.days;
    if (!d) return [];
    return Array.isArray(d) ? d : Object.values(d);
  }

  function dayDateStr(day) {
    return day.date || day.dayKey || (day.id && /^\d{4}-\d{2}-\d{2}/.test(day.id) ? day.id.slice(0, 10) : null);
  }

  // ---- Day stat computation (from blob tickets/lines) ----
  function dayStats(day) {
    let revenue = 0, commission = 0, plans = 0, customers = 0, hours = 0;
    const tickets = day.tickets || [];
    customers = tickets.length;
    for (const tk of tickets) {
      for (const ln of (tk.lines || [])) {
        const qty = Number(ln.quantity) || 1;
        const total = Number(ln.line_total ?? ln.total ?? (ln.unitPrice || ln.unit_price || 0) * qty) || 0;
        revenue += total;
        if (ln.commission != null && !ln.is_return) commission += Number(ln.commission) || 0;
        if (ln.kind === "servicePlan" || ln.kind === "plan") plans += 1;
      }
    }
    hours = Number(day.hours || day.workedHours || day.worked_hours || 0);
    // Fall back to shift hours if the day has shifts but no hours field.
    if (!hours && Array.isArray(day.shifts)) {
      for (const s of day.shifts) hours += Number(s.hours || s.workedHours || 0);
    }
    return { revenue, commission, plans, customers, hours };
  }

  // ---- goalProgress port (AppStore+Goals.swift) ----
  function relevantDays(goal, days) {
    const today = iso(new Date());
    switch (goal.period) {
      case "day":
        return days.filter(d => dayDateStr(d) === today);
      case "week": {
        const now = new Date();
        const startOfWeek = new Date(now);
        startOfWeek.setDate(now.getDate() - now.getDay()); // Sunday start (app uses Calendar.current)
        const s = iso(startOfWeek);
        return days.filter(d => { const dt = dayDateStr(d); return dt && dt >= s && dt <= today; });
      }
      case "payPeriod": {
        const pp = payPeriodContaining(today);
        return days.filter(d => { const dt = dayDateStr(d); return dt && dt >= pp.start && dt <= pp.end; });
      }
      case "month": {
        const prefix = today.slice(0, 7); // YYYY-MM
        return days.filter(d => (dayDateStr(d) || "").startsWith(prefix));
      }
      default:
        return [];
    }
  }

  // ---- Exact "money made" via PayEngine (commission + base + premium + OT) ----
  // Cached per backup load; reset in open().
  let _payCtx = null;
  function payCtx() {
    if (_payCtx) return _payCtx;
    const data = (currentBackup && currentBackup.data) || {};
    const profile = data.profile || {};
    let table = null, premiumByDay = {};
    try {
      if (typeof PayEngine !== "undefined") {
        table = PayEngine.tableForProfile(profile);
        premiumByDay = PayEngine.premiumsByDay(data.shifts || [], data.holidayDates || []) || {};
      }
    } catch (e) { /* fall back to empty premium/table */ }
    _payCtx = { table, premiumByDay };
    return _payCtx;
  }
  function moneyMadeForDay(d) {
    try {
      if (typeof PayEngine === "undefined") return 0;
      const { table, premiumByDay } = payCtx();
      const dk = dayDateStr(d);
      const premium = (dk && premiumByDay[dk]) || PayEngine.emptyPremium();
      const pay = PayEngine.dayPay(d, premium, table);
      return (pay && pay.total) || 0;
    } catch (e) { return 0; }
  }

  function goalProgress(goal, days) {
    const relevant = relevantDays(goal, days);
    let current = 0;    switch (goal.metric) {
      case "revenue":
        current = relevant.reduce((s, d) => s + dayStats(d).revenue, 0);
        break;
      case "commission":
        current = relevant.reduce((s, d) => s + dayStats(d).commission, 0);
        break;
      case "moneyMade":
        // Exact: PayEngine.dayPay(day).total — commission + base + premium + OT.
        current = relevant.reduce((s, d) => s + moneyMadeForDay(d), 0);
        break;
      case "plans":
        current = relevant.reduce((s, d) => s + dayStats(d).plans, 0);
        break;
      case "cph": {
        const hours = relevant.reduce((s, d) => s + dayStats(d).hours, 0);
        const customers = relevant.reduce((s, d) => s + dayStats(d).customers, 0);
        current = hours > 0 ? customers / hours : 0;
        break;
      }
    }
    const fraction = goal.target > 0 ? Math.min(1, Math.max(0, current / goal.target)) : 0;
    return { current, target: goal.target, fraction };
  }

  // ---- Formatting (GoalMetric.valueLabel) ----
  function valueLabel(metric, value) {
    const m = METRICS[metric] || METRICS.revenue;
    if (m.isMoney) return money(value);
    if (metric === "plans") return String(Math.round(value));
    // cph: integer if whole, else 1 decimal
    return value === Math.round(value) ? String(Math.round(value)) : value.toFixed(1);
  }

  function compactMoney(value) {
    // Widget-style compact: $1.2K
    if (value >= 1000) return "$" + (value / 1000).toFixed(1).replace(/\.0$/, "") + "K";
    return money(value);
  }

  function headline(goal) {
    const m = METRICS[goal.metric];
    const amount = m.isMoney
      ? money(goal.target)
      : valueLabel(goal.metric, goal.target) + (goal.metric === "plans" ? " plans" : " CPH");
    return amount + " · " + PERIODS[goal.period].title.toLowerCase();
  }

  // ---- Mutations (via SyncEngine.queueWrite) ----
  async function createGoal(metric, period, target) {
    const goal = {
      id: "goal-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
      metric, period, target,
      createdAt: new Date().toISOString(),
      isActive: true,
    };
    // App setGoal semantics: deactivate all others, insert new at 0.
    await SyncEngine.queueWrite({ type: "addGoal", goal });
    return goal;
  }

  async function activateGoal(goalId) {
    const backup = await SyncEngine.getLocalBackup();
    const goals = getGoals(backup);
    // Deactivate all, activate the chosen one.
    for (const g of goals) {
      if (g.isActive !== (g.id === goalId)) {
        await SyncEngine.queueWrite({
          type: "updateGoal", goalId: g.id, updates: { isActive: g.id === goalId },
        });
      }
    }
  }

  async function deleteGoal(goalId) {
    await SyncEngine.queueWrite({ type: "deleteGoal", goalId });
  }

  async function updateGoalTarget(goalId, target) {
    await SyncEngine.queueWrite({ type: "updateGoal", goalId, updates: { target } });
  }

  // ---- UI ----
  let currentBackup = null;
  let detailGoalId = null;

  async function open() {
    const box = $("goals-body");
    box.innerHTML = spinner("Loading goals…");
    try {
      let backup = await SyncEngine.getLocalBackup();
      if (!backup || !backup.data) {
        await SyncEngine.syncBackup();
        backup = await SyncEngine.getLocalBackup();
      }
      currentBackup = backup;
      _payCtx = null; // fresh PayEngine table/premiums for this backup
      if (detailGoalId) renderDetail(box);
      else renderList(box);
    } catch (e) { showError(box, e); }
  }

  function renderList(box) {
    const goals = getGoals(currentBackup);
    const days = getDays(currentBackup);
    const active = goals.find(g => g.isActive);

    let html = '<div class="goals-head"><h2>Goals</h2>' +
      '<button class="btn primary" id="goal-new">+ New goal</button></div>';

    // Active goal hero (Home widget style: "N to go · M% there")
    if (active) {
      const p = goalProgress(active, days);
      const remaining = Math.max(0, active.target - p.current);
      const m = METRICS[active.metric];
      html += '<div class="goal-hero" data-goal-id="' + esc(active.id) + '">' +
        '<div class="gh-top"><span class="gh-label">🎯 GOAL</span>' +
        '<span class="gh-period">' + esc(PERIODS[active.period].title.toUpperCase()) + "</span></div>";
      if (p.fraction >= 1) {
        html += '<div class="gh-hit">GOAL HIT 🎉</div>';
      } else {
        html += '<div class="gh-remaining">' +
          (m.isMoney ? compactMoney(remaining) : valueLabel(active.metric, remaining)) + "</div>" +
          '<div class="gh-sub">to go · ' + esc(m.title) + "</div>";
      }
      html += '<div class="g-progress"><div class="g-bar" style="width:' +
        Math.round(p.fraction * 100) + '%"></div></div>' +
        '<div class="g-numbers">' + esc(valueLabel(active.metric, p.current)) + " / " +
        esc(valueLabel(active.metric, active.target)) +
        ' <span class="g-pct">' + Math.round(p.fraction * 100) + "%</span></div>" +
        "</div>";
    }

    if (!goals.length) {
      html += emptyBox("No goals yet. Tap “+ New goal” and Buddy will track it automatically.");
    } else {
      html += '<div class="goals-grid">';
      for (const g of goals) {
        const p = goalProgress(g, days);
        const pct = Math.round(p.fraction * 100);
        html += '<div class="goal-card' + (p.fraction >= 1 ? " done" : "") +
          '" data-goal-id="' + esc(g.id) + '">' +
          '<div class="goal-card-top"><span class="g-metric-ico">' +
          esc(METRICS[g.metric].symbol) + "</span>" +
          (g.isActive
            ? '<span class="pill active-pill">Active</span>'
            : '<button class="link-btn goal-use" data-goal-id="' + esc(g.id) + '">Use</button>') +
          "</div>" +
          "<h3>" + esc(headline(g)) + "</h3>" +
          '<div class="g-progress"><div class="g-bar" style="width:' + pct + '%"></div></div>' +
          '<div class="g-numbers">' + esc(valueLabel(g.metric, p.current)) + " / " +
          esc(valueLabel(g.metric, g.target)) +
          ' <span class="g-pct">' + pct + "%</span></div>" +
          '<div class="g-sub2">' + pct + "% · " + esc(METRICS[g.metric].title) + "</div>" +
          (p.fraction >= 1 ? '<div class="g-done">✅ Completed</div>' : "") +
          "</div>";
      }
      html += "</div>";
    }

    box.innerHTML = html;
    $("goal-new").onclick = () => openEditor(null);
    box.querySelectorAll(".goal-card").forEach(card => {
      card.addEventListener("click", (e) => {
        if (e.target.closest(".goal-use")) return; // handled separately
        detailGoalId = card.dataset.goalId;
        renderDetail(box);
      });
    });
    box.querySelectorAll(".goal-use").forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        await activateGoal(btn.dataset.goalId);
        await open();
      };
    });
    const hero = box.querySelector(".goal-hero");
    if (hero) hero.onclick = () => { detailGoalId = hero.dataset.goalId; renderDetail(box); };

    // Celebration: if the active goal just hit 100%, show the banner once.
    if (active) {
      const p = goalProgress(active, days);
      maybeCelebrate(active, p);
    }
  }

  function renderDetail(box) {
    const goals = getGoals(currentBackup);
    const days = getDays(currentBackup);
    const goal = goals.find(g => g.id === detailGoalId);
    if (!goal) { detailGoalId = null; renderList(box); return; }
    const p = goalProgress(goal, days);
    const pct = Math.round(p.fraction * 100);
    const remaining = Math.max(0, goal.target - p.current);
    const m = METRICS[goal.metric];

    let html = '<div class="goals-head"><button class="btn ghost" id="goal-back">← Goals</button>' +
      "<h2>Goal detail</h2></div>" +
      '<div class="panel goal-detail">' +
      '<div class="gd-head"><span class="g-metric-ico big">' + esc(m.symbol) + "</span>" +
      "<div><h3>" + esc(headline(goal)) + "</h3>" +
      '<div class="g-sub2">' + esc(m.title) + " · " + esc(PERIODS[goal.period].title) + "</div></div></div>" +
      '<div class="g-progress big"><div class="g-bar" style="width:' + pct + '%"></div></div>' +
      '<div class="gd-stats">' +
      '<div class="gd-stat"><span class="gd-num">' + esc(valueLabel(goal.metric, p.current)) + '</span><span class="gd-lbl">Current</span></div>' +
      '<div class="gd-stat"><span class="gd-num">' + esc(valueLabel(goal.metric, goal.target)) + '</span><span class="gd-lbl">Target</span></div>' +
      '<div class="gd-stat"><span class="gd-num">' + esc(m.isMoney ? compactMoney(remaining) : valueLabel(goal.metric, remaining)) + '</span><span class="gd-lbl">To go</span></div>' +
      '<div class="gd-stat"><span class="gd-num">' + pct + '%</span><span class="gd-lbl">There</span></div>' +
      "</div>";

    // Progress history: per-day contributions in this period.
    const relevant = relevantDays(goal, days)
      .map(d => ({ date: dayDateStr(d), stats: dayStats(d), day: d }))
      .filter(x => x.date)
      .sort((a, b) => a.date < b.date ? -1 : 1);
    if (relevant.length) {
      html += '<div class="section-title">Progress history</div><div class="gd-history">';
      for (const r of relevant.slice(0, 14)) {
        let val = 0;
        if (goal.metric === "revenue") val = r.stats.revenue;
        else if (goal.metric === "commission") val = r.stats.commission;
        else if (goal.metric === "moneyMade") val = moneyMadeForDay(r.day);
        else if (goal.metric === "plans") val = r.stats.plans;
        else if (goal.metric === "cph") val = r.stats.hours > 0 ? r.stats.customers / r.stats.hours : 0;
        if (val <= 0) continue;
        html += '<div class="gd-hrow"><span>' + esc(fmtD(r.date)) + "</span>" +
          "<strong>" + esc(valueLabel(goal.metric, val)) + "</strong></div>";
      }
      html += "</div>";
    }

    html += '<div class="btn-row">' +
      (goal.isActive
        ? '<span class="pill active-pill">Active goal</span>'
        : '<button class="btn" id="goal-activate">Set active</button>') +
      '<button class="btn ghost" id="goal-edit">Edit target</button>' +
      '<button class="btn danger-ghost" id="goal-delete">Delete</button>' +
      "</div></div>";

    box.innerHTML = html;
    $("goal-back").onclick = () => { detailGoalId = null; renderList(box); };
    const actBtn = $("goal-activate");
    if (actBtn) actBtn.onclick = async () => { await activateGoal(goal.id); await open(); };
    $("goal-edit").onclick = () => openEditor(goal);
    $("goal-delete").onclick = async () => {
      if (!confirm("Delete this goal?")) return;
      await deleteGoal(goal.id);
      detailGoalId = null;
      await open();
    };
  }

  // ---- Editor modal (GoalEditorView port) ----
  function openEditor(existing) {
    let metric = existing ? existing.metric : "revenue";
    let period = existing ? existing.period : "day";
    const placeholders = { revenue: "3000", commission: "300", moneyMade: "150", plans: "5", cph: "3" };

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML =
      '<div class="modal-card goal-editor">' +
      "<h3>" + (existing ? "Edit goal" : "New goal") + "</h3>" +
      '<p class="modal-sub">Buddy tracks it automatically</p>' +
      '<label class="fld-lbl">I want to hit</label>' +
      '<div class="goal-target-row">' +
      '<span class="goal-dollar" id="ge-dollar">$</span>' +
      '<input id="ge-target" inputmode="decimal" placeholder="' + placeholders[metric] + '" value="' +
      (existing ? esc(String(existing.target)) : "") + '">' +
      "</div>" +
      '<label class="fld-lbl">Metric</label><div class="opt-grid" id="ge-metrics"></div>' +
      '<label class="fld-lbl">Period</label><div class="opt-grid" id="ge-periods"></div>' +
      '<div class="form-err" id="ge-err"></div>' +
      '<div class="btn-row"><button class="btn primary" id="ge-save">' +
      (existing ? "Save" : "Set goal") + '</button>' +
      '<button class="btn ghost" id="ge-cancel">Cancel</button></div>' +
      "</div>";
    document.body.appendChild(overlay);

    const mGrid = overlay.querySelector("#ge-metrics");
    const pGrid = overlay.querySelector("#ge-periods");
    const dollar = overlay.querySelector("#ge-dollar");
    const targetInput = overlay.querySelector("#ge-target");

    function renderMetrics() {
      mGrid.innerHTML = Object.keys(METRICS).map(k =>
        '<button class="opt-card' + (k === metric ? " selected" : "") + '" data-k="' + k + '">' +
        '<span class="opt-ico">' + METRICS[k].symbol + "</span>" + esc(METRICS[k].title) + "</button>"
      ).join("");
      mGrid.querySelectorAll(".opt-card").forEach(b => {
        b.onclick = () => {
          metric = b.dataset.k;
          targetInput.placeholder = placeholders[metric];
          dollar.style.visibility = METRICS[metric].isMoney ? "visible" : "hidden";
          renderMetrics();
        };
      });
      dollar.style.visibility = METRICS[metric].isMoney ? "visible" : "hidden";
    }
    function renderPeriods() {
      pGrid.innerHTML = Object.keys(PERIODS).map(k =>
        '<button class="opt-card' + (k === period ? " selected" : "") + '" data-k="' + k + '">' +
        esc(PERIODS[k].title) + "</button>"
      ).join("");
      pGrid.querySelectorAll(".opt-card").forEach(b => {
        b.onclick = () => { period = b.dataset.k; renderPeriods(); };
      });
    }
    renderMetrics();
    renderPeriods();

    overlay.querySelector("#ge-cancel").onclick = () => overlay.remove();
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.querySelector("#ge-save").onclick = async () => {
      const err = overlay.querySelector("#ge-err");
      let value = parseFloat(String(targetInput.value).replace(/[^0-9.]/g, "")) || 0;
      // App rule: CPH target < 1 is invalid.
      if (metric === "cph" && value > 0 && value < 1) value = 0;
      if (!(value > 0)) { err.textContent = "Enter a target greater than zero."; return; }
      try {
        if (existing) await updateGoalTarget(existing.id, value);
        else await createGoal(metric, period, value);
        overlay.remove();
        await open();
      } catch (e2) { err.textContent = e2.message || "Couldn't save."; }
    };
    setTimeout(() => targetInput.focus(), 50);
  }

  // ---- Goal-hit celebration (BadgeCelebrationView pattern) ----
  const celebratedKey = "goals-celebrated";
  async function maybeCelebrate(goal, progress) {
    if (progress.fraction < 1) return;
    let seen = [];
    try { seen = JSON.parse(localStorage.getItem(celebratedKey) || "[]"); } catch (e) {}
    // Celebrate once per goal per period-instance (goal id + period start).
    const periodStart = (() => {
      const today = iso(new Date());
      if (goal.period === "day") return today;
      if (goal.period === "month") return today.slice(0, 7);
      if (goal.period === "payPeriod") return payPeriodContaining(today).start;
      const now = new Date(); const s = new Date(now);
      s.setDate(now.getDate() - now.getDay()); return iso(s);
    })();
    const key = goal.id + "@" + periodStart;
    if (seen.includes(key)) return;
    seen.push(key);
    try { localStorage.setItem(celebratedKey, JSON.stringify(seen.slice(-50))); } catch (e) {}

    const banner = document.createElement("div");
    banner.className = "celebration-banner";
    banner.innerHTML =
      '<div class="cel-confetti">🎉</div>' +
      "<div><strong>GOAL HIT!</strong><br>" + esc(headline(goal)) + "</div>" +
      '<button class="cel-close">✕</button>';
    document.body.appendChild(banner);
    requestAnimationFrame(() => banner.classList.add("show"));
    const dismiss = () => { banner.classList.remove("show"); setTimeout(() => banner.remove(), 400); };
    banner.querySelector(".cel-close").onclick = dismiss;
    banner.onclick = (e) => { if (e.target === banner) dismiss(); };
    setTimeout(dismiss, 4600);
  }

  // Public API. dashboard.html's loadGoals() should delegate here.
  return { open, getGoals, goalProgress, headline, valueLabel, createGoal, activateGoal, deleteGoal };
})();

// Drop-in replacement for dashboard.html's loadGoals():
// dashboard.html calls loadGoals() on tab switch — keep the name working.
async function loadGoals() {
  await GoalsUI.open();
}
