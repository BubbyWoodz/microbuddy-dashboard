// Parity tests: dashboard JS vs the iOS Swift logic (vectors copied from
// MicroBuddyTests: MoneyMathTests, BrandAliasTests, TimeHandlingTests,
// ShiftIntegrityTests, BackupConflictTests). Run: node tests/parity.test.js
// Optional real-data check: MB_BACKUP=/path/backup.json node tests/parity.test.js
"use strict";
process.env.TZ = process.env.TZ || "America/Los_Angeles";
const fs = require("fs"), vm = require("vm"), path = require("path");
const root = path.join(__dirname, "..");
const ctx = vm.createContext({ console, Date, Math, JSON, Intl, setTimeout, clearTimeout,
  window: {}, navigator: { onLine: false }, document: { documentElement: { getAttribute() {}, setAttribute() {} }, getElementById() { return null; } },
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} }, crypto: require("crypto").webcrypto,
  self: { crypto: require("crypto").webcrypto } });
for (const f of ["brandaliases.js", "shiftmath.js", "payengine.js", "sb.js", "sync.js", "stats.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, f), "utf8") +
    "\n;for (const k of ['BrandAliases','ShiftMath','PayEngine','SB','AppDataSanitizer','SyncEngine','StatsUI','Stats']) { try { if (typeof eval(k) !== 'undefined') globalThis[k] = eval(k); } catch (e) {} }", ctx, { filename: f });
}
const { PayEngine: P, BrandAliases: B, ShiftMath: S, SyncEngine: E } = ctx;
let fails = 0, n = 0;
const ok = (name, cond, extra) => { n++; if (!cond) fails++; console.log((cond ? "PASS " : "FAIL ") + name + (cond || extra === undefined ? "" : " " + JSON.stringify(extra))); };
const close = (a, b) => Math.abs(a - b) < 1e-9;

// ---- Batch 15 money math ----
const gsa = P.gsaTable();
ok("9.995 stays 12%", P.commissionRate(gsa, 9.995, "inDepartment") === 0.12);
[[9.99, .12], [10, .06], [99.99, .06], [99.995, .06], [100, .03], [199.99, .03], [199.995, .03], [200, .02], [480, .02]]
  .forEach(([p, r]) => ok("bracket " + p, P.commissionRate(gsa, p, "inDepartment") === r));
ok("9.995 line commission", close(P.lineCommission({ unitPrice: 9.995, quantity: 1, kind: "inDepartment" }, gsa), 9.995 * 0.12));
ok("lunch <5h = 0", P.lunchMinutesFor(4, 30) === 0 && P.lunchMinutesFor(3, 45) === 0);
ok("lunch 11h+ = 90", P.lunchMinutesFor(11, 45) === 90 && P.lunchMinutesFor(12, 30) === 90);
ok("lunch default profile = 30", P.lunchMinutesFor(8, P.profileLunchDefault({})) === 30);
ok("lunch custom profile 45", P.lunchMinutesFor(8, P.profileLunchDefault({ defaultLunchMinutes: 45 })) === 45);

// ---- Batch 21 pay period display rule ----
const pd = P.payPeriodContaining("2026-10-02"); // payday
ok("payday shows the just-closed period", pd.start === "2026-09-18" && pd.end === "2026-10-01", pd);
ok("block(payday) starts that day", P.payPeriodBlock("2026-10-02").start === "2026-10-02");
ok("day after payday -> new block", P.payPeriodContaining("2026-10-03").start === "2026-10-02");
ok("next of closed period is the new block", P.nextPeriod(pd).start === "2026-10-02");

// ---- Batch 22 brand aliases ----
[["UniFi", "Ubiquiti"], [" UniFi ", "Ubiquiti"], ["UNIFI", "Ubiquiti"], ["UBIQUITI", "Ubiquiti"], ["ROG", "ASUS"], ["asus", "ASUS"],
 ["WD", "Western Digital"], ["MacBook", "Apple"], ["Surface", "Microsoft"], ["Xbox", "Microsoft"], ["Pixel", "Google"],
 ["Predator", "Acer"], ["TTGO", "LILYGO"], ["Soundcore", "Anker"], ["", ""], ["   ", ""], ["Alienware", "Alienware"], ["Beats", "Beats"], ["HyperX", "HyperX"]]
  .forEach(([a, b]) => ok("alias " + JSON.stringify(a), B.canonical(a) === b, B.canonical(a)));
