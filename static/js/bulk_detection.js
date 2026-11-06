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

// GPS is rarely better than a few metres and under canopy is often much
// worse, so a fixed 8 m "different tree" distance splits one tree into two
// whenever its photos' fixes wander. The distance limit is therefore widened
// to what the two photos' own accuracy could explain. BULK_ASSUMED_ACCURACY_M
// stands in for photos that don't say how accurate their fix was.
const BULK_ASSUMED_ACCURACY_M = 10;
// In a group of 3+ photos, a fix this far from the group's median position
// is a stray reading and is left out when averaging the tree's location.
const BULK_OUTLIER_M = 30;

// A group in one of these states has been (or is being) saved, so its
// photos, roles and location can't be changed any more.
const BULK_LOCKED_STATUSES = new Set(["processing", "done", "queued"]);

// Toast if the shared helper is there (offline_queue.js loads it on every
// page); alert() only as a last resort.
function bulkNotify(message, kind) {
  if (typeof rgToast === "function") rgToast(message, kind || "error");
  else alert(message);
}

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
  // A photo whose own accuracy figure is worse than GPS_MAX_ACCURACY_M
  // (gps_exif.js) is treated like a photo with no GPS: its position isn't
  // trustworthy enough to place a tree, so the group asks for a map pick.
  // tooImprecise keeps the number so the card can say why.
  const tooImprecise = exif && exif.accuracy != null && exif.accuracy > GPS_MAX_ACCURACY_M ? exif.accuracy : null;
  const usable = exif && tooImprecise === null;
  return {
    file,
    previewUrl: URL.createObjectURL(file),
    lat: usable ? exif.lat : null,
    lng: usable ? exif.lng : null,
    accuracy: usable ? exif.accuracy : null,   // metres, null = the photo doesn't say
    tooImprecise,
    // file.lastModified always exists, even with zero EXIF -- keeps
    // clustering possible for every photo, not just ones with a real tag.
    capturedAt: (exif && exif.capturedAt) || file.lastModified,
  };
}

// How far apart two photos' positions may be and still count as one tree:
// the fixed base distance, or what both photos' accuracy figures could
// explain together if that's larger.
function distanceLimitM(a, b) {
  const accA = a.accuracy != null ? a.accuracy : BULK_ASSUMED_ACCURACY_M;
  const accB = b.accuracy != null ? b.accuracy : BULK_ASSUMED_ACCURACY_M;
  return Math.max(BULK_DIST_M, Math.hypot(accA, accB));
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
    const limit = distanceLimitM(item, last);
    const breaks = gapS > BULK_TIME_GAP_S || (dist !== null && dist > limit);
    if (breaks) {
      const uncertain = gapS <= BULK_TIME_GAP_S * 1.34 && (dist === null || dist <= limit * 1.34)
        && (gapS > BULK_TIME_GAP_UNCERTAIN_S || (dist !== null && dist > limit * (BULK_DIST_UNCERTAIN_M / BULK_DIST_M)));
      groups.push({ items: [item], uncertain });
    } else {
      g.items.push(item);
    }
  }
  return groups;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// One location for the whole group. A stray reading (3+ photos, one of them
// BULK_OUTLIER_M or more from the median position) is dropped, and the rest
// are averaged weighted by 1/accuracy^2, so a 4 m fix counts far more than a
// 25 m one instead of the two being averaged as equals. The accuracy reported
// is the best individual figure in the group (null if no photo gave one).
function groupLocation(items) {
  let pts = items.filter(i => i.lat != null);
  if (!pts.length) return null;
  if (pts.length >= 3) {
    const midLat = median(pts.map(p => p.lat));
    const midLng = median(pts.map(p => p.lng));
    const kept = pts.filter(p => haversineMeters(p.lat, p.lng, midLat, midLng) < BULK_OUTLIER_M);
    if (kept.length) pts = kept;
  }
  let weightSum = 0, latSum = 0, lngSum = 0, bestAccuracy = null;
  for (const p of pts) {
    const acc = p.accuracy != null ? p.accuracy : BULK_ASSUMED_ACCURACY_M;
    const weight = 1 / (Math.max(acc, 3) ** 2);   // floor: a claimed 0.1 m shouldn't swamp everything
    weightSum += weight;
    latSum += p.lat * weight;
    lngSum += p.lng * weight;
    if (p.accuracy != null && (bestAccuracy === null || p.accuracy < bestAccuracy)) bestAccuracy = p.accuracy;
  }
  return { lat: latSum / weightSum, lng: lngSum / weightSum, accuracy: bestAccuracy, manual: false };
}

