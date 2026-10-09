"use strict";
/* ============ badges.js — Badges view (port of BadgesView.swift) ============
 * Three shelves of single-day milestones: Money sold, Customers helped, Money
 * made. Days are scanned oldest-first so a badge always points at the FIRST
 * day that crossed it. Clicking an unlocked badge opens that day.
 * Data comes from the same blob the Stats view loaded (StatsUI state.data).
 * ========================================================================== */
const BadgesUI = (() => {
  const range = (from, through, by) => { const a = []; for (let v = from; v <= through; v += by) a.push(v); return a; };

  const CATEGORIES = [
    { id: "revenue", title: "Money sold", subtitle: "Sold for the company in one day",
      icon: "cash", tint: "var(--amber)", thresholds: range(500, 20000, 500) },
    { id: "cph", title: "Customers helped", subtitle: "Customers helped in one day",
      icon: "users", tint: "var(--navy-bright)", thresholds: [1].concat(range(5, 50, 5)) },
    { id: "commission", title: "Money made", subtitle: "Taken home in one day",
      icon: "cash", tint: "var(--money)", thresholds: range(50, 3000, 50) },
  ];

  const I = (n, o) => (typeof Icon === "function" ? Icon(n, o) : "");

  function badgeValue(cat, t) {
    if (cat.id === "cph") return String(t);
    if (t >= 1000) return "$" + (t % 1000 === 0 ? (t / 1000) + "K" : (t / 1000).toFixed(1) + "K");
    return "$" + t;
  }

  function valueOf(cat, day, table) {
    if (cat.id === "revenue") return StatsUI._dayRevenue(day);
    if (cat.id === "cph") return StatsUI._dayCustomerCount(day);
    return PayEngine.dayCommission(day, table);
  }

  function tiers(cat, days, table) {
    const sorted = days.slice().sort((a, b) => String(StatsUI._dayKeyOf(a)) < String(StatsUI._dayKeyOf(b)) ? -1 : 1);
    const vals = sorted.map(d => valueOf(cat, d, table));
    return cat.thresholds.map(t => {
      const i = vals.findIndex(v => v >= t);
      return { threshold: t, day: i >= 0 ? sorted[i] : null };
    });
  }

  function focusIndex(list) {
    let best = -1;
    list.forEach((t, i) => {
      if (!t.day) return;
      if (best < 0) { best = i; return; }
      const a = StatsUI._dayKeyOf(t.day), b = StatsUI._dayKeyOf(list[best].day);
      if (a > b || (a === b && t.threshold >= list[best].threshold)) best = i;
    });
    return best;
  }

  function mediumDay(key) {
    const d = PayEngine.parseKey(key);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  function render(el, data, opts) {
    if (!el) return;
    const days = ((data && data.days) || []).filter(d => !PayEngine.isEmptyDay(d));
    const table = data && data.table;
    if (!days.length) {
      el.innerHTML = `<div class="panel"><div class="empty-state"><div class="empty-ico">${I("award", { size: 32 })}</div>` +
        `<div class="t">No badges yet</div><p>Log a day of sales and your first badges land on these shelves.</p></div></div>`;
      return;
    }
    const shelves = CATEGORIES.map(c => ({ cat: c, list: tiers(c, days, table) }));
    const unlocked = shelves.reduce((s, x) => s + x.list.filter(t => t.day).length, 0);
    const total = shelves.reduce((s, x) => s + x.list.length, 0);

    let html = `<div class="grid">` +
      `<div class="panel col-12"><div class="sec-head" style="margin:0">` +
      `<span class="avatar" style="width:46px;height:46px;background:var(--accent);color:var(--on-accent)">${I("award", { size: 22 })}</span>` +
      `<div class="grow"><div class="sec-title">${unlocked} of ${total} badges</div>` +
      `<div class="sec-sub">Every badge is one day's milestone — the shelves fill themselves as you log.</div></div>` +
      shelves.map(s => {
        const n = s.list.filter(t => t.day).length;
        return `<span class="chip" style="color:${s.cat.tint}">${I(s.cat.icon, { size: 14 })}${esc(s.cat.title)} ${n}/${s.list.length}</span>`;
      }).join("") +
      `</div></div>`;

    for (const s of shelves) {
      const n = s.list.filter(t => t.day).length;
      html += `<div class="panel col-12 badge-shelf"><div class="sec-head"><div class="grow">` +
        `<div class="sec-title">${esc(s.cat.title)}</div>` +
        `<div class="sec-sub">${esc(s.cat.subtitle)} · ${n} of ${s.list.length} unlocked</div></div>` +
        `<button class="icon-btn" data-scroll="-1" data-shelf="${s.cat.id}" aria-label="Scroll left">${I("chevron-left")}</button>` +
        `<button class="icon-btn" data-scroll="1" data-shelf="${s.cat.id}" aria-label="Scroll right">${I("chevron-right")}</button></div>` +
        `<div class="badge-row" id="shelf-${s.cat.id}" data-focus="${focusIndex(s.list)}">` +
        s.list.map(t => {
          const key = t.day ? StatsUI._dayKeyOf(t.day) : "";
          const coin = `<div class="badge-coin${t.day ? "" : " locked"}" style="${t.day ? `background:linear-gradient(135deg, ${s.cat.tint}, color-mix(in srgb, ${s.cat.tint} 70%, transparent))` : ""};flex-direction:column;gap:2px">` +
            `${I(s.cat.icon, { size: 13 })}<span>${esc(badgeValue(s.cat, t.threshold))}</span></div>`;
          const label = `<div class="badge-date">${t.day ? esc(mediumDay(key)) : "Locked"}</div>`;
          return t.day
            ? `<button class="badge-tile" data-day="${esc(key)}" title="${esc(s.cat.title)} ${esc(badgeValue(s.cat, t.threshold))} — open day" style="background:none;border:0;cursor:pointer;color:inherit">${coin}${label}</button>`
            : `<div class="badge-tile" style="opacity:.85">${coin}${label}</div>`;
        }).join("") +
        `</div><div class="shelf-board"></div></div>`;
    }
    el.innerHTML = html + `</div>`;

    el.querySelectorAll(".badge-tile[data-day]").forEach(b => b.addEventListener("click", () => {
      const fn = opts && opts.onOpenDay;
      if (typeof fn === "function") fn(b.dataset.day);
    }));
    el.querySelectorAll("[data-scroll]").forEach(b => b.addEventListener("click", () => {
      const row = el.querySelector("#shelf-" + b.dataset.shelf);
      if (row) row.scrollBy({ left: Number(b.dataset.scroll) * row.clientWidth * 0.8, behavior: "smooth" });
    }));
    // Center each shelf on its most recent unlock (like the iOS shelf glide).
    el.querySelectorAll(".badge-row").forEach(row => {
      const i = Number(row.dataset.focus);
      if (i < 0) return;
      const tile = row.children[i];
      if (tile) row.scrollLeft = Math.max(0, tile.offsetLeft - row.offsetLeft - row.clientWidth / 2 + tile.clientWidth / 2);
    });
  }

  return { render, CATEGORIES, _tiers: tiers };
})();
