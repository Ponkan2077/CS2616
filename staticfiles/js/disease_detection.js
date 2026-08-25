/* Handles the two-step capture flow (root image, then trunk image — see
   comment 4), resizes each photo client-side before upload, sends both to
   the real AI model for analysis, and uploads both resized images
   directly to cloud storage via a presigned URL (falling back to
   attaching them to the save form's file inputs for a normal multipart
   submission if direct upload isn't available). */

let rootImageFile = null;   // resized File, ready to attach to the save form
let trunkImageFile = null;
let rootGPS = null;   // { lat, lng, source: 'exif' | 'device' } -- resolved per image
let trunkGPS = null;

// Direct-to-storage upload state. Uploads kick off in the background as
// soon as the analysis result is shown, so they're usually
// already finished by the time the farmer reviews the result and hits
// Save. directUploadPromise resolves once both are done (or resolves
// anyway on failure/unavailability, leaving the original file-input
// attachment from showResult() as the fallback).
let directUploadPromise = null;

// One-shot read of the device's current position, promisified. Used as a
// fallback when a photo has no EXIF GPS of its own (see resolveImageGPS
// below) -- this works fine offline too, since GPS hardware doesn't need
// a data connection, only a permission grant and sky visibility.
//
// Returns { lat, lng, source: "device" } on success, or null with a
// human-readable reason on failure -- distinguishing "you denied the
// permission prompt" from "GPS hardware couldn't get a fix in time" matters
// a lot in the field (e.g. under rubber tree canopy), since the fix for
// each is completely different.
function getDeviceGPS() {
  return new Promise(resolve => {
    if (!navigator.geolocation) { resolve({ error: "This browser doesn't support device location." }); return; }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, source: "device", capturedAt: Date.now() }),
      err => {
        const reasons = {
          1: "Location permission was denied. Enable location for this site in your browser settings.",
          2: "Couldn't get a GPS fix. Try moving to open sky, away from thick canopy or buildings.",
          3: "GPS location timed out. Try again, ideally with a clearer view of the sky.",
        };
        resolve({ error: reasons[err.code] || "Couldn't get your device's location." });
      },
      // 15s (not the default 3 typical minimum) since a fix can genuinely
      // take longer under rubber tree canopy; maximumAge lets the trunk
      // photo reuse a fix from moments ago (root photo) instead of
      // re-polling GPS hardware and making the farmer wait twice.
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
    );
  });
}

// Every photo has to carry a location one way or another, but which
// fallback is trustworthy depends on HOW the photo got here:
//
// - Take Photo (source "camera"): the shot and the upload happen in the
//   same moment, standing at the same tree. A live device GPS reading at
//   that moment is a genuinely accurate stand-in when the photo itself has
//   no EXIF GPS (the normal case for browser camera capture -- browsers
//   strip it there for privacy regardless of Location Services being on).
//
// - Browse or drag-drop (source "file"): this is an EXISTING photo. It
//   could've been taken this morning at the farm and uploaded tonight from
//   home -- the phone's current position has no reliable relationship to
//   where that photo was actually taken. Tagging it with a live reading
//   would silently mislabel the tree instead of honestly saying "unknown."
//   (On Android specifically, EXIF GPS is stripped from nearly every photo
//   handed over through the system Photo Picker anyway -- an OS privacy
//   policy since Android 13, independent of Camera/Location settings -- so
//   this path failing is expected, not a bug to chase.)
//
// Returns { lat, lng, source } on success, or { error } on failure --
// never plain null, so the caller always has something to show the user.
async function resolveImageGPS(file, source) {
  const exifGps = await extractGPSFromFile(file);
  if (exifGps) return exifGps;
  if (source !== "camera") {
    return {
      error: "This photo has no location data attached (normal for gallery/browsed photos, especially on Android). Use Take Photo instead so we can read your current location.",
    };
  }
  return await getDeviceGPS();
}

// Hides the banner. Called after page-load check, a successful photo
// capture, or a live permission change -- whichever happens first.
function hideLocationBanner() {
  const banner = document.getElementById("location-banner");
  if (banner) banner.style.display = "none";
}

function showLocationBanner(reason) {
  const banner = document.getElementById("location-banner");
  const bannerText = document.getElementById("location-banner-text");
  if (!banner || !bannerText) return;
  bannerText.textContent = `${reason || "Couldn't get your device's location."} Needed for Take Photo. On Android: browser menu → Settings → Sites and downloads → Site permissions → Location.`;
  banner.style.display = "";
}

