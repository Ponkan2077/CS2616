/* ============================================================
   offline_queue.js — Offline queue for BULK UPLOAD only.

   Take Photo (single capture) is online-only now: it needs a live
   connection for the device GPS fix and for AI analysis, so it no
   longer queues anything. Bulk Upload is different -- photos are
   already on the phone, their GPS (when they have any) is already
   inside the file, and grouping them into trees is all local work --
   so a whole farm visit can be prepared with zero signal, queued
   here in IndexedDB, and synced once a connection comes back.

   Loaded globally from base.html (after csrf.js), so a queue built
   on the farm syncs the moment the app is opened anywhere with
   signal -- not only if the person remembers to revisit Bulk Upload.

   Deliberately NOT built on the Background Sync API: it's
   Chrome/Android-only (no Safari/iOS support at all) and doesn't
   guarantee *when* it fires. "Sync on the 'online' event, on page
   load, when the tab becomes visible, plus a manual Sync Now
   button" is the combination that's actually dependable across
   devices.

   Analysis can't happen offline (it's a live call to the Cloud Run
   model), so a queued tree is analyzed AND saved in one pass at
   sync time, exactly like a normal online save -- nothing about how
   a synced tree ends up in the database is different.

   Old items queued by the previous offline Take Photo flow use the
   same database/record shape, so they still sync normally.
   ============================================================ */

const OFFLINE_DB_NAME = "rubberguard_offline";
const OFFLINE_DB_VERSION = 1;
const OFFLINE_STORE = "pending_scans";

// An automatic pass (page load, 'online' event, tab visible) won't
// re-attempt an item it tried less than this long ago, so a model host
// that's down doesn't get hit again on every single page navigation.
// Sync Now ignores this.
const AUTO_RETRY_COOLDOWN_MS = 60000;
// A request that hangs this long (dead connection that never errors) is
// treated as "offline" so one stuck fetch can't block the queue forever.
const SYNC_REQUEST_TIMEOUT_MS = 150000;

/* ---------- small helpers ---------- */

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Lightweight toast in the (previously unused) #toast-container from base.html.
function rgToast(message, kind) {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const palette = {
    success: ["#1c3a2e", "#4ade80"],
    error: ["#3b1f24", "#f87171"],
    info: ["#1e3a5f", "#7cb8ff"],
  }[kind || "info"];
  const el = document.createElement("div");
  el.setAttribute("role", "status");
  el.style.cssText = `background:${palette[0]};color:${palette[1]};border:1px solid ${palette[1]}66;` +
    "border-radius:10px;padding:10px 14px;margin-top:8px;font-size:12.5px;max-width:320px;" +
    "box-shadow:0 6px 20px rgba(0,0,0,.35);";
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 6500);
}

/* ---------- IndexedDB ---------- */

let offlineDbPromise = null;

function openOfflineDB() {
  if (!offlineDbPromise) {
    offlineDbPromise = new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) {
        reject(new Error("This browser can't store photos offline."));
        return;
      }
      const req = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(OFFLINE_STORE)) {
          db.createObjectStore(OFFLINE_STORE, { keyPath: "id", autoIncrement: true });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // One shared connection; let go of it if another tab upgrades the DB.
        db.onversionchange = () => { db.close(); offlineDbPromise = null; };
        resolve(db);
      };
      req.onerror = () => { offlineDbPromise = null; reject(req.error); };
    });
  }
  return offlineDbPromise;
}

// Runs fn(store) in one transaction and resolves with the request's result.
async function runStore(mode, fn) {
  const db = await openOfflineDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OFFLINE_STORE, mode);
    const req = fn(tx.objectStore(OFFLINE_STORE));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Offline storage transaction aborted."));
  });
}

function queueScan(record) {
  return runStore("readwrite", store => store.add({
    ...record, status: "pending", errorMessage: null, queuedAt: Date.now(),
  }));
}

function getAllQueuedScans() {
  return runStore("readonly", store => store.getAll());
}

function deleteQueuedScan(id) {
  return runStore("readwrite", store => store.delete(id));
}

// Read-modify-write inside ONE transaction, so a concurrent update can't
// slip in between the get and the put.
async function updateQueuedScan(id, patch) {
  const db = await openOfflineDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OFFLINE_STORE, "readwrite");
    const store = tx.objectStore(OFFLINE_STORE);
    let found = false;
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      if (getReq.result) { found = true; store.put({ ...getReq.result, ...patch }); }
    };
    tx.oncomplete = () => resolve(found);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Offline storage transaction aborted."));
  });
}

/* ---------- syncing ---------- */

