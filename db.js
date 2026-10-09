"use strict";
/* ============ db.js — IndexedDB local data layer for Micro Buddy PWA ============
 * Stores (all offline-first):
 *   "apiCache" — generic API response cache, keyed by exact request path:
 *       key   = request path, e.g. "/api/days?start=2026-01-01&end=2026-09-28&limit=200"
 *       value = { path, data, kind, cachedAt }
 *   "kv" — small key/values: lastSync, fullSyncDone, profile, theme.
 *       NOTE: AI config is SERVER-ONLY and must never be written here.
 *   "chat" (v2) — Buddy chat history, survives offline:
 *       value = { id (auto), session, role ("user"|"assistant"), content, ts }
 *       index on "session" for per-conversation reads.
 *   "writeQueue" (v3) — offline mutations waiting to sync to Supabase:
 *       value = { id (auto), op, ts }
 *       op = { type: 'addTicket'|'addLine'|'deleteLine'|'updateLine'|'setDayNote', ... }
 */
const MBDB = (() => {
  const DB_NAME = "microbuddy";
  const DB_VERSION = 3;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("apiCache")) {
          db.createObjectStore("apiCache", { keyPath: "path" });
        }
        if (!db.objectStoreNames.contains("kv")) {
          db.createObjectStore("kv", { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains("chat")) {
          const chat = db.createObjectStore("chat", { keyPath: "id", autoIncrement: true });
          chat.createIndex("session", "session", { unique: false });
        }
        if (!db.objectStoreNames.contains("writeQueue")) {
          db.createObjectStore("writeQueue", { keyPath: "id", autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("indexedDB open failed"));
    });
    return dbp;
  }

  function run(store, mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      let req;
      const t = db.transaction(store, mode);
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error || new Error("transaction failed"));
      t.onabort = () => reject(t.error || new Error("transaction aborted"));
      try {
        req = fn(t.objectStore(store));
      } catch (e) {
        reject(e);
      }
    }));
  }

  // ---- apiCache ----
  async function putCache(path, data, kind) {
    await run("apiCache", "readwrite", os =>
      os.put({ path, data, kind: kind || "api", cachedAt: Date.now() }));
  }
  async function getCache(path) {
    return run("apiCache", "readonly", os => os.get(path));
  }
  async function getAllCachedPaths() {
    const keys = await run("apiCache", "readonly", os => os.getAllKeys());
    return keys || [];
  }
  async function getCacheCount() {
    const n = await run("apiCache", "readonly", os => os.count());
    return n || 0;
  }
  async function clearCache() {
    await run("apiCache", "readwrite", os => os.clear());
  }
  async function deleteCache(path) {
    await run("apiCache", "readwrite", os => os.delete(path));
  }

  /// Full unlink wipe: every local store plus web storage, so no trace of
  /// the account remains on this browser. Used when the phone unlinks this
  /// dashboard (POST /api/pair/revoke) and on manual sign-out.
  async function wipeAll() {
    for (const store of ["apiCache", "kv", "chat", "writeQueue"]) {
      try { await run(store, "readwrite", os => os.clear()); } catch (e) {}
    }
    try { localStorage.clear(); } catch (e) {}
    try { sessionStorage.clear(); } catch (e) {}
  }

  // ---- kv ----
  // Only non-sensitive preferences belong here. AI config is server-only.
  async function kvSet(key, value) {
    if (key === "ai_config" || key === "aiConfig") {
      throw new Error("AI config must not be stored on the device");
    }
    await run("kv", "readwrite", os => os.put({ key, value, updatedAt: Date.now() }));
  }
  async function kvGet(key) {
    const rec = await run("kv", "readonly", os => os.get(key));
    return rec ? rec.value : null;
  }
  async function kvDelete(key) {
    await run("kv", "readwrite", os => os.delete(key));
  }

  // ---- chat history (Buddy) ----
  async function addChatMessage(session, role, content) {
    const id = await run("chat", "readwrite", os =>
      os.add({ session, role, content, ts: Date.now() }));
    return id;
  }
  async function getChatHistory(session, limit) {
    const all = await run("chat", "readonly", os => {
      const idx = os.index("session");
      return idx.getAll(IDBKeyRange.only(session));
    });
    const sorted = (all || []).sort((a, b) => a.ts - b.ts || a.id - b.id);
    return typeof limit === "number" ? sorted.slice(-limit) : sorted;
  }
  async function clearChat(session) {
    const all = await run("chat", "readonly", os => {
      const idx = os.index("session");
      return idx.getAllKeys(IDBKeyRange.only(session));
    });
    if (all && all.length) {
      await run("chat", "readwrite", os => {
        all.forEach(id => os.delete(id));
        return null;
      });
    }
  }
  // Replace a whole session's messages (server is canonical on sync).
  // messages: [{role, content, ts}]
  async function replaceChatSession(session, messages) {
    await run("chat", "readwrite", os => {
      const idx = os.index("session");
      const getReq = idx.getAllKeys(IDBKeyRange.only(session));
      getReq.onsuccess = () => {
        (getReq.result || []).forEach(id => os.delete(id));
        (messages || []).forEach(m => {
          if (m && (m.role === "user" || m.role === "assistant")
              && typeof m.content === "string") {
            os.add({ session, role: m.role, content: m.content,
                     ts: Number(m.ts) || Date.now() });
          }
        });
      };
      return getReq;
    });
  }
  async function listChatSessions() {
    const all = await run("chat", "readonly", os => os.getAll());
    const seen = {};
    (all || []).forEach(m => { seen[m.session] = Math.max(seen[m.session] || 0, m.ts); });
    return Object.keys(seen).sort((a, b) => seen[b] - seen[a]);
  }

  // ---- write queue (offline mutations) ----
  async function queueWrite(op) {
    const id = await run("writeQueue", "readwrite", os =>
      os.add({ op, ts: Date.now() }));
    return id;
  }
  async function getWriteQueue() {
    const all = await run("writeQueue", "readonly", os => os.getAll());
    return (all || []).sort((a, b) => a.ts - b.ts || a.id - b.id);
  }
  async function clearWriteQueue(ids) {
    if (!ids || !ids.length) {
      await run("writeQueue", "readwrite", os => os.clear());
      return;
    }
    await run("writeQueue", "readwrite", os => {
      ids.forEach(id => os.delete(id));
      return null;
    });
  }
  async function writeQueueCount() {
    const n = await run("writeQueue", "readonly", os => os.count());
    return n || 0;
  }

  return {
    open, putCache, getCache, getAllCachedPaths, getCacheCount, clearCache,
    deleteCache, wipeAll,
    kvSet, kvGet, kvDelete, addChatMessage, getChatHistory, clearChat, listChatSessions,
    replaceChatSession, queueWrite, getWriteQueue, clearWriteQueue, writeQueueCount,
  };
})();
