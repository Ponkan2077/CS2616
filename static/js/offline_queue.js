/* ============================================================
   offline_queue.js — Lets a scan be captured with zero signal
   (common out in the farm) and synced automatically once the
   phone reconnects, instead of the capture flow just failing.

   Deliberately NOT built on the Background Sync API: it's
   Chrome/Android-only (no Safari/iOS support at all), needs a
   registered service worker plus a permission grant, and doesn't
   guarantee *when* it fires. For a system that has to reliably
   work on whatever phone a farmer/inspector is holding, "sync on
   the 'online' event, retry on page load, plus a manual Sync Now
   button" is the combination that's actually dependable across
   devices -- not the fancier-sounding option.

   Analysis can't happen offline at all (it's a live call to the
   Cloud Run model), so a queued scan is analyzed AND saved in one
   pass at sync time, exactly like a normal online scan -- nothing
   about how a synced tree ends up in the database is different
   from one saved live.
   ============================================================ */

const OFFLINE_DB_NAME = "rubberguard_offline";
const OFFLINE_DB_VERSION = 1;
const OFFLINE_STORE = "pending_scans";

function openOfflineDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(OFFLINE_STORE)) {
        db.createObjectStore(OFFLINE_STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openOfflineDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OFFLINE_STORE, mode);
    const store = tx.objectStore(OFFLINE_STORE);
    const result = fn(store);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  });
}

function queueScan(record) {
  return withStore("readwrite", store => store.add({ ...record, status: "pending", errorMessage: null }));
}

