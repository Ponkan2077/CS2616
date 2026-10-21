/* ============================================================
   sw.js — Keeps the Bulk Upload page usable with zero signal, so
   photos can be grouped and queued on the phone (see
   offline_queue.js) and synced once a connection comes back.

   Take Photo (the single-capture page) is deliberately NOT cached
   here: it needs a live connection for GPS and AI analysis, so
   serving a stale copy of it offline would only dead-end the user.

   Served from /detection/sw.js rather than /static/js/sw.js on
   purpose: a service worker's scope can only be at or below the
   URL it's served from, and static files normally live under a
   separate /static/ prefix that would otherwise cap this at
   /static/js/ and never actually cover the page. See
   views.service_worker_js + urls.py.

   What gets cached:
   - /detection/bulk/ itself: network-first (so the farm list and
     CSRF token stay current online), cached copy used offline.
     Only clean 200 responses are stored -- never a login redirect
     or an error page, which would otherwise get served back as
     "the bulk page" the next time the phone is offline.
   - /static/ files and the CDN assets base.html loads (Bootstrap,
     icons, fonts, Leaflet, Chart.js): stale-while-revalidate, so
     the page is styled and scripted offline, not just present.
     The bulk page also asks us to cache everything it loaded
     (see precacheOfflineShell in offline_queue.js), so this works
     after the FIRST visit, not only the second.
   ============================================================ */

const CACHE_NAME = "rubberguard-offline-shell-v2";
const BULK_PATH = "/detection/bulk/";
const ASSET_HOSTS = [
  "cdn.jsdelivr.net",
  "unpkg.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
];

function isAssetUrl(url) {
  if (url.origin === self.location.origin) return url.pathname.startsWith("/static/");
  return ASSET_HOSTS.includes(url.hostname);
}

// Fetches a URL and stores it only if it's something worth serving
// later: a real 200 (not a redirect to /login/, not a 4xx/5xx), or an
// opaque cross-origin response (can't be inspected, but is how a CDN
// asset without CORS headers comes back).
async function cacheIfGood(cache, request) {
  let response;
  try {
    response = await fetch(request);
  } catch (err) {
    if (typeof request === "string" || request.mode === "cors") {
      // Retry without CORS for CDNs that don't send the header.
      response = await fetch(typeof request === "string" ? request : request.url, { mode: "no-cors" });
    } else {
      throw err;
    }
  }
  if (response.type === "opaque" || (response.ok && !response.redirected)) {
    await cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cacheIfGood(cache, BULK_PATH)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(names =>
      // Also clears the old "rubberguard-detection-shell-v1" cache that
      // held the single-capture page from before it went online-only.
      Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)))
    )
  );
  self.clients.claim();
});

// The bulk page asks us to cache everything it loaded (stylesheets,
// scripts, fonts) right after registering -- see precacheOfflineShell().
self.addEventListener("message", event => {
  const data = event.data;
  if (!data || data.type !== "precache" || !Array.isArray(data.urls)) return;
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.allSettled(
        data.urls
          .map(u => { try { return new URL(u, self.location.origin); } catch { return null; } })
          .filter(u => u && (isAssetUrl(u) || u.pathname === BULK_PATH))
          .map(u => cache.match(u.href).then(hit => hit || cacheIfGood(cache, u.href)))
      )
    )
  );
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return; // POSTs to analyze/save pass straight through
  const url = new URL(event.request.url);

  // The bulk page's own navigation: network-first.
  if (url.origin === self.location.origin && url.pathname === BULK_PATH) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async cache => {
        try {
          const response = await fetch(event.request);
          if (response.ok && !response.redirected) cache.put(BULK_PATH, response.clone());
          return response;
        } catch (err) {
          const cached = await cache.match(BULK_PATH);
          if (cached) return cached;
          throw err;
        }
      })
    );
    return;
  }

  // Static files and CDN assets: serve the cached copy immediately and
  // refresh it in the background. /static/ URLs carry ?v=<version>, so a
  // new deploy is a new URL and never gets a stale copy.
  if (isAssetUrl(url)) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async cache => {
        const cached = await cache.match(event.request, { ignoreVary: true });
        const refresh = cacheIfGood(cache, event.request).catch(() => null);
        if (cached) { event.waitUntil(refresh); return cached; }
        const fresh = await refresh;
        if (fresh) return fresh;
        throw new Error("offline and not cached");
      })
    );
  }
  // Everything else (other pages, /ping/, /api/, map tiles) is untouched.
});
