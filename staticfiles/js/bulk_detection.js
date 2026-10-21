// Bulk Upload works with no signal: grouping, EXIF GPS and resizing are all
// local, and "Save All" queues each tree on the device (IndexedDB, see
// offline_queue.js) when there's no connection, then syncs it automatically
// once there is one. Only the manual map picker needs a connection (tiles).
//
// Same thresholds discussed for auto-grouping: time gap is the primary
// signal (GPS is often missing on Browse'd photos), distance only used
// when both photos being compared actually have it.
const BULK_TIME_GAP_S = 90;
const BULK_DIST_M = 8;
const BULK_TIME_GAP_UNCERTAIN_S = 70;
const BULK_DIST_UNCERTAIN_M = 6;

let bulkGroups = [];
let bulkGroupSeq = 0;
let bulkLocationTargetId = null;
let bulkLocationMap = null;
let bulkLocationMarker = null;
const bulkFarmCenters = JSON.parse(document.getElementById("farm-centers-data").textContent);

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function extractItemMetadata(file) {
  const exif = window.extractGPSFromFile ? await window.extractGPSFromFile(file) : null;
  return {
    file,
    previewUrl: URL.createObjectURL(file),
    lat: exif ? exif.lat : null,
    lng: exif ? exif.lng : null,
    // file.lastModified always exists, even with zero EXIF -- keeps
    // clustering possible for every photo, not just ones with a real tag.
    capturedAt: (exif && exif.capturedAt) || file.lastModified,
  };
}

// Sequential clustering: sorted by time, walk once, compare each photo
// only to the last one already in the current group (not a running
// average) so slowly panning around one tree doesn't drift a false split.
function clusterItems(items) {
  const sorted = [...items].sort((a, b) => a.capturedAt - b.capturedAt);
  const groups = [];
  for (const item of sorted) {
    const g = groups[groups.length - 1];
    if (!g) { groups.push({ items: [item], uncertain: false }); continue; }
    const last = g.items[g.items.length - 1];
    const gapS = (item.capturedAt - last.capturedAt) / 1000;
    const dist = item.lat != null && last.lat != null ? haversineMeters(item.lat, item.lng, last.lat, last.lng) : null;
    const breaks = gapS > BULK_TIME_GAP_S || (dist !== null && dist > BULK_DIST_M);
    if (breaks) {
      const uncertain = gapS <= BULK_TIME_GAP_S * 1.34 && (dist === null || dist <= BULK_DIST_M * 1.34)
        && (gapS > BULK_TIME_GAP_UNCERTAIN_S || (dist !== null && dist > BULK_DIST_UNCERTAIN_M));
      groups.push({ items: [item], uncertain });
    } else {
      g.items.push(item);
    }
  }
  return groups;
}

function groupLocation(items) {
  const withGps = items.filter(i => i.lat != null);
  if (!withGps.length) return null;
  const lat = withGps.reduce((s, i) => s + i.lat, 0) / withGps.length;
  const lng = withGps.reduce((s, i) => s + i.lng, 0) / withGps.length;
  return { lat, lng, manual: false };
}

async function handleBulkFiles(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;
  const statusEl = document.getElementById("bulk-status");
  statusEl.textContent = `Reading ${files.length} photo${files.length === 1 ? "" : "s"}…`;

  const items = await Promise.all(files.map(extractItemMetadata));
  const clustered = clusterItems(items);

  bulkGroups = clustered.map(g => ({
    id: ++bulkGroupSeq,
    items: g.items,
    uncertain: g.uncertain,
    rootIdx: null,
    trunkIdx: null,
    location: groupLocation(g.items),
    status: "draft", // draft | processing | done | queued (saved on device, will sync) | error
    errorMsg: "",
    savedTreeId: "",
  }));

  statusEl.textContent = `Grouped into ${bulkGroups.length} possible tree${bulkGroups.length === 1 ? "" : "s"} — review before saving.`;
  renderBulkGroups();
}

function isGroupReady(g) {
  return g.rootIdx !== null && g.trunkIdx !== null && g.rootIdx !== g.trunkIdx && !!g.location;
}