// No usable connection (offline, dropped mid-request, or hung): the item
// is NOT broken, it just hasn't had a chance yet -- stays queued.
class NetworkError extends Error {}
// The server bounced us to /login/ (session expired, or a stale CSRF token
// -- Django's CSRF failure view also redirects there). Every remaining item
// would fail the same way, so the pass stops.
class SessionError extends Error {}

async function postForJson(url, formData, extraHeaders) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNC_REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "X-CSRFToken": getCsrfToken(), ...(extraHeaders || {}) },
      body: formData,
      credentials: "same-origin",
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof TypeError || err.name === "AbortError") throw new NetworkError("No connection");
    throw err; // e.g. getCsrfToken() couldn't find a token
  } finally {
    clearTimeout(timer);
  }

  if (res.redirected && /\/login\//.test(new URL(res.url).pathname)) {
    throw new SessionError("Your session expired. Log in again, then press Sync Now.");
  }
  let data = null;
  try { data = await res.json(); } catch (_) { /* not JSON -- handled below */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Server error (${res.status})`);
    err.status = res.status;
    throw err;
  }
  if (data === null) throw new Error("Unexpected response from the server.");
  return data;
}

// Replays one queued tree through the exact same two endpoints a live
// scan uses: analyze, then save. X-Requested-With tells save_detection()
// to respond with JSON instead of redirecting. Also used directly by
// bulk_detection.js for the online path.
async function syncOneScan(record) {
  const analyzeForm = new FormData();
  analyzeForm.append("root_image", record.rootBlob, record.rootBlob.name || "root.webp");
  analyzeForm.append("trunk_image", record.trunkBlob, record.trunkBlob.name || "trunk.webp");
  const analyzeData = await postForJson("/detection/analyze/", analyzeForm);

  const saveForm = new FormData();
  saveForm.append("farm_pk", record.farmPk);
  saveForm.append("tree_id", record.treeId || "");
  saveForm.append("disease", analyzeData.disease);
  saveForm.append("confidence", analyzeData.confidence);
  saveForm.append("root_condition", analyzeData.root_condition);
  saveForm.append("lat", record.lat);
  saveForm.append("lng", record.lng);
  const capturedAt = new Date(record.capturedAt);
  if (record.capturedAt && !isNaN(capturedAt)) saveForm.append("captured_at", capturedAt.toISOString());
  saveForm.append("root_image", record.rootBlob, record.rootBlob.name || "root.webp");
  saveForm.append("trunk_image", record.trunkBlob, record.trunkBlob.name || "trunk.webp");
  saveForm.append("csrfmiddlewaretoken", getCsrfToken());
  return postForJson("/detection/save/", saveForm, { "X-Requested-With": "XMLHttpRequest" });
}

let syncInFlight = false;

// Goes through the queue once, in sequence (not parallel -- a
// cold-starting Cloud Run instance handling several requests at once is
// slower overall than one at a time, and sequential is easier to reason
// about when several items fail for the same underlying reason).
//
// opts.manual (Sync Now): also retries items that previously failed
// outright, and ignores the auto-retry cooldown. Automatic passes leave
// "Failed" items alone so a permanently-bad one isn't re-analyzed on
// every page load.
//
// Returns { synced, failed, skipped } -- skipped is "busy", "offline" or
// "session" when the pass didn't (fully) run.
async function syncPendingScans(opts) {
  opts = opts || {};
  // Web Locks makes this safe across tabs too (two tabs syncing the same
  // item at once would save the tree twice); the flag is the fallback.
  if (navigator.locks && navigator.locks.request) {
    return navigator.locks.request("rubberguard-sync", { ifAvailable: true }, lock =>
      lock ? runSyncPass(opts) : { synced: 0, failed: 0, skipped: "busy" });
  }
  if (syncInFlight) return { synced: 0, failed: 0, skipped: "busy" };
  syncInFlight = true;
  try { return await runSyncPass(opts); } finally { syncInFlight = false; }
}

async function runSyncPass(opts) {
  // Probe first: marking every queued item "failed" because the phone only
  // *thought* it was online is exactly the bug this guards against.
  if (!(await isActuallyOnline())) return { synced: 0, failed: 0, skipped: "offline" };

  const items = await getAllQueuedScans();
  let synced = 0;
  let failed = 0;
  let stopped = null;

  for (const item of items) {
    if (!opts.manual) {
      if (item.status === "error") continue;
      if (item.lastAttemptAt && Date.now() - item.lastAttemptAt < AUTO_RETRY_COOLDOWN_MS) continue;
    }
    // A "syncing" item found here (no other pass holds the lock) was left
    // behind by an interrupted pass -- page closed, connection dropped --
    // so it's retried like any other instead of sticking on "Syncing...".
    await updateQueuedScan(item.id, { status: "syncing", errorMessage: null, lastAttemptAt: Date.now() });
    renderPendingScans();
    try {
      await syncOneScan(item);
      await deleteQueuedScan(item.id);
      synced++;
    } catch (err) {
      // lastAttemptAt: 0 on the first two = "this never really got a try":
      // no cooldown, so the very next trigger (connection back, or the
      // person logging in again) retries immediately instead of waiting out
      // AUTO_RETRY_COOLDOWN_MS. Only genuine server-side failures cool down.
      if (err instanceof NetworkError) {
        await updateQueuedScan(item.id, { status: "pending", lastAttemptAt: 0 });
        stopped = "offline";
      } else if (err instanceof SessionError) {
        await updateQueuedScan(item.id, { status: "pending", errorMessage: err.message, lastAttemptAt: 0 });
        stopped = "session";
      } else if (err.status >= 500) {
        // Model host cold-starting/down, or a transient server error --
        // worth another try later, not a permanent failure.
        await updateQueuedScan(item.id, { status: "pending", errorMessage: `${err.message} -- will retry` });
        failed++;
      } else {
        await updateQueuedScan(item.id, { status: "error", errorMessage: err.message || "Sync failed" });
        failed++;
      }
    }
    renderPendingScans();
    if (stopped) break;
  }

  if (synced) rgToast(`Synced ${synced} queued tree${synced === 1 ? "" : "s"}.`, "success");
  if (failed) rgToast(`${failed} queued tree${failed === 1 ? "" : "s"} couldn't sync. Open Bulk Upload to review.`, "error");
  if (stopped === "session") rgToast("Session expired. Log in again to sync your queued trees.", "error");
  return { synced, failed, skipped: stopped };
}

