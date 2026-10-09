"use strict";
/* ============ settings.js — Settings pages: Buddy AI, Appearance, This dashboard ============
 * Appearance: the phone is the source of truth. "Match my phone" (default)
 *   applies profile.themePreference from the synced backup blob; when the
 *   phone hasn't shared a theme (or the switch is off) the manual pick here
 *   is used. The manual pick is stored only in this browser (IndexedDB) and
 *   is never written to the blob — the iPhone keeps its own theme.
 * Buddy AI: SERVER-ONLY config. Fetched live from /api/ai-config, never
 *   cached on the device. The API key field is write-only.
 * This dashboard: screen lock, offline cache, chat history, sign out.
 */
const SettingsUI = (() => {
  // Exact titles/subtitles from ThemePreference.swift.
  const THEMES = [
    { id: "auto", name: "Auto", desc: "Follows your computer's Light or Dark Mode",
      swatch: "linear-gradient(135deg,#f2f2f7 0 50%,#0b1220 50% 100%)" },
    { id: "light", name: "Light", desc: "Always the bright look",
      swatch: "linear-gradient(160deg,#ffffff,#e9edf5)" },
    { id: "dark", name: "Dark", desc: "Always the dark look",
      swatch: "linear-gradient(160deg,#1b2540,#0b1220)" },
    { id: "terminal", name: "Terminal", desc: "Blue-on-black text-mode dashboard",
      swatch: "repeating-linear-gradient(0deg,#000 0 6px,#04122a 6px 7px)" },
    { id: "modern", name: "Modern (Frosted Glass)", desc: "Bliss wallpaper under frosted glass",
      swatch: "linear-gradient(180deg,#3d8ee8 0 55%,#5aa83a 55% 100%)" },
    { id: "win95", name: "Windows 95", desc: "Teal desktop, beveled silver chrome",
      swatch: "linear-gradient(180deg,#000080 0 22%,#c0c0c0 22% 100%)" },
  ];
  const TITLE = Object.fromEntries(THEMES.map(t => [t.id, t.name]));
  const I = (n, o) => (typeof Icon === "function" ? Icon(n, o) : "");

  // ---------------- Appearance ----------------
  async function renderAppearance(box) {
    if (!box) return;
    const st = await SyncEngine.themeState(true);
    const follow = st.mode !== "manual";
    let status;
    if (st.phone) {
      status = follow
        ? `Matching your phone: <b>${esc(TITLE[st.phone] || st.phone)}</b>. Change it on the phone and this dashboard follows on the next sync.`
        : `Your phone uses <b>${esc(TITLE[st.phone] || st.phone)}</b>. This dashboard is using its own pick below.`;
    } else {
      status = follow
        ? `Your phone hasn't shared its theme yet, so Auto is used (matches your computer's Light or Dark Mode).`
        : `Using the pick below on this dashboard.`;
    }
    box.innerHTML =
      `<div class="panel"><div class="settings-row static">` +
      `<span class="sr-ico">${I("phone")}</span><span class="sr-text"><span class="sr-title">Match my phone</span>` +
      `<span class="sr-sub">Use whatever theme your phone is set to</span></span>` +
      `<label class="switch"><input type="checkbox" id="theme-follow"${follow ? " checked" : ""}><span></span></label></div>` +
      `<div class="hint" id="theme-status">${status}</div></div>` +
      `<div class="panel"><div class="sec-head"><div class="grow"><div class="sec-title">Theme</div>` +
      `<div class="sec-sub">Pick how Micro Buddy looks${follow ? " — turn off Match my phone to choose your own" : ""}</div></div></div>` +
      `<div class="theme-grid">` + THEMES.map(t => {
        const sel = t.id === st.effective;
        return `<button class="theme-card${sel ? " selected" : ""}" data-theme-id="${t.id}"${follow ? " disabled" : ""}>` +
          `<span class="theme-swatch" style="background:${t.swatch}"></span>` +
          `<span class="theme-name">${esc(t.name)}${sel ? " " + I("check-circle", { size: 16, cls: "ico accent" }) : ""}</span>` +
          `<span class="theme-desc">${esc(t.desc)}</span></button>`;
      }).join("") + `</div>` +
      `<div class="hint" style="margin-top:12px">Auto matches your computer's Light or Dark Mode. Terminal re-skins the whole dashboard as a blue-on-black text dashboard; Modern lays a Bliss wallpaper under frosted-glass panels; Windows 95 turns it into a teal desktop with beveled silver windows. Your data and math stay exactly the same.</div></div>`;

    box.querySelector("#theme-follow").addEventListener("change", async e => {
      await SyncEngine.setThemeMode(e.target.checked ? "phone" : "manual");
      renderAppearance(box);
    });
    box.querySelectorAll(".theme-card").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (btn.disabled) return;
        await SyncEngine.setTheme(btn.dataset.themeId); // manual mode
        renderAppearance(box);
      });
    });
  }

  // ---------------- Buddy AI ----------------
  function aiFormHTML() {
    return (
      '<div class="field"><label>Provider</label>' +
      '<select id="ai-provider">' +
      '<option value="disabled">Disabled</option>' +
      '<option value="ollama">Ollama (local)</option>' +
      '<option value="openai">OpenAI-compatible endpoint</option>' +
      "</select></div>" +
      '<div class="field"><label>Server URL</label>' +
      '<input type="url" id="ai-url" placeholder="http://your-server:11434" autocomplete="off" spellcheck="false">' +
      '<div class="hint">Ollama default: http://localhost:11434 if it runs on this same server (the dashboard reaches it, not your browser) — no key needed on your LAN.</div></div>' +
      '<div class="field"><label>Model</label>' +
      '<input type="text" id="ai-model" placeholder="llama3.2" autocomplete="off" spellcheck="false" list="ai-model-list">' +
      '<datalist id="ai-model-list"></datalist>' +
      '<div class="hint">Type a model name, or <button type="button" class="link-btn" id="ai-load-models">load the list</button> from your server.</div></div>' +
      '<div class="field"><label>API key <span class="opt">(optional)</span></label>' +
      '<input type="password" id="ai-key" placeholder="Leave blank to keep the saved key" autocomplete="new-password">' +
      '<div class="hint" id="ai-key-hint"></div></div>' +
      '<div class="btn-row" style="margin-top:12px">' +
      '<button class="btn primary" id="ai-save">' + I("check") + ' Save AI settings</button>' +
      '<button class="btn ghost" id="ai-test">' + I("zap") + ' Test connection</button>' +
      "</div>" +
      '<div id="ai-status" class="form-status"></div>' +
      '<div class="hint" style="margin-top:10px">Stored on the server only — never on this device. ' +
      "Buddy chats go through the dashboard's secure proxy.</div>"
    );
  }

  async function renderAI(box) {
    if (!box) return;
    box.innerHTML =
      '<div class="grid"><div class="panel col-7" id="ai-panel"><div class="sec-head"><div class="grow"><div class="sec-title">Model</div>' +
      '<div class="sec-sub">Where Buddy\'s answers come from</div></div></div>' + aiFormHTML() + "</div>" +
      '<div class="panel col-5"><div class="sec-head"><div class="grow"><div class="sec-title">Chat history</div>' +
      '<div class="sec-sub">Buddy conversations sync with the server</div></div></div>' +
      '<div class="list-item"><div class="li-main">Clear chat history<div class="li-sub">Deletes it on this device and the server</div></div>' +
      '<button class="btn ghost danger sm" id="clear-chat">' + I("trash", { size: 14 }) + ' Clear</button></div></div></div>';
    await loadAIConfig();
    document.getElementById("ai-save").addEventListener("click", saveAIConfig);
    document.getElementById("ai-test").addEventListener("click", testAIConfig);
    document.getElementById("ai-provider").addEventListener("change", toggleAIFields);
    document.getElementById("ai-load-models").addEventListener("click", loadAIModels);
    document.getElementById("clear-chat").addEventListener("click", async () => {
      if (!confirm("Delete all Buddy chat history (this device and the server)?")) return;
      const sessions = await MBDB.listChatSessions().catch(() => []);
      for (const s of sessions) await MBDB.clearChat(s).catch(() => {});
      await MBDB.kvSet("chatSessions", []).catch(() => {});
      await MBDB.kvSet("chatSyncTs", 0).catch(() => {});
      if (navigator.onLine) { try { await fetch("/api/chat", { method: "DELETE" }); } catch (e) {} }
      try { BuddyUI.reset(); } catch (e) {}
      if (window.toast) window.toast("Chat history cleared");
    });
  }

  // ---------------- This dashboard (device) ----------------
  async function renderDevice(box) {
    if (!box) return;
    box.innerHTML =
      '<div class="sec-head"><div class="grow"><div class="sec-title">This dashboard</div>' +
      '<div class="sec-sub">Device-only settings — these never leave this browser</div></div></div>' +
      '<div class="list-item"><div class="li-main">Screen lock<div class="li-sub" id="screen-lock-sub">Optional password after idle</div></div>' +
      '<button class="btn ghost sm" id="screen-lock-toggle">Off</button></div>' +
      '<div class="list-item"><div class="li-main">Lock after<div class="li-sub">Idle time before the password appears</div></div>' +
      '<select id="screen-lock-timeout" style="width:auto">' +
      '<option value="1">1 minute</option><option value="5">5 minutes</option>' +
      '<option value="15">15 minutes</option><option value="30">30 minutes</option>' +
      '<option value="60">1 hour</option></select></div>' +
      '<div class="list-item"><div class="li-main">Password<div class="li-sub">Forgot it? Unlink from the iPhone app to reset</div></div>' +
      '<button class="btn ghost sm" id="screen-lock-setpw">Set password</button></div>' +
      '<div class="list-item"><div class="li-main">Lock now<div class="li-sub" id="screen-lock-status">Requires a password</div></div>' +
      '<button class="btn ghost sm" id="screen-lock-now">' + I("lock", { size: 14 }) + ' Lock</button></div>' +
      '<div class="list-item"><div class="li-main">Offline data<div class="li-sub" id="cache-size">Your synced backup is stored in this browser</div></div>' +
      '<button class="btn ghost sm" id="clear-cache">' + I("refresh", { size: 14 }) + ' Re-download</button></div>' +
      '<div class="list-item"><div class="li-main">Sign out<div class="li-sub">On this device only — the iPhone stays linked to others</div></div>' +
      '<button class="btn ghost danger sm" id="signout-btn">' + I("logout", { size: 14 }) + ' Sign out</button></div>';

    try {
      const slStatus = box.querySelector("#screen-lock-status");
      const slToggle = box.querySelector("#screen-lock-toggle");
      const slTimeout = box.querySelector("#screen-lock-timeout");
      const slPwBtn = box.querySelector("#screen-lock-setpw");
      const slSub = box.querySelector("#screen-lock-sub");
      const slSay = (m) => { if (slStatus) { slStatus.textContent = m; setTimeout(() => { slStatus.textContent = "Requires a password"; }, 4000); } };
      const slRefresh = () => {
        const st = ScreenLock.getState();
        slToggle.textContent = st.enabled ? "On" : "Off";
        slToggle.classList.toggle("primary", st.enabled);
        slTimeout.value = String(st.timeoutMin);
        slPwBtn.textContent = st.hasPassword ? "Change password" : "Set password";
        if (slSub) slSub.textContent = st.enabled ? "On — locks after " + st.timeoutMin + " min idle" : "Optional password after idle";
      };
      slToggle.addEventListener("click", () => {
        const st = ScreenLock.getState();
        if (!st.enabled) {
          if (!st.hasPassword) {
            const pw = prompt("Choose a screen-lock password (min 4 characters):");
            if (pw === null) return;
            const r = ScreenLock.setPassword(pw);
            if (!r.ok) { slSay(r.error); return; }
            slSay("Screen lock on.");
          } else { ScreenLock.setEnabled(true); slSay("Screen lock on."); }
        } else {
          const pw = prompt("Enter your current password to turn the lock off:");
          if (pw === null) return;
          if (!ScreenLock.verify(pw)) { slSay("Wrong password."); return; }
          ScreenLock.setEnabled(false);
          slSay("Screen lock off.");
        }
        slRefresh();
      });
      slTimeout.addEventListener("change", () => { ScreenLock.setTimeoutMin(slTimeout.value); slRefresh(); });
      slPwBtn.addEventListener("click", () => {
        const st = ScreenLock.getState();
        if (st.hasPassword) {
          const cur = prompt("Enter your current password:");
          if (cur === null) return;
          if (!ScreenLock.verify(cur)) { slSay("Wrong password."); return; }
        }
        const pw = prompt(st.hasPassword ? "New password (min 4 characters):" : "Choose a screen-lock password (min 4 characters):");
        if (pw === null) return;
        const r = ScreenLock.setPassword(pw);
        slSay(r.ok ? "Password saved — lock on." : r.error);
        slRefresh();
      });
      box.querySelector("#screen-lock-now").addEventListener("click", () => ScreenLock.lockNow());
      slRefresh();
    } catch (e) { /* screen lock unavailable */ }

    box.querySelector("#clear-cache").addEventListener("click", async () => {
      if (!confirm("Re-download your data from the cloud? Unsynced edits stay queued.")) return;
      try { await MBDB.clearCache(); } catch (e) {}
      await MBDB.kvSet("lastSync", 0).catch(() => {});
      try { await SyncEngine.incrementalSync({ force: true }); } catch (e) {}
      if (window.toast) window.toast("Data re-downloaded");
    });
    box.querySelector("#signout-btn").addEventListener("click", async () => {
      if (!confirm("Sign out of Micro Buddy on this device?")) return;
      // Server drops this browser's session AND deletes its dashboard link
      // row, so the phone's "Linked dashboards" list updates.
      let token = "";
      try { const ss = await SB.getValidSession(); token = (ss && ss.access_token) || ""; } catch (e) {}
      try {
        await fetch("/api/session/logout", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ access_token: token }) });
      } catch (e) {}
      try { await MBDB.wipeAll(); } catch (e) {}
      try { localStorage.removeItem("mb_supabase_session"); localStorage.removeItem("mb_dashboard_link"); } catch (e) {}
      location.reload();
    });
  }

  async function loadAIConfig() {
    const status = document.getElementById("ai-status");
    try {
      const res = await fetch("/api/ai-config");
      if (res.status === 401) { status.textContent = "Sign in to manage AI settings."; return; }
      if (!res.ok) throw new Error("request failed");
      const cfg = await res.json();
      document.getElementById("ai-provider").value = cfg.provider || "disabled";
      document.getElementById("ai-url").value = cfg.server_url || "";
      document.getElementById("ai-model").value = cfg.model || "";
      document.getElementById("ai-key-hint").textContent = cfg.api_key_set
        ? "An API key is saved on the server."
        : "No API key saved.";
      toggleAIFields();
    } catch (e) {
      status.textContent = "Couldn't load AI settings: " + e.message;
      status.className = "form-status error";
    }
  }

  function toggleAIFields() {
    const p = document.getElementById("ai-provider").value;
    const disabled = p === "disabled";
    ["ai-url", "ai-model", "ai-key"].forEach(id => {
      document.getElementById(id).disabled = disabled;
    });
    document.getElementById("ai-test").disabled = disabled;
  }

  async function saveAIConfig() {
    const status = document.getElementById("ai-status");
    status.textContent = "Saving…";
    status.className = "form-status";
    const body = {
      provider: document.getElementById("ai-provider").value,
      server_url: document.getElementById("ai-url").value.trim(),
      model: document.getElementById("ai-model").value.trim(),
      api_key: document.getElementById("ai-key").value, // empty = keep existing
    };
    try {
      const res = await fetch("/api/ai-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "save failed");
      document.getElementById("ai-key").value = "";
      document.getElementById("ai-key-hint").textContent = data.api_key_set
        ? "An API key is saved on the server."
        : "No API key saved.";
      status.textContent = "Saved. Buddy will use these settings.";
      status.className = "form-status ok";
      toggleAIFields();
      // Let the Buddy tab pick up the new config next time it loads.
      BuddyUI.reset();
    } catch (e) {
      status.textContent = "Save failed: " + e.message;
      status.className = "form-status error";
    }
  }

  async function testAIConfig() {
    const status = document.getElementById("ai-status");
    status.textContent = "Testing…";
    status.className = "form-status";
    try {
      const res = await fetch("/api/ai-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "Reply with exactly: OK" }] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "test failed");
      status.textContent = "Connected! Server replied: " + String(data.reply || "").slice(0, 120);
      status.className = "form-status ok";
    } catch (e) {
      status.textContent = "Test failed: " + e.message;
      status.className = "form-status error";
    }
  }

  async function loadAIModels() {
    const status = document.getElementById("ai-status");
    const provider = document.getElementById("ai-provider").value;
    const serverUrl = document.getElementById("ai-url").value.trim();
    if (provider === "disabled") {
      status.textContent = "Pick a provider first.";
      status.className = "form-status error";
      return;
    }
    if (!serverUrl) {
      status.textContent = "Enter the server URL first.";
      status.className = "form-status error";
      return;
    }
    status.textContent = "Loading models…";
    status.className = "form-status";
    try {
      const res = await fetch("/api/ai-models?provider=" + encodeURIComponent(provider) +
        "&server_url=" + encodeURIComponent(serverUrl));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "request failed");
      const list = document.getElementById("ai-model-list");
      list.innerHTML = "";
      (data.models || []).forEach(name => {
        const opt = document.createElement("option");
        opt.value = name;
        list.appendChild(opt);
      });
      if ((data.models || []).length === 0) {
        status.textContent = "No models found on that server.";
        status.className = "form-status error";
      } else {
        status.textContent = data.models.length + " model(s) found — pick one from the list.";
        status.className = "form-status ok";
        // Preselect the first model if the field is empty.
        const input = document.getElementById("ai-model");
        if (!input.value.trim()) input.value = data.models[0];
      }
    } catch (e) {
      status.textContent = "Couldn't load models: " + e.message;
      status.className = "form-status error";
    }
  }

  function reset() {}

  // Apply the cached/phone theme before first paint on boot.
  async function applyCachedTheme() {
    try { await SyncEngine.syncPreferences(); }
    catch (e) { SyncEngine.applyTheme("auto"); }
  }

  // Back-compat: old callers used SettingsUI.load() for the AI page.
  async function load() { await renderAI(document.getElementById("settings-ai-body")); }

  return { load, reset, renderAI, renderAppearance, renderDevice, applyCachedTheme, THEMES };
})();