function renderBulkGroups() {
  const container = document.getElementById("bulk-groups-container");
  container.innerHTML = bulkGroups.map((g, idx) => {
    const ready = isGroupReady(g);
    const thumbs = g.items.map((item, i) => {
      const role = i === g.rootIdx ? "root" : i === g.trunkIdx ? "trunk" : null;
      const dim = role ? "" : "opacity:.55;";
      return `
        <div class="text-center" style="width:84px;">
          <img src="${item.previewUrl}" style="width:84px;height:84px;object-fit:cover;border-radius:6px;${dim}">
          <div class="d-flex gap-1 mt-1">
            <button class="btn btn-sm ${role === "root" ? "btn-success" : "btn-outline-secondary"}" style="font-size:10px;padding:1px 5px;" data-action="set-role" data-group="${g.id}" data-item="${i}" data-role="root">Root</button>
            <button class="btn btn-sm ${role === "trunk" ? "btn-primary" : "btn-outline-secondary"}" style="font-size:10px;padding:1px 5px;" data-action="set-role" data-group="${g.id}" data-item="${i}" data-role="trunk">Trunk</button>
          </div>
          <button class="btn btn-sm btn-link text-danger p-0 mt-1" style="font-size:10px;" data-action="split-out" data-group="${g.id}" data-item="${i}">Move to new tree</button>
        </div>`;
    }).join("");

    const locText = g.location
      ? `📍 ${g.location.lat.toFixed(5)}, ${g.location.lng.toFixed(5)}${g.location.manual ? " (manual)" : ""}`
      : `<span class="text-danger">No GPS on these photos — location needed</span>`;

    const statusBadge = {
      draft: "",
      processing: '<span class="badge-disease" style="background:#1e3a5f;color:#7cb8ff;"><i class="bi bi-arrow-repeat"></i> Saving…</span>',
      done: `<span class="badge-disease" style="background:#1c3a2e;color:#4ade80;"><i class="bi bi-check-circle-fill"></i> Saved as ${escapeHtml(g.savedTreeId)}</span>`,
      queued: '<span class="badge-disease" style="background:#3b3020;color:#e0b84a;"><i class="bi bi-cloud-arrow-up"></i> Queued — syncs automatically</span>',
      error: `<span class="badge-disease" style="background:#3b1f24;color:#f87171;">Failed</span>`,
    }[g.status];

    const errorLine = g.status === "error" ? `<div class="text-danger mt-1" style="font-size:11.5px;">${escapeHtml(g.errorMsg)}</div>` : "";
    const uncertainLine = g.uncertain
      ? `<div class="mb-2" style="font-size:11px;color:#fbbf24;"><i class="bi bi-exclamation-triangle-fill"></i> Borderline split from the previous tree — double-check this grouping.</div>`
      : "";
    const readyLine = !ready && g.status === "draft"
      ? `<div class="text-muted mb-2" style="font-size:11px;">Needs a Root photo, a Trunk photo, and a location before it can be saved.</div>` : "";

    return `
      <div class="card-rg mb-3" data-group-card="${g.id}">
        <div class="card-header-rg d-flex justify-content-between align-items-center">
          <span>Tree ${idx + 1} <span class="text-muted" style="font-size:11px;">(${g.items.length} photo${g.items.length === 1 ? "" : "s"})</span></span>
          <div class="d-flex align-items-center gap-2">
            ${statusBadge}
            ${idx > 0 ? `<button class="btn btn-sm btn-outline-secondary" style="font-size:11px;" data-action="merge-up" data-group="${g.id}"><i class="bi bi-arrow-up"></i> Merge with previous</button>` : ""}
          </div>
        </div>
        <div class="card-body-rg">
          ${uncertainLine}
          <div class="d-flex gap-2 flex-wrap mb-2">${thumbs}</div>
          ${readyLine}
          <div class="d-flex justify-content-between align-items-center">
            <div style="font-size:12px;">${locText}</div>
            <button class="btn btn-sm btn-outline-primary" style="font-size:11px;" data-action="set-location" data-group="${g.id}">
              <i class="bi bi-geo-alt"></i> ${g.location ? "Change" : "Set"} Location
            </button>
          </div>
          ${errorLine}
        </div>
      </div>`;
  }).join("");

  // Already-saved and already-queued trees aren't "ready to save" anymore.
  const readyCount = bulkGroups.filter(g => isGroupReady(g) && g.status !== "done" && g.status !== "queued").length;
  const queuedCount = bulkGroups.filter(g => g.status === "queued").length;
  document.getElementById("bulk-actions").style.display = bulkGroups.length ? "" : "none";
  document.getElementById("bulk-summary").textContent =
    `${readyCount} of ${bulkGroups.length} trees ready to save` + (queuedCount ? ` · ${queuedCount} queued` : "");
}