async function handleBulkFiles(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;
  const statusEl = document.getElementById("bulk-status");
  statusEl.textContent = `Reading ${files.length} photo${files.length === 1 ? "" : "s"}…`;

  // The previous batch's preview URLs are about to be replaced; release them.
  bulkGroups.forEach(g => g.items.forEach(item => URL.revokeObjectURL(item.previewUrl)));

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
  // Android's gallery picker often strips GPS out of the photos it hands
  // over, so a whole batch can arrive with none. Say so once, up front,
  // instead of leaving the farmer to wonder why every tree asks for a location.
  if (!items.some(i => i.lat != null)) {
    statusEl.textContent += " None of these photos carry usable GPS (Android's gallery picker often removes it) — set each tree's location on the map, or use Take Photo for trees you're standing at.";
  }
  renderBulkGroups();
}

function isGroupReady(g) {
  return g.rootIdx !== null && g.trunkIdx !== null && g.rootIdx !== g.trunkIdx && !!g.location;
}

function renderBulkGroups() {
  const container = document.getElementById("bulk-groups-container");
  container.innerHTML = bulkGroups.map((g, idx) => {
    const ready = isGroupReady(g);
    const locked = BULK_LOCKED_STATUSES.has(g.status);
    const dis = locked ? " disabled" : "";
    const thumbs = g.items.map((item, i) => {
      const role = i === g.rootIdx ? "root" : i === g.trunkIdx ? "trunk" : null;
      const dim = role ? "" : " is-dim";
      const photoName = `photo ${i + 1} of tree ${idx + 1}`;
      const alt = role ? `${role === "root" ? "Root" : "Trunk"} ${photoName}` : `Unassigned ${photoName}`;
      return `
        <div class="text-center bulk-thumb-box">
          <img src="${item.previewUrl}" alt="${alt}" class="bulk-thumb${dim}">
          <div class="d-flex gap-1 mt-1">
            <button type="button" class="btn btn-sm bulk-role-btn btn-outline-secondary" aria-pressed="${role === "root"}" aria-label="Use ${photoName} as the root photo" data-action="set-role" data-group="${g.id}" data-item="${i}" data-role="root"${dis}>Root</button>
            <button type="button" class="btn btn-sm bulk-role-btn btn-outline-secondary" aria-pressed="${role === "trunk"}" aria-label="Use ${photoName} as the trunk photo" data-action="set-role" data-group="${g.id}" data-item="${i}" data-role="trunk"${dis}>Trunk</button>
          </div>
          <button type="button" class="btn btn-sm btn-link text-muted p-0 mt-1 bulk-move-btn" aria-label="Move ${photoName} to a new tree" data-action="split-out" data-group="${g.id}" data-item="${i}"${dis}>Move to new tree</button>
        </div>`;
    }).join("");

    // When no photo in the group had a usable fix, say if that was because
    // they were too imprecise (and by how much) rather than missing outright.
    const weakest = g.items.map(i => i.tooImprecise).filter(v => v != null).sort((a, b) => a - b)[0];
    const noGpsText = weakest != null
      ? `GPS on these photos is too imprecise (best about ±${Math.round(weakest)} m) — location needed`
      : "No GPS on these photos — location needed";
    const accuracyText = g.location && g.location.accuracy != null ? ` · ±${Math.round(g.location.accuracy)} m` : "";
    const locText = g.location
      ? `📍 ${g.location.lat.toFixed(5)}, ${g.location.lng.toFixed(5)}${accuracyText}${g.location.manual ? " (manual)" : ""}`
      : `<span class="text-danger">${noGpsText}</span>`;

    const statusBadge = {
      draft: "",
      processing: '<span class="status-pill is-busy"><i class="bi bi-arrow-repeat"></i> Saving…</span>',
      done: `<span class="status-pill is-done"><i class="bi bi-check-circle-fill"></i> Saved as ${escapeHtml(g.savedTreeId)}</span>`,
      queued: '<span class="status-pill is-queued"><i class="bi bi-cloud-arrow-up"></i> Queued — syncs automatically</span>',
      error: `<span class="status-pill is-error">Failed</span>`,
    }[g.status];

    const errorLine = g.status === "error" ? `<div class="text-danger mt-1 text-sm-rg">${escapeHtml(g.errorMsg)}</div>` : "";
    const uncertainLine = g.uncertain
      ? `<div class="mb-2 text-sm-rg"><i class="bi bi-exclamation-triangle-fill"></i> Borderline split from the previous tree — double-check this grouping.</div>`
      : "";
    const readyLine = !ready && g.status === "draft"
      ? `<div class="text-muted mb-2 text-sm-rg">Needs a Root photo, a Trunk photo, and a location before it can be saved.</div>` : "";

    return `
      <div class="card-rg mb-3" data-group-card="${g.id}">
        <div class="card-header-rg d-flex justify-content-between align-items-center">
          <span>Tree ${idx + 1} <span class="text-muted text-sm-rg">(${g.items.length} photo${g.items.length === 1 ? "" : "s"})</span></span>
          <div class="d-flex align-items-center gap-2">
            ${statusBadge}
            ${idx > 0 ? `<button type="button" class="btn btn-sm btn-outline-secondary rg-tap" data-action="merge-up" data-group="${g.id}"${dis || (BULK_LOCKED_STATUSES.has(bulkGroups[idx - 1].status) ? " disabled" : "")}><i class="bi bi-arrow-up" aria-hidden="true"></i> Merge with previous</button>` : ""}
          </div>
        </div>
        <div class="card-body-rg">
          ${uncertainLine}
          <div class="d-flex gap-2 flex-wrap mb-2">${thumbs}</div>
          ${readyLine}
          <div class="d-flex justify-content-between align-items-center">
            <div class="text-sm-rg">${locText}</div>
            <button type="button" class="btn btn-sm btn-outline-primary rg-tap" aria-label="${g.location ? "Change" : "Set"} location for tree ${idx + 1}" data-action="set-location" data-group="${g.id}"${dis}>
              <i class="bi bi-geo-alt" aria-hidden="true"></i> ${g.location ? "Change" : "Set"} Location
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
  // One solid button on the screen: Choose Photos until there are groups to
  // review, then Save All Ready Trees.
  const pickBtn = document.getElementById("bulk-file-input").closest("label");
  if (pickBtn) {
    pickBtn.classList.toggle("btn-primary", !bulkGroups.length);
    pickBtn.classList.toggle("btn-outline-secondary", bulkGroups.length > 0);
  }
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
  // Saved / queued / saving groups are frozen (their buttons are also
  // disabled; this covers anything that still reaches the handler).
  if (BULK_LOCKED_STATUSES.has(g.status)) return;

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
    if (!prev || BULK_LOCKED_STATUSES.has(prev.status)) return;
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
    bulkNotify("The map picker needs a connection. Photos with their own GPS still work; set the others once you're back online.", "error");
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
  if (!farmPk) { bulkNotify("Choose a farm first, then save.", "error"); return; }

  const ready = bulkGroups.filter(g => isGroupReady(g) && g.status !== "done" && g.status !== "queued");
  if (!ready.length) return;

  const processBtn = document.getElementById("bulk-process-btn");
  processBtn.disabled = true;
  // With disease detection switched off on the server, a live save would be
  // refused, so every tree is kept on this device instead and syncs by itself
  // once detection is available (offline_queue.js retries on its own).
  const detectionOn = window.AI_ENABLED !== false;
  let online = detectionOn && await isActuallyOnline();
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
          accuracy: g.location.manual ? null : (g.location.accuracy != null ? g.location.accuracy : null),
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
        g.errorMsg = err.message || "Couldn't save this tree. Please try again.";
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
      rgToast(
        detectionOn
          ? `${queuedNow} tree${queuedNow === 1 ? "" : "s"} saved on this device. They sync automatically once you're back online.`
          : `${queuedNow} tree${queuedNow === 1 ? "" : "s"} saved on this device. They sync automatically once disease detection is available.`,
        "info"
      );
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