// Kicks off a pass only when there's actually something worth trying.
async function maybeAutoSync() {
  try {
    const items = await getAllQueuedScans();
    if (items.some(i => i.status !== "error")) syncPendingScans();
  } catch (_) { /* IndexedDB unavailable -- nothing could have been queued */ }
}

/* ---------- Pending Sync card (bulk_upload.html) ---------- */

function formatRelativeTime(epochMs) {
  const diffMin = Math.round((Date.now() - epochMs) / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.round(diffHr / 24)}d ago`;
}

// Data only ever lives in IndexedDB, so this list has to be built
// client-side -- there's nothing for the server to render here.
async function renderPendingScans() {
  const section = document.getElementById("pending-scans-section");
  const list = document.getElementById("pending-scans-list");
  const countBadge = document.getElementById("pending-scans-count");
  if (!section || !list) return;

  let items;
  try { items = await getAllQueuedScans(); } catch (_) { return; }
  if (countBadge) countBadge.textContent = items.length;
  section.style.display = items.length ? "" : "none";
  if (!items.length) return;

  list.innerHTML = items.map(item => {
    const statusHtml = {
      pending: '<span class="badge-disease" style="background:#3b3020;color:#e0b84a;">Waiting to sync</span>',
      syncing: '<span class="badge-disease" style="background:#1e3a5f;color:#7cb8ff;"><i class="bi bi-arrow-repeat"></i> Syncing…</span>',
      error: '<span class="badge-disease" style="background:#3b1f24;color:#f87171;">Failed</span>',
    }[item.status] || "";

    const noteColor = item.status === "error" ? "text-danger" : "text-warning";
    const noteLine = item.errorMessage
      ? `<div class="${noteColor} mt-1" style="font-size:11px;">${escapeHtml(item.errorMessage)}</div>` : "";

    return `
      <div class="d-flex justify-content-between align-items-start py-2 border-bottom" style="border-color:var(--border)!important;">
        <div>
          <div style="font-size:13px;">${escapeHtml(item.treeId) || "(auto tree ID)"}</div>
          <div class="text-muted" style="font-size:11px;">
            Captured ${formatRelativeTime(item.capturedAt || item.queuedAt)} · GPS via ${escapeHtml(item.gpsSource)} · ${statusHtml}
          </div>
          ${noteLine}
        </div>
        <div class="d-flex gap-1">
          <button class="btn btn-sm btn-outline-danger" style="font-size:11px;padding:2px 8px;" onclick="discardQueuedScan(${Number(item.id)})">
            <i class="bi bi-trash"></i>
          </button>
        </div>
      </div>`;
  }).join("");
}

function discardQueuedScan(id) {
  if (!confirm("Discard this queued tree? It hasn't been saved anywhere yet.")) return;
  deleteQueuedScan(id).then(renderPendingScans);
}

/* ---------- connectivity ---------- */

// Real reachability check, not navigator.onLine -- that flag only says the
// device has *some* network link, not that this server is reachable, and
// can get stuck misreporting in either direction after a screen wake or
// network switch. /ping/ answers 204 with no DB/template work; requiring
// exactly 204 also rejects a captive portal's 200 "please sign in" page.
async function isActuallyOnline() {
  if (typeof fetch !== "function") return navigator.onLine; // can't probe -- best guess
  try {
    const fetchPromise = fetch("/ping/", { method: "GET", cache: "no-store" });
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 4000));
    const res = await Promise.race([fetchPromise, timeoutPromise]);
    return res.status === 204;
  } catch {
    return false;
  }
}

let connectivityCheckId = 0;
// Last known result of the probe; undefined until the first one finishes.
// disease_detection.js reads this (and the rg:connectivity event) to block
// Take Photo while offline.
window.rgOnline = undefined;

async function updateConnectivityBanner() {
  const banner = document.getElementById("offline-banner");
  if (!banner) return;
  // Multiple triggers (interval, online/offline events, visibility change)
  // can each kick off their own overlapping check. If an older, slower
  // check (e.g. one that has to wait out the full 4s timeout because it
  // started while genuinely offline) resolves AFTER a newer, faster one,
  // its stale result would clobber the correct state. This id guard makes
  // only the most recently STARTED check allowed to touch the banner.
  const myCheckId = ++connectivityCheckId;
  const online = await isActuallyOnline();
  if (myCheckId !== connectivityCheckId) return;

  // The banner uses Bootstrap's "d-flex" for layout, and Bootstrap's
  // display utilities are all `display: ... !important` -- a plain
  // banner.style.display assignment can NEVER win against that. So the
  // class is toggled (backed by an !important inline override to hide).
  banner.classList.toggle("d-flex", !online);
  if (online) {
    banner.style.setProperty("display", "none", "important");
  } else {
    banner.style.removeProperty("display");
  }
  window.rgOnline = online;
  document.dispatchEvent(new CustomEvent("rg:connectivity", { detail: { online } }));
}

/* ---------- offline page shell (Bulk Upload) ---------- */

// Registers sw.js and asks it to cache everything this page loaded, so the
// page works offline after the FIRST visit (without this, the service
// worker only sees assets requested after it takes control, i.e. the second
// visit). Called from bulk_upload.html.
async function enableOfflineShell(swUrl) {
  if (!("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register(swUrl, { scope: "/detection/" });
    await navigator.serviceWorker.ready;
    const target = reg.active || navigator.serviceWorker.controller;
    if (!target) return;
    const urls = new Set([location.pathname]);
    document.querySelectorAll('link[rel="stylesheet"][href], script[src]').forEach(el => urls.add(el.href || el.src));
    performance.getEntriesByType("resource").forEach(e => urls.add(e.name));
    target.postMessage({ type: "precache", urls: [...urls] });
  } catch (_) {
    // Offline page caching just won't be available this session. Queuing
    // still works on a page that's already loaded.
  }
}

/* ---------- wiring ---------- */

document.addEventListener("DOMContentLoaded", async () => {
  if (document.getElementById("offline-banner")) await updateConnectivityBanner();
  renderPendingScans();
  // Covers a queue built in an earlier, fully-offline session where the app
  // is only now being reopened somewhere with signal.
  maybeAutoSync();

  const syncBtn = document.getElementById("sync-now-btn");
  if (syncBtn) {
    syncBtn.addEventListener("click", async () => {
      syncBtn.disabled = true;
      try {
        const result = await syncPendingScans({ manual: true });
        if (result && result.skipped === "offline") rgToast("Still offline. Your trees stay queued and will sync once there's a connection.", "error");
        else if (result && result.skipped === "busy") rgToast("A sync is already running.", "info");
      } finally {
        syncBtn.disabled = false;
      }
    });
  }

  // Re-probes every 15s while the banner says "offline" -- recovers from
  // the navigator.onLine stuck-true/stuck-false problem, since the 'online'
  // event doesn't reliably fire in every case that flips it back.
  setInterval(() => {
    const banner = document.getElementById("offline-banner");
    if (banner && banner.style.display !== "none") {
      updateConnectivityBanner().then(() => {
        if (window.rgOnline) maybeAutoSync();
      });
    }
  }, 15000);
});

window.addEventListener("online", () => {
  updateConnectivityBanner();
  maybeAutoSync();
});
window.addEventListener("offline", updateConnectivityBanner);

// Mobile browsers can restore this page from a frozen snapshot (bfcache)
// when you switch apps/tabs and come back, with no timers ticking to fix a
// stale banner. Both events below force a fresh check the instant the page
// becomes visible/resumed again -- and are also the natural moment to sync
// a queue built while the phone was offline in another app.
window.addEventListener("pageshow", (event) => {
  if (event.persisted) { updateConnectivityBanner(); maybeAutoSync(); }
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") { updateConnectivityBanner(); maybeAutoSync(); }
});
