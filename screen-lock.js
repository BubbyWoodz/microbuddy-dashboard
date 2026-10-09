/* ============ screen-lock.js — optional dashboard screen lock ============
 * Dashboard-only setting (no iOS equivalent): an optional password that
 * gates the dashboard after the tab has been away longer than the chosen
 * timeout. Off by default — for shared households, not solo setups.
 *
 * Honest scope: this is a casual-snooper deterrent (like WhatsApp Web's
 * screen lock), not encryption. Someone with devtools could bypass it.
 * It never locks while the tab is open and active — only when the page
 * loads or the tab regains focus after being idle past the timeout.
 * Forgot the password? Unlink from the iPhone app — the wipe clears it.
 */
const ScreenLock = (() => {
  const LS_KEY = "mb_screen_lock";
  let cfg = null;          // {enabled, salt, hash, timeoutMin}
  let lastActive = Date.now();
  let persistTimer = null;

  function loadCfg() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      cfg = raw ? JSON.parse(raw) : null;
    } catch (e) { cfg = null; }
    if (cfg && typeof cfg !== "object") cfg = null;
  }
  function saveCfg() {
    try {
      if (cfg) localStorage.setItem(LS_KEY, JSON.stringify(cfg));
      else localStorage.removeItem(LS_KEY);
    } catch (e) {}
  }
  // cyrb53 — small non-crypto hash; fine for a deterrent lock.
  function hashStr(str, seed) {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
  }
  function randomSalt() {
    const a = new Uint8Array(16);
    try { crypto.getRandomValues(a); }
    catch (e) { for (let i = 0; i < 16; i++) a[i] = (Math.random() * 256) | 0; }
    return Array.from(a).map(b => b.toString(16).padStart(2, "0")).join("");
  }
  function hashPassword(pw, salt) {
    return hashStr(salt + ":" + pw, 0x9e3779b9) + hashStr(pw + ":" + salt, 0x85ebca6b);
  }

  function getLastActive() {
    try {
      const v = parseInt(localStorage.getItem(LS_KEY + ":lastActive") || "0", 10);
      return v || lastActive;
    } catch (e) { return lastActive; }
  }
  function setLastActive(t) {
    lastActive = t;
    try { localStorage.setItem(LS_KEY + ":lastActive", String(t)); } catch (e) {}
  }
  function markActive() {
    lastActive = Date.now();
    // Persist throttled so a reload/close keeps a fresh timestamp.
    if (!persistTimer) {
      persistTimer = setTimeout(() => {
        persistTimer = null;
        setLastActive(lastActive);
      }, 30000);
    }
  }

  function overlay() {
    let el = document.getElementById("screen-lock");
    if (el) return el;
    el = document.createElement("div");
    el.id = "screen-lock";
    el.style.cssText = "position:fixed;inset:0;z-index:10000;display:none;" +
      "align-items:center;justify-content:center;" +
      "background:rgba(10,10,14,.78);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);";
    el.innerHTML =
      '<div style="width:min(340px,88vw);padding:28px;border-radius:16px;text-align:center;' +
      'background:#17171c;color:#f2f2f5;box-shadow:0 12px 44px rgba(0,0,0,.5);">' +
      '<div style="font-size:17px;font-weight:600;margin-bottom:6px">Dashboard locked</div>' +
      '<div style="font-size:13px;opacity:.65;margin-bottom:18px">Enter your screen-lock password</div>' +
      '<input id="screen-lock-pw" type="password" autocomplete="current-password" placeholder="Password" ' +
      'style="width:100%;box-sizing:border-box;padding:11px 14px;border-radius:10px;border:1px solid #3a3a42;' +
      'background:#0e0e12;color:#f2f2f5;font-size:16px;outline:none;margin-bottom:12px">' +
      '<button id="screen-lock-go" style="width:100%;padding:11px;border:none;border-radius:10px;' +
      'background:#0a84ff;color:#fff;font-size:16px;font-weight:600;cursor:pointer">Unlock</button>' +
      '<div id="screen-lock-err" style="min-height:18px;margin-top:10px;font-size:13px;color:#ff7a7a"></div>' +
      "</div>";
    document.body.appendChild(el);
    const pw = el.querySelector("#screen-lock-pw");
    const go = () => tryUnlock(pw.value);
    el.querySelector("#screen-lock-go").addEventListener("click", go);
    pw.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
    return el;
  }
  function tryUnlock(pw) {
    const el = overlay();
    const err = el.querySelector("#screen-lock-err");
    if (cfg && cfg.hash === hashPassword(pw || "", cfg.salt)) {
      err.textContent = "";
      el.querySelector("#screen-lock-pw").value = "";
      hide();
      setLastActive(Date.now());
    } else {
      err.textContent = "Wrong password — try again.";
      el.querySelector("#screen-lock-pw").select();
    }
  }
  function show() {
    overlay().style.display = "flex";
    setTimeout(() => {
      const pw = document.getElementById("screen-lock-pw");
      if (pw) pw.focus();
    }, 60);
  }
  function hide() {
    const el = document.getElementById("screen-lock");
    if (el) el.style.display = "none";
  }
  function shouldLock() {
    if (!cfg || !cfg.enabled || !cfg.hash) return false;
    const timeoutMs = (cfg.timeoutMin || 5) * 60000;
    return Date.now() - getLastActive() > timeoutMs;
  }
  function check() {
    if (shouldLock()) show();
  }

  // ---- settings API (used by settings.js) ----
  function getState() {
    loadCfg();
    return {
      enabled: !!(cfg && cfg.enabled),
      timeoutMin: (cfg && cfg.timeoutMin) || 5,
      hasPassword: !!(cfg && cfg.hash),
    };
  }
  function setPassword(newPw) {
    if (!newPw || newPw.length < 4) return { ok: false, error: "Use at least 4 characters." };
    loadCfg();
    const salt = randomSalt();
    cfg = Object.assign({}, cfg, {
      enabled: true,
      salt,
      hash: hashPassword(newPw, salt),
      timeoutMin: (cfg && cfg.timeoutMin) || 5,
    });
    saveCfg();
    setLastActive(Date.now());
    return { ok: true };
  }
  function verify(pw) {
    loadCfg();
    return !!(cfg && cfg.hash === hashPassword(pw || "", cfg.salt || ""));
  }
  function setEnabled(on) {
    loadCfg();
    if (on && !(cfg && cfg.hash)) return { ok: false, error: "Set a password first." };
    cfg = Object.assign({}, cfg, { enabled: !!on });
    saveCfg();
    return { ok: true };
  }
  function setTimeoutMin(min) {
    const m = parseInt(min, 10);
    if (![1, 5, 15, 30, 60].includes(m)) return { ok: false };
    loadCfg();
    cfg = Object.assign({}, cfg, { timeoutMin: m });
    saveCfg();
    return { ok: true };
  }

  function init() {
    loadCfg();
    lastActive = getLastActive();
    ["pointerdown", "keydown", "touchstart"].forEach(ev =>
      document.addEventListener(ev, markActive, { passive: true }));
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) setLastActive(lastActive);
      else check();
    });
    window.addEventListener("pagehide", () => {
      if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
      setLastActive(lastActive);
    });
    check(); // lock on load if we were away past the timeout
  }

  return {
    init, check, hide,
    getState, setPassword, verify, setEnabled, setTimeoutMin,
    lockNow: () => { if (cfg && cfg.enabled && cfg.hash) show(); },
  };
})();