// Checked on page load so a blocked permission shows up immediately, not
// only after Take Photo fails. Also listens for the permission changing
// live (e.g. the user answers the prompt after this first check already
// ran), so the banner doesn't get stuck once access is actually granted.
function checkLocationAvailability() {
  getDeviceGPS().then(result => {
    if (result && !result.error) hideLocationBanner();
    else showLocationBanner(result && result.error);
  });

  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: "geolocation" }).then(status => {
      status.onchange = () => { if (status.state === "granted") checkLocationAvailability(); };
    }).catch(() => {});
  }
}

// Advances the workflow strip, marking prior steps done and the given step active.
function setWorkflowStep(index) {
  for (let i = 0; i <= 4; i++) {
    const el = document.getElementById(`step-${i}`);
    if (!el) continue;
    el.classList.remove("active", "done");
    if (i < index) el.classList.add("done");
    if (i === index) el.classList.add("active");
  }
}

// Resizes an image file so its longest edge is at most STORAGE_MAX_DIMENSION,
// respecting camera EXIF orientation via the browser's own decode, and
// returns a Promise<File> (WebP). Smaller source images are left as-is.
// Reads the CSRF token straight out of the save form's own hidden input,
// so the direct-upload requests below stay authenticated the same way
// the eventual form submission is, without depending on cookie settings.

