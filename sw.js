/* ============ sw.js — service worker for the Micro Buddy dashboard ============
 * Version-tied, network-first app shell:
 *  - The cache name carries the dashboard version, so every release drops the
 *    old shell on activate (no more stale narrow layouts after an update).
 *  - HTML, CSS and JS: network first, cache fallback (works offline, never
 *    serves an old layout while the server is reachable).
 *  - Icons / images: cache first (they rarely change).
 *  - /api/* and Supabase: never cached here. Offline data lives in IndexedDB
 *    (sync.js), so the worker must not hand out stale API responses.
 */
"use strict";

const VERSION = "2.0.7";
const SHELL_CACHE = "mb-shell-" + VERSION;

const SHELL_ASSETS = [
  "/", "/manifest.json", "/themes.css", "/components.css",
  "/icons.js", "/db.js", "/sb.js", "/sync.js", "/payengine.js", "/daydetail.js",
  "/stats.js", "/badges.js", "/sales.js", "/sale-entry.js", "/schedule.js", "/journal.js",
  "/coworkers.js", "/goals.js", "/microcharm.js", "/profile.js",
  "/leaderboard.js", "/brands.js", "/home-widgets.js", "/qrcode.min.js",
  "/settings.js", "/screen-lock.js", "/buddy-actions.js", "/buddy.js",
  "/icons/icon-og.png", "/icons/icon-192.png",
];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    // Best effort per asset: one missing file must not abort the install.
    await Promise.all(SHELL_ASSETS.map(u =>
      shell.add(new Request(u, { cache: "reload" })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k !== SHELL_CACHE ? caches.delete(k) : null)));
    await self.clients.claim();
  })());
});

function isShellCode(url, req) {
  if (req.mode === "navigate") return true;
  return /\.(?:html|css|js|json)$/.test(url.pathname) || url.pathname === "/";
}

async function networkFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(req, { cache: "no-store" });
    if (res && res.ok) cache.put(req.mode === "navigate" ? "/" : req, res.clone()).catch(() => {});
    return res;
  } catch (e) {
    const hit = await cache.match(req.mode === "navigate" ? "/" : req, { ignoreSearch: true });
    if (hit) return hit;
    throw e;
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
  return res;
}

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;       // Supabase etc.
  if (url.pathname.startsWith("/api/")) return;          // live data only
  if (url.pathname === "/logout" || url.pathname.startsWith("/widget")) return;
  if (isShellCode(url, req)) { event.respondWith(networkFirst(req)); return; }
  event.respondWith(cacheFirst(req));
});
