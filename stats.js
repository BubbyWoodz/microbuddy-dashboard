"use strict";
/* ============ stats.js — Stats tab depth for the Micro Buddy dashboard ============
 *
 * Faithful port of:
 *   ios-micro-buddy/MicroBuddy/Stores/StatsEngine.swift   (summary, rank, highlights, trendPoints, buckets)
 *   ios-micro-buddy/MicroBuddy/Stores/CrewStats.swift     (per-person crew stats)
 *   ios-micro-buddy/MicroBuddy/Views/StatsView.swift      (range picker, totals, trends, superlatives, rankings)
 *   ios-micro-buddy/MicroBuddy/Views/CrewStatsView.swift  (crew sub-tab)
 *   ios-micro-buddy/MicroBuddy/Models/Shift.swift         (overlapHours, isExactShift, closesWith)
 *   BuddyViewModel.swift TimeParse                        (schedule time parsing)
 *
 * All pay math goes through PayEngine (exact port of the iOS math).
 * All data comes from the local backup blob via SyncEngine.getLocalBackup().
 *
 * Parent wiring (dashboard.html):
 *   <script src="/payengine.js"></script>
 *   <script src="/stats.js"></script>
 *   StatsUI.onOpenDay = (dayKey) => openDayDetail(dayKey);  // tap a highlight/ticket → day detail
 *   StatsUI.render(document.getElementById("stats-body"));
 *
 * Uses globals from dashboard.html: money, num, esc.
 * Uses CSS variables (works with all 6 themes).
 * ===================================================================================== */