function getAllQueuedScans() {
  return new Promise(async (resolve, reject) => {
    const db = await openOfflineDB();
    const tx = db.transaction(OFFLINE_STORE, "readonly");
    const req = tx.objectStore(OFFLINE_STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function deleteQueuedScan(id) {
  return withStore("readwrite", store => store.delete(id));
}

function updateQueuedScan(id, patch) {
  return new Promise(async (resolve, reject) => {
    const db = await openOfflineDB();
    const tx = db.transaction(OFFLINE_STORE, "readwrite");
    const store = tx.objectStore(OFFLINE_STORE);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const existing = getReq.result;
      if (!existing) { resolve(null); return; }
      store.put({ ...existing, ...patch });
    };
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

// Replays one queued scan through the exact same two endpoints a live
// scan uses: analyze, then save. X-Requested-With tells save_detection()
// to respond with JSON instead of redirecting, since there's no page
// navigation happening here.
async function syncOneScan(record) {
  const analyzeForm = new FormData();
  analyzeForm.append("root_image", record.rootBlob);
  analyzeForm.append("trunk_image", record.trunkBlob);

  const analyzeRes = await fetch("/detection/analyze/", {
    method: "POST",
    headers: { "X-CSRFToken": getCsrfToken() },
    body: analyzeForm,
  });
  const analyzeData = await analyzeRes.json();
  if (!analyzeRes.ok) throw new Error(analyzeData.error || "Analysis failed");

  const saveForm = new FormData();
  saveForm.append("farm_pk", record.farmPk);
  saveForm.append("tree_id", record.treeId || "");
  saveForm.append("block", record.block || "");
  saveForm.append("disease", analyzeData.disease);
  saveForm.append("confidence", analyzeData.confidence);
  saveForm.append("root_condition", analyzeData.root_condition);
  saveForm.append("lat", record.lat);
  saveForm.append("lng", record.lng);
  saveForm.append("root_image", record.rootBlob);
  saveForm.append("trunk_image", record.trunkBlob);
  saveForm.append("csrfmiddlewaretoken", getCsrfToken());

  const saveRes = await fetch("/detection/save/", {
    method: "POST",
    headers: { "X-CSRFToken": getCsrfToken(), "X-Requested-With": "XMLHttpRequest" },
    body: saveForm,
  });
  const saveData = await saveRes.json().catch(() => ({}));
  if (!saveRes.ok) throw new Error(saveData.error || "Save failed");
  return saveData;
}

let syncInFlight = false;

// Goes through every queued scan once, in sequence (not parallel -- a
// cold-starting Cloud Run instance handling several requests at once is
// slower overall than one at a time, and sequential is easier to reason
// about when several items fail for the same underlying reason, like
// still actually being offline despite the 'online' event firing).
async function syncPendingScans() {
  if (syncInFlight) return;
  syncInFlight = true;
  try {
    const items = await getAllQueuedScans();
    for (const item of items.filter(i => i.status !== "syncing")) {
      await updateQueuedScan(item.id, { status: "syncing", errorMessage: null });
      renderPendingScans();
      try {
        await syncOneScan(item);
        await deleteQueuedScan(item.id);
      } catch (err) {
        await updateQueuedScan(item.id, { status: "error", errorMessage: err.message || "Sync failed" });
      }
      renderPendingScans();
    }
  } finally {
    syncInFlight = false;
  }
}

function formatRelativeTime(epochMs) {
  const diffMin = Math.round((Date.now() - epochMs) / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.round(diffHr / 24)}d ago`;
}

// Renders the Pending Scans card (see disease_detection.html). Data only
// ever lives in IndexedDB, so this list has to be built client-side --
// there's nothing for the server to render here.
async function renderPendingScans() {
  const section = document.getElementById("pending-scans-section");
  const list = document.getElementById("pending-scans-list");
  const countBadge = document.getElementById("pending-scans-count");
  if (!section || !list) return;

  const items = await getAllQueuedScans();
  countBadge.textContent = items.length;
  section.style.display = items.length ? "" : "none";
  if (!items.length) return;

  list.innerHTML = items.map(item => {
    const statusHtml = {
      pending: '<span class="badge-disease" style="background:#3b3020;color:#e0b84a;">Pending</span>',
      syncing: '<span class="badge-disease" style="background:#1e3a5f;color:#7cb8ff;"><i class="bi bi-arrow-repeat"></i> Syncing…</span>',
      error: '<span class="badge-disease" style="background:#3b1f24;color:#f87171;">Failed</span>',
    }[item.status] || "";

    const errorLine = item.status === "error" && item.errorMessage
      ? `<div class="text-danger mt-1" style="font-size:11px;">${item.errorMessage}</div>` : "";

    return `
      <div class="d-flex justify-content-between align-items-start py-2 border-bottom" style="border-color:var(--border)!important;">
        <div>
          <div style="font-size:13px;">${item.treeId || "(auto tree ID)"} — Block ${item.block || "—"}</div>
          <div class="text-muted" style="font-size:11px;">
            Captured ${formatRelativeTime(item.capturedAt)} · GPS via ${item.gpsSource} · ${statusHtml}
          </div>
          ${errorLine}
        </div>
        <div class="d-flex gap-1">
          <button class="btn btn-sm btn-outline-danger" style="font-size:11px;padding:2px 8px;" onclick="discardQueuedScan(${item.id})">
            <i class="bi bi-trash"></i>
          </button>
        </div>
      </div>`;
  }).join("");
}

function discardQueuedScan(id) {
  if (!confirm("Discard this queued scan? It hasn't been saved anywhere yet.")) return;
  deleteQueuedScan(id).then(renderPendingScans);
}

// Shows/hides the top-of-page connectivity banner and (re)triggers a sync
// pass once we've actually confirmed the connection, not just on
// navigator.onLine's say-so -- that flag reflects whether the device has
// *any* network link, not whether this server is reachable. It can also
// get stuck: it flips true/false on OS-level link changes, so if it read
// false for a moment (waking from sleep, switching from mobile data to
// WiFi) and no further transition fires afterward, the banner stays
// stuck showing "offline" indefinitely even once the connection is fine.
async function isActuallyOnline() {
  if (!navigator.onLine) return false; // no link at all -- no point probing
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch("/detection/", { method: "HEAD", cache: "no-store", signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

async function updateConnectivityBanner() {
  const banner = document.getElementById("offline-banner");
  if (!banner) return;
  const online = await isActuallyOnline();
  banner.style.display = online ? "none" : "";
}

document.addEventListener("DOMContentLoaded", async () => {
  await updateConnectivityBanner();
  renderPendingScans();
  // Covers the case where scans were queued in a previous, fully-offline
  // session and the app is only now being reopened somewhere with signal.
  if (navigator.onLine) syncPendingScans();

  const syncBtn = document.getElementById("sync-now-btn");
  if (syncBtn) syncBtn.addEventListener("click", syncPendingScans);

  // Re-probes every 15s while the banner is showing "offline" -- this is
  // what actually recovers from the navigator.onLine stuck-true/stuck-false
  // problem above, since the 'online' event it would otherwise wait for
  // doesn't reliably fire in every case that flips it back.
  setInterval(() => {
    const banner = document.getElementById("offline-banner");
    if (banner && banner.style.display !== "none") {
      updateConnectivityBanner().then(() => {
        if (banner.style.display === "none") syncPendingScans();
      });
    }
  }, 15000);
});

window.addEventListener("online", () => {
  updateConnectivityBanner();
  syncPendingScans();
});
window.addEventListener("offline", updateConnectivityBanner);
