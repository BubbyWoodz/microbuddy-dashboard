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
 *  - Goal widget text: "N to go · M% there", "Goal hit" at 100%
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
    revenue:    { title: "Money Sold",      icon: "dollar", isMoney: true,
                  placeholder: "3000", hint: "Total dollars sold" },
    commission: { title: "Commission Earned", icon: "cash", isMoney: true,
                  placeholder: "300", hint: "Commission dollars earned" },
    moneyMade:  { title: "Money Made",      icon: "wallet", isMoney: true,
                  placeholder: "150", hint: "Take-home pay (commission + base)" },
    plans:      { title: "Plans Sold",      icon: "shield", isMoney: false,
                  placeholder: "5", hint: "Service plans sold" },
    cph:        { title: "CPH Reached",     icon: "users", isMoney: false,
                  placeholder: "3", hint: "Customers per hour" },
  };
  const PERIODS = {
    day:      { title: "Every Day" },
    week:     { title: "This Week" },
    payPeriod:{ title: "This Pay Period" },
    month:    { title: "This Month" },
  };

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

  // The day's local key. WorkDay.id is the "yyyy-MM-dd" key; `date` is a
  // full ISO timestamp, so it must never be compared as a string.
  function dayDateStr(day) {
    if (day && typeof day.id === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day.id)) return day.id;
    if (day && day.date) return PayEngine.dayKey(day.date);
    return null;
  }

  // ---- Day stats — WorkDay.swift (revenue, commission, plansSold, customerCount, workedHours) ----
  function dayStats(day) {
    const { table } = payCtx();
    const tickets = day.tickets || [];
    let revenue = 0, plans = 0;
    for (const tk of tickets) {
      for (const ln of (tk.lines || [])) {
        revenue += PayEngine.lineRevenue(ln);
        if (ln.kind === "servicePlan" && !ln.isReturn && !ln.isExchange) plans += Number(ln.quantity) || 1;
      }
    }
    const customers = tickets.filter(t => !(t.lines || []).some(l => l.isExchange)).length;
    return { revenue, commission: PayEngine.dayCommission(day, table), plans, customers, hours: PayEngine.workedHours(day) };
  }

  // ---- goalProgress port (AppStore+Goals.swift) ----
  function relevantDays(goal, days) {
    const today = PayEngine.dayKey(new Date());
    switch (goal.period) {
      case "day":
        return days.filter(d => dayDateStr(d) === today);
      case "week": {
        // Calendar.current weekOfYear (US: Sunday-Saturday).
        const now = new Date();
        const s = PayEngine.dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay()));
        const e = PayEngine.addDays(s, 6);
        return days.filter(d => { const k = dayDateStr(d); return k && k >= s && k <= e; });
      }
      case "payPeriod": {
        const pp = PayEngine.payPeriodContaining(today);
        return days.filter(d => { const k = dayDateStr(d); return k && PayEngine.periodContains(pp, k); });
      }
      case "month": {
        const prefix = today.slice(0, 7);
        return days.filter(d => (dayDateStr(d) || "").startsWith(prefix));
      }
      default:
        return [];
    }
  }

  /// ctx (optional): { table, premiumByDay } from the caller (Home widgets).
  function goalProgress(goal, days, ctx) {
    const prev = _payCtx;
    if (ctx && ctx.table) _payCtx = { table: ctx.table, premiumByDay: ctx.premiumByDay || {} };
    try { return goalProgressInner(goal, days); } finally { if (ctx && ctx.table) _payCtx = prev; }
  }
  function goalProgressInner(goal, days) {
    const relevant = relevantDays(goal, days);
    let current = 0;
    switch (goal.metric) {
      case "revenue": current = relevant.reduce((s, d) => s + dayStats(d).revenue, 0); break;
      case "commission": current = relevant.reduce((s, d) => s + dayStats(d).commission, 0); break;
      case "moneyMade":
        if (goal.period === "payPeriod") {
          // Whole-period floor incl. company top-up, matching the pay card.
          const { table, premiumByDay } = payCtx();
          const pp = PayEngine.payPeriodContaining(PayEngine.dayKey(new Date()));
          current = PayEngine.periodSummary(pp, days, premiumByDay, table).totalPay || 0;
        } else {
          current = relevant.reduce((s, d) => s + moneyMadeForDay(d), 0);
        }
        break;
      case "plans": current = relevant.reduce((s, d) => s + dayStats(d).plans, 0); break;
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
      id: AppDataSanitizer.uuid(),
      metric, period, target,
      createdAt: SB.isoSeconds(new Date()),
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

  const I = (n, o) => (typeof Icon === "function" ? Icon(n, o) : "");
  function bar(fr, done) { return '<div class="bar' + (done ? " money" : "") + '"><i style="width:' + Math.round(fr * 100) + '%"></i></div>'; }
  function toGo(goal, p) {
    const m = METRICS[goal.metric];
    const remaining = Math.max(0, goal.target - p.current);
    return p.fraction >= 1 ? "Goal hit" : (m.isMoney ? compactMoney(remaining) : valueLabel(goal.metric, remaining)) + " to go";
  }

  function renderList(box) {
    const goals = getGoals(currentBackup);
    const days = getDays(currentBackup);
    const active = goals.find(g => g.isActive);
    let html = '<div class="panel"><div class="sec-head"><div class="grow"><div class="sec-title">Goals</div>' +
      '<div class="sec-sub">Buddy tracks them automatically — same goals as your phone</div></div>' +
      '<button class="btn primary sm" id="goal-new">' + I("plus", { size: 14 }) + " New goal</button></div>";
    if (!goals.length) {
      html += '<div class="empty-state"><div class="empty-ico">' + I("target", { size: 30 }) + '</div><div class="t">No goals yet</div><p>Set one and Buddy will keep score.</p></div></div>';
      box.innerHTML = html;
      $("goal-new").onclick = () => openEditor(null);
      return;
    }
    html += '<div class="grid">';
    if (active) {
      const p = goalProgress(active, days);
      const m = METRICS[active.metric];
      html += '<div class="tile left col-5 clickable" data-goal-id="' + esc(active.id) + '" style="padding:18px">' +
        '<div class="t">' + I("target", { size: 14 }) + " Active goal · " + esc(PERIODS[active.period].title) + "</div>" +
        '<div class="hero-num md ' + (p.fraction >= 1 ? "money" : "") + '" style="margin:6px 0 2px">' + esc(valueLabel(active.metric, p.current)) +
        ' <span class="muted" style="font-size:16px;font-weight:600">of ' + esc(valueLabel(active.metric, active.target)) + "</span></div>" +
        '<div class="c">' + esc(m.title) + "</div>" +
        '<div style="margin:12px 0 6px">' + bar(p.fraction, p.fraction >= 1) + "</div>" +
        '<div class="c">' + esc(toGo(active, p)) + " · " + Math.round(p.fraction * 100) + "% there</div></div>";
    }
    html += '<div class="' + (active ? "col-7" : "col-12") + '"><div class="tiles c2">';
    for (const g of goals) {
      const p = goalProgress(g, days);
      const pct = Math.round(p.fraction * 100);
      html += '<div class="tile left clickable goal-card" data-goal-id="' + esc(g.id) + '">' +
        '<div class="t">' + I(METRICS[g.metric].icon, { size: 14 }) + " " + esc(METRICS[g.metric].title) +
        (g.isActive ? ' <span class="chip money" style="margin-left:auto">Active</span>'
          : ' <button class="link-btn goal-use" style="margin-left:auto" data-goal-id="' + esc(g.id) + '">Use</button>') + "</div>" +
        '<div class="big">' + esc(headline(g)) + "</div>" +
        '<div style="margin:8px 0 4px">' + bar(p.fraction, p.fraction >= 1) + "</div>" +
        '<div class="c">' + esc(valueLabel(g.metric, p.current)) + " of " + esc(valueLabel(g.metric, g.target)) + " · " + pct + "%" +
        (p.fraction >= 1 ? " · Completed" : "") + "</div></div>";
    }
    html += "</div></div></div></div>";
    box.innerHTML = html;
    $("goal-new").onclick = () => openEditor(null);
    box.querySelectorAll("[data-goal-id].clickable").forEach(card => {
      card.addEventListener("click", (e) => {
        if (e.target.closest(".goal-use")) return;
        detailGoalId = card.dataset.goalId;
        renderDetail(box);
      });
    });
    box.querySelectorAll(".goal-use").forEach(btn => {
      btn.onclick = async (e) => { e.stopPropagation(); await activateGoal(btn.dataset.goalId); await open(); };
    });
    if (active) maybeCelebrate(active, goalProgress(active, days));
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
    let html = '<div class="panel"><div class="sec-head"><button class="icon-btn" id="goal-back" aria-label="Back to goals">' + I("chevron-left") + "</button>" +
      '<div class="grow"><div class="sec-title">' + esc(headline(goal)) + '</div><div class="sec-sub">' + esc(m.title) + " · " + esc(PERIODS[goal.period].title) + "</div></div>" +
      (goal.isActive ? '<span class="chip money">Active goal</span>' : '<button class="btn sm" id="goal-activate">Set active</button>') +
      '<button class="btn ghost sm" id="goal-edit">' + I("edit", { size: 14 }) + " Edit target</button>" +
      '<button class="btn danger sm" id="goal-delete">' + I("trash", { size: 14 }) + " Delete</button></div>" +
      '<div style="margin:6px 0 14px">' + bar(p.fraction, p.fraction >= 1) + "</div>" +
      '<div class="tiles c4">' +
        '<div class="tile"><div class="v">' + esc(valueLabel(goal.metric, p.current)) + '</div><div class="l">Current</div></div>' +
        '<div class="tile"><div class="v">' + esc(valueLabel(goal.metric, goal.target)) + '</div><div class="l">Target</div></div>' +
        '<div class="tile"><div class="v">' + esc(m.isMoney ? compactMoney(remaining) : valueLabel(goal.metric, remaining)) + '</div><div class="l">To go</div></div>' +
        '<div class="tile"><div class="v ' + (pct >= 100 ? "money" : "") + '">' + pct + '%</div><div class="l">There</div></div>' +
      "</div>";
    const relevant = relevantDays(goal, days)
      .map(d => ({ date: dayDateStr(d), stats: dayStats(d), day: d }))
      .filter(x => x.date)
      .sort((a, b) => a.date < b.date ? -1 : 1);
    const rows = [];
    for (const r of relevant) {
      let val = 0;
      if (goal.metric === "revenue") val = r.stats.revenue;
      else if (goal.metric === "commission") val = r.stats.commission;
      else if (goal.metric === "moneyMade") val = moneyMadeForDay(r.day);
      else if (goal.metric === "plans") val = r.stats.plans;
      else if (goal.metric === "cph") val = r.stats.hours > 0 ? r.stats.customers / r.stats.hours : 0;
      if (val > 0) rows.push('<div class="kv-row"><span class="k">' + esc(fmtD(r.date)) + '</span><span class="v">' + esc(valueLabel(goal.metric, val)) + "</span></div>");
    }
    if (rows.length) html += '<div class="label" style="margin:16px 0 4px">Progress by day</div>' + rows.join("");
    box.innerHTML = html + "</div>";
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
      '<div class="modal-card">' +
      "<h2>" + (existing ? "Edit goal" : "New goal") + "</h2>" +
      '<p class="caption" style="margin:-8px 0 14px">Buddy tracks it automatically</p>' +
      '<div class="field"><label>I want to hit</label><div class="input-prefix"><span id="ge-dollar">$</span>' +
      '<input id="ge-target" inputmode="decimal" placeholder="' + placeholders[metric] + '" value="' + (existing ? esc(String(existing.target)) : "") + '"></div></div>' +
      (existing ? "" : '<div class="field"><label>Metric</label><div class="seg-pills" id="ge-metrics"></div></div>' +
        '<div class="field"><label>Period</label><div class="seg-pills" id="ge-periods"></div></div>') +
      '<div class="form-error" id="ge-err"></div>' +
      '<div class="modal-actions"><button class="btn ghost" id="ge-cancel">Cancel</button>' +
      '<button class="btn primary" id="ge-save">' + (existing ? "Save" : "Set goal") + "</button></div></div>";
    document.body.appendChild(overlay);
    const mGrid = overlay.querySelector("#ge-metrics");
    const pGrid = overlay.querySelector("#ge-periods");
    const dollar = overlay.querySelector("#ge-dollar");
    const targetInput = overlay.querySelector("#ge-target");
    function renderMetrics() {
      dollar.style.display = METRICS[metric].isMoney ? "" : "none";
      if (!mGrid) return;
      mGrid.innerHTML = Object.keys(METRICS).map(k =>
        '<button class="seg-pill' + (k === metric ? " selected" : "") + '" data-k="' + k + '">' + I(METRICS[k].icon, { size: 14 }) + " " + esc(METRICS[k].title) + "</button>").join("");
      mGrid.querySelectorAll("button").forEach(b => {
        b.onclick = () => { metric = b.dataset.k; targetInput.placeholder = placeholders[metric]; renderMetrics(); };
      });
    }
    function renderPeriods() {
      if (!pGrid) return;
      pGrid.innerHTML = Object.keys(PERIODS).map(k =>
        '<button class="seg-pill' + (k === period ? " selected" : "") + '" data-k="' + k + '">' + esc(PERIODS[k].title) + "</button>").join("");
      pGrid.querySelectorAll("button").forEach(b => { b.onclick = () => { period = b.dataset.k; renderPeriods(); }; });
    }
    renderMetrics();
    renderPeriods();
    overlay.querySelector("#ge-cancel").onclick = () => overlay.remove();
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.querySelector("#ge-save").onclick = async () => {
      const err = overlay.querySelector("#ge-err");
      let value = parseFloat(String(targetInput.value).replace(/[^0-9.]/g, "")) || 0;
      if (metric === "cph" && value > 0 && value < 1) value = 0; // app rule
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
      if (goal.period === "payPeriod") return PayEngine.payPeriodContaining(today).start;
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
      '<span class="cel-ico">' + I("trophy", { size: 22 }) + "</span>" +
      "<div><strong>Goal hit</strong><br>" + esc(headline(goal)) + "</div>" +
      '<button class="icon-btn cel-close" aria-label="Dismiss">' + I("close", { size: 14 }) + "</button>";
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