function findGroup(id) {
  return bulkGroups.find(g => g.id === Number(id));
}

function handleBulkContainerClick(e) {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const g = findGroup(btn.dataset.group);
  if (!g) return;

  if (btn.dataset.action === "set-role") {
    const i = Number(btn.dataset.item);
    if (btn.dataset.role === "root") g.rootIdx = g.rootIdx === i ? null : i;
    else g.trunkIdx = g.trunkIdx === i ? null : i;
    renderBulkGroups();
  } else if (btn.dataset.action === "split-out") {
    const i = Number(btn.dataset.item);
    const [moved] = g.items.splice(i, 1);
    if (g.rootIdx === i) g.rootIdx = null;
    if (g.trunkIdx === i) g.trunkIdx = null;
    if (g.rootIdx > i) g.rootIdx -= 1;
    if (g.trunkIdx > i) g.trunkIdx -= 1;
    bulkGroups.push({
      id: ++bulkGroupSeq, items: [moved], uncertain: false,
      rootIdx: null, trunkIdx: null, location: groupLocation([moved]),
      status: "draft", errorMsg: "", savedTreeId: "",
    });
    if (!g.items.length) bulkGroups = bulkGroups.filter(x => x !== g);
    renderBulkGroups();
  } else if (btn.dataset.action === "merge-up") {
    const idx = bulkGroups.indexOf(g);
    const prev = bulkGroups[idx - 1];
    if (!prev) return;
    prev.items = prev.items.concat(g.items);
    // Force the roles to be re-picked -- old indices don't line up anymore.
    prev.rootIdx = null;
    prev.trunkIdx = null;
    prev.location = prev.location || groupLocation(prev.items);
    bulkGroups.splice(idx, 1);
    renderBulkGroups();
  } else if (btn.dataset.action === "set-location") {
    openBulkLocationModal(g.id);
  }
}

function openBulkLocationModal(groupId) {
  // Bootstrap and Leaflet both come from CDNs; offline they're only there if
  // sw.js cached them on an earlier visit.
  if (typeof bootstrap === "undefined") {
    alert("The map picker isn't available offline. Photos that carry their own GPS still work; for the rest, set the location once you're back online.");
    return;
  }
  bulkLocationTargetId = groupId;
  const modalEl = document.getElementById("bulk-location-modal");
  const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
  modal.show();
}

document.getElementById("bulk-location-modal").addEventListener("shown.bs.modal", () => {
  const offlineNote = document.getElementById("bulk-location-offline-note");
  if (offlineNote) offlineNote.style.display = window.rgOnline === false ? "" : "none";
  if (typeof L === "undefined") {
    document.getElementById("bulk-location-map").textContent = "The map couldn't load. Set this location once you're back online.";
    return;
  }
  const g = findGroup(bulkLocationTargetId);
  const farmPk = document.getElementById("bulk-farm-select").value;
  const fallback = bulkFarmCenters[farmPk] || [6.9214, 122.0790];
  const start = g && g.location ? [g.location.lat, g.location.lng] : fallback;

  if (!bulkLocationMap) {
    bulkLocationMap = L.map("bulk-location-map").setView(start, 16);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap" }).addTo(bulkLocationMap);
    bulkLocationMap.on("click", e => {
      if (bulkLocationMarker) bulkLocationMap.removeLayer(bulkLocationMarker);
      bulkLocationMarker = L.marker(e.latlng).addTo(bulkLocationMap);
    });
  } else {
    bulkLocationMap.setView(start, 16);
  }
  bulkLocationMap.invalidateSize();
  if (bulkLocationMarker) { bulkLocationMap.removeLayer(bulkLocationMarker); bulkLocationMarker = null; }
  bulkLocationMarker = L.marker(start).addTo(bulkLocationMap);
});