ok("alias matches", B.matches("UniFi", "Ubiquiti") && !B.matches("Logitech", "Ubiquiti"));

// ---- Batch 16 time parsing ----
const T = S.TimeParse;
ok("9:00 p.m. = 1260", T.minutes("9:00 p.m.") === 1260);
ok("9:00 a.m. = 540", T.minutes("9:00 a.m.") === 540);
ok("p.m. not ambiguous", T.clock("9:00 p.m.").isAmbiguous === false);
const h = T.span("10:00 AM to 6:00 PM");
ok("span AM to PM", h.start.minutes === 600 && h.end.minutes === 1080 && !h.start.isAmbiguous);
const dt = T.span("10:00 a.m. – 6:00 p.m.");
ok("dotted span", dt && dt.start.minutes === 600 && dt.end.minutes === 1080);
ok("range minutes first half", T.minutes("10:00 AM to 6:00 PM") === 600);

// ---- Batch 29 shift integrity ----
const L = S.ShiftLedger;
const ukg = { id: "u1", start: "2026-10-12T17:00:00Z", end: "2026-10-13T01:00:00Z", isManual: false, coworkers: [] };
const man = { id: "m1", start: "2026-10-14T17:00:00Z", end: "2026-10-15T01:00:00Z", isManual: true, coworkers: [] };
ok("overlap guard finds clash", L.overlap("2026-10-12T20:00:00Z", "2026-10-12T22:00:00Z", [ukg]).id === "u1");
ok("overlap guard ignores self", L.overlap(ukg.start, ukg.end, [ukg], "u1") === null);
ok("overlap guard ignores tombstones", L.overlap(ukg.start, ukg.end, [Object.assign({}, ukg, { isRemoved: true })]) === null);
const eu = L.editUpdates(ukg, "2026-10-12T18:00:00Z", "2026-10-13T01:00:00Z");
ok("UKG edit -> actual hours", eu.actualStart === "2026-10-12T18:00:00Z" && !("start" in eu));
const em = L.editUpdates(man, "2026-10-14T18:00:00Z", "2026-10-15T01:00:00Z");
ok("manual edit rewrites own times", em.start === "2026-10-14T18:00:00Z" && em.actualStart === null);
ok("worked hours use actuals", close(S.hours(Object.assign({}, ukg, { actualStart: "2026-10-12T18:00:00Z" })), 7));
const now = new Date("2026-10-09T12:00:00Z");
const tomb = Object.assign({}, ukg, { isRemoved: true, ukgIdentifier: "u1" });
const m1 = L.merge([tomb], [{ id: "u1", start: ukg.start, end: ukg.end, title: "Shift", location: "" }], now);
ok("ICS pull cannot resurrect a tombstone", m1.length === 1 && m1[0].isRemoved === true, m1);
const ed = Object.assign({}, ukg, { actualStart: "2026-10-12T18:00:00Z", actualEnd: ukg.end, isEdited: true });
const m2 = L.merge([ed], [{ id: "u1", start: "2026-10-12T16:00:00Z", end: ukg.end, title: "S", location: "" }], now);
ok("ICS pull keeps actual hours, updates posted", m2.length === 1 && m2[0].actualStart === ed.actualStart && m2[0].start === "2026-10-12T16:00:00Z");
const m3 = L.merge([man], [{ id: "u9", start: man.start, end: man.end, title: "S", location: "" }], now);
ok("ICS echo of a manual shift: no duplicate active row", m3.filter(x => !x.isRemoved).length === 1, m3);
const m4 = L.merge([ukg], [], now);
ok("future untouched UKG shift dropped from feed is removed", m4.length === 0);
ok("payable hours skip tombstones", L.payableHours(S.shiftDayKey(ukg), [tomb]) === 0);

