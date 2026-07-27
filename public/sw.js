/**
 * Reel Service Worker
 *
 * Caching strategy:
 *   - Navigation (HTML) requests:        network-first, fallback to cache
 *   - Same-origin static assets:         stale-while-revalidate
 *   - API requests (/api/*):             network-only (no caching)
 *   - Cross-origin requests:             pass-through (no caching)
 *
 * Vanilla JS (no Workbox). Bump CACHE_NAME on deploys to invalidate caches.
 */

const CACHE_NAME = "reel-v1";

const PRECACHE_URLS = [
  "/",
  "/logo.svg",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
];

// --- Install: precache core assets ----------------------------------------
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // Use { cache: "reload" } to bypass HTTP cache for fresh precache.
      await Promise.all(
        PRECACHE_URLS.map(async (url) => {
          try {
            const res = await fetch(url, { cache: "reload" });
            if (res && res.ok) {
              await cache.put(url, res.clone());
            }
          } catch (_err) {
            // Skip failed precache entries — don't fail install.
          }
        })
      );
      await self.skipWaiting();
    })()
  );
});

// --- Activate: clean up old caches ----------------------------------------
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

// --- Fetch: route by request type -----------------------------------------
self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Only handle GET; let the browser handle POST/PUT/etc. normally.
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Cross-origin: pass-through, never cache.
  if (url.origin !== self.location.origin) return;

  // API requests: network-only — don't cache dynamic data.
  if (url.pathname.startsWith("/api/")) return;

  // Navigation (HTML document) requests: network-first, fallback to cache,
  // and finally to the cached "/" shell for offline support.
  if (req.mode === "navigate") {
    event.respondWith(networkFirstNavigation(event));
    return;
  }

  // Same-origin static assets (and everything else same-origin):
  // stale-while-revalidate.
  event.respondWith(staleWhileRevalidate(event));
});

// --- Helpers ---------------------------------------------------------------

function isStaticAsset(req, url) {
  const assetExtensions = [
    ".js",
    ".css",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".svg",
    ".ico",
    ".woff",
    ".woff2",
    ".ttf",
    ".eot",
    ".otf",
  ];
  return (
    req.destination === "style" ||
    req.destination === "script" ||
    req.destination === "image" ||
    req.destination === "font" ||
    assetExtensions.some((ext) => url.pathname.endsWith(ext))
  );
}

async function networkFirstNavigation(event) {
  const req = event.request;
  try {
    const networkRes = await fetch(req);
    const cache = await caches.open(CACHE_NAME);
    cache.put(req, networkRes.clone()).catch(() => {});
    return networkRes;
  } catch (_err) {
    // Offline: try the exact navigation cache, then fall back to "/".
    const cached = await caches.match(req);
    if (cached) return cached;
    const fallback = await caches.match("/");
    if (fallback) return fallback;
    return new Response(
      "<h1>Offline</h1><p>Reel is not available offline right now.</p>",
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }
}

async function staleWhileRevalidate(event) {
  const req = event.request;
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);

  const networkPromise = fetch(req)
    .then((networkRes) => {
      // Only cache valid same-origin successful basic responses.
      if (networkRes && networkRes.ok && networkRes.type === "basic") {
        cache.put(req, networkRes.clone()).catch(() => {});
      }
      return networkRes;
    })
    .catch(() => null);

  // Serve from cache immediately if available; otherwise wait for network.
  if (cached) {
    // Revalidate in the background.
    event.waitUntil(networkPromise);
    return cached;
  }

  const networkRes = await networkPromise;
  if (networkRes) return networkRes;

  // Last resort: nothing cached and network failed.
  return new Response("", { status: 504, statusText: "Gateway Timeout" });
}

// --- Allow page to trigger immediate activation ----------------------------
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
