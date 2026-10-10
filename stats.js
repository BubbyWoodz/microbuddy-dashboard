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

  // Shift math lives in shiftmath.js (exact iOS Shift.swift port: worked
  // hours, meridiem-aware resolvedBounds, removal tombstones).
  const overlapHours = (shift, cw) => ShiftMath.overlapHours(shift, cw);
  const shiftHours = shift => ShiftMath.hours(shift);
  const isExactShift = (shift, cw) => ShiftMath.isExactShift(shift, cw);
  const closesWith = (shift, cw) => ShiftMath.closesWith(shift, cw);

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
    // SaleTicket.itemCount: returns, exchanges and service plans excluded.
    return allLines(day).reduce((s, l) => s + ((l.isReturn || l.isExchange || l.kind === "servicePlan") ? 0 : (l.quantity || 0)), 0);
  }

  function dayPlansSold(day) {
    return allLines(day).reduce((s, l) =>
      s + ((!l.isReturn && !l.isExchange && l.kind === "servicePlan") ? (l.quantity || 0) : 0), 0);
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
        // Brand rankings fold product lines into the parent (iOS StatsEngine.rankingKey).
        const folded = (by === "brand" && raw && typeof BrandAliases !== "undefined") ? BrandAliases.canonical(raw) : raw;
        const key = folded ? folded : "Unlabeled";
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
    // primary/secondary are formatters — call them with the day so the card
    // shows the value (it used to print the function source).
    const add = (id, title, day, primary, secondary) => {
      if (!day) return;
      const val = f => (typeof f === "function" ? f(day) : f);
      result.push({
        id, title, dayKey: dayKeyOf(day),
        date: parseKey(dayKeyOf(day)), primary: val(primary), secondary: val(secondary),
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
      if (shift.isRemoved) return false; // removal tombstone
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

    // Port of CrewStats.stats (Batch 31): the private schedule vault gives
    // real overlap hours. A vault row with times is the schedule of record
    // for that person+day, so the hand-added list can't double count it.
    const vault = (state.data && state.data.vault) || [];
    const vaultHits = ShiftMath.vaultOverlaps(vault, filtered);
    const timedVaultDays = ShiftMath.vaultTimedKeys(vault, filtered);
    const newStat = name => ({
      name, partnerShifts: 0, briefShifts: 0, overlapHours: 0, briefOverlapHours: 0,
      exactShifts: 0, closingShifts: 0, dayKeys: {},
    });
    const buckets = {};
    for (const shift of filtered) {
      const hrs = shiftHours(shift);
      const dk = ShiftMath.shiftDayKey(shift);
      for (const member of (shift.coworkers || [])) {
        const mObj = typeof member === "string" ? { name: member } : member;
        const rawName = String(mObj.name || "").trim();
        if (!rawName) continue;
        const key = ShiftMath.identity(rawName);
        if (timedVaultDays.has(key + "|" + dk)) continue;
        const stat = buckets[key] || newStat(ShiftMath.displayName(rawName) || rawName);
        const overlap = overlapHours(shift, mObj);
        // Under half your shift alongside them = brief, never a partner stat.
        // Unknown hours still count as partners.
        const isBrief = overlap != null && hrs > 0 && overlap < hrs * 0.5;
        if (isBrief) {
          stat.briefShifts += 1;
          stat.briefOverlapHours += overlap || 0;
        } else {
          stat.partnerShifts += 1;
          if (overlap != null) stat.overlapHours += overlap;
          if (isExactShift(shift, mObj)) stat.exactShifts += 1;
          if (closesWith(shift, mObj)) stat.closingShifts += 1;
          if (dk) stat.dayKeys[dk] = true;
        }
        buckets[key] = stat;
      }
    }
    for (const hit of vaultHits) {
      const stat = buckets[hit.identity] || newStat(hit.name);
      if (stat.name.split(" ").length < hit.name.split(" ").length) stat.name = hit.name;
      // Vault overlap always counts, even twenty minutes.
      stat.partnerShifts += 1;
      stat.overlapHours += hit.hours;
      if (isExactShift(hit.shift, hit.coworker)) stat.exactShifts += 1;
      if (closesWith(hit.shift, hit.coworker)) stat.closingShifts += 1;
      stat.dayKeys[hit.dateKey] = true;
      buckets[hit.identity] = stat;
    }
    const list = Object.values(buckets);
    if (!list.length) return [];

    const daysByID = {};
    for (const d of (days || [])) daysByID[dayKeyOf(d)] = d;

    for (const stat of list) {
      const keys = Object.keys(stat.dayKeys);
      stat.dayKeyList = keys;
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

  function crewAvatar(name, size) {
    if (window.CoworkersUI && CoworkersUI.avatarForName) return CoworkersUI.avatarForName(name, size);
    return `<span class="avatar initials" style="width:${size}px;height:${size}px">${esc(initials(name))}</span>`;
  }

  function initials(name) {
    const words = String(name).split(" ").filter(Boolean);
    return words.slice(0, 2).map(w => w[0]).join("").toUpperCase();
  }

  // ---------------------------------------------------------------------------
  // UI state + rendering (desktop: one switcher, one range picker, 12-col grid)
  // ---------------------------------------------------------------------------

  const TABS = [
    { id: "stats", label: "Stats", icon: "bars" },
    { id: "crew", label: "Crew", icon: "users" },
    { id: "badges", label: "Badges", icon: "medal" },
    { id: "leaderboard", label: "Leaderboard", icon: "trophy" },
  ];

  const state = {
    range: "month",
    statsTab: "stats", // "stats" | "crew" | "badges" | "leaderboard"
    customStart: null,
    customEnd: null,
    trendMetric: "commission", // "commission" | "revenue" | "items"
    data: null, // { days, shifts, profile, table, premiumByDay }
  };

  let onOpenDay = null;
  let lastContainer = null;

  const I = (name, opts) => (typeof Icon === "function" ? Icon(name, opts) : "");

  function rangeLabel() {
    if (state.range !== "custom") return RANGE_TITLES[state.range];
    if (state.customStart && state.customEnd) {
      if (state.customStart === state.customEnd) return fmtMonthDay(parseKey(state.customStart));
      return `${fmtMonthDay(parseKey(state.customStart))} – ${fmtMonthDay(parseKey(state.customEnd))}`;
    }
    return "Custom";
  }

  async function loadData() {
    const backup = await SyncEngine.getLocalBackup();
    const data = (backup && backup.data) || {};
    const profile = data.profile || {};
    const table = PayEngine.tableForProfile(profile);
    const shifts = (data.shifts || []).filter(s => s && !s.isRemoved);
    const premiumByDay = PayEngine.premiumsByDay(shifts, data.holidayDates || []);
    state.data = { days: data.days || [], shifts, profile, table, premiumByDay,
      vault: Array.isArray(data.scheduleVault) ? data.scheduleVault : [] };
  }

  function spinnerHTML(msg) { return `<div class="spinner">${esc(msg || "Loading stats…")}</div>`; }

  function emptyHTML(icon, title, message) {
    return `<div class="panel"><div class="empty-state"><div class="empty-ico">${I(icon, { size: 32 })}</div>` +
      `<div class="t">${esc(title)}</div><p>${esc(message)}</p></div></div>`;
  }

  function compactMoney(n) {
    const v = Number(n) || 0;
    const abs = Math.abs(v);
    const sign = v < 0 ? "-" : "";
    if (abs >= 1000000) return `${sign}$${(abs / 1000000).toFixed(1)}M`;
    if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(1)}k`;
    return money(v);
  }

  // ---- Header: switcher + range picker ----
  function headHTML() {
    const seg = `<div class="segmented" role="tablist">` + TABS.map(t =>
      `<button data-stab="${t.id}" class="${state.statsTab === t.id ? "active" : ""}" role="tab">` +
      `${I(t.icon, { size: 16 })}<span>${t.label}</span></button>`).join("") + `</div>`;
    const showRange = state.statsTab === "stats" || state.statsTab === "crew";
    let range = "";
    if (showRange) {
      range = `<div class="range-picker panel tight">` +
        `<div><div class="label">Showing</div></div>` +
        `<select id="stats-range" aria-label="Showing">` +
        RANGES.map(r => `<option value="${r}"${state.range === r ? " selected" : ""}>${r === "custom" && state.range === "custom" ? esc(rangeLabel()) : RANGE_TITLES[r]}</option>`).join("") +
        `</select>` +
        (state.range === "custom"
          ? `<input type="date" id="stats-custom-start" value="${esc(state.customStart || "")}" aria-label="From">` +
            `<span class="muted">to</span>` +
            `<input type="date" id="stats-custom-end" value="${esc(state.customEnd || "")}" aria-label="To">`
          : "") +
        `</div>`;
    }
    return `<div class="page-head"><div><h2>Stats</h2>` +
      `<div class="page-sub">${state.statsTab === "badges" ? "Every badge is one day's milestone" :
        state.statsTab === "leaderboard" ? "You and your friends, side by side" : esc(rangeLabel())}</div></div>` +
      `<div class="spacer"></div>${seg}${range}</div>`;
  }

  // ---- Stats tab ----
  function tile(label, value, color) {
    return `<div class="tile"><div class="v" style="color:${color}">${value}</div><div class="l">${esc(label)}</div></div>`;
  }

  function totalsCardHTML(s) {
    const neg = s.commission < -0.005;
    let html = `<div class="panel col-5">` +
      `<div class="label">Commission earned</div>` +
      `<div class="hero-num lg ${neg ? "red" : "money"}" style="margin:4px 0 2px">${money(s.commission)}</div>` +
      `<div class="caption">${s.days.length} day${s.days.length === 1 ? "" : "s"} · ${s.hours.toFixed(1)} hrs worked</div>` +
      `<div class="tiles c3" style="margin-top:16px">` +
      tile("Money sold", compactMoney(s.revenue), "var(--text-primary)") +
      tile("Commission / hr", money(s.commissionPerHour), "var(--amber)") +
      tile("Items sold", num(s.items), "var(--navy-bright)") +
      tile("Avg ticket", compactMoney(s.averageTicket), "var(--money-text)") +
      tile("CPH", s.hours > 0 ? s.customersPerHour.toFixed(1) : "—", "var(--amber)") +
      tile("Customers", num(s.ticketCount), "var(--money-text)") +
      `</div>`;
    if (s.hours > 0) {
      html += `<div style="margin-top:14px">`;
      if (s.basePay > 0.005) html += payRow("Base pay", `$${PayEngine.BASE_HOURLY_RATE.toFixed(2)}/hr open hours`, money(s.basePay));
      if (s.premiumHours > 0) html += payRow("Min-wage premium", `${s.premiumHours.toFixed(1)} hrs × $${PayEngine.MINIMUM_WAGE.toFixed(2)}`, money(s.premiumPay));
      if (s.overtimePay > 0.005) html += payRow("Overtime", "CA daily ×1.5 / ×2 min wage", money(s.overtimePay));
      html += `<div class="kv-row total"><span class="k">Total pay</span><span class="v">${money(s.totalPay)}</span></div></div>`;
    }
    if (s.returnsTotal > 0.005) {
      html += `<div class="kv-row"><span class="k muted">${I("return", { size: 16 })} Returns in this range</span><span class="v red">-${money(s.returnsTotal)}</span></div>`;
    }
    return html + `</div>`;
  }

  function payRow(label, detail, value) {
    return `<div class="kv-row"><span class="k">${esc(label)}</span><span class="sub">${esc(detail)}</span>` +
      `<span class="v money">${value}</span></div>`;
  }

  function trendsCardHTML(days, table) {
    const points = trendPoints(days, state.range, table, state.customStart, state.customEnd);
    const metrics = [
      { id: "commission", label: "Commission" },
      { id: "revenue", label: "Money sold" },
      { id: "items", label: "Items" },
    ];
    const unit = state.range === "today" ? "sale" : (state.range === "year" || state.range === "all") ? "month" : "day";
    const metricLabel = metrics.find(m => m.id === state.trendMetric).label;
    let html = `<div class="panel col-7"><div class="sec-head"><div class="grow">` +
      `<div class="sec-title">Trends</div><div class="sec-sub">${esc(metricLabel)} per ${unit}</div></div>` +
      `<div class="segmented">` + metrics.map(m =>
        `<button data-metric="${m.id}" class="${state.trendMetric === m.id ? "active" : ""}">${m.label}</button>`).join("") +
      `</div></div>`;
    html += points.length
      ? `<div class="chart-box">${barChartSVG(points, state.trendMetric)}</div>`
      : `<div class="empty">Nothing to chart for this range yet.</div>`;
    return html + `</div>`;
  }

  function barChartSVG(points, metric) {
    const W = 860, H = 300, PAD_L = 52, PAD_R = 12, PAD_T = 14, PAD_B = 30;
    const vals = points.map(p => metric === "items" ? p.items : p[metric]);
    const maxV = Math.max(...vals, 0.01);
    const minV = Math.min(...vals, 0);
    const span = maxV - minV || 1;
    const n = points.length;
    const plotH = H - PAD_T - PAD_B;
    const slotW = (W - PAD_L - PAD_R) / n;
    const barW = Math.max(3, Math.min(42, slotW * 0.62));
    const y0 = PAD_T + plotH * (maxV / span);
    const fmt = v => metric === "items" ? num(Math.round(v)) : compactMoney(v);
    let grid = "";
    for (let g = 0; g <= 4; g++) {
      const v = minV + span * (g / 4);
      const y = PAD_T + plotH - plotH * (g / 4);
      grid += `<line x1="${PAD_L}" x2="${W - PAD_R}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--hairline)" stroke-width="1"/>` +
        `<text x="${PAD_L - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--text-secondary)">${esc(fmt(v))}</text>`;
    }
    let bars = "", labels = "";
    const labelStep = Math.max(1, Math.ceil(n / 14));
    const fill = metric === "commission" ? "var(--money)" : metric === "revenue" ? "var(--accent)" : "var(--navy-bright)";
    points.forEach((p, i) => {
      const v = vals[i];
      const h = Math.max(2, Math.abs(v) / span * plotH);
      const x = PAD_L + slotW * i + (slotW - barW) / 2;
      const y = v >= 0 ? y0 - h : y0;
      bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="${Math.min(4, barW / 3).toFixed(1)}" ` +
        `fill="${v < 0 ? "var(--red)" : fill}" opacity="0.9"><title>${esc(p.label)}: ${esc(metric === "items" ? num(v) : money(v))}</title></rect>`;
      if (i % labelStep === 0) {
        const lx = PAD_L + slotW * i + slotW / 2;
        labels += `<text x="${lx.toFixed(1)}" y="${H - 9}" text-anchor="middle" font-size="11" fill="var(--text-secondary)">${esc(shortLabel(p.label))}</text>`;
      }
    });
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Trend chart">${grid}${bars}${labels}</svg>`;
  }

  function shortLabel(label) {
    const m = String(label).match(/(\d{1,2}\/\d{1,2})/);
    if (m) return m[1];
    const tm = String(label).match(/(\d{1,2}:\d{2})\s*([AP])M/i);
    if (tm) return tm[1] + tm[2].toLowerCase();
    return String(label).slice(0, 6);
  }

  const HIGHLIGHT_ICONS = {
    best: "crown", money: "tag", items: "box", "cph-high": "zap", "cph-low": "trend",
    "cph-customers": "users", "short-money": "hourglass", "short-comm": "sparkles",
    "long-money": "clock", "long-comm": "moon",
  };

  function highlightsHTML(s) {
    if (state.range === "today" || !s.highlights.length) return "";
    let html = `<div class="panel col-12"><div class="sec-head"><div class="grow"><div class="sec-title">Standout days</div>` +
      `<div class="sec-sub">The days worth remembering</div></div></div><div class="tiles" style="grid-template-columns:repeat(auto-fill,minmax(190px,1fr))">`;
    for (const h of s.highlights) {
      const tint = h.id === "cph-low" || h.id.startsWith("long") ? "var(--text-secondary)" : "var(--amber)";
      html += `<button class="tile left stats-highlight" data-day="${esc(h.dayKey)}" style="cursor:pointer;color:inherit;font:inherit">` +
        `<div class="t" style="color:${tint}">${I(HIGHLIGHT_ICONS[h.id] || "star", { size: 14 })}${esc(h.title)}</div>` +
        `<div class="big">${esc(h.primary)}</div><div class="c">${esc(h.secondary)}</div></button>`;
    }
    if (s.offDayCount > 0) {
      html += `<div class="tile left"><div class="t">${I("moon", { size: 14 })}Sold on days off</div>` +
        `<div class="big">${money(s.offDayRevenue)}</div><div class="c">across ${s.offDayCount} day${s.offDayCount === 1 ? "" : "s"} off</div></div>`;
      if (s.offDayReturns > 0.005) {
        html += `<div class="tile left"><div class="t">${I("return", { size: 14 })}Returned on days off</div>` +
          `<div class="big red">-${money(s.offDayReturns)}</div><div class="c">across ${s.offDayCount} day${s.offDayCount === 1 ? "" : "s"} off</div></div>`;
      }
    }
    return html + `</div></div>`;
  }

  function biggestTicketsHTML(s) {
    const bm = s.biggestTicketByMoney, bi = s.biggestTicketByItems;
    let html = `<div class="panel col-4"><div class="sec-head"><div class="grow"><div class="sec-title">Biggest sales</div>` +
      `<div class="sec-sub">Single tickets that carried you</div></div></div><div class="tiles c2">`;
    const t = (title, icon, value, caption, dayKey) =>
      `<button class="tile left stats-highlight" data-day="${esc(dayKey)}" style="cursor:pointer;color:inherit;font:inherit">` +
      `<div class="t">${I(icon, { size: 14 })}${esc(title)}</div><div class="big money" style="font-size:22px">${esc(value)}</div>` +
      `<div class="c">${esc(caption)}</div></button>`;
    if (bm) html += t("Biggest sale (money)", "tag", compactMoney(ticketRevenue(bm.ticket)),
      `${fmtDayOnly(parseKey(dayKeyOf(bm.day)))} · ${ticketItemCount(bm.ticket)} items`, dayKeyOf(bm.day));
    if (bi) html += t("Most items in one sale", "box", num(ticketItemCount(bi.ticket)),
      `${fmtDayOnly(parseKey(dayKeyOf(bi.day)))} · ${compactMoney(ticketRevenue(bi.ticket))}`, dayKeyOf(bi.day));
    if (!bm && !bi) html += `<div class="empty">No tickets in this range.</div>`;
    return html + `</div></div>`;
  }

  function rankingHTML(title, subtitle, items) {
    let html = `<div class="panel col-4"><div class="sec-head"><div class="grow"><div class="sec-title">${esc(title)}</div>` +
      `<div class="sec-sub">${esc(subtitle)}</div></div></div>`;
    if (!items.length) return html + `<div class="empty">Nothing yet — log some sales to build this list.</div></div>`;
    const peak = Math.max(...items.map(i => i.count), 1);
    html += `<div class="rank-list">`;
    items.forEach((item, idx) => {
      const frac = peak > 0 ? Math.max(0.02, item.count / peak) : 0;
      html += `<div class="rank"><span class="n${idx < 3 ? " top" : ""}">${idx + 1}</span>` +
        `<span class="name" title="${esc(item.name)}">${esc(item.name)}</span>` +
        `<span class="val">${num(item.count)} <span class="muted" style="font-weight:600">· ${compactMoney(item.value)}</span></span>` +
        `<div class="bar"><i style="width:${(frac * 100).toFixed(1)}%;${idx < 3 ? "" : "background:var(--navy-bright);opacity:.7"}"></i></div></div>`;
    });
    return html + `</div></div>`;
  }

  function statsTabHTML() {
    const { days, table, premiumByDay } = state.data;
    const filtered = filterByRange(days, state.range, state.customStart, state.customEnd);
    const s = computeSummary(filtered, table, premiumByDay, state.range);
    state._summary = s;
    if (!filtered.length) {
      const msg = state.range === "custom" ? "Nothing logged in that range" : `Nothing logged for ${RANGE_TITLES[state.range].toLowerCase()}`;
      return emptyHTML("chart", msg, "Log some sales and this page fills up with your numbers.");
    }
    return `<div class="grid">` +
      totalsCardHTML(s) + trendsCardHTML(days, table) + highlightsHTML(s) +
      biggestTicketsHTML(s) +
      rankingHTML("Top 10 brands", "By units sold", s.topBrands) +
      rankingHTML("Top 10 products", "Your bread and butter", s.topProducts) +
      `</div>`;
  }

  // ---- Crew tab ----
  function crewTabHTML() {
    const { shifts, days, table } = state.data;
    const list = crewStats(shifts, days, table, state.range, state.customStart, state.customEnd);
    const partners = list.filter(s => s.partnerShifts > 0);
    const brief = list.filter(s => s.partnerShifts === 0 && s.briefShifts > 0)
      .sort((a, b) => a.briefShifts === b.briefShifts ? b.briefOverlapHours - a.briefOverlapHours : b.briefShifts - a.briefShifts);
    if (!partners.length && !brief.length) {
      return emptyHTML("users", `No crew logged for ${rangeLabel().toLowerCase()}`, "Add who's working to a shift and this page fills up.");
    }
    let html = `<div class="grid">`;
    if (partners.length) {
      const most = partners[0], least = partners[partners.length - 1];
      html += crewSuperCard("Most time with", "crown", "var(--amber)", most) +
        crewSuperCard("Least often", "users", "var(--navy-bright)", least) +
        `<div class="panel col-4"><div class="label">Crew size</div><div class="hero-num md">${partners.length}</div>` +
        `<div class="caption">${partners.length === 1 ? "person" : "people"} worked with · ${rangeLabel()}</div></div>`;
      html += `<div class="panel col-8"><div class="sec-head"><div class="grow"><div class="sec-title">Everyone</div>` +
        `<div class="sec-sub">${partners.length} ${partners.length === 1 ? "person" : "people"} worked with, ranked by shifts together</div></div></div>` +
        `<div class="list">` + partners.map((s, i) => crewRowHTML(s, i + 1)).join("") + `</div></div>`;
    }
    html += `<div class="panel ${partners.length ? "col-4" : "col-12"}"><div class="sec-head"><div class="grow"><div class="sec-title">Brief overlaps</div>` +
      `<div class="sec-sub">On the roster but under half your shift — not counted in Everyone</div></div></div>`;
    if (!brief.length) html += `<div class="empty">No brief overlaps.</div>`;
    for (const s of brief) {
      html += `<div class="list-item">${crewAvatar(s.name, 34)}` +
        `<div class="li-main">${esc(s.name)}<div class="li-sub">${hoursText(s.briefOverlapHours)} total overlap</div></div>` +
        `<div class="li-val">${s.briefShifts}<div class="li-sub">${s.briefShifts === 1 ? "shift" : "shifts"}</div></div></div>`;
    }
    return html + `</div></div>`;
  }

  function crewSuperCard(title, icon, tint, stat) {
    return `<div class="panel col-4"><div class="label" style="color:${tint}">${I(icon, { size: 14 })} ${esc(title)}</div>` +
      `<div class="hero-num md" style="overflow-wrap:anywhere">${esc(stat.name)}</div>` +
      `<div class="caption">${esc(superDetail(stat))}</div></div>`;
  }

  /// CrewStats.overlapCaption: "1h on Tue" for a single shared day, else "8h together".
  // CrewStatsView.superDetail
  function superDetail(stat) {
    const caption = overlapCaption(stat);
    if (Object.keys(stat.dayKeys || {}).length === 1 && caption) return caption;
    const shifts = stat.partnerShifts + " shift" + (stat.partnerShifts === 1 ? "" : "s");
    return caption ? shifts + " · " + caption : shifts;
  }
  function overlapCaption(stat) {
    if (!(stat.overlapHours > 0)) return "";
    const h = hoursText(stat.overlapHours);
    const keys = stat.dayKeyList || [];
    if (keys.length === 1) {
      const d = new Date(keys[0] + "T12:00:00");
      if (!isNaN(d)) return h + " on " + d.toLocaleDateString("en-US", { weekday: "short" });
    }
    return h + " together";
  }

  function crewRowHTML(stat, rank) {
    const parts = [];
    if (stat.overlapHours > 0) parts.push(overlapCaption(stat));
    if (stat.exactShifts > 0) parts.push(`same hours ${stat.exactShifts}×`);
    if (stat.closingShifts > 0) parts.push(`closed together ${stat.closingShifts}×`);
    if (stat.loggedDaysCount > 0) parts.push(`avg ${money(stat.avgRevenue)} sold`);
    const detail = parts.length ? parts.join(" · ") : "hours not recorded yet";
    return `<div class="list-item"><span class="muted" style="width:20px;text-align:right;font-weight:800;font-size:12px">${rank}</span>` +
      `${crewAvatar(stat.name, 36)}` +
      `<div class="li-main">${esc(stat.name)}<div class="li-sub">${esc(detail)}</div></div>` +
      `<div class="li-val" style="font-size:17px">${stat.partnerShifts}<div class="li-sub">${stat.partnerShifts === 1 ? "shift" : "shifts"}</div></div></div>`;
  }

  // ---- Main render + events ----
  async function render(container) {
    if (!container) return;
    lastContainer = container;
    container.innerHTML = spinnerHTML("Loading stats…");
    try { await loadData(); }
    catch (e) {
      container.innerHTML = emptyHTML("alert", "Couldn't load stats", (e && e.message) || "Check your connection and try again.");
      return;
    }
    paint(container);
  }

  function paint(container) {
    let body;
    if (state.statsTab === "crew") body = crewTabHTML();
    else if (state.statsTab === "badges") body = `<div id="badges-host"></div>`;
    else if (state.statsTab === "leaderboard") body = `<div id="leaderboard-body">${spinnerHTML("Loading leaderboard…")}</div>`;
    else body = statsTabHTML();
    container.innerHTML = headHTML() + body;
    if (state.statsTab === "badges" && typeof BadgesUI !== "undefined") {
      BadgesUI.render(container.querySelector("#badges-host"), state.data, { onOpenDay });
    }
    if (state.statsTab === "leaderboard" && typeof LeaderboardUI !== "undefined") {
      try { LeaderboardUI.open(container.querySelector("#leaderboard-body")); }
      catch (e) { container.querySelector("#leaderboard-body").innerHTML = emptyHTML("alert", "Couldn't load the leaderboard", e.message || ""); }
    }
    bind(container);
  }

  function bind(container) {
    container.querySelectorAll("[data-stab]").forEach(btn => {
      btn.addEventListener("click", () => { state.statsTab = btn.dataset.stab; paint(container); });
    });
    const sel = container.querySelector("#stats-range");
    if (sel) sel.addEventListener("change", () => {
      state.range = sel.value;
      if (state.range === "custom") {
        const now = new Date();
        if (!state.customStart) state.customStart = toKey(new Date(now.getFullYear(), now.getMonth(), 1));
        if (!state.customEnd) state.customEnd = toKey(now);
      }
      paint(container);
    });
    ["#stats-custom-start", "#stats-custom-end"].forEach(id => {
      const el = container.querySelector(id);
      if (!el) return;
      el.addEventListener("change", () => {
        const s = container.querySelector("#stats-custom-start"), e = container.querySelector("#stats-custom-end");
        if (s.value) state.customStart = s.value;
        if (e.value) state.customEnd = e.value;
        if (state.customStart && state.customEnd && state.customStart > state.customEnd) {
          const t = state.customStart; state.customStart = state.customEnd; state.customEnd = t;
        }
        paint(container);
      });
    });
    container.querySelectorAll("[data-metric]").forEach(btn => {
      btn.addEventListener("click", () => { state.trendMetric = btn.dataset.metric; paint(container); });
    });
    container.querySelectorAll(".stats-highlight[data-day]").forEach(el => {
      el.addEventListener("click", () => { if (typeof onOpenDay === "function") onOpenDay(el.dataset.day); });
    });
  }

  async function refresh() { if (lastContainer) await render(lastContainer); }
  function setTab(tab) { state.statsTab = tab; if (lastContainer && state.data) paint(lastContainer); }

  return {
    render, refresh, setTab,
    set onOpenDay(fn) { onOpenDay = fn; },
    get onOpenDay() { return onOpenDay; },
    _computeSummary: computeSummary,
    _filterByRange: filterByRange,
    _crewStats: crewStats,
    _trendPoints: trendPoints,
    _state: state,
    _compactMoney: compactMoney,
    _dayRevenue: dayRevenue,
    _dayCustomerCount: dayCustomerCount,
    _dayItemsSold: dayItemsSold,
    _dayKeyOf: dayKeyOf,
  };
})();
