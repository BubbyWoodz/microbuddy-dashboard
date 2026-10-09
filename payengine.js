"use strict";
/* ============ payengine.js — exact JS port of the Micro Buddy iOS pay math ============
 *
 * Source of truth: BubbyWoodz/micro-buddy (branch main), ios-micro-buddy/
 *   - MicroBuddy/Models/CommissionTable.swift
 *   - MicroBuddy/Models/SaleModels.swift      (SaleLine/SaleTicket commission)
 *   - MicroBuddy/Models/WorkDay.swift         (workedHours, CA daily overtime)
 *   - MicroBuddy/Models/StoreHours.swift      (min wage, base rate, premiums)
 *   - MicroBuddy/Models/PayPeriod.swift       (PayPeriod + PayEngine.dayPay/summary)
 *   - MicroBuddy/Models/CaliforniaTaxes.swift (CATaxEstimate 2026 take-home)
 *   - MicroBuddy/Models/UserProfile.swift     (profile.table resolution)
 *   - MicroBuddy/Models/Department.swift      (department raw values)
 *   - MicroBuddy/Stores/AppStore+Schedule.swift (premiumsByDay, payPeriodSummary)
 *   - MicroBuddy/Views/HomeView.swift         (period take-home gating)
 *   - MicroBuddy/Views/DayDetailView.swift    (day take-home gating)
 *
 * Pure functions only — no DOM, no network. Dates are "yyyy-MM-dd" day keys;
 * day arithmetic runs in UTC to stay DST-proof (Swift uses Calendar.current,
 * but whole-day math is identical either way).
 *
 * Data shapes (match the backup blob):
 *   day     = { id/date: "yyyy-MM-dd", tickets: [...], scheduledHours, lunchMinutes, ... }
 *   ticket  = { lines: [ { product, brand, unitPrice, quantity, kind,
 *                          isReturn, sku, isExchange } ] }
 *   kind    = "inDepartment" | "outOfDepartment" | "servicePlan"
 *   profile = { department: "gsa", commissionTables: {...},
 *               incomeTaxEstimate: 0.105, state: "CA" }
 *   shift   = { start: ISO string, end: ISO string }
 * ===================================================================================== */
