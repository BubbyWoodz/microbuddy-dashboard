"use strict";
/* ============ settings.js — Settings tab: theme picker + AI config ============
 * Theme: applied instantly via SyncEngine.setTheme(), saved to the server
 *   (per Apple user) and cached in IndexedDB for offline use.
 * AI config: SERVER-ONLY. Fetched live from /api/ai-config, never cached
 *   on the device. The API key field is write-only — the server never
 *   returns it (only api_key_set: true/false).
 */
const SettingsUI = (() => {
  const THEMES = [
    { id: "auto", name: "Auto", desc: "Follows your device's appearance", swatch: "#8b94a7" },
    { id: "light", name: "Light", desc: "Always the bright look", swatch: "#f4f5f7" },
    { id: "dark", name: "Dark", desc: "Always the dark look", swatch: "#0d1017" },
    { id: "terminal", name: "Terminal", desc: "Blue-on-black text mode", swatch: "#000000" },
    { id: "modern", name: "Modern", desc: "Frosted glass over Bliss", swatch: "#3a9bdc" },
    { id: "win95", name: "Win95", desc: "Teal desktop, beveled panels", swatch: "#008080" },
  ];

  let loaded = false;

  function themePickerHTML(current) {
    return '<div class="theme-grid">' + THEMES.map(t =>
      '<button class="theme-card' + (t.id === current ? " selected" : "") + '" data-theme-id="' + t.id + '">' +
      '<span class="theme-swatch" style="background:' + t.swatch + '"></span>' +
      '<span class="theme-name">' + t.name + "</span>" +
      '<span class="theme-desc">' + t.desc + "</span>" +
      "</button>"
    ).join("") + "</div>";
  }

  function aiFormHTML() {
    return (
      '<div class="field-row"><label>Provider</label>' +
      '<select id="ai-provider">' +
      '<option value="disabled">Disabled</option>' +
      '<option value="ollama">Ollama (local)</option>' +
      '<option value="openai">OpenAI-compatible endpoint</option>' +
      "</select></div>" +
      '<div class="field-row"><label>Server URL</label>' +
      '<input type="url" id="ai-url" placeholder="http://umbrel.local:11434" autocomplete="off" spellcheck="false">' +
      '<div class="hint">Ollama default: http://localhost:11434 if it runs on this same server (the dashboard reaches it, not your browser) — no key needed on your LAN.</div></div>' +
      '<div class="field-row"><label>Model</label>' +
      '<input type="text" id="ai-model" placeholder="llama3.2" autocomplete="off" spellcheck="false" list="ai-model-list">' +
      '<datalist id="ai-model-list"></datalist>' +
      '<div class="hint">Type a model name, or <button type="button" class="link-btn" id="ai-load-models">load the list</button> from your server.</div></div>' +
      '<div class="field-row"><label>API key <span class="opt">(optional)</span></label>' +
      '<input type="password" id="ai-key" placeholder="Leave blank to keep the saved key" autocomplete="new-password">' +
      '<div class="hint" id="ai-key-hint"></div></div>' +
      '<div class="btn-row">' +
      '<button class="btn" id="ai-save">Save AI settings</button>' +
      '<button class="btn ghost" id="ai-test">Test connection</button>' +
      "</div>" +
      '<div id="ai-status" class="form-status"></div>' +
      '<div class="hint" style="margin-top:10px">Stored on the server only — never on this device. ' +
      "Buddy chats go through the dashboard's secure proxy.</div>"
    );
  }

  async function load() {
    if (loaded) return;
    loaded = true;
    const box = document.getElementById("settings-body");
    const currentTheme = document.documentElement.getAttribute("data-theme") || "dark";

    box.innerHTML =
      '<div class="section-title">Appearance</div>' +
      '<div class="panel"><div class="li-sub" style="margin-bottom:10px">Theme syncs from your iPhone app — the phone is the source of truth.</div>' +
      themePickerHTML(currentTheme) +
      '<div class="btn-row" style="margin-top:10px">' +
      '<button class="btn ghost" id="theme-sync-now">Sync now</button>' +
      '<span id="theme-sync-status" class="form-status" style="margin:0"></span>' +
      "</div></div>" +
      '<div class="section-title">Buddy AI</div>' +
      '<div class="panel" id="ai-panel">' + aiFormHTML() + "</div>" +
      '<div class="section-title">Data</div>' +
      '<div class="panel">' +
      '<div class="list-item"><div class="li-main">Offline cache<div class="li-sub" id="cache-size">—</div></div>' +
      '<button class="btn ghost" id="clear-cache">Clear</button></div>' +
      '<div class="list-item"><div class="li-main">Chat history<div class="li-sub">Buddy conversations (synced)</div></div>' +
      '<button class="btn ghost" id="clear-chat">Clear</button></div>' +
      '<div class="list-item" style="border:none"><div class="li-main">Sign out<div class="li-sub">On this device only</div></div>' +
      '<button class="btn ghost" id="signout-btn">Sign out</button></div>' +
      "</div>" +
      '<div class="section-title">Dashboard</div>' +
      '<div class="panel">' +
      '<div class="li-sub" style="margin-bottom:10px">Dashboard-only settings — these never leave this browser.</div>' +
      '<div class="list-item"><div class="li-main">Screen lock<div class="li-sub" id="screen-lock-sub">Optional password after idle</div></div>' +
      '<button class="btn ghost" id="screen-lock-toggle">Off</button></div>' +
      '<div class="list-item"><div class="li-main">Lock after<div class="li-sub">Idle time before the password appears</div></div>' +
      '<select id="screen-lock-timeout" style="width:auto">' +
      '<option value="1">1 minute</option><option value="5">5 minutes</option>' +
      '<option value="15">15 minutes</option><option value="30">30 minutes</option>' +
      '<option value="60">1 hour</option></select></div>' +
      '<div class="list-item" style="border:none"><div class="li-main">Password<div class="li-sub">Forgot it? Unlink from the iPhone app to reset</div></div>' +
      '<button class="btn ghost" id="screen-lock-pw">Set password</button></div>' +
      '<div class="btn-row"><button class="btn ghost" id="screen-lock-now">Lock now</button>' +
      '<span id="screen-lock-status" class="form-status" style="margin:0"></span></div>' +
      "</div>";

    // Theme picker
    box.querySelectorAll(".theme-card").forEach(btn => {
      btn.addEventListener("click", async () => {
        box.querySelectorAll(".theme-card").forEach(b => b.classList.remove("selected"));
        btn.classList.add("selected");
        await SyncEngine.setTheme(btn.dataset.themeId);
      });
    });

    // Pull the latest theme from the iPhone (via the server) and apply it.
    document.getElementById("theme-sync-now").addEventListener("click", async () => {
      const status = document.getElementById("theme-sync-status");
      status.textContent = "Syncing…";
      status.className = "form-status";
      try {
        const res = await fetch("/api/preferences");
        if (!res.ok) throw new Error("request failed");
        const prefs = await res.json();
        if (prefs && prefs.theme) {
          await SyncEngine.setTheme(prefs.theme);
          box.querySelectorAll(".theme-card").forEach(b =>
            b.classList.toggle("selected", b.dataset.themeId === prefs.theme));
          status.textContent = "Synced from iPhone.";
          status.className = "form-status ok";
        } else {
          throw new Error("no theme returned");
        }
      } catch (e) {
        status.textContent = "Sync failed: " + e.message;
        status.className = "form-status error";
      }
    });

    // AI config — always fetched live, never from device storage.
    await loadAIConfig();

    document.getElementById("ai-save").addEventListener("click", saveAIConfig);
    document.getElementById("ai-test").addEventListener("click", testAIConfig);
    document.getElementById("ai-provider").addEventListener("change", toggleAIFields);
    document.getElementById("ai-load-models").addEventListener("click", loadAIModels);

    // Cache info
    try {
      const n = await MBDB.getCacheCount();
      document.getElementById("cache-size").textContent = n + " cached responses";
    } catch (e) { /* ignore */ }

    document.getElementById("clear-cache").addEventListener("click", async () => {
      if (!confirm("Clear all cached sales data on this device? It'll re-download on next sync.")) return;
      await MBDB.clearCache();
      await MBDB.kvSet("lastSync", 0);
      await MBDB.kvSet("fullSyncDone", false);
      document.getElementById("cache-size").textContent = "0 cached responses";
    });
    document.getElementById("clear-chat").addEventListener("click", async () => {
      if (!confirm("Delete all Buddy chat history (this device and the server)?")) return;
      const sessions = await MBDB.listChatSessions().catch(() => []);
      for (const s of sessions) await MBDB.clearChat(s).catch(() => {});
      await MBDB.kvSet("chatSessions", []).catch(() => {});
      await MBDB.kvSet("chatSyncTs", 0).catch(() => {});
      if (navigator.onLine) {
        try { await fetch("/api/chat", { method: "DELETE" }); } catch (e) {}
      }
      BuddyUI.reset();
    });
    // ---- Dashboard: screen lock (dashboard-only, optional) ----
    try {
      const slStatus = document.getElementById("screen-lock-status");
      const slToggle = document.getElementById("screen-lock-toggle");
      const slTimeout = document.getElementById("screen-lock-timeout");
      const slPwBtn = document.getElementById("screen-lock-pw");
      const slSub = document.getElementById("screen-lock-sub");
      const slSay = (m) => { if (slStatus) { slStatus.textContent = m; setTimeout(() => { slStatus.textContent = ""; }, 4000); } };
      const slRefresh = () => {
        const st = ScreenLock.getState();
        slToggle.textContent = st.enabled ? "On" : "Off";
        slTimeout.value = String(st.timeoutMin);
        slPwBtn.textContent = st.hasPassword ? "Change password" : "Set password";
        if (slSub) slSub.textContent = st.enabled
          ? "On — locks after " + st.timeoutMin + " min idle"
          : "Optional password after idle";
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
          } else {
            ScreenLock.setEnabled(true);
            slSay("Screen lock on.");
          }
        } else {
          const pw = prompt("Enter your current password to turn the lock off:");
          if (pw === null) return;
          if (!ScreenLock.verify(pw)) { slSay("Wrong password."); return; }
          ScreenLock.setEnabled(false);
          slSay("Screen lock off.");
        }
        slRefresh();
      });
      slTimeout.addEventListener("change", () => {
        ScreenLock.setTimeoutMin(slTimeout.value);
        slRefresh();
      });
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
      document.getElementById("screen-lock-now").addEventListener("click", () => {
        ScreenLock.lockNow();
      });
      slRefresh();
    } catch (e) { /* screen lock unavailable — settings still work */ }

    document.getElementById("signout-btn").addEventListener("click", async () => {
      if (!confirm("Sign out of Micro Buddy on this device?")) return;
      await fetch("/logout");
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
        ? "● An API key is saved on the server."
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
        ? "● An API key is saved on the server."
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

  function reset() { loaded = false; }

  // Expose for the theme to be applied before first paint on boot.
  async function applyCachedTheme() {
    const t = await MBDB.kvGet("theme").catch(() => null);
    SyncEngine.applyTheme(t || "dark");
  }

  return { load, reset, applyCachedTheme, THEMES };
})();
