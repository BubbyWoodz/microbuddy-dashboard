// Theme id mapping tests: phone ThemePreference raw values <-> dashboard.
// Run: node tests/theme.test.js
"use strict";
const fs = require("fs"), vm = require("vm"), path = require("path");
const root = path.join(__dirname, "..");

let appliedTheme = null;
let themePref = null;
const attrs = {};
const ctx = vm.createContext({
  console, Date, Math, JSON, Intl, setTimeout, clearTimeout,
  window: {
    matchMedia(q) {
      return {
        matches: /light/.test(q) ? false : false, // default dark for tests
        addEventListener() {},
        removeEventListener() {},
      };
    },
    dispatchEvent() { return true; },
    addEventListener() {},
  },
  navigator: { onLine: false },
  document: {
    documentElement: {
      getAttribute(k) { return attrs[k] || null; },
      setAttribute(k, v) {
        attrs[k] = v;
        if (k === "data-theme") appliedTheme = v;
        if (k === "data-theme-pref") themePref = v;
      },
    },
    getElementById() { return null; },
    querySelector() { return null; },
  },
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  crypto: require("crypto").webcrypto,
  self: { crypto: require("crypto").webcrypto },
  fetch: async () => ({ ok: false }),
  CustomEvent: function CustomEvent(type, init) { this.type = type; this.detail = init && init.detail; },
});

for (const f of ["db.js", "sb.js", "sync.js"]) {
  vm.runInContext(
    fs.readFileSync(path.join(root, f), "utf8") +
      "\n;try { if (typeof SyncEngine !== 'undefined') globalThis.SyncEngine = SyncEngine; } catch (e) {}",
    ctx,
    { filename: f }
  );
}
const E = ctx.SyncEngine;
let fails = 0, n = 0;
const ok = (name, cond, extra) => {
  n++;
  if (!cond) fails++;
  console.log((cond ? "PASS " : "FAIL ") + name + (cond || extra === undefined ? "" : " " + JSON.stringify(extra)));
};

// Exact phone ids from ThemePreference.swift
const phoneIds = [
  ["auto", "auto"],
  ["light", "light"],
  ["dark", "dark"],
  ["terminal", "terminal"],
  ["modern", "modern"],
  ["win95", "win95"],
  ["professional_auto", "professional_auto"],
  ["professional_light", "professional_light"],
  ["professional_dark", "professional_dark"],
];
for (const [raw, want] of phoneIds) {
  ok("phone id " + raw, E.normalizeTheme(raw) === want, E.normalizeTheme(raw));
}

// Fuzzy / display forms must not collapse Professional into Light/Dark/Auto
ok("Professional Light display", E.normalizeTheme("Professional Light") === "professional_light");
ok("Professional Dark display", E.normalizeTheme("Professional Dark") === "professional_dark");
ok("Professional Auto display", E.normalizeTheme("Professional Auto") === "professional_auto");
ok("professional-light dashed", E.normalizeTheme("professional-light") === "professional_light");
ok("PROFESSIONAL_LIGHT upper", E.normalizeTheme("PROFESSIONAL_LIGHT") === "professional_light");

// Bare light/dark/auto still work
ok("bare light", E.normalizeTheme("light") === "light");
ok("bare dark", E.normalizeTheme("Dark") === "dark");
ok("bare auto", E.normalizeTheme("auto") === "auto");

// Unknown ids fall back gracefully (null -> callers use auto)
ok("unknown null", E.normalizeTheme("neon_cyber") === null);
ok("empty null", E.normalizeTheme("") === null);
ok("null in", E.normalizeTheme(null) === null);

// applyTheme: professional_auto resolves via prefers-color-scheme (test ctx = dark)
appliedTheme = null; themePref = null;
E.applyTheme("professional_auto");
ok("professional_auto pref kept", themePref === "professional_auto", themePref);
ok("professional_auto applied dark", appliedTheme === "professional_dark", appliedTheme);

appliedTheme = null; themePref = null;
E.applyTheme("professional_light");
ok("professional_light applied", appliedTheme === "professional_light" && themePref === "professional_light");

appliedTheme = null; themePref = null;
E.applyTheme("professional_dark");
ok("professional_dark applied", appliedTheme === "professional_dark" && themePref === "professional_dark");

appliedTheme = null; themePref = null;
E.applyTheme("not_a_theme");
ok("unknown falls back to auto pref", themePref === "auto", themePref);
ok("unknown auto resolves to dark", appliedTheme === "dark", appliedTheme);

// CSS files contain both professional themes
const themesCss = fs.readFileSync(path.join(root, "themes.css"), "utf8");
ok("css has professional_light", themesCss.includes('[data-theme="professional_light"]'));
ok("css has professional_dark", themesCss.includes('[data-theme="professional_dark"]'));
ok("css accent light #0B4F9C", /professional_light[\s\S]*?--accent:\s*#0B4F9C/i.test(themesCss));
ok("css accent dark #6AA1E8", /professional_dark[\s\S]*?--accent:\s*#6AA1E8/i.test(themesCss));

// Settings catalog: Professional first, Archived empty
const settingsSrc = fs.readFileSync(path.join(root, "settings.js"), "utf8");
ok("settings has professional_auto", settingsSrc.includes('"professional_auto"'));
ok("settings ARCHIVED empty", /const ARCHIVED = \[\];/.test(settingsSrc));
ok("settings PROFESSIONAL before MAIN", settingsSrc.indexOf("const PROFESSIONAL") < settingsSrc.indexOf("const MAIN"));

console.log(fails ? `${fails}/${n} FAILED` : `ALL ${n} PASS`);
process.exit(fails ? 1 : 0);