const PayEngine = (() => {

  // ---------------------------------------------------------------------------
  // Date helpers (day-key based)
  // ---------------------------------------------------------------------------

  const DAY_MS = 86400000;

  /// "yyyy-MM-dd" for a Date (UTC) — mirrors WorkDay.key's stable format.
  function dayKey(d) {
    const dt = (d instanceof Date) ? d : new Date(d);
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const day = String(dt.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  /// Parse a "yyyy-MM-dd" key to a UTC-midnight Date.
  function parseKey(key) {
    const [y, m, d] = String(key).split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }

  /// Add whole days to a day key, returning a day key.
  function addDays(key, n) {
    return dayKey(new Date(parseKey(key).getTime() + n * DAY_MS));
  }

  /// Whole days from keyA to keyB (keyB - keyA).
  function daysBetween(keyA, keyB) {
    return Math.round((parseKey(keyB) - parseKey(keyA)) / DAY_MS);
  }

  /// 0=Sunday..6=Saturday for a day key (Swift: Calendar weekday 1=Sunday).
  function weekday(key) {
    return parseKey(key).getUTCDay();
  }

  // ---------------------------------------------------------------------------
  // StoreHours.swift — constants
  // ---------------------------------------------------------------------------

  /// California minimum wage, effective January 1, 2026. (StoreHours.swift:15)
  const MINIMUM_WAGE = 16.90;

  /// Base pay for hours worked while the store is open — commission comes on
  /// top of this. (StoreHours.swift:19)
  const BASE_HOURLY_RATE = 4.0;

  // ---------------------------------------------------------------------------
  // CommissionTable.swift — GSA/CE rates, confirmed by the user
  // ---------------------------------------------------------------------------

  /// The GSA table (CommissionTable.swift:49-58). CE is identical; every other
  /// department starts on the GSA table (CommissionTable.default, line 60-63).
  function gsaTable() {
    return {
      tiers: [
        { minPrice: 0,   maxPrice: 9.99,   rate: 0.12 },
        { minPrice: 10,  maxPrice: 99.99,  rate: 0.06 },
        { minPrice: 100, maxPrice: 199.99, rate: 0.03 },
        { minPrice: 200, maxPrice: null,   rate: 0.02 }, // nil = "and up"
      ],
      outOfDepartmentRate: 0.01,
      servicePlanRate: 0.10,
    };
  }

  /// Commission rate for one unit at `unitPrice`.
  /// Port of CommissionTable.rate(unitPrice:kind:) (CommissionTable.swift:68-82).
  /// Note the exact edge behavior: a price in a gap between tiers (e.g. 9.995)
  /// matches nothing and falls back to the last tier's rate.
  function commissionRate(table, unitPrice, kind) {
    if (kind === "servicePlan") return table.servicePlanRate;
    if (kind === "outOfDepartment") return table.outOfDepartmentRate;
    const price = Math.abs(unitPrice);
    const sorted = [...table.tiers].sort((a, b) => a.minPrice - b.minPrice);
    for (const tier of sorted) {
      const upper = (tier.maxPrice === null || tier.maxPrice === undefined)
        ? Infinity : tier.maxPrice;
      if (price >= tier.minPrice && price <= upper) return tier.rate;
    }
    return sorted.length ? sorted[sorted.length - 1].rate : 0;
  }

  /// Resolve the commission table for a profile.
  /// Port of UserProfile.table (UserProfile.swift:241-243).
  function tableForProfile(profile) {
    const p = profile || {};
    const dept = p.department || "gsa";
    const tables = p.commissionTables || {};
    return tables[dept] || gsaTable();
  }

  // ---------------------------------------------------------------------------
  // SaleModels.swift — per-line / per-ticket / per-day commission
  // ---------------------------------------------------------------------------

  /// One line's revenue: returns subtract. (SaleModels.swift:75-77)
  function lineRevenue(line) {
    return (line.isReturn ? -1 : 1) * line.unitPrice * line.quantity;
  }

  /// One line's commission. (SaleModels.swift:79-82)
  function lineCommission(line, table) {
    return lineRevenue(line) * commissionRate(table, line.unitPrice, line.kind);
  }

  /// One ticket's commission. (SaleModels.swift:106-108)
  function ticketCommission(ticket, table) {
    return (ticket.lines || []).reduce((s, l) => s + lineCommission(l, table), 0);
  }

  /// One day's commission across all tickets. (WorkDay.swift:commission(using:))
  function dayCommission(day, table) {
    return (day.tickets || []).reduce((s, t) => s + ticketCommission(t, table), 0);
  }

  // ---------------------------------------------------------------------------
  // WorkDay.swift — hours and California daily overtime
  // ---------------------------------------------------------------------------

  /// Paid hours actually worked (lunch removed). (WorkDay.swift:60-62)
  function workedHours(day) {
    return Math.max(0, (day.scheduledHours || 0) - (day.lunchMinutes || 0) / 60);
  }

  /// CA daily overtime: hours past 8 worked, up to 12, pay 1.5x.
  /// (WorkDay.swift:70)
  function overtimeHours15(day) {
    return Math.max(0, Math.min(workedHours(day), 12) - 8);
  }

  /// Hours worked past 12 pay double time. (WorkDay.swift:72)
  function overtimeHours2(day) {
    return Math.max(0, workedHours(day) - 12);
  }

  function hasOvertime(day) {
    return overtimeHours15(day) > 0.005 || overtimeHours2(day) > 0.005;
  }

  /// A day with no tickets logged projects no pay. (WorkDay.swift:isEmpty,
  /// PayEngine.summary filter, PayPeriod.swift:209)
  function isEmptyDay(day) {
    return !(day.tickets && day.tickets.length);
  }

  // ---------------------------------------------------------------------------
  // StoreHours.swift — store open/close windows and min-wage premium hours
  // ---------------------------------------------------------------------------

  /// Open/close hour for a day key: Mon-Sat 10-21, Sunday 11-18, with listed
  /// holidays running Sunday hours. (StoreHours.swift:40-51)
  function openAndClose(key, holidayDates) {
    // holidayDates may be a Set (has) or an Array (includes) — JSON
    // round-trips turn Sets into Arrays.
    let isHoliday = false;
    if (holidayDates) {
        if (typeof holidayDates.has === "function") isHoliday = holidayDates.has(key);
        else if (typeof holidayDates.includes === "function") isHoliday = holidayDates.includes(key);
    }
    const sundayHours = weekday(key) === 0 || isHoliday;
    return sundayHours ? { open: 11, close: 18 } : { open: 10, close: 21 };
  }

  /// Min-wage hours for one shift: time before opening + time after closing.
  /// Port of StoreHours.premiumHours (StoreHours.swift:54-59).
  /// shift = { start: Date|ISO, end: Date|ISO }; key = "yyyy-MM-dd" of the day.
  function premiumHoursForShift(shift, key, holidayDates) {
    const { open, close } = openAndClose(key, holidayDates);
    const dayStart = parseKey(key).getTime();
    const openMs = dayStart + open * 3600000;
    const closeMs = dayStart + close * 3600000;
    const startMs = (shift.start instanceof Date ? shift.start : new Date(shift.start)).getTime();
    const endMs = (shift.end instanceof Date ? shift.end : new Date(shift.end)).getTime();
    return {
      opening: Math.max(0, (openMs - startMs) / 3600000),
      closing: Math.max(0, (endMs - closeMs) / 3600000),
    };
  }

  /// Opening/closing premium for a whole day, summed across its shifts.
  /// Port of StoreHours.premium(for:shifts:) (StoreHours.swift:62-70).
  /// Returns { openingHours, closingHours, totalHours, pay, isEmpty } —
  /// mirrors DayPremium (StoreHours.swift:75-81).
  function dayPremium(shifts, key, holidayDates) {
    let openingHours = 0, closingHours = 0;
    for (const shift of (shifts || [])) {
      const h = premiumHoursForShift(shift, key, holidayDates);
      openingHours += h.opening;
      closingHours += h.closing;
    }
    const totalHours = openingHours + closingHours;
    return {
      openingHours,
      closingHours,
      totalHours,
      pay: totalHours * MINIMUM_WAGE,          // DayPremium.pay
      isEmpty: totalHours <= 0.004,            // DayPremium.isEmpty
    };
  }

  /// Premiums keyed by "yyyy-MM-dd", built from a shift list.
  /// Port of AppStore.premiumsByDay (AppStore+Schedule.swift:19-28).
  function premiumsByDay(shifts, holidayDates) {
    const result = {};
    for (const shift of (shifts || [])) {
      const key = dayKey(shift.start);
      const h = premiumHoursForShift(shift, key, holidayDates);
      const p = result[key] || { openingHours: 0, closingHours: 0 };
      p.openingHours += h.opening;
      p.closingHours += h.closing;
      result[key] = p;
    }
    // Attach derived fields to match DayPremium.
    for (const key of Object.keys(result)) {
      const p = result[key];
      p.totalHours = p.openingHours + p.closingHours;
      p.pay = p.totalHours * MINIMUM_WAGE;
      p.isEmpty = p.totalHours <= 0.004;
    }
    return result;
  }

  function emptyPremium() {
    return { openingHours: 0, closingHours: 0, totalHours: 0, pay: 0, isEmpty: true };
  }

  // ---------------------------------------------------------------------------
  // PayPeriod.swift — biweekly periods anchored to payday Sep 18, 2026
  // ---------------------------------------------------------------------------

  /// A known payday — every payday is a multiple of 14 days from this one.
  /// (PayPeriod.swift:28-34)
  const ANCHOR_PAYDAY = "2026-09-18";

  /// The pay period containing a day key: the 14 days ending the day before
  /// the next payday in the biweekly cycle.
  /// Port of PayPeriod.containing (PayPeriod.swift:38-55).
  function payPeriodContaining(key) {
    const k = dayKey(key);
    const delta = daysBetween(k, ANCHOR_PAYDAY); // day -> anchor
    const periodsAway = Math.ceil((1 - delta) / 14);
    const payday = addDays(ANCHOR_PAYDAY, 14 * periodsAway);
    return {
      start: addDays(payday, -14),
      end: addDays(payday, -1),
      payday,
    };
  }

  /// True when a day key falls inside the period.
  /// Port of PayPeriod.contains (PayPeriod.swift:70-74).
  function periodContains(period, key) {
    const k = dayKey(key);
    const dayAfterEnd = addDays(period.end, 1);
    return k >= period.start && k < dayAfterEnd;
  }

  /// The period immediately before / after this one. (PayPeriod.swift:58-68)
  function previousPeriod(period) {
    return payPeriodContaining(addDays(period.start, -1));
  }
  function nextPeriod(period) {
    return payPeriodContaining(addDays(period.end, 1));
  }

  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  /// "Sep 4–17" or "Aug 21–Sep 3". (PayPeriod.swift:77-89)
  function periodLabel(period) {
    const s = parseKey(period.start), e = parseKey(period.end);
    const startText = `${MONTHS[s.getUTCMonth()]} ${s.getUTCDate()}`;
    if (s.getUTCMonth() === e.getUTCMonth()) {
      return `${startText}–${e.getUTCDate()}`;
    }
    return `${startText}–${MONTHS[e.getUTCMonth()]} ${e.getUTCDate()}`;
  }

  /// "Payday Sep 18". (PayPeriod.swift:92-96)
  function paydayLabel(period) {
    const p = parseKey(period.payday);
    return `Payday ${MONTHS[p.getUTCMonth()]} ${p.getUTCDate()}`;
  }

  // ---------------------------------------------------------------------------
  // PayEngine.dayPay — one day's pay split into its pieces
  // (PayPeriod.swift:149-193)
  // ---------------------------------------------------------------------------

  /// Pay split for one day. Overtime hours are the LAST hours worked, so they
  /// land in the closing premium first — those upgrade from flat minimum wage
  /// to the OT rate — and only the remainder come off the open floor instead
  /// of $4/hr base.
  function dayPay(day, premium, table) {
    const p = premium || emptyPremium();
    const ot15 = overtimeHours15(day);
    const ot2 = overtimeHours2(day);
    const otTotal = ot15 + ot2;
    // Overtime landing in closed-store hours replaces the flat min-wage
    // premium with the OT rate — never both.
    const otInPremium = Math.min(otTotal, p.closingHours);
    const otOnOpenFloor = otTotal - otInPremium;
    // Regular hours worked while the store was open — the hours that earn
    // base pay. Overtime hours are excluded: they earn their OT rate instead
    // of base pay (open-floor OT) or the flat closed-store premium
    // (closed-store OT).
    const openHrs = Math.max(0, workedHours(day) - p.totalHours - otOnOpenFloor);
    const commission = dayCommission(day, table);
    const basePay = openHrs * BASE_HOURLY_RATE;
    const overtimePay = ot15 * 1.5 * MINIMUM_WAGE + ot2 * 2 * MINIMUM_WAGE;
    const premiumPay = Math.max(0, p.pay - otInPremium * MINIMUM_WAGE);
    // Surplus/deficit is open-floor economics: commission + $4 base vs
    // minimum wage on regular open hours.
    const floor = MINIMUM_WAGE * openHrs;
    const delta = commission + basePay - floor;
    const total = commission + basePay + premiumPay + overtimePay;
    return {
      day,
      premium: p,
      openHours: openHrs,
      commission,
      basePay,
      premiumPay,
      overtimePay,
      delta,
      total,
      isShort: delta < -0.005,       // DayPay.isShort
      deficit: Math.max(0, -delta),   // DayPay.deficit
      surplus: Math.max(0, delta),    // DayPay.surplus
    };
  }

  // ---------------------------------------------------------------------------
  // PayEngine.summary — the whole period rolled up, floor applied across it
  // (PayPeriod.swift:196-229)
  // ---------------------------------------------------------------------------

  /// Rolls every day in the period up and applies the minimum-wage floor
  /// across the whole period: surplus offsets short days first, and only the
  /// remaining shortfall becomes a company top-up.
  function periodSummary(period, days, premiumByDay, table) {
    // Only days with logged sales count toward pay — a day that just has
    // scheduled hours (no tickets input yet) doesn't project pay.
    const dayPays = (days || [])
      .filter(d => periodContains(period, d.id || dayKey(d.date)) && !isEmptyDay(d))
      .sort((a, b) => {
        const ka = a.id || dayKey(a.date), kb = b.id || dayKey(b.date);
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      })
      .map(d => dayPay(d, (premiumByDay || {})[(d.id || dayKey(d.date))] || emptyPremium(), table));

    const sum = (f) => dayPays.reduce((s, dp) => s + f(dp), 0);
    const openHours = sum(dp => dp.openHours);
    const commission = sum(dp => dp.commission);
    const basePay = sum(dp => dp.basePay);
    const premiumPay = sum(dp => dp.premiumPay);
    const overtimePay = sum(dp => dp.overtimePay);
    const overtimeHours15Total = sum(dp => overtimeHours15(dp.day));
    const overtimeHours2Total = sum(dp => overtimeHours2(dp.day));
    // Only regular open hours can ever fall short — premium and overtime
    // pay meet their own floors exactly.
    const floor = MINIMUM_WAGE * openHours;
    const topUp = Math.max(0, floor - (commission + basePay));
    const totalPay = commission + basePay + premiumPay + overtimePay + topUp;
    const shortDays = dayPays.filter(dp => dp.isShort);
    return {
      period,
      days: dayPays,
      openHours,
      commission,
      basePay,
      premiumPay,
      overtimePay,
      overtimeHours15: overtimeHours15Total,
      overtimeHours2: overtimeHours2Total,
      floor,
      topUp,
      totalPay,                                            // PayPeriodSummary.totalPay
      shortDays,
      surplus: Math.max(0, commission + basePay - floor),  // PayPeriodSummary.surplus
      // Short days exist but the period's surplus already covers them.
      isCoveredBySurplus: topUp <= 0.005 && shortDays.length > 0,
    };
  }

  // ---------------------------------------------------------------------------
  // CaliforniaTaxes.swift — 2026 take-home estimator
  // ---------------------------------------------------------------------------

  /// Tax year these constants describe. (CaliforniaTaxes.swift:11)
  const TAX_YEAR = 2026;

  /// Social Security employee rate (2026). (CaliforniaTaxes.swift:15)
  const SOCIAL_SECURITY = 0.062;
  /// Medicare employee rate (2026). (CaliforniaTaxes.swift:17)
  const MEDICARE = 0.0145;
  /// California SDI employee rate (2026) — no wage cap. (CaliforniaTaxes.swift:19)
  const SDI = 0.013;

  /// Fixed employee payroll stack: 8.95% of gross, not user-editable.
  /// (CaliforniaTaxes.swift:22)
  const FIXED_PAYROLL_RATE = SOCIAL_SECURITY + MEDICARE + SDI; // 0.0895

  /// Default combined federal + California income-tax estimate — 10.5%.
  /// The only editable knob. (CaliforniaTaxes.swift:26)
  const DEFAULT_INCOME_TAX_RATE = 0.105;

  /// Allowed range for the editable income-tax estimate: 0–40%.
  /// (CaliforniaTaxes.swift:29)
  const INCOME_TAX_MIN = 0.0, INCOME_TAX_MAX = 0.40;

  /// Clamps a user-entered income-tax rate (decimal) into the allowed range.
  /// (CaliforniaTaxes.swift:32-34)
  function clampIncomeTax(rate) {
    return Math.min(Math.max(rate, INCOME_TAX_MIN), INCOME_TAX_MAX);
  }

  /// Estimated tax split for one gross amount. Pure arithmetic.
  /// Port of CATaxEstimate.breakdown (CaliforniaTaxes.swift:51-66).
  function taxBreakdown(gross, incomeRate) {
    const rate = clampIncomeTax(incomeRate);
    const socialSecurity = gross * SOCIAL_SECURITY;
    const medicare = gross * MEDICARE;
    const sdi = gross * SDI;
    const incomeTax = gross * rate;
    const totalTaxes = socialSecurity + medicare + sdi + incomeTax;
    return {
      socialSecurity,
      medicare,
      sdi,
      incomeTax,
      totalTaxes,
      net: gross - totalTaxes,
      combinedRate: FIXED_PAYROLL_RATE + rate,
    };
  }

  /// True when the user's home state is California — gates the estimated
  /// take-home math. (UserProfile.swift:isCalifornia)
  function isCalifornia(profile) {
    return (profile && profile.state) === "CA";
  }

  /// Estimated take-home for one day's pay. Shown only for CA associates and
  /// only when the day total is positive. (DayDetailView.swift:422-423)
  /// Returns the CATaxEstimate.Breakdown or null.
  function dayTakeHome(pay, profile) {
    if (!isCalifornia(profile) || !(pay.total > 0.005)) return null;
    return taxBreakdown(pay.total, profile.incomeTaxEstimate ?? DEFAULT_INCOME_TAX_RATE);
  }

  /// Estimated take-home for a pay period. Shown only for CA associates and
  /// only when the period total is positive. (HomeView.swift:247-251)
  /// Returns the CATaxEstimate.Breakdown or null.
  function periodTakeHome(summary, profile) {
    if (!isCalifornia(profile) || !(summary.totalPay > 0.005)) return null;
    return taxBreakdown(summary.totalPay, profile.incomeTaxEstimate ?? DEFAULT_INCOME_TAX_RATE);
  }

  /// Estimated take-home on a commission number (MicroCharm cheers).
  /// (MicroCharmEngine.swift:99-100)
  function commissionTakeHome(commission, profile) {
    if (!isCalifornia(profile)) return commission;
    return taxBreakdown(commission, profile.incomeTaxEstimate ?? DEFAULT_INCOME_TAX_RATE).net;
  }

  // ---------------------------------------------------------------------------
  // Convenience: full pipeline for the dashboard
  // ---------------------------------------------------------------------------

  /// One-call day pay: builds the premium from shifts, resolves the table
  /// from the profile, returns { pay, takeHome }.
  function calculateDayPay(day, shifts, profile, holidayDates) {
    const key = day.id || dayKey(day.date);
    const table = tableForProfile(profile);
    const premium = dayPremium(shiftsForDay(shifts, key), key, holidayDates);
    const pay = dayPay(day, premium, table);
    return { pay, takeHome: dayTakeHome(pay, profile) };
  }

  /// One-call period pay: premiums from shifts, table from profile.
  /// Returns { summary, takeHome }.
  function calculatePeriodPay(period, days, shifts, profile, holidayDates) {
    const table = tableForProfile(profile);
    const premiumByDay = premiumsByDay(shifts, holidayDates);
    const summary = periodSummary(period, days, premiumByDay, table);
    return { summary, takeHome: periodTakeHome(summary, profile) };
  }

  function shiftsForDay(shifts, key) {
    return (shifts || []).filter(s => dayKey(s.start) === key);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  return {
    // constants
    MINIMUM_WAGE, BASE_HOURLY_RATE,
    TAX_YEAR, SOCIAL_SECURITY, MEDICARE, SDI, FIXED_PAYROLL_RATE,
    DEFAULT_INCOME_TAX_RATE, INCOME_TAX_MIN, INCOME_TAX_MAX,
    ANCHOR_PAYDAY,
    // dates
    dayKey, parseKey, addDays, daysBetween, weekday,
    // commission
    gsaTable, commissionRate, tableForProfile,
    lineRevenue, lineCommission, ticketCommission, dayCommission,
    // workday
    workedHours, overtimeHours15, overtimeHours2, hasOvertime, isEmptyDay,
    // store hours / premium
    openAndClose, premiumHoursForShift, dayPremium, premiumsByDay, emptyPremium,
    // pay periods
    payPeriodContaining, periodContains, previousPeriod, nextPeriod,
    periodLabel, paydayLabel,
    // pay engine
    dayPay, periodSummary,
    // taxes / take-home
    clampIncomeTax, taxBreakdown, isCalifornia,
    dayTakeHome, periodTakeHome, commissionTakeHome,
    // convenience
    calculateDayPay, calculatePeriodPay,
  };
})();
