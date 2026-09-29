/* ============ sw.js — service worker for Micro Buddy PWA ============
 * App-shell caching strategy:
 *  - First-party shell (/, dashboard.html, manifest.json, *.js, icons):
 *      cache-first, refreshed in the background (stale-while-revalidate).
 *  - Chart.js CDN: cache-first (versioned URL = immutable).
 *  - Apple SDK: network-only (auth requires network anyway; never stale-cache it).
 *  - /api/* : network-only. Offline data comes from IndexedDB via sync.js —
 *      the service worker must NOT serve stale API responses.
 */
"use strict";

const SHELL_CACHE = "mb-shell-v3";
const CDN_CACHE = "mb-cdn-v1";

const SHELL_ASSETS = [
  "/",
  "/dashboard.html",
  "/manifest.json",
  "/themes.css",
  "/db.js",
  "/sync.js",
  "/qrcode.min.js",
  "/settings.js",
  "/buddy.js",
];

const CDN_ASSETS = [
  "https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js",
];

self.addEventListener("install", event => {
  event.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL_CACHE);
      await shell.addAll(SHELL_ASSETS.map(u => new Request(u, { cache: "reload" })));
      const cdn = await caches.open(CDN_CACHE);
      await Promise.all(CDN_ASSETS.map(async u => {
        try { await cdn.add(new Request(u, { mode: "no-cors", cache: "reload" })); }
        catch (e) { console.warn("[sw] cdn pre-cache failed:", u); }
      }));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => {
        if (k !== SHELL_CACHE && k !== CDN_CACHE) return caches.delete(k);
        return null;
      }));
      await self.clients.claim();
    })()
  );
});

function isApi(url) { return url.pathname.startsWith("/api/"); }
function isAppleSdk(url) { return url.hostname === "appleid.cdn-apple.com"; }
function isCdnAsset(url) {
  return CDN_ASSETS.some(a => url.href === a || url.href.startsWith(a));
}
function isShellAsset(url) {
  if (url.origin !== self.location.origin) return false;
  const p = url.pathname;
  return p === "/" || p === "/dashboard.html" || p === "/manifest.json" ||
    p.endsWith(".js") || p.startsWith("/icons/");
}

self.addEventListener("fetch", event => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  // API + Apple SDK: always network (offline data is served from IndexedDB).
  if (isApi(url) || isAppleSdk(url)) return;

  // Versioned CDN libs: cache-first.
  if (isCdnAsset(url)) {
    event.respondWith(
      caches.open(CDN_CACHE).then(cache =>
        cache.match(request).then(hit => {
          if (hit) return hit;
          return fetch(request).then(res => {
            if (res.ok || res.type === "opaque") cache.put(request, res.clone());
            return res;
          });
        })
      )
    );
    return;
  }

  // App shell: stale-while-revalidate.
  if (isShellAsset(url)) {
    event.respondWith(
      caches.open(SHELL_CACHE).then(cache =>
        cache.match(request).then(hit => {
          const net = fetch(request).then(res => {
            if (res.ok) cache.put(request, res.clone());
            return res;
          }).catch(() => hit); // offline: fall back to cache (may be undefined)
          return hit || net;
        })
      )
    );
    return;
  }
  // Everything else: passthrough.
});