// Asks Django for a short-lived presigned URL to PUT one image straight
// to cloud storage. kind is 'roots' or 'trunks'.
async function requestUploadUrl(kind) {
  const res = await fetch("/detection/upload-url/", {
    method: "POST",
    headers: {
      "X-CSRFToken": getCsrfToken(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ kind }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Upload URL request failed (${res.status})`);
  }
  return res.json(); // { key, upload_url, expires_in }
}

// Uploads one already-resized WebP file straight to cloud storage and
// returns its object key. Throws if direct upload isn't available or the
// PUT itself fails -- callers fall back to the multipart file inputs.
async function uploadDirectly(file, kind) {
  const { key, upload_url } = await requestUploadUrl(kind);
  const putRes = await fetch(upload_url, {
    method: "PUT",
    headers: { "Content-Type": "image/webp" },
    body: file,
  });
  if (!putRes.ok) throw new Error("Direct upload to storage failed");
  return key;
}

// Kicks off both direct uploads in the background. On success, fills the
// save form's hidden key fields and clears the file inputs (so the
// multipart submission doesn't also send the raw bytes through Django).
// On any failure -- cloud storage not configured, network error, etc --
// leaves the file inputs exactly as showResult() set them, so the
// original multipart upload path still works with no user-visible change.
function startDirectUploads() {
  directUploadPromise = Promise.all([
    uploadDirectly(rootImageFile, "roots"),
    uploadDirectly(trunkImageFile, "trunks"),
  ]).then(([rootKey, trunkKey]) => {
    document.getElementById("save-root-image-key").value = rootKey;
    document.getElementById("save-trunk-image-key").value = trunkKey;
    document.getElementById("save-root-image").value = "";
    document.getElementById("save-trunk-image").value = "";
  }).catch(() => {
    // Fall back silently -- file inputs already hold the resized images.
  });
}


// Resolves GPS from the original file (has to happen before resize, since
// redrawing onto a canvas strips all EXIF including GPS), resizes it, and
// only then accepts the capture -- rejecting outright if neither the
// photo's own EXIF nor a live device position could provide a location.
function handleCapture(file, { previewImgId, dropZoneId, kind, source }) {
  const dropZone = document.getElementById(dropZoneId);
  const previewImg = document.getElementById(previewImgId);
  const statusEl = document.getElementById(`${kind}-gps-status`);
  if (statusEl) { statusEl.textContent = "Checking location…"; statusEl.className = "text-muted mt-1"; statusEl.style.fontSize = "11px"; }

  Promise.all([resolveImageGPS(file, source), resizeImageFile(file)]).then(([gps, resizedFile]) => {
    if (!gps || gps.error) {
      if (statusEl) {
        statusEl.textContent = (gps && gps.error) || "No location data found in this photo, and couldn't get your device's GPS either.";
        statusEl.className = "text-danger mt-1";
        statusEl.style.fontSize = "11px";
      }
      return; // reject: image is not accepted, existing state (if any) is untouched
    }
    if (gps) hideLocationBanner(); // any successful resolution, EXIF or device, means location isn't blocked right now

    if (kind === "root") {
      rootImageFile = resizedFile;
      rootGPS = gps;
    } else {
      trunkImageFile = resizedFile;
      trunkGPS = gps;
    }
    if (statusEl) {
      statusEl.textContent = `📍 Location from ${gps.source === "exif" ? "photo" : "device"}`;
      statusEl.className = "text-healthy mt-1";
      statusEl.style.fontSize = "11px";
    }

    // The tree gets one location -- prefer the root photo's, since
    // root and trunk are shot moments apart at the same tree and root is
    // captured first. Refreshed every time either GPS resolves, so
    // whichever was captured most recently is reflected immediately.
    const chosenGps = rootGPS || trunkGPS;
    document.getElementById("save-lat").value = chosenGps.lat;
    document.getElementById("save-lng").value = chosenGps.lng;
    if (chosenGps.capturedAt) document.getElementById("save-captured-at").value = new Date(chosenGps.capturedAt).toISOString();

    previewImg.src = URL.createObjectURL(resizedFile);
    previewImg.style.display = "block";
    dropZone.classList.add("has-image");

    if (kind === "root") {
      // Root image captured first -- unlock the trunk capture step.
      document.getElementById("trunk-zone-wrapper").classList.remove("step-locked");
      setWorkflowStep(1);
    } else {
      // Stays disabled if no model is configured -- see the banner
      // rendered in disease_detection.html instead of enabling a button
      // that would just error out.
      document.getElementById("analyze-btn").disabled = !window.AI_ENABLED;
      setWorkflowStep(2);
    }
  }).catch(() => {
    alert("Couldn't process that image. Please try another photo.");
  });
}


// Sends the two captured photos to the real AI model (views.analyze_detection)
// and shows its actual result. Root condition comes back from the same
// call -- assessed separately from trunk disease server-side, since
// exposed roots aren't one of the trained trunk disease classes (see the
// dynamic DiseaseClass catalog for what those are).
async function runAnalysis() {
  setWorkflowStep(2);
  const analyzeBtn = document.getElementById("analyze-btn");
  const errorBox = document.getElementById("analyze-error");
  errorBox.style.display = "none";
  analyzeBtn.disabled = true;
  analyzeBtn.innerHTML = '<i class="bi bi-hourglass-split"></i> Analyzing...';

  const formData = new FormData();
  formData.append("root_image", rootImageFile);
  formData.append("trunk_image", trunkImageFile);

  let res;
  try {
    res = await fetch("/detection/analyze/", {
      method: "POST",
      headers: { "X-CSRFToken": getCsrfToken() },
      body: formData,
    });
  } catch (networkErr) {
    // fetch() throwing here (as opposed to resolving with a bad status)
    // means there's no network path at all right now -- analysis can't
    // happen offline no matter what, so queue the scan instead of
    // dead-ending with an error the user can't do anything about.
    await queueScanOffline();
    analyzeBtn.disabled = false;
    analyzeBtn.innerHTML = '<i class="bi bi-cpu"></i> Analyze Images';
    return;
  }

  try {
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Analysis failed (${res.status})`);
    showResult(data.disease, data.confidence, data.root_condition, data.action);
    setWorkflowStep(3);
  } catch (err) {
    errorBox.textContent = err.message || "Analysis failed. Please try again.";
    errorBox.style.display = "";
    setWorkflowStep(1);
  } finally {
    analyzeBtn.disabled = false;
    analyzeBtn.innerHTML = '<i class="bi bi-cpu"></i> Analyze Images';
  }
}

// Stores the current capture (both images + resolved GPS) in IndexedDB
// via offline_queue.js, then resets the form so the farmer can keep
// scanning the next tree right away instead of getting stuck. Analysis
// itself happens later, at sync time, once there's a connection again.
async function queueScanOffline() {
  const farmPk = document.getElementById("save-farm-pk").value;
  if (!farmPk) {
    alert("Select a farm before scanning.");
    return;
  }
  const chosenGps = rootGPS || trunkGPS;
  await queueScan({
    farmPk,
    treeId: document.getElementById("save-tree-id").value.trim(),
    block: document.getElementById("save-block").value.trim(),
    rootBlob: rootImageFile,
    trunkBlob: trunkImageFile,
    lat: chosenGps.lat,
    lng: chosenGps.lng,
    gpsSource: chosenGps.source,
    // Real photo capture time (EXIF/device), not queue time -- matters
    // most exactly here, since offline scans can sit queued for hours.
    capturedAt: chosenGps.capturedAt || Date.now(),
  });
  if (typeof renderPendingScans === "function") renderPendingScans();

  const errorBox = document.getElementById("analyze-error");
  errorBox.className = "alert alert-warning mt-2 py-2";
  errorBox.style.fontSize = "12.5px";
  errorBox.style.display = "";
  errorBox.textContent = "No connection right now — this scan was saved on your device and will analyze and sync automatically once you're back online.";

  resetCaptureForm();
}

// Clears the capture state back to a fresh scan, without a page reload
// (so farm/tree-id typed so far, and the message above, both survive).
function resetCaptureForm() {
  rootImageFile = null;
  trunkImageFile = null;
  rootGPS = null;
  trunkGPS = null;
  ["root", "trunk"].forEach(kind => {
    const previewImg = document.getElementById(`${kind}-preview-img`);
    const dropZone = document.getElementById(`${kind}-drop-zone`);
    const statusEl = document.getElementById(`${kind}-gps-status`);
    previewImg.style.display = "none";
    previewImg.src = "";
    dropZone.classList.remove("has-image");
    if (statusEl) statusEl.textContent = "";
  });
  document.getElementById("trunk-zone-wrapper").classList.add("step-locked");
  document.getElementById("analyze-btn").disabled = true;
  document.getElementById("save-lat").value = "";
  document.getElementById("save-lng").value = "";
  document.getElementById("save-captured-at").value = "";
  setWorkflowStep(0);
}

// Populates and reveals the result panel, hides the class reference card,
// and fills the hidden save-form fields (including the two image files).
function showResult(disease, confidence, rootCondition, action) {
  document.getElementById("result-disease").textContent = disease;
  document.getElementById("result-conf").textContent = `${confidence}%`;
  document.getElementById("result-fill").style.width = `${confidence}%`;
  document.getElementById("result-action").textContent = action || "No recommendation on file for this result.";

  const rootBadge = document.getElementById("result-root-condition");
  rootBadge.textContent = rootCondition || "Not reported by model";
  rootBadge.className = rootCondition === "Exposed Roots Detected"
    ? "fw-bold mt-1 text-pink" : "fw-bold mt-1 text-healthy";

  const badge = document.getElementById("threshold-badge-result");
  if (confidence >= 80) {
    badge.innerHTML = '<span class="threshold-badge threshold-confirmed"><i class="bi bi-check-circle-fill"></i> Confirmed Detection</span>';
  } else if (confidence >= 50) {
    badge.innerHTML = '<span class="threshold-badge threshold-review"><i class="bi bi-exclamation-circle-fill"></i> Manual Review Suggested</span>';
  } else {
    badge.innerHTML = '<span class="threshold-badge" style="background:rgba(248,113,113,.15);color:#f87171;border:1px solid rgba(248,113,113,.35);"><i class="bi bi-question-circle-fill"></i> Uncertain — Not a Reliable Classification</span>';
  }

  document.getElementById("save-disease").value = disease;
  document.getElementById("save-confidence").value = confidence;
  document.getElementById("save-root-condition").value = rootCondition;

  // Attach the two resized image files to the actual file inputs inside
  // the save form, so the normal multipart form submission uploads them.
  const rootInput = document.getElementById("save-root-image");
  const trunkInput = document.getElementById("save-trunk-image");
  const rootTransfer = new DataTransfer();
  rootTransfer.items.add(rootImageFile);
  rootInput.files = rootTransfer.files;
  const trunkTransfer = new DataTransfer();
  trunkTransfer.items.add(trunkImageFile);
  trunkInput.files = trunkTransfer.files;

  document.getElementById("result-box").style.display = "";
  document.getElementById("class-reference").style.display = "none";

  startDirectUploads();
}

function wireCaptureZone({ dropZoneId, fileInputId, cameraInputId, previewImgId, kind }) {
  const dropZone = document.getElementById(dropZoneId);
  const fileInput = document.getElementById(fileInputId);
  const cameraInput = cameraInputId ? document.getElementById(cameraInputId) : null;

  // Clicking the drop zone itself opens the camera when nothing's been
  // captured yet (the more likely intent while standing at a tree), and
  // re-opens the browse picker once an image is already showing (the more
  // likely intent there is "pick a different one"). Both explicit buttons
  // below remain available regardless, so this is just a helpful default.
  dropZone.addEventListener("click", () => {
    if (dropZone.classList.contains("step-locked")) return;
    if (cameraInput && !dropZone.classList.contains("has-image")) cameraInput.click();
    else fileInput.click();
  });
  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) handleCapture(fileInput.files[0], { previewImgId, dropZoneId, kind, source: "file" });
  });
  if (cameraInput) {
    cameraInput.addEventListener("change", () => {
      if (cameraInput.files[0]) handleCapture(cameraInput.files[0], { previewImgId, dropZoneId, kind, source: "camera" });
    });
  }
  dropZone.addEventListener("dragover", e => {
    e.preventDefault();
    if (!dropZone.classList.contains("step-locked")) dropZone.classList.add("dragover");
  });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
  dropZone.addEventListener("drop", e => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    if (dropZone.classList.contains("step-locked")) return;
    // Drag-and-drop is also an existing file, same reasoning as Browse.
    if (e.dataTransfer.files[0]) handleCapture(e.dataTransfer.files[0], { previewImgId, dropZoneId, kind, source: "file" });
  });
}

