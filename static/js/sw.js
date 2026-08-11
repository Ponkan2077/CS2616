/* ============================================================
   sw.js — Caches just the /detection/ page shell so it still
   loads with zero signal (the offline scan queue in
   offline_queue.js is only useful if the capture form itself is
   reachable offline in the first place).

   Served from /detection/sw.js rather than /static/js/sw.js on
   purpose: a service worker's scope can only be at or below the
   URL it's served from, and static files normally live under a
   separate /static/ prefix that would otherwise cap this at
   /static/js/ and never actually cover the page. See
   views.service_worker_js + urls.py.

   Deliberately doesn't try to cache the static JS/CSS files --
   those are already served with far-future cache headers under a
   versioned URL (?v=...), so the browser's own HTTP cache already
   keeps them around without a service worker's help. This only
   handles the one thing that actually needs it: the dynamically
   rendered HTML page itself.
   ============================================================ */

const CACHE_NAME = "rubberguard-detection-shell-v1";

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.add("/detection/")).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);

  // Only the detection page's own GET navigation is handled here.
  // Everything else -- POSTs to analyze/save/upload-url, other pages,
  // admin, etc. -- passes straight through untouched. A failed
  // analyze/save POST can't be served from a cache anyway; that's what
  // the offline queue in offline_queue.js is for.
  if (event.request.method !== "GET" || !url.pathname.startsWith("/detection")) return;

  event.respondWith(
    fetch(event.request)
      .then(networkResponse => {
        // Network-first: always prefer a live copy when there's a
        // connection (so the farm list, CSRF token, etc. stay current),
        // and refresh the cached fallback as a side effect.
        const copy = networkResponse.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        return networkResponse;
      })
      .catch(() => caches.match(event.request).then(cached => cached || caches.match("/detection/")))
  );
});
