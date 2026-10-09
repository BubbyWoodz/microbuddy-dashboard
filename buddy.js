"use strict";
/* ============ buddy.js — Buddy tab: synced chat with the server AI ============
 * Architecture (per Christian):
 *   - Conversations are DATA: they sync. Stored in IndexedDB (offline) and
 *     on the server per Apple user (canonical). Full sync on login via
 *     SyncEngine.syncChat(), incremental after.
 *   - The MODEL is a per-platform setting: the dashboard uses the user's
 *     custom server AI (Ollama / OpenAI-compatible) via /api/ai-chat.
 *     AI config is server-only and never touches the device.
 *   - The backend appends both the user message and the AI reply to the
 *     stored conversation and injects fresh sales context into the system
 *     prompt, so Buddy answers like the app's Buddy does.
 * Conversation schema: sessions of [{role, content, ts}] — simple and
 * platform-agnostic for future iOS interop.
 */
const BuddyUI = (() => {
  let loaded = false;
  let aiReady = null;
  let currentSession = null;
  let sending = false;

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function fmtTime(ts) {
    try {
      return new Date(ts).toLocaleString(undefined, {
        month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit",
      });
    } catch (e) { return ""; }
  }

  // Called by the tab switcher each time the Buddy tab is shown.
  async function open() {
    const box = document.getElementById("buddy-body");
    if (!box) return;
    if (!loaded) {
      loaded = true;
      const I = (n, o) => (typeof Icon === "function" ? Icon(n, o) : "");
      box.innerHTML =
        '<div class="page-head"><div><h2>Buddy</h2><div class="page-sub">Your sales buddy — ask about your numbers, schedule or pay</div></div></div>' +
        '<div class="chat-layout">' +
        '<aside class="chat-sessions panel">' +
        '<button class="btn primary block" id="chat-new">' + I("plus", { size: 14 }) + ' New chat</button>' +
        '<div class="label" style="margin:14px 4px 6px">Conversations</div>' +
        '<div id="chat-session-list" class="session-list"></div>' +
        "</aside>" +
        '<div class="chat-main panel">' +
        '<div id="chat-messages" class="chat-messages"></div>' +
        '<div id="chat-setup" class="chat-setup" hidden></div>' +
        '<div id="chat-pills" class="chat-pills"></div>' +
        '<form id="chat-form" class="chat-input-row">' +
        '<input type="text" id="chat-input" placeholder="Ask Buddy about your numbers…" autocomplete="off">' +
        '<button class="btn primary" type="submit" id="chat-send">' + I("send", { size: 15 }) + ' Send</button>' +
        "</form>" +
        "</div></div>";
      document.getElementById("chat-new").addEventListener("click", newSession);
      document.getElementById("chat-form").addEventListener("submit", e => {
        e.preventDefault();
        const inp = document.getElementById("chat-input");
        const text = inp.value.trim();
        if (text && !sending) { inp.value = ""; send(text); }
      });
      // Structured actions: confirm/decline cards (event delegation, bound once).
      if (window.BuddyActions) {
        BuddyActions.bindCardActions(box, (kind, id, message) => {
          if (message && currentSession) {
            MBDB.addChatMessage(currentSession, "assistant", message).catch(() => {});
            addMessageEl("assistant", message, Date.now());
          }
        });
      }
    }
    await checkAIStatus();
    if (aiReady) {
      try { await SyncEngine.syncChat(); } catch (e) { /* offline: use cache */ }
      await renderAll();
      // Context-aware quick prompts (scored like the app's personalizedPrompts).
      if (window.BuddyActions) {
        try { await BuddyActions.renderPills(text => { if (!sending) send(text); }); } catch (e) {}
      }
    }
  }

  function reset() {
    loaded = false; aiReady = null; currentSession = null; sending = false;
  }

  // AI status is always checked live — the config is server-only.
  async function checkAIStatus() {
    const setupBox = document.getElementById("chat-setup");
    const form = document.getElementById("chat-form");
    try {
      const res = await fetch("/api/ai-config");
      if (!res.ok) throw new Error("status check failed");
      const cfg = await res.json();
      aiReady = cfg.provider && cfg.provider !== "disabled";
    } catch (e) {
      aiReady = false;
    }
    if (!aiReady) {
      setupBox.hidden = false;
      form.style.display = "none";
      document.getElementById("chat-messages").innerHTML = "";
      document.getElementById("chat-session-list").innerHTML = "";
      setupBox.innerHTML =
        '<div class="empty-state">' +
        '<div class="empty-ico">' + (typeof Icon === "function" ? Icon("robot", { size: 34 }) : "") + '</div><div class="t">Buddy isn\'t set up yet</div>' +
        '<p>Point the dashboard at your AI server (Ollama, or any OpenAI-compatible endpoint) in Settings, then come back and chat.</p>' +
        '<button class="btn primary" id="goto-ai-settings">Open Buddy AI settings</button>' +
        "</div>";
      document.getElementById("goto-ai-settings").addEventListener("click", () => {
        if (window.openSettingsPage) window.openSettingsPage("ai");
      });
    } else {
      setupBox.hidden = true;
      form.style.display = "";
    }
  }

  async function renderAll() {
    await renderSessionList();
    if (!currentSession) {
      // Resume the most recent session, if any.
      const sessions = await MBDB.kvGet("chatSessions").catch(() => null) || [];
      if (sessions.length) currentSession = sessions[0].id;
    }
    await renderMessages();
    await renderSessionList(); // refresh active highlight
  }

  async function renderSessionList() {
    const listBox = document.getElementById("chat-session-list");
    if (!listBox) return;
    const sessions = await MBDB.kvGet("chatSessions").catch(() => null) || [];
    if (!sessions.length) {
      listBox.innerHTML = '<div class="li-sub" style="padding:8px 4px">No conversations yet.</div>';
      return;
    }
    listBox.innerHTML = sessions.map(s =>
      '<div class="session-item' + (s.id === currentSession ? " active" : "") + '" data-sid="' + esc(s.id) + '">' +
      '<div class="session-title">' + esc(s.title || "Untitled") + "</div>" +
      '<div class="session-meta">' + esc(fmtTime(s.updated_at)) +
      " · " + (s.message_count || 0) + " msgs</div>" +
      '<button class="session-del" data-del="' + esc(s.id) + '" title="Delete" aria-label="Delete conversation">' + (typeof Icon === "function" ? Icon("trash", { size: 14 }) : "") + '</button>' +
      "</div>"
    ).join("");
    listBox.querySelectorAll(".session-item").forEach(el => {
      el.addEventListener("click", e => {
        if (e.target.dataset.del) return;
        currentSession = el.dataset.sid;
        renderMessages();
        renderSessionList();
      });
    });
    listBox.querySelectorAll(".session-del").forEach(btn => {
      btn.addEventListener("click", async e => {
        e.stopPropagation();
        const sid = btn.dataset.del;
        if (!confirm("Delete this conversation?")) return;
        await MBDB.clearChat(sid).catch(() => {});
        if (navigator.onLine) {
          try { await fetch("/api/chat?session=" + encodeURIComponent(sid), { method: "DELETE" }); } catch (err) {}
        }
        if (currentSession === sid) currentSession = null;
        try { await SyncEngine.syncChat(); } catch (err) {}
        await renderAll();
      });
    });
  }

  async function renderMessages() {
    const box = document.getElementById("chat-messages");
    if (!box) return;
    if (!currentSession) {
      box.innerHTML = '<div class="empty-state"><div class="empty-ico">' + (typeof Icon === "function" ? Icon("robot", { size: 34 }) : "") + '</div><div class="t">Start a new chat</div>' +
        "<p>Ask about today's numbers, your week, commission, schedule — Buddy knows your data.</p></div>";
      return;
    }
    const msgs = await MBDB.getChatHistory(currentSession).catch(() => []);
    if (!msgs.length) {
      box.innerHTML = '<div class="empty-state"><div class="empty-ico">' + (typeof Icon === "function" ? Icon("robot", { size: 34 }) : "") + '</div><div class="t">Start a new chat</div>' +
        "<p>Ask about today's numbers, your week, commission, schedule — Buddy knows your data.</p></div>";
      return;
    }
    box.innerHTML = msgs.map(m =>
      '<div class="chat-msg ' + m.role + '"><div class="chat-bubble">' + esc(m.content) + "</div>" +
      '<div class="chat-ts">' + esc(fmtTime(m.ts)) + "</div></div>"
    ).join("");
    box.scrollTop = box.scrollHeight;
    // Re-attach confirm/decline cards for still-pending proposals.
    if (window.BuddyActions) {
      try { await BuddyActions.attachPendingCards(currentSession); } catch (e) {}
    }
  }

  function newSession() {
    currentSession = (crypto.randomUUID ? crypto.randomUUID()
      : "s" + Date.now().toString(36) + Math.random().toString(36).slice(2));
    renderMessages();
    renderSessionList();
    const inp = document.getElementById("chat-input");
    if (inp) inp.focus();
  }

  function addMessageEl(role, content, ts) {
    const box = document.getElementById("chat-messages");
    if (!box) return null;
    // Drop the empty-state placeholder on first message.
    const empty = box.querySelector(".empty-state");
    if (empty) box.innerHTML = "";
    const div = document.createElement("div");
    div.className = "chat-msg " + role;
    div.innerHTML = '<div class="chat-bubble">' + esc(content) + "</div>" +
      '<div class="chat-ts">' + esc(fmtTime(ts)) + "</div>";
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
    return div;
  }

  async function send(text) {
    if (!navigator.onLine) {
      addMessageEl("assistant", "You're offline — Buddy needs a connection to your AI server to reply. Your history is still here.", Date.now());
      return;
    }
    if (!currentSession) newSession();
    const sid = currentSession;
    sending = true;
    const sendBtn = document.getElementById("chat-send");
    if (sendBtn) sendBtn.disabled = true;
    const userTs = Date.now();
    // Optimistic local write (also survives if the request fails).
    await MBDB.addChatMessage(sid, "user", text).catch(() => {});
    addMessageEl("user", text, userTs);
    const typing = addMessageEl("assistant", "…", Date.now());
    if (typing) typing.querySelector(".chat-bubble").classList.add("typing");
    try {
      const res = await fetch("/api/ai-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sid, messages: [{ role: "user", content: text }] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ("request failed: " + res.status));
      // Structured actions: parse {"reply","actions"}, apply via the queue,
      // and render confirm/decline cards for proposals.
      let displayReply = data.reply, cardsHTML = "";
      if (window.BuddyActions) {
        try {
          const parsed = BuddyActions.parseResponse(data.reply);
          displayReply = parsed.reply;
          const result = await BuddyActions.applyActions(parsed.actions);
          if (result.applied.length) {
            displayReply += "\n" + result.applied.map(a => "- " + a).join("\n");
          }
          cardsHTML = BuddyActions.renderProposalCards(result);
        } catch (e) {
          console.warn("buddy actions failed:", e.message);
        }
      }
      // Server is canonical: it stored both sides. Mirror the reply locally
      // into the session the message was sent from (user may have switched).
      await MBDB.addChatMessage(sid, "assistant", displayReply).catch(() => {});
      if (currentSession === sid) {
        if (typing) typing.remove();
        const el = addMessageEl("assistant", displayReply, data.reply_ts || Date.now());
        if (el && cardsHTML) {
          const wrap = document.createElement("div");
          wrap.className = "proposal-wrap";
          wrap.innerHTML = cardsHTML;
          el.after(wrap);
          document.getElementById("chat-messages").scrollTop =
            document.getElementById("chat-messages").scrollHeight;
        }
      } else if (typing) {
        typing.remove();
      }
      // Refresh the session list (title may be new).
      try { await SyncEngine.syncChat(); } catch (e) {}
      await renderSessionList();
      if (currentSession === sid) await renderMessages();
    } catch (e) {
      if (typing) typing.remove();
      addMessageEl("assistant", "Couldn't reach Buddy: " + e.message, Date.now());
    } finally {
      sending = false;
      if (sendBtn) sendBtn.disabled = false;
    }
  }

  return { open, reset, newSession };
})();