// Keeps Step 1 locked (see .step-locked in style.css) until a farm is
// picked -- a scan captured with no farm attached has nowhere to save
// to, whether it saves live or gets queued offline. Server-rendered
// initial state (see disease_detection.html) already covers the common
// case of a farm already selected app-wide; this just keeps it in sync
// as the person changes the dropdown.
function wireFarmGate() {
  const farmSelect = document.getElementById("save-farm-pk");
  const rootWrapper = document.getElementById("root-zone-wrapper");
  if (!farmSelect || !rootWrapper) return;
  const update = () => rootWrapper.classList.toggle("step-locked", !farmSelect.value);
  farmSelect.addEventListener("change", update);
  update();
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("root-preview-img").style.display = "none";
  document.getElementById("trunk-preview-img").style.display = "none";
  wireFarmGate();
  wireCaptureZone({ dropZoneId: "root-drop-zone", fileInputId: "root-file-input", cameraInputId: "root-camera-input", previewImgId: "root-preview-img", kind: "root" });
  wireCaptureZone({ dropZoneId: "trunk-drop-zone", fileInputId: "trunk-file-input", cameraInputId: "trunk-camera-input", previewImgId: "trunk-preview-img", kind: "trunk" });
  document.getElementById("analyze-btn").addEventListener("click", runAnalysis);
  wireSaveSubmit();
  checkLocationAvailability();
  const locBanner = document.getElementById("location-banner");
  if (locBanner) locBanner.addEventListener("click", checkLocationAvailability);
  wireTreeIdPreview();
});

