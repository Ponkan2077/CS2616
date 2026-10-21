/* ============================================================
   csrf.js — Shared CSRF token helper. Loaded globally from
   base.html (before main.js), so every page can call
   getCsrfToken() -- the notification bell click handler in
   main.js used to call it on pages that never loaded this file,
   which silently broke notification clicks everywhere except the
   detection/bulk pages.

   Reads the csrftoken COOKIE first (Django's documented approach
   for AJAX), falling back to a hidden form input. The cookie is
   always current, whereas a form token baked into a cached page
   (e.g. the offline bulk-upload shell served by sw.js) can go
   stale after a re-login -- which would make queued uploads fail
   their sync with a CSRF error.
   ============================================================ */

function getCsrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
  if (match) return decodeURIComponent(match[1]);
  const input = document.querySelector("input[name=csrfmiddlewaretoken]");
  if (input && input.value) return input.value;
  throw new Error("Security token missing -- reload the page and try again.");
}
