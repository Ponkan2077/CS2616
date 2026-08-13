/* Handles the two-step capture flow (root image, then trunk image — see
   comment 4), resizes each photo client-side before upload, sends both to
   the real AI model for analysis, and uploads both resized images
   directly to cloud storage via a presigned URL (falling back to
   attaching them to the save form's file inputs for a normal multipart
   submission if direct upload isn't available). */

// Images are stored at up to this size on the longest edge -- separate
// from whatever input size a future trained CNN normalizes to (e.g.
// 224x224), which would happen right before inference, not at capture time.
const STORAGE_MAX_DIMENSION = 1080;
const STORAGE_WEBP_QUALITY = 0.85;

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
function getDeviceGPS() {
  return new Promise(resolve => {
    if (!navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, source: "device" }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  });
}

// Every photo has to carry a location one way or another: prefer the
// GPS baked into the photo's own EXIF (works for both a fresh camera
// shot with location tagging on, and an existing geotagged photo picked
// from the gallery), and only fall back to the device's live position
// when the file has none. Returns null if neither is available -- the
// caller rejects the photo in that case rather than saving it untagged.
async function resolveImageGPS(file) {
  const exifGps = await extractGPSFromFile(file);
  if (exifGps) return exifGps;
  return await getDeviceGPS();
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
function resizeImageFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      let { width, height } = img;
      const longestEdge = Math.max(width, height);
      if (longestEdge > STORAGE_MAX_DIMENSION) {
        const scale = STORAGE_MAX_DIMENSION / longestEdge;
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      canvas.toBlob(blob => {
        if (!blob) { reject(new Error("Resize failed")); return; }
        const resizedName = file.name.replace(/\.[^.]+$/, "") + ".webp";
        resolve(new File([blob], resizedName, { type: "image/webp" }));
      }, "image/webp", STORAGE_WEBP_QUALITY);
    };
    img.onerror = reject;
    img.src = objectUrl;
  });
}

// Reads the CSRF token straight out of the save form's own hidden input,
// so the direct-upload requests below stay authenticated the same way
// the eventual form submission is, without depending on cookie settings.
function getCsrfToken() {
  return document.querySelector('#save-form input[name=csrfmiddlewaretoken]').value;
}

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
function handleCapture(file, { previewImgId, dropZoneId, kind }) {
  const dropZone = document.getElementById(dropZoneId);
  const previewImg = document.getElementById(previewImgId);
  const statusEl = document.getElementById(`${kind}-gps-status`);
  if (statusEl) { statusEl.textContent = "Checking location…"; statusEl.className = "text-muted mt-1"; statusEl.style.fontSize = "11px"; }

  Promise.all([resolveImageGPS(file), resizeImageFile(file)]).then(([gps, resizedFile]) => {
    if (!gps) {
      if (statusEl) {
        statusEl.textContent = "No location data found in this photo, and couldn't get your device's GPS either. Enable location and try again.";
        statusEl.className = "text-danger mt-1";
        statusEl.style.fontSize = "11px";
      }
      return; // reject: image is not accepted, existing state (if any) is untouched
    }

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
  const chosenGps = rootGPS || trunkGPS;
  await queueScan({
    farmPk: document.getElementById("save-farm-pk").value,
    treeId: document.getElementById("save-tree-id").value.trim(),
    block: document.getElementById("save-block").value.trim(),
    rootBlob: rootImageFile,
    trunkBlob: trunkImageFile,
    lat: chosenGps.lat,
    lng: chosenGps.lng,
    gpsSource: chosenGps.source,
    capturedAt: Date.now(),
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
  rootBadge.textContent = rootCondition;
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

function wireCaptureZone({ dropZoneId, fileInputId, previewImgId, kind }) {
  const dropZone = document.getElementById(dropZoneId);
  const fileInput = document.getElementById(fileInputId);

  dropZone.addEventListener("click", () => {
    if (dropZone.classList.contains("step-locked")) return;
    fileInput.click();
  });
  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) handleCapture(fileInput.files[0], { previewImgId, dropZoneId, kind });
  });
  dropZone.addEventListener("dragover", e => {
    e.preventDefault();
    if (!dropZone.classList.contains("step-locked")) dropZone.classList.add("dragover");
  });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
  dropZone.addEventListener("drop", e => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    if (dropZone.classList.contains("step-locked")) return;
    if (e.dataTransfer.files[0]) handleCapture(e.dataTransfer.files[0], { previewImgId, dropZoneId, kind });
  });
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("root-preview-img").style.display = "none";
  document.getElementById("trunk-preview-img").style.display = "none";
  wireCaptureZone({ dropZoneId: "root-drop-zone", fileInputId: "root-file-input", previewImgId: "root-preview-img", kind: "root" });
  wireCaptureZone({ dropZoneId: "trunk-drop-zone", fileInputId: "trunk-file-input", previewImgId: "trunk-preview-img", kind: "trunk" });
  document.getElementById("analyze-btn").addEventListener("click", runAnalysis);
  wireSaveSubmit();
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
