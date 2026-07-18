/* Handles the two-step capture flow (root image, then trunk image — see
   comment 4), resizes each photo client-side before upload, runs a
   simulated CNN analysis step (no trained model is wired in yet), and
   uploads both resized images directly to cloud storage via a presigned
   URL (falling back to attaching them to the save form's file inputs for
   a normal multipart submission if direct upload isn't available). */

// Populated from window.DISEASE_CATALOG, which is rendered server-side
// from the dynamic DiseaseClass catalog (see views.disease_detection) --
// NOT a hardcoded list, since the real disease set depends on the trained
// CNN model's actual classes, which depends on dataset/field availability.
const DISEASE_INFO = window.DISEASE_CATALOG || {};

// Images are stored at up to this size on the longest edge -- separate
// from whatever input size a future trained CNN normalizes to (e.g.
// 224x224), which would happen right before inference, not at capture time.
const STORAGE_MAX_DIMENSION = 1080;
const STORAGE_WEBP_QUALITY = 0.85;

let rootImageFile = null;   // resized File, ready to attach to the save form
let trunkImageFile = null;
let capturedLat = null;     // device GPS, captured at scan time (Chapter 3:
let capturedLng = null;     // "Mobile GPS module - Auto the capture coordinates")

// Direct-to-storage upload state. Uploads kick off in the background as
// soon as the (simulated) analysis result is shown, so they're usually
// already finished by the time the farmer reviews the result and hits
// Save. directUploadPromise resolves once both are done (or resolves
// anyway on failure/unavailability, leaving the original file-input
// attachment from showResult() as the fallback).
let directUploadPromise = null;

// Requests the device's current position once, as soon as the user starts
// a scan. Silently no-ops on denial/unsupported browsers -- save_detection
// falls back to the farm's center point server-side in that case.
function captureDeviceGPS() {
  if (!navigator.geolocation || capturedLat !== null) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      capturedLat = pos.coords.latitude;
      capturedLng = pos.coords.longitude;
      document.getElementById("save-lat").value = capturedLat;
      document.getElementById("save-lng").value = capturedLng;
    },
    () => { /* denied or unavailable -- server falls back to farm center */ },
    { enableHighAccuracy: true, timeout: 8000 }
  );
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


// stores the result for the save form, and advances the workflow.
function handleCapture(file, { previewImgId, dropZoneId, kind }) {
  const dropZone = document.getElementById(dropZoneId);
  const previewImg = document.getElementById(previewImgId);

  resizeImageFile(file).then(resizedFile => {
    if (kind === "root") {
      rootImageFile = resizedFile;
    } else {
      trunkImageFile = resizedFile;
    }
    previewImg.src = URL.createObjectURL(resizedFile);
    previewImg.style.display = "block";
    dropZone.classList.add("has-image");

    if (kind === "root") {
      // Root image captured first -- unlock the trunk capture step.
      document.getElementById("trunk-zone-wrapper").classList.remove("step-locked");
      setWorkflowStep(1);
    } else {
      document.getElementById("analyze-btn").disabled = false;
      setWorkflowStep(2);
    }
  }).catch(() => {
    alert("Couldn't process that image. Please try another photo.");
  });
}

// Runs a simulated CNN analysis (random pick among trunk disease classes)
// plus a simulated root-condition check, since a trained model isn't
// wired into this Django app yet. Root condition is assessed separately
// from trunk disease -- exposed roots aren't one of the trained trunk
// disease classes (see the dynamic DiseaseClass catalog for what those are).
function runAnalysis() {
  const classes = Object.keys(DISEASE_INFO);
  if (classes.length === 0) {
    alert("No disease classes are configured yet. Add at least one in the admin panel.");
    return;
  }
  setWorkflowStep(2);
  const analyzeBtn = document.getElementById("analyze-btn");
  analyzeBtn.disabled = true;
  analyzeBtn.innerHTML = '<i class="bi bi-hourglass-split"></i> Analyzing...';

  setTimeout(() => {
    const disease = classes[Math.floor(Math.random() * classes.length)];
    const confidence = Math.round((70 + Math.random() * 29) * 10) / 10;
    const rootCondition = Math.random() < 0.75 ? "Healthy Roots" : "Exposed Roots Detected";
    showResult(disease, confidence, rootCondition);
    setWorkflowStep(3);
    analyzeBtn.disabled = false;
    analyzeBtn.innerHTML = '<i class="bi bi-cpu"></i> Analyze Images';
  }, 1400);
}

// Populates and reveals the result panel, hides the class reference card,
// and fills the hidden save-form fields (including the two image files).
function showResult(disease, confidence, rootCondition) {
  const info = DISEASE_INFO[disease];
  document.getElementById("result-disease").textContent = disease;
  document.getElementById("result-conf").textContent = `${confidence}%`;
  document.getElementById("result-fill").style.width = `${confidence}%`;
  document.getElementById("result-action").textContent = info.action;

  const rootBadge = document.getElementById("result-root-condition");
  rootBadge.textContent = rootCondition;
  rootBadge.className = rootCondition === "Exposed Roots Detected"
    ? "fw-bold mt-1 text-pink" : "fw-bold mt-1 text-healthy";

  const badge = document.getElementById("threshold-badge-result");
  badge.innerHTML = confidence >= 80
    ? '<span class="threshold-badge threshold-confirmed"><i class="bi bi-check-circle-fill"></i> Confirmed Detection</span>'
    : '<span class="threshold-badge threshold-review"><i class="bi bi-exclamation-circle-fill"></i> Manual Review Suggested</span>';

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
  captureDeviceGPS();
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