// Waits for the background direct uploads (if any are in flight) before
// actually submitting the save form, so a fast click right after the
// result appears can't race ahead of the uploads finishing.
function wireSaveSubmit() {
  const btn = document.getElementById("save-submit-btn");
  const form = document.getElementById("save-form");
  if (!btn || !form) return;

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const originalHtml = btn.innerHTML;
    btn.innerHTML = '<i class="bi bi-hourglass-split"></i> Saving...';
    if (directUploadPromise) {
      await directUploadPromise;
    }
    form.submit();
  });
}

// Shows the farmer what their typed tree code will actually be saved as
// (farm ID prefix + their code), matching the server-side prefixing in
// save_detection() -- so there's no surprise about why "T1" shows up in
// the inventory as "FARM-001-T1". Mirrors the server logic only for
// display; the server remains the source of truth for the real prefixing
// and uniqueness check.
function wireTreeIdPreview() {
  const farmSelect = document.getElementById("save-farm-pk");
  const treeIdInput = document.getElementById("save-tree-id");
  const previewEl = document.getElementById("tree-id-preview");
  if (!farmSelect || !treeIdInput || !previewEl) return;

  function update() {
    const farmId = farmSelect.selectedOptions[0]?.dataset.farmId || "";
    const code = treeIdInput.value.trim();
    if (!farmId || !code) {
      previewEl.textContent = "";
      return;
    }
    const finalId = code.startsWith(`${farmId}-`) ? code : `${farmId}-${code}`;
    previewEl.textContent = ` — will be saved as "${finalId}"`;
  }

  farmSelect.addEventListener("change", update);
  treeIdInput.addEventListener("input", update);
}