document.getElementById("bulk-location-confirm").addEventListener("click", () => {
  const g = findGroup(bulkLocationTargetId);
  if (g && bulkLocationMarker) {
    const { lat, lng } = bulkLocationMarker.getLatLng();
    g.location = { lat, lng, manual: true };
  }
  bootstrap.Modal.getInstance(document.getElementById("bulk-location-modal")).hide();
  renderBulkGroups();
});

// Online: runs each group through syncOneScan (offline_queue.js) -- the
// exact same analyze-then-save chain the offline sync uses -- one group at
// a time. Offline (or the moment the connection drops mid-batch): the group
// is resized and stored in the on-device queue instead, and the global sync
// in offline_queue.js saves it automatically once there's a connection.
async function processBulkGroups() {
  const farmPk = document.getElementById("bulk-farm-select").value;
  if (!farmPk) { alert("Select a farm first."); return; }

  const ready = bulkGroups.filter(g => isGroupReady(g) && g.status !== "done" && g.status !== "queued");
  if (!ready.length) return;

  const processBtn = document.getElementById("bulk-process-btn");
  processBtn.disabled = true;
  let online = await isActuallyOnline();
  let queuedNow = 0;
  try {
    for (const g of ready) {
      g.status = "processing";
      g.errorMsg = "";
      renderBulkGroups();
      let stopBatch = false;
      try {
        const rootItem = g.items[g.rootIdx];
        const trunkItem = g.items[g.trunkIdx];
        const [rootBlob, trunkBlob] = await Promise.all([resizeImageFile(rootItem.file), resizeImageFile(trunkItem.file)]);
        const record = {
          farmPk, treeId: "",
          rootBlob, trunkBlob,
          lat: g.location.lat, lng: g.location.lng,
          gpsSource: g.location.manual ? "manual" : "exif",
          capturedAt: rootItem.capturedAt,
        };

        let saved = false;
        if (online) {
          try {
            const result = await syncOneScan(record);
            g.status = "done";
            g.savedTreeId = result.tree_id;
            saved = true;
          } catch (err) {
            if (!(err instanceof NetworkError)) throw err;
            online = false; // connection dropped mid-batch -- queue this one and the rest
          }
        }
        if (!saved) {
          try {
            await queueScan(record);
          } catch (queueErr) {
            throw new Error("Couldn't store this tree on the device (storage may be full or blocked). Free some space or save it once you're online.");
          }
          g.status = "queued";
          queuedNow++;
        }
      } catch (err) {
        g.status = "error";
        g.errorMsg = err.message || "Save failed";
        // Every remaining tree would fail the same way once the session is gone.
        if (err instanceof SessionError) stopBatch = true;
      }
      renderBulkGroups();
      if (stopBatch) break;
    }
  } finally {
    processBtn.disabled = false;
    renderPendingScans();
    if (queuedNow) {
      rgToast(`${queuedNow} tree${queuedNow === 1 ? "" : "s"} saved on this device. They sync automatically once you're back online.`, "info");
      // If the offline reading was a false alarm (slow signal), this syncs
      // right away; if it's real, the probe fails fast and they just wait.
      maybeAutoSync();
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("bulk-file-input").addEventListener("change", e => handleBulkFiles(e.target.files));
  document.getElementById("bulk-groups-container").addEventListener("click", handleBulkContainerClick);
  document.getElementById("bulk-process-btn").addEventListener("click", processBulkGroups);
});