const StatsUI = (() => {

  // ---------------------------------------------------------------------------
  // Date helpers (local timezone — matches the app's Calendar.current)
  // ---------------------------------------------------------------------------

  const DAY_MS = 86400000;

  function parseKey(key) {
    const [y, m, d] = String(key).split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  function toKey(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function dayKeyOf(day) {
    return day.id || day.date;
  }

  function todayKey() {
    return toKey(new Date());
  }

  function startOfWeek(d) {
    const c = new Date(d);
    c.setDate(c.getDate() - c.getDay()); // Sunday start (US locale, like the app)
    c.setHours(0, 0, 0, 0);
    return c;
  }

  function fmtShort(date) {
    // "EEE, MMM d" like the app's highlight formatter
    return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  }

  function fmtDayOnly(date) {
    // shortDay — "Mon 9/28" style
    return date.toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric" });
  }

  function fmtMonthDay(date) {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  // ---------------------------------------------------------------------------
  // Range containment (port of StatsRange.contains)
  // ---------------------------------------------------------------------------

  const RANGES = ["today", "week", "month", "year", "all", "custom"];
  const RANGE_TITLES = {
    today: "Today", week: "This Week", month: "This Month",
    year: "This Year", all: "All Time", custom: "Custom",
  };

  function rangeContains(range, date, customStart, customEnd) {
    const now = new Date();
    switch (range) {
      case "today":
        return toKey(date) === toKey(now);
      case "week":
        return toKey(startOfWeek(date)) === toKey(startOfWeek(now));
      case "month":
        return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
      case "year":
        return date.getFullYear() === now.getFullYear();
      case "all":
      case "custom":
        return true;
      default:
        return true;
    }
  }

  function filterByRange(days, range, customStart, customEnd) {
    const cs = customStart ? parseKey(customStart) : null;
    const ce = customEnd ? parseKey(customEnd) : null;
    return days.filter(day => {
      const key = dayKeyOf(day);
      if (!key) return false;
      const date = parseKey(key);
      if (!rangeContains(range, date, customStart, customEnd)) return false;
      if (range === "custom") {
        if (cs && date < cs) return false;
        if (ce) {
          const ceEnd = new Date(ce);
          ceEnd.setHours(23, 59, 59, 999);
          if (date > ceEnd) return false;
        }
      }
      return !PayEngine.isEmptyDay(day);
    });
  }

  // ---------------------------------------------------------------------------
  // TimeParse port (BuddyViewModel.swift) — "10:00 AM", "6:30p", "14:00"
  // ---------------------------------------------------------------------------

  function timeParseMinutes(raw) {
    if (raw == null) return null;
    let text = String(raw).trim().toLowerCase();
    if (!text) return null;
    let offset = 0;
    const amIdx = text.indexOf("am");
    const pmIdx = text.indexOf("pm");
    if (amIdx >= 0) {
      text = text.slice(0, amIdx) + text.slice(amIdx + 2);
    } else if (pmIdx >= 0) {
      offset = 720;
      text = text.slice(0, pmIdx) + text.slice(pmIdx + 2);
    } else if (text.endsWith("a")) {
      text = text.slice(0, -1);
    } else if (text.endsWith("p")) {
      offset = 720;
      text = text.slice(0, -1);
    }
    text = text.replace(/[ .:,\-]+/g, " ").trim();
    const parts = text.split(":");
    const hour = parseInt((parts[0] || "").trim(), 10);
    if (isNaN(hour)) return null;
    const minute = parts.length > 1 ? parseInt(String(parts[1]).slice(0, 2), 10) || 0 : 0;
    if (offset === 0 && hour > 12) return hour * 60 + minute;
    return (hour % 12) * 60 + minute + offset;
  }

  // ---------------------------------------------------------------------------
  // Shift helpers (port of Shift.swift overlap/exact/closes logic)
  // ---------------------------------------------------------------------------

  function parseShiftDate(v) {
    if (v == null) return null;
    if (v instanceof Date) return v;
    if (typeof v === "number") {
      // Swift Codable Date: seconds since 1970 (or ms if large)
      return new Date(v < 1e12 ? v * 1000 : v);
    }
    const d = new Date(String(v));
    return isNaN(d.getTime()) ? null : d;
  }

  function shiftMinutes(date) {
    return date.getHours() * 60 + date.getMinutes();
  }

  // Chooses between am/pm/next-day readings of an ambiguous time.
  function reading(value, winLo, winHi) {
    const candidates = [value, value + 720, value + 1440, value - 720];
    const inside = candidates.find(c => c >= winLo && c <= winHi);
    if (inside !== undefined) return inside;
    return candidates.reduce((a, b) =>
      Math.abs(b - winLo) < Math.abs(a - winLo) ? b : a);
  }

  function overlapHours(shift, coworker) {
    const start = parseShiftDate(shift.start);
    const end = parseShiftDate(shift.end);
    if (!start || !end) return null;
    const userStart = shiftMinutes(start);
    let userEnd = shiftMinutes(end);
    if (userEnd <= userStart) userEnd += 1440;
    const startValue = timeParseMinutes(coworker.start);
    const endValue = timeParseMinutes(coworker.end);
    if (startValue == null && endValue == null) return null;
    let cwStart = startValue != null ? reading(startValue, userStart, userEnd) : userStart;
    let cwEnd = endValue != null ? reading(endValue, userStart, userEnd + 60) : userEnd;
    if (cwEnd < cwStart) cwEnd += 1440;
    const overlap = Math.min(userEnd, cwEnd) - Math.max(userStart, cwStart);
    return Math.max(0, overlap) / 60;
  }

  function shiftHours(shift) {
    const start = parseShiftDate(shift.start);
    const end = parseShiftDate(shift.end);
    if (!start || !end) return 0;
    return Math.max(0, (end - start) / 3600000);
  }

  function isExactShift(shift, coworker) {
    const startMin = timeParseMinutes(coworker.start);
    const endMin = timeParseMinutes(coworker.end);
    if (startMin == null || endMin == null) return false;
    const start = parseShiftDate(shift.start);
    const end = parseShiftDate(shift.end);
    if (!start || !end) return false;
    return Math.abs(startMin - shiftMinutes(start)) <= 2 &&
           Math.abs(endMin - shiftMinutes(end)) <= 2;
  }

  function closesWith(shift, coworker) {
    const endMin = timeParseMinutes(coworker.end);
    if (endMin == null) return false;
    const end = parseShiftDate(shift.end);
    if (!end) return false;
    const userEnd = shiftMinutes(end);
    const candidates = [endMin, endMin + 720, endMin - 720, endMin + 1440];
    const best = candidates.reduce((a, b) =>
      Math.abs(b - userEnd) < Math.abs(a - userEnd) ? b : a);
    return Math.abs(best - userEnd) <= 60;
  }

  function hoursText(hours) {
    const totalMinutes = Math.round(hours * 60);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    if (h === 0) return `${m}m`;
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
  }

  // ---------------------------------------------------------------------------
  // WorkDay computed helpers (mirror the Swift model's derived properties)
  // ---------------------------------------------------------------------------

  function allLines(day) {
    const out = [];
    for (const t of (day.tickets || [])) {
      for (const l of (t.lines || [])) out.push(l);
    }
    return out;
  }

  function dayRevenue(day) {
    return allLines(day).reduce((s, l) => s + PayEngine.lineRevenue(l), 0);
  }

  function dayItemsSold(day) {
    return allLines(day).reduce((s, l) => s + (l.isReturn ? 0 : (l.quantity || 0)), 0);
  }

  function dayPlansSold(day) {
    return allLines(day).reduce((s, l) =>
      s + ((!l.isReturn && l.kind === "servicePlan") ? (l.quantity || 0) : 0), 0);
  }

  function dayPlansRevenue(day) {
    return allLines(day).reduce((s, l) =>
      s + ((l.kind === "servicePlan") ? PayEngine.lineRevenue(l) : 0), 0);
  }

  function dayReturnsTotal(day) {
    // Positive magnitude, like the app's returnsTotal.
    return allLines(day).reduce((s, l) =>
      s + (l.isReturn ? Math.abs(PayEngine.lineRevenue(l)) : 0), 0);
  }

  function dayCustomerCount(day) {
    return (day.tickets || []).length;
  }

  function dayCustomersPerHour(day) {
    const h = PayEngine.workedHours(day);
    return h > 0 ? dayCustomerCount(day) / h : 0;
  }

  function dayCommissionPerHour(day, table, premiumHours) {
    const open = Math.max(0, PayEngine.workedHours(day) - (premiumHours || 0));
    return open > 0.005 ? PayEngine.dayCommission(day, table) / open : 0;
  }

  function ticketRevenue(ticket) {
    return (ticket.lines || []).reduce((s, l) => s + PayEngine.lineRevenue(l), 0);
  }

  function ticketItemCount(ticket) {
    return (ticket.lines || []).reduce((s, l) => s + (l.isReturn ? 0 : (l.quantity || 0)), 0);
  }

  // ---------------------------------------------------------------------------
  // StatsEngine port
  // ---------------------------------------------------------------------------

  function rankDays(days, by, table) {
    // by: "brand" | "product" — top 10 by count, ties broken by revenue.
    const totals = {};
    for (const day of days) {
      for (const line of allLines(day)) {
        if (line.isReturn) continue;
        const raw = String(line[by] || "").trim();
        const key = raw ? raw : "Unlabeled";
        const e = totals[key] || { revenue: 0, count: 0 };
        e.revenue += PayEngine.lineRevenue(line);
        e.count += line.quantity || 0;
        totals[key] = e;
      }
    }
    return Object.entries(totals)
      .map(([name, e]) => ({ name, subtitle: `${e.count} sold`, value: e.revenue, count: e.count }))
      .sort((a, b) => a.count === b.count ? b.value - a.value : b.count - a.count)
      .slice(0, 10);
  }

  function computeHighlights(days, table, premiumByDay) {
    const result = [];
    const add = (id, title, day, primary, secondary) => {
      if (!day) return;
      result.push({
        id, title, dayKey: dayKeyOf(day),
        date: parseKey(dayKeyOf(day)), primary, secondary,
      });
    };

    const maxBy = (arr, fn) => arr.length ? arr.reduce((a, b) => fn(b) > fn(a) ? b : a) : null;
    const minBy = (arr, fn) => arr.length ? arr.reduce((a, b) => fn(b) < fn(a) ? b : a) : null;

    const byCommission = maxBy(days, d => PayEngine.dayCommission(d, table));
    const byRevenue = maxBy(days, d => dayRevenue(d));
    const byItems = maxBy(days, d => dayItemsSold(d));
    const withHours = days.filter(d => PayEngine.workedHours(d) > 0);
    const anHour = d => dayCommissionPerHour(d, table, (premiumByDay[dayKeyOf(d)] || {}).totalHours || 0);
    const bestCPH = maxBy(withHours, anHour);
    const worstCPH = minBy(withHours, anHour);
    const customerDays = withHours.filter(d => (d.tickets || []).length > 0);
    const bestCustomers = maxBy(customerDays, d => dayCustomersPerHour(d));

    add("best", "Best Day", byCommission,
      d => money(PayEngine.dayCommission(d, table)) + " earned",
      d => fmtShort(parseKey(dayKeyOf(d))));
    add("money", "Most Money Sold", byRevenue,
      d => money(dayRevenue(d)),
      d => fmtShort(parseKey(dayKeyOf(d))));
    add("items", "Most Items Sold", byItems,
      d => `${num(dayItemsSold(d))} items`,
      d => fmtShort(parseKey(dayKeyOf(d))));
    add("cph-high", "Best $ An Hour", bestCPH,
      d => money(anHour(d)) + "/hr",
      d => fmtShort(parseKey(dayKeyOf(d))));
    add("cph-low", "Least $ An Hour", worstCPH,
      d => money(anHour(d)) + "/hr",
      d => fmtShort(parseKey(dayKeyOf(d))));
    add("cph-customers", "Best CPH", bestCustomers,
      d => dayCustomersPerHour(d).toFixed(1) + " CPH",
      d => fmtShort(parseKey(dayKeyOf(d))));

    // Efficiency superlatives: short shifts that crushed it, long shifts that didn't.
    if (withHours.length >= 2) {
      const sortedByHours = [...withHours].sort((a, b) =>
        PayEngine.workedHours(a) - PayEngine.workedHours(b));
      const half = Math.max(1, Math.floor(sortedByHours.length / 2));
      const shortHalf = sortedByHours.slice(0, half);
      const longHalf = sortedByHours.slice(-half);

      add("short-money", "Short Shift, Big Money",
        maxBy(shortHalf, d => dayRevenue(d)),
        d => money(dayRevenue(d)),
        d => `${PayEngine.workedHours(d).toFixed(1)} hrs · ${fmtShort(parseKey(dayKeyOf(d)))}`);
      add("short-comm", "Short Shift, Big Commission",
        maxBy(shortHalf, d => PayEngine.dayCommission(d, table)),
        d => money(PayEngine.dayCommission(d, table)),
        d => `${PayEngine.workedHours(d).toFixed(1)} hrs · ${fmtShort(parseKey(dayKeyOf(d)))}`);
      add("long-money", "Long Shift, Least Money",
        minBy(longHalf, d => dayRevenue(d)),
        d => money(dayRevenue(d)),
        d => `${PayEngine.workedHours(d).toFixed(1)} hrs · ${fmtShort(parseKey(dayKeyOf(d)))}`);
      add("long-comm", "Long Shift, Least Commission",
        minBy(longHalf, d => PayEngine.dayCommission(d, table)),
        d => money(PayEngine.dayCommission(d, table)),
        d => `${PayEngine.workedHours(d).toFixed(1)} hrs · ${fmtShort(parseKey(dayKeyOf(d)))}`);
    }
    return result;
  }

  function computeSummary(days, table, premiumByDay, range) {
    const s = {
      days,
      revenue: 0, commission: 0, items: 0, plansSold: 0, plansRevenue: 0,
      hours: 0, returnsTotal: 0, ticketCount: 0,
      averageTicket: 0, commissionPerHour: 0, customersPerHour: 0,
      premiumPay: 0, premiumHours: 0, basePay: 0, overtimePay: 0,
      topBrands: [], topProducts: [], highlights: [],
      offDayRevenue: 0, offDayReturns: 0, offDayCount: 0,
      biggestTicketByMoney: null, biggestTicketByItems: null,
      topDays: [],
    };
    if (!days.length) return s;

    for (const d of days) {
      s.revenue += dayRevenue(d);
      s.commission += PayEngine.dayCommission(d, table);
      s.items += dayItemsSold(d);
      s.plansSold += dayPlansSold(d);
      s.plansRevenue += dayPlansRevenue(d);
      s.hours += PayEngine.workedHours(d);
      s.returnsTotal += dayReturnsTotal(d);
      s.ticketCount += dayCustomerCount(d);
    }
    s.averageTicket = s.ticketCount > 0 ? s.revenue / s.ticketCount : 0;
    s.customersPerHour = s.hours > 0 ? s.ticketCount / s.hours : 0;

    for (const day of days) {
      const key = dayKeyOf(day);
      const premium = premiumByDay[key] || { totalHours: 0, closingHours: 0, pay: 0 };
      const ot15 = PayEngine.overtimeHours15(day);
      const ot2 = PayEngine.overtimeHours2(day);
      const otTotal = ot15 + ot2;
      // Overtime hours are the last hours worked: they upgrade the closing
      // premium to the OT rate first, then come off the open floor instead of
      // $4/hr base — never both.
      const otInPremium = Math.min(otTotal, premium.closingHours || 0);
      s.premiumHours += Math.max(0, (premium.totalHours || 0) - otInPremium);
      s.premiumPay += Math.max(0, (premium.pay || 0) - otInPremium * PayEngine.MINIMUM_WAGE);
      s.overtimePay += ot15 * 1.5 * PayEngine.MINIMUM_WAGE + ot2 * 2 * PayEngine.MINIMUM_WAGE;
      const openHours = Math.max(0,
        PayEngine.workedHours(day) - (premium.totalHours || 0) - (otTotal - otInPremium));
      s.basePay += openHours * PayEngine.BASE_HOURLY_RATE;
    }
    s.totalPay = s.commission + s.premiumPay + s.basePay + s.overtimePay;

    // "An Hour" — commission over open-floor hours only.
    const openFloorHours = Math.max(0, s.hours - s.premiumHours);
    s.commissionPerHour = openFloorHours > 0.005 ? s.commission / openFloorHours : 0;

    s.topBrands = rankDays(days, "brand", table);
    s.topProducts = rankDays(days, "product", table);
    s.topDays = [...days].sort((a, b) =>
      PayEngine.dayCommission(b, table) - PayEngine.dayCommission(a, table));

    // Day-off earnings.
    const offDays = days.filter(d =>
      PayEngine.workedHours(d) <= 0.005 && (d.tickets || []).length > 0);
    s.offDayRevenue = offDays.reduce((x, d) => x + dayRevenue(d), 0);
    s.offDayReturns = offDays.reduce((x, d) => x + dayReturnsTotal(d), 0);
    s.offDayCount = offDays.length;

    // Biggest tickets.
    for (const day of days) {
      for (const ticket of (day.tickets || [])) {
        const rev = ticketRevenue(ticket);
        const items = ticketItemCount(ticket);
        if (!s.biggestTicketByMoney || rev > ticketRevenue(s.biggestTicketByMoney.ticket)) {
          s.biggestTicketByMoney = { day, ticket };
        }
        if (!s.biggestTicketByItems || items > ticketItemCount(s.biggestTicketByItems.ticket)) {
          s.biggestTicketByItems = { day, ticket };
        }
      }
    }

    if (range !== "today") {
      s.highlights = computeHighlights(days, table, premiumByDay);
    }
    return s;
  }

  // ---------------------------------------------------------------------------
  // Trend points (port of StatsEngine.trendPoints)
  // ---------------------------------------------------------------------------

  function trendPoints(days, range, table, customStart, customEnd) {
    const filtered = filterByRange(days, range, customStart, customEnd)
      .sort((a, b) => String(dayKeyOf(a)) < String(dayKeyOf(b)) ? -1 : 1);

    if (range === "today") {
      const day = filtered.find(d => dayKeyOf(d) === todayKey());
      if (!day) return [];
      return (day.tickets || [])
        .slice()
        .sort((a, b) => String(a.time || "") < String(b.time || "") ? -1 : 1)
        .map(t => ({
          date: t.time ? new Date(t.time) : parseKey(dayKeyOf(day)),
          label: t.time ? fmtTimeOnly(t.time) : "",
          commission: PayEngine.ticketCommission(t, table),
          revenue: ticketRevenue(t),
          items: ticketItemCount(t),
        }));
    }
    if (range === "year" || range === "all") {
      // Per-month buckets.
      const groups = {};
      for (const d of filtered) {
        const key = dayKeyOf(d).slice(0, 7); // yyyy-MM
        (groups[key] = groups[key] || []).push(d);
      }
      return Object.keys(groups).sort().map(k => {
        const g = groups[k];
        const dt = parseKey(k + "-01");
        return {
          date: dt,
          label: dt.toLocaleDateString("en-US", { month: "short" }),
          commission: g.reduce((x, d) => x + PayEngine.dayCommission(d, table), 0),
          revenue: g.reduce((x, d) => x + dayRevenue(d), 0),
          items: g.reduce((x, d) => x + dayItemsSold(d), 0),
        };
      });
    }
    // Per-day for week/month/custom.
    return filtered.map(d => ({
      date: parseKey(dayKeyOf(d)),
      label: fmtDayOnly(parseKey(dayKeyOf(d))),
      commission: PayEngine.dayCommission(d, table),
      revenue: dayRevenue(d),
      items: dayItemsSold(d),
    }));
  }

  function fmtTimeOnly(v) {
    const d = parseShiftDate(v);
    if (!d) return "";
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }

  // ---------------------------------------------------------------------------
  // CrewStats port
  // ---------------------------------------------------------------------------

  function crewStats(shifts, days, table, range, customStart, customEnd) {
    const cs = customStart ? parseKey(customStart) : null;
    const ce = customEnd ? parseKey(customEnd) : null;
    const filtered = (shifts || []).filter(shift => {
      const start = parseShiftDate(shift.start);
      if (!start) return false;
      if (!rangeContains(range, start, customStart, customEnd)) return false;
      if (range === "custom") {
        if (cs && start < cs) return false;
        if (ce) {
          const ceEnd = new Date(ce);
          ceEnd.setHours(23, 59, 59, 999);
          if (start > ceEnd) return false;
        }
      }
      return true;
    });

    // Names merge case-insensitively.
    const buckets = {};
    for (const shift of filtered) {
      const hrs = shiftHours(shift);
      for (const member of (shift.coworkers || [])) {
        const rawName = String(member.name || member || "").trim();
        if (!rawName) continue;
        const key = rawName.toLowerCase();
        const stat = buckets[key] || {
          name: rawName, partnerShifts: 0, briefShifts: 0,
          overlapHours: 0, briefOverlapHours: 0,
          exactShifts: 0, closingShifts: 0, dayKeys: {},
        };
        const overlap = overlapHours(shift, typeof member === "string" ? { name: member } : member);
        // Under half your shift alongside them = brief, never a partner stat.
        // Unknown hours still count as partners.
        const isBrief = overlap != null && hrs > 0 && overlap < hrs * 0.5;
        if (isBrief) {
          stat.briefShifts += 1;
          stat.briefOverlapHours += overlap || 0;
        } else {
          stat.partnerShifts += 1;
          if (overlap != null) stat.overlapHours += overlap;
          const mObj = typeof member === "string" ? { name: member } : member;
          if (isExactShift(shift, mObj)) stat.exactShifts += 1;
          if (closesWith(shift, mObj)) stat.closingShifts += 1;
          const dk = PayEngine.dayKey(shift.start);
          if (dk) stat.dayKeys[dk] = true;
        }
        buckets[key] = stat;
      }
    }
    const list = Object.values(buckets);
    if (!list.length) return [];

    const daysByID = {};
    for (const d of (days || [])) daysByID[dayKeyOf(d)] = d;

    for (const stat of list) {
      const keys = Object.keys(stat.dayKeys);
      const sharedDays = keys.map(k => daysByID[k]).filter(Boolean);
      stat.loggedDaysCount = sharedDays.length;
      stat.avgRevenue = 0;
      stat.avgCommission = 0;
      if (sharedDays.length) {
        stat.avgRevenue = sharedDays.reduce((x, d) => x + dayRevenue(d), 0) / sharedDays.length;
        stat.avgCommission = sharedDays.reduce((x, d) => x + PayEngine.dayCommission(d, table), 0) / sharedDays.length;
      }
      delete stat.dayKeys;
    }
    return list.sort((a, b) =>
      a.partnerShifts === b.partnerShifts
        ? (a.overlapHours === b.overlapHours ? (a.name < b.name ? -1 : 1) : b.overlapHours - a.overlapHours)
        : b.partnerShifts - a.partnerShifts);
  }

  function initials(name) {
    const words = String(name).split(" ").filter(Boolean);
    return words.slice(0, 2).map(w => w[0]).join("").toUpperCase();
  }

  // ---------------------------------------------------------------------------
  // UI state + rendering
  // ---------------------------------------------------------------------------

  const state = {
    range: "month",
    statsTab: "stats", // "stats" | "crew"
    customStart: null,
    customEnd: null,
    trendMetric: "commission", // "commission" | "revenue" | "items"
    showCustom: false,
    data: null, // { days, shifts, profile, table, premiumByDay }
  };

  // Tap-through to day detail — parent wires this.
  let onOpenDay = null;

  function rangeLabel() {
    if (state.range !== "custom") return RANGE_TITLES[state.range];
    if (state.customStart && state.customEnd) {
      if (state.customStart === state.customEnd) {
        return fmtMonthDay(parseKey(state.customStart));
      }
      return `${fmtMonthDay(parseKey(state.customStart))} – ${fmtMonthDay(parseKey(state.customEnd))}`;
    }
    return "Custom";
  }

  async function loadData() {
    const backup = await SyncEngine.getLocalBackup();
    const data = (backup && backup.data) || {};
    const profile = data.profile || {};
    const table = PayEngine.tableForProfile(profile);
    const shifts = data.shifts || [];
    const premiumByDay = PayEngine.premiumsByDay(shifts, data.holidayDates || []);
    state.data = {
      days: data.days || [],
      shifts,
      profile,
      table,
      premiumByDay,
    };
  }

  function spinnerHTML(msg) {
    return `<div class="spinner">${esc(msg || "Loading stats…")}</div>`;
  }

  function emptyHTML(symbol, title, message) {
    return `<div class="panel" style="text-align:center;padding:32px 20px">` +
      `<div style="font-size:32px;margin-bottom:8px">${symbol}</div>` +
      `<div style="font-weight:700;margin-bottom:4px">${esc(title)}</div>` +
      `<div style="color:var(--muted);font-size:13px">${esc(message)}</div></div>`;
  }

  // ---- Range picker ----

  function rangePickerHTML() {
    const opts = RANGES.map(r =>
      `<button class="btn${state.range === r ? " primary" : " ghost"}" data-range="${r}" ` +
      `style="padding:6px 10px;font-size:13px">${RANGE_TITLES[r]}</button>`
    ).join("");
    return `<div class="panel" style="margin-bottom:12px">` +
      `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">` +
      `<div><div class="label">SHOWING</div>` +
      `<div style="font-size:18px;font-weight:700">${esc(rangeLabel())}</div></div>` +
      (state.range === "custom"
        ? `<button class="btn ghost" id="stats-custom-btn" style="padding:6px 10px;font-size:13px">Change dates</button>`
        : "") +
      `</div>` +
      `<div style="display:flex;gap:6px;flex-wrap:wrap">${opts}</div>` +
      (state.showCustom ? customRangeHTML() : "") +
      `</div>`;
  }

  function customRangeHTML() {
    return `<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;align-items:flex-end">` +
      `<div class="field"><label>From</label>` +
      `<input type="date" id="stats-custom-start" value="${esc(state.customStart || "")}"></div>` +
      `<div class="field"><label>To</label>` +
      `<input type="date" id="stats-custom-end" value="${esc(state.customEnd || "")}"></div>` +
      `<button class="btn primary" id="stats-custom-apply" style="padding:8px 14px">Apply</button>` +
      `</div>`;
  }

  // ---- Stats sub-tab ----

  function miniStat(label, value, color) {
    return `<div class="card" style="padding:12px 8px;text-align:center">` +
      `<div style="font-size:17px;font-weight:800;color:${color};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${value}</div>` +
      `<div class="label" style="margin-top:4px">${esc(label)}</div></div>`;
  }

  function totalsCardHTML(s) {
    const neg = s.commission < -0.005;
    let html = `<div class="panel" style="margin-bottom:12px">`;
    // Hero
    html += `<div style="text-align:center;padding:8px 0 16px">` +
      `<div class="label">COMMISSION EARNED</div>` +
      `<div style="font-size:34px;font-weight:800;color:${neg ? "var(--red)" : "var(--accent)"}">${money(s.commission)}</div>` +
      `<div style="color:var(--muted);font-size:13px">${s.days.length} day${s.days.length === 1 ? "" : "s"} · ${s.hours.toFixed(1)} hrs worked</div>` +
      `</div>`;
    // Grid
    html += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">` +
      miniStat("Money sold", compactMoney(s.revenue), "var(--text)") +
      miniStat("Commission / hr", money(s.commissionPerHour), "var(--amber)") +
      miniStat("Items sold", num(s.items), "var(--blue)") +
      miniStat("Avg ticket", compactMoney(s.averageTicket), "var(--accent)") +
      miniStat("CPH", s.hours > 0 ? s.customersPerHour.toFixed(1) : "—", "var(--amber)") +
      miniStat("Customers", num(s.ticketCount), "var(--accent)") +
      `</div>`;
    // Pay rows
    if (s.hours > 0) {
      html += `<div style="margin-top:12px;border-top:1px solid var(--border);padding-top:12px">`;
      if (s.basePay > 0.005) {
        html += payRow("Base pay", `$${PayEngine.BASE_HOURLY_RATE.toFixed(2)}/hr open hours`, money(s.basePay));
      }
      if (s.premiumHours > 0) {
        html += payRow("Min-wage premium",
          `${s.premiumHours.toFixed(1)} hrs × $${PayEngine.MINIMUM_WAGE.toFixed(2)}`,
          money(s.premiumPay));
      }
      if (s.overtimePay > 0.005) {
        html += payRow("Overtime", "CA daily ×1.5 / ×2 min wage", money(s.overtimePay));
      }
      html += `<div class="list-item" style="border:none;padding:10px 0 0">` +
        `<div class="li-main" style="font-weight:700">Total pay</div>` +
        `<div class="li-val" style="font-weight:800;font-size:16px">${money(s.totalPay)}</div></div>`;
      html += `</div>`;
    }
    html += `</div>`;
    return html;
  }

  function payRow(label, detail, value) {
    return `<div class="list-item"><div class="li-main"><div style="font-size:13px;font-weight:600">${esc(label)}</div>` +
      `<div class="li-sub">${esc(detail)}</div></div>` +
      `<div class="li-val" style="color:var(--accent);font-weight:700">${value}</div></div>`;
  }

  function compactMoney(n) {
    const v = Number(n) || 0;
    const abs = Math.abs(v);
    const sign = v < 0 ? "-" : "";
    if (abs >= 1000000) return `${sign}$${(abs / 1000000).toFixed(1)}M`;
    if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(1)}K`;
    return money(v);
  }

  // ---- Trends chart (pure SVG) ----

  function trendsCardHTML(days, table) {
    const points = trendPoints(days, state.range, table, state.customStart, state.customEnd);
    const metrics = [
      { id: "commission", label: "Commission" },
      { id: "revenue", label: "Money sold" },
      { id: "items", label: "Items" },
    ];
    const metricBtns = metrics.map(m =>
      `<button class="btn${state.trendMetric === m.id ? " primary" : " ghost"}" data-metric="${m.id}" ` +
      `style="padding:6px 10px;font-size:13px">${m.label}</button>`
    ).join("");
    const unit = state.range === "today" ? "sale" : (state.range === "year" || state.range === "all") ? "month" : "day";
    const metricLabel = metrics.find(m => m.id === state.trendMetric).label;

    let html = `<div class="panel" style="margin-bottom:12px">` +
      `<div class="section-title">Trends</div>` +
      `<div style="color:var(--muted);font-size:12px;margin:-6px 0 10px">${esc(metricLabel)} per ${unit}</div>` +
      `<div style="display:flex;gap:6px;margin-bottom:12px">${metricBtns}</div>`;

    if (!points.length) {
      html += `<div style="color:var(--muted);font-size:13px">Nothing to chart for this range yet.</div>`;
    } else {
      html += barChartSVG(points, state.trendMetric);
    }

    // Returns row
    const s = state._summary;
    if (s && s.returnsTotal > 0.005) {
      html += `<div class="list-item" style="border:none;padding-top:12px">` +
        `<div class="li-main" style="font-size:13px;color:var(--muted)">↩ Returns in this range</div>` +
        `<div class="li-val" style="color:var(--red);font-weight:700">-${money(s.returnsTotal)}</div></div>`;
    }
    html += `</div>`;
    return html;
  }

  function barChartSVG(points, metric) {
    const W = 340, H = 180, PAD_L = 8, PAD_R = 8, PAD_T = 8, PAD_B = 28;
    const vals = points.map(p => metric === "items" ? p.items : p[metric]);
    const maxV = Math.max(...vals, 0.01);
    const n = points.length;
    const slotW = (W - PAD_L - PAD_R) / n;
    const barW = Math.max(2, Math.min(28, slotW * 0.62));

    let bars = "";
    let labels = "";
    // Show at most ~8 x labels.
    const labelStep = Math.max(1, Math.ceil(n / 8));
    points.forEach((p, i) => {
      const v = vals[i];
      const h = Math.max(2, (v / maxV) * (H - PAD_T - PAD_B));
      const x = PAD_L + slotW * i + (slotW - barW) / 2;
      const y = H - PAD_B - h;
      const isNeg = v < 0;
      bars += `<rect x="${x.toFixed(1)}" y="${(isNeg ? H - PAD_B - 2 : y).toFixed(1)}" ` +
        `width="${barW.toFixed(1)}" height="${Math.abs(h).toFixed(1)}" rx="2" ` +
        `fill="${isNeg ? "var(--red)" : "var(--accent)"}" opacity="0.85">` +
        `<title>${esc(p.label)}: ${metric === "items" ? num(v) : money(v)}</title></rect>`;
      if (i % labelStep === 0) {
        const lx = PAD_L + slotW * i + slotW / 2;
        labels += `<text x="${lx.toFixed(1)}" y="${H - 8}" text-anchor="middle" ` +
          `font-size="9" fill="var(--muted)">${esc(shortLabel(p.label))}</text>`;
      }
    });
    // Max value label
    const maxLabel = metric === "items" ? num(maxV) : compactMoney(maxV);
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block" role="img">` +
      `<text x="${W - PAD_R}" y="${PAD_T + 8}" text-anchor="end" font-size="10" fill="var(--muted)">${esc(maxLabel)}</text>` +
      bars + labels + `</svg>`;
  }

  function shortLabel(label) {
    // "Mon 9/28" → "9/28"; "Sep" stays; "10:30 AM" → "10:30a"
    const m = String(label).match(/(\d{1,2}\/\d{1,2})/);
    if (m) return m[1];
    const tm = String(label).match(/(\d{1,2}:\d{2})\s*([AP])M/i);
    if (tm) return tm[1] + tm[2].toLowerCase();
    return String(label).slice(0, 6);
  }

  // ---- Standout days (superlatives) ----

  const HIGHLIGHT_ICONS = {
    best: "👑", money: "💰", items: "📦",
    "cph-high": "⚡", "cph-low": "🐢", "cph-customers": "👥",
    "short-money": "🐇", "short-comm": "✨",
    "long-money": "🕐", "long-comm": "🌙",
  };

  function highlightsHTML(s) {
    if (state.range === "today" || !s.highlights.length) return "";
    let html = `<div class="panel" style="margin-bottom:12px">` +
      `<div class="section-title">Standout days</div>` +
      `<div style="color:var(--muted);font-size:12px;margin:-6px 0 10px">The days worth remembering</div>` +
      `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">`;
    for (const h of s.highlights) {
      html += `<button class="card stats-highlight" data-day="${esc(h.dayKey)}" ` +
        `style="padding:12px;text-align:left;cursor:pointer">` +
        `<div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.4px">` +
        `${HIGHLIGHT_ICONS[h.id] || "⭐"} ${esc(h.title)}</div>` +
        `<div style="font-size:16px;font-weight:800;margin:4px 0 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(h.primary)}</div>` +
        `<div style="font-size:11px;color:var(--muted)">${esc(h.secondary)}</div>` +
        `</button>`;
    }
    // Day-off earnings tiles.
    if (s.offDayCount > 0) {
      html += `<div class="card" style="padding:12px">` +
        `<div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase">🌙 Sold on days off</div>` +
        `<div style="font-size:16px;font-weight:800;margin:4px 0 2px">${money(s.offDayRevenue)}</div>` +
        `<div style="font-size:11px;color:var(--muted)">across ${s.offDayCount} day${s.offDayCount === 1 ? "" : "s"} off</div></div>`;
      if (s.offDayReturns > 0.005) {
        html += `<div class="card" style="padding:12px">` +
          `<div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase">↩ Returned on days off</div>` +
          `<div style="font-size:16px;font-weight:800;margin:4px 0 2px;color:var(--red)">-${money(s.offDayReturns)}</div>` +
          `<div style="font-size:11px;color:var(--muted)">across ${s.offDayCount} day${s.offDayCount === 1 ? "" : "s"} off</div></div>`;
      }
    }
    html += `</div></div>`;
    return html;
  }

  // ---- Biggest tickets ----

  function biggestTicketsHTML(s) {
    const bm = s.biggestTicketByMoney;
    const bi = s.biggestTicketByItems;
    if (!bm && !bi) return "";
    const tile = (title, icon, value, caption, dayKey, color) =>
      dayKey
        ? `<button class="card stats-highlight" data-day="${esc(dayKey)}" style="padding:14px;text-align:left;cursor:pointer">` +
          `<div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase">${icon} ${esc(title)}</div>` +
          `<div style="font-size:20px;font-weight:800;margin:4px 0 2px;color:${color}">${esc(value)}</div>` +
          `<div style="font-size:11px;color:var(--muted)">${esc(caption)}</div></button>`
        : "";
    let html = `<div class="panel" style="margin-bottom:12px">` +
      `<div class="section-title">Biggest sales</div>` +
      `<div style="color:var(--muted);font-size:12px;margin:-6px 0 10px">Single tickets that carried you</div>` +
      `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">`;
    if (bm) {
      html += tile("Biggest sale (money)", "💰",
        compactMoney(ticketRevenue(bm.ticket)),
        `${fmtDayOnly(parseKey(dayKeyOf(bm.day)))} · ${ticketItemCount(bm.ticket)} items`,
        dayKeyOf(bm.day), "var(--accent)");
    }
    if (bi) {
      html += tile("Most items in one sale", "📦",
        num(ticketItemCount(bi.ticket)),
        `${fmtDayOnly(parseKey(dayKeyOf(bi.day)))} · ${compactMoney(ticketRevenue(bi.ticket))}`,
        dayKeyOf(bi.day), "var(--accent)");
    }
    html += `</div></div>`;
    return html;
  }

  // ---- Rankings ----

  function rankingHTML(title, subtitle, items, accentFirst) {
    let html = `<div class="panel" style="margin-bottom:12px">` +
      `<div class="section-title">${esc(title)}</div>` +
      `<div style="color:var(--muted);font-size:12px;margin:-6px 0 10px">${esc(subtitle)}</div>`;
    if (!items.length) {
      html += `<div style="color:var(--muted);font-size:13px;padding:8px 0">Nothing yet — log some sales to build this list.</div>`;
    } else {
      const peak = Math.max(...items.map(i => i.count), 1);
      items.forEach((item, idx) => {
        const frac = peak > 0 ? item.count / peak : 0;
        const tint = idx < 3 ? "var(--accent)" : "var(--blue)";
        html += `<div class="list-item" style="align-items:center">` +
          `<span class="rank${idx < 3 ? " r" + (idx + 1) : ""}">${idx + 1}</span>` +
          `<div class="li-main" style="min-width:0"><div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(item.name)}</div>` +
          `<div class="li-sub">${num(item.count)} sold · ${compactMoney(item.value)}</div>` +
          `<div style="height:4px;border-radius:2px;background:var(--card2);margin-top:6px">` +
          `<div style="height:100%;width:${(frac * 100).toFixed(1)}%;border-radius:2px;background:${tint}"></div></div></div>` +
          `<div class="li-val" style="font-size:13px">${compactMoney(item.value)}</div></div>`;
      });
    }
    html += `</div>`;
    return html;
  }

  // ---- Crew sub-tab ----

  function crewTabHTML() {
    const { shifts, days, table } = state.data;
    const list = crewStats(shifts, days, table, state.range, state.customStart, state.customEnd);
    const partners = list.filter(s => s.partnerShifts > 0);
    const brief = list
      .filter(s => s.partnerShifts === 0 && s.briefShifts > 0)
      .sort((a, b) => a.briefShifts === b.briefShifts
        ? b.briefOverlapHours - a.briefOverlapHours
        : b.briefShifts - a.briefShifts);

    if (!partners.length && !brief.length) {
      return emptyHTML("👥",
        `No crew logged for ${RANGE_TITLES[state.range].toLowerCase()}`,
        "Add who's working to a shift and this page fills up.");
    }

    let html = "";
    // Superlative cards: most time with / least often.
    if (partners.length) {
      const most = partners[0];
      const least = partners[partners.length - 1];
      html += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">` +
        crewSuperCard("MOST TIME WITH", "👑", "var(--amber)", most) +
        crewSuperCard("LEAST OFTEN", "❓", "var(--blue)", least) +
        `</div>`;

      html += `<div class="panel" style="margin-bottom:12px">` +
        `<div class="section-title">Everyone</div>` +
        `<div style="color:var(--muted);font-size:12px;margin:-6px 0 10px">${partners.length} ${partners.length === 1 ? "person" : "people"} worked with, ranked by shifts together</div>`;
      partners.forEach((s, i) => { html += crewRowHTML(s, i + 1); });
      html += `</div>`;
    }
    if (brief.length) {
      html += `<div class="panel" style="margin-bottom:12px;opacity:0.9">` +
        `<div class="section-title">Brief overlaps</div>` +
        `<div style="color:var(--muted);font-size:12px;margin:-6px 0 10px">On the roster but under half your shift — not counted above</div>`;
      for (const s of brief) {
        html += `<div class="list-item"><div style="display:flex;align-items:center;gap:12px;min-width:0">` +
          `<span style="width:34px;height:34px;border-radius:50%;background:var(--card2);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;color:var(--muted);flex-shrink:0">${esc(initials(s.name))}</span>` +
          `<div class="li-main"><div style="font-weight:600">${esc(s.name)}</div>` +
          `<div class="li-sub">${hoursText(s.briefOverlapHours)} total overlap</div></div></div>` +
          `<div class="li-val"><div style="font-weight:800">${s.briefShifts}</div>` +
          `<div class="li-sub">${s.briefShifts === 1 ? "shift" : "shifts"}</div></div></div>`;
      }
      html += `</div>`;
    }
    return html;
  }

  function crewSuperCard(title, icon, tint, stat) {
    return `<div class="card" style="padding:14px">` +
      `<div style="font-size:10px;font-weight:700;color:${tint};text-transform:uppercase">${icon} ${esc(title)}</div>` +
      `<div style="font-size:17px;font-weight:800;margin:6px 0 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(stat.name)}</div>` +
      `<div style="font-size:12px;color:var(--muted);font-weight:600">${stat.partnerShifts} shift${stat.partnerShifts === 1 ? "" : "s"} · ${hoursText(stat.overlapHours)}</div></div>`;
  }

  function crewRowHTML(stat, rank) {
    const parts = [];
    if (stat.overlapHours >= 0.1) parts.push(`${hoursText(stat.overlapHours)} together`);
    if (stat.exactShifts > 0) parts.push(`same hours ${stat.exactShifts}×`);
    if (stat.closingShifts > 0) parts.push(`closed together ${stat.closingShifts}×`);
    if (stat.loggedDaysCount > 0) parts.push(`avg ${money(stat.avgRevenue)} sold`);
    const detail = parts.length ? parts.join(" · ") : "hours not recorded yet";
    return `<div class="list-item"><div style="display:flex;align-items:center;gap:12px;min-width:0">` +
      `<span style="width:18px;font-size:12px;font-weight:800;color:var(--muted)">${rank}</span>` +
      `<span style="width:34px;height:34px;border-radius:50%;background:var(--card2);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;color:var(--blue);flex-shrink:0">${esc(initials(stat.name))}</span>` +
      `<div class="li-main"><div style="font-weight:700">${esc(stat.name)}</div>` +
      `<div class="li-sub">${esc(detail)}</div></div></div>` +
      `<div class="li-val"><div style="font-weight:800;font-size:16px">${stat.partnerShifts}</div>` +
      `<div class="li-sub">${stat.partnerShifts === 1 ? "shift" : "shifts"}</div></div></div>`;
  }

  // ---- Stats sub-tab assembly ----

  function statsTabHTML() {
    const { days, table, premiumByDay } = state.data;
    const filtered = filterByRange(days, state.range, state.customStart, state.customEnd);
    const s = computeSummary(filtered, table, premiumByDay, state.range);
    state._summary = s;

    if (!filtered.length) {
      const msg = state.range === "custom"
        ? "Nothing logged in that range"
        : `Nothing logged for ${RANGE_TITLES[state.range].toLowerCase()}`;
      return emptyHTML("📊", msg, "Log some sales and this page fills up with your numbers.");
    }

    return totalsCardHTML(s) +
      trendsCardHTML(days, table) +
      highlightsHTML(s) +
      biggestTicketsHTML(s) +
      rankingHTML("Top 10 brands", "By units sold", s.topBrands) +
      rankingHTML("Top 10 products", "Your bread and butter", s.topProducts);
  }

  // ---------------------------------------------------------------------------
  // Main render + events
  // ---------------------------------------------------------------------------

  function subTabsHTML() {
    const tabs = [
      { id: "stats", label: "Stats" },
      { id: "crew", label: "Crew" },
    ];
    return `<div style="display:flex;gap:6px;margin-bottom:12px">` +
      tabs.map(t =>
        `<button class="btn${state.statsTab === t.id ? " primary" : " ghost"}" data-stab="${t.id}" ` +
        `style="flex:1;padding:8px;font-size:14px;font-weight:700">${t.label}</button>`
      ).join("") + `</div>`;
  }

  async function render(container) {
    if (!container) return;
    container.innerHTML = spinnerHTML("Loading stats…");
    try {
      await loadData();
    } catch (e) {
      container.innerHTML = emptyHTML("⚠️", "Couldn't load stats",
        (e && e.message) || "Check your connection and try again.");
      return;
    }
    paint(container);
  }

  function paint(container) {
    let html = subTabsHTML() + rangePickerHTML();
    html += state.statsTab === "crew" ? crewTabHTML() : statsTabHTML();
    container.innerHTML = html;
    bind(container);
  }

  function bind(container) {
    // Sub-tabs.
    container.querySelectorAll("[data-stab]").forEach(btn => {
      btn.addEventListener("click", () => {
        state.statsTab = btn.dataset.stab;
        paint(container);
      });
    });
    // Range presets.
    container.querySelectorAll("[data-range]").forEach(btn => {
      btn.addEventListener("click", () => {
        const r = btn.dataset.range;
        if (r === "custom") {
          state.showCustom = true;
          // Default the draft to this month → today.
          const now = new Date();
          const first = new Date(now.getFullYear(), now.getMonth(), 1);
          if (!state.customStart) state.customStart = toKey(first);
          if (!state.customEnd) state.customEnd = toKey(now);
        } else {
          state.showCustom = false;
        }
        state.range = r;
        paint(container);
      });
    });
    // Custom range controls.
    const customBtn = container.querySelector("#stats-custom-btn");
    if (customBtn) {
      customBtn.addEventListener("click", () => {
        state.showCustom = !state.showCustom;
        paint(container);
      });
    }
    const applyBtn = container.querySelector("#stats-custom-apply");
    if (applyBtn) {
      applyBtn.addEventListener("click", () => {
        const s = container.querySelector("#stats-custom-start");
        const e = container.querySelector("#stats-custom-end");
        if (s && s.value) state.customStart = s.value;
        if (e && e.value) state.customEnd = e.value;
        // Guard: start <= end.
        if (state.customStart && state.customEnd && state.customStart > state.customEnd) {
          const t = state.customStart;
          state.customStart = state.customEnd;
          state.customEnd = t;
        }
        state.range = "custom";
        state.showCustom = false;
        paint(container);
      });
    }
    // Trend metric switcher.
    container.querySelectorAll("[data-metric]").forEach(btn => {
      btn.addEventListener("click", () => {
        state.trendMetric = btn.dataset.metric;
        paint(container);
      });
    });
    // Tap-through to day detail (highlights + biggest tickets).
    container.querySelectorAll(".stats-highlight[data-day]").forEach(el => {
      el.addEventListener("click", () => {
        if (typeof onOpenDay === "function") onOpenDay(el.dataset.day);
      });
    });
  }

  // Public API.
  return {
    render,
    // Parent wiring: StatsUI.onOpenDay = (dayKey) => openDayDetail(dayKey);
    set onOpenDay(fn) { onOpenDay = fn; },
    get onOpenDay() { return onOpenDay; },
    // Exposed for testing / reuse.
    _computeSummary: computeSummary,
    _filterByRange: filterByRange,
    _crewStats: crewStats,
    _trendPoints: trendPoints,
    _state: state,
  };
})();