// ---- Batch 31 vault overlap / names ----
ok("legalName LAST, FIRST M.", S.legalName("RIVERA, ALEX M.") === "Alex Rivera");
ok("identity order-insensitive", S.identity("Rivera, Alex") === S.identity("Alex Rivera"));
const vshift = { id: "v", start: "2026-10-12T22:00:00Z", end: "2026-10-13T06:00:00Z", isManual: false, coworkers: [] }; // 3-11 PM PT
const hits = S.vaultOverlaps([{ name: "Alex Rivera", dateKey: "2026-10-12", start: "10:40 PM", end: "11:30 PM" }], [vshift]);
ok("vault: twenty minutes counts", hits.length === 1 && close(hits[0].hours, 20 / 60), hits);
ok("3-rule: exact", S.mirrorRule("3:00 PM", "11:00 PM", "3:00 PM", "11:00 PM") === "exact");
ok("3-rule: same end", S.mirrorRule("3:00 PM", "11:00 PM", "1:00 PM", "11:00 PM") === "same_end");
ok("3-rule: within hour", S.mirrorRule("3:00 PM", "11:00 PM", "3:30 PM", "10:30 PM") === "within_hour");
ok("3-rule: none", S.mirrorRule("3:00 PM", "11:00 PM", "9:00 AM", "5:00 PM") === null);

// ---- Batch 33 merge rules ----
const st = { conflicts: 0 };
const mg = E.merge3;
const base = { contacts: [{ id: "c", note: "x" }] };
ok("phone delete vs dashboard edit keeps edited record",
  mg(base, { contacts: [{ id: "c", note: "edited" }] }, { contacts: [] }, st).contacts.length === 1);
ok("dashboard delete vs phone edit keeps phone record",
  mg(base, { contacts: [] }, { contacts: [{ id: "c", note: "phone" }] }, st).contacts[0].note === "phone");
ok("delete vs unchanged deletes", mg(base, { contacts: [] }, base, st).contacts.length === 0);
const tk = mg({ t: [{ id: "A", p: "Cable", u: 9 }] }, { t: [{ id: "A", p: "Keyboard", u: 9 }] }, { t: [{ id: "B", p: "Cable", u: 9 }, { id: "A", p: "Cable", u: 25 }] }, st).t;
ok("field merge + order follows cloud", tk.map(x => x.id).join() === "B,A" && tk[1].p === "Keyboard" && tk[1].u === 25, tk);
ok("same field both changed -> phone wins", mg({ a: 1 }, { a: 2 }, { a: 3 }, st).a === 3);
ok("holiday adds union", JSON.stringify(mg({ h: ["2026-01-01"] }, { h: ["2026-01-01", "2026-07-04"] }, { h: ["2026-01-01", "2026-12-25"] }, st).h) === JSON.stringify(["2026-01-01", "2026-12-25", "2026-07-04"]));

// ---- Optional: real backup (read-only export) ----
if (process.env.MB_BACKUP) {
  const raw = JSON.parse(fs.readFileSync(process.env.MB_BACKUP, "utf8"));
  const data = raw.data || raw;
  const per = P.payPeriodBlock(process.env.MB_PERIOD || "2026-09-18");
  const days = (data.days || []).filter(d => P.periodContains(per, d.id));
  const table = P.tableForProfile(data.profile);
  let net = 0, ret = 0, cust = 0, com = 0;
  for (const d of days) for (const t of d.tickets || []) {
    if (!(t.lines || []).some(l => l.isExchange)) cust++;
    for (const l of t.lines || []) { const r = P.lineRevenue(l); net += r; if (l.isReturn) ret += -r; com += P.lineCommission(l, table); }
  }
  console.log("REAL period " + per.start + ".." + per.end + ": net " + net.toFixed(2) + ", returns " + ret.toFixed(2) + ", customers " + cust + ", commission " + com.toFixed(2));
  if (process.env.MB_EXPECT) {
    const e = JSON.parse(process.env.MB_EXPECT);
    if (e.net != null) ok("real net matches iOS", Math.abs(net - e.net) < 0.005, net);
    if (e.customers != null) ok("real customers match iOS", cust === e.customers, cust);
  }
}
console.log(fails ? `${fails}/${n} FAILED` : `ALL ${n} PASS`);
process.exit(fails ? 1 : 0);
