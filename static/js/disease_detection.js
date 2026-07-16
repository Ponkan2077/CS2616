/* Handles the two-step capture flow (root image, then trunk image — see
   comment 4), resizes each photo client-side before upload, runs a
   simulated CNN analysis step (no trained model is wired in yet), and
   populates the save form -- including the two resized image files --
   ready for a normal multipart form submission. */

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

// Shared handler for both capture zones: resizes the file, previews it,
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
  wireCaptureZone({ dropZoneId: "root-drop-zone", fileInputId: "root-file-input", previewImgId: "root-preview-img", kind: "root" });
  wireCaptureZone({ dropZoneId: "trunk-drop-zone", fileInputId: "trunk-file-input", previewImgId: "trunk-preview-img", kind: "trunk" });
  document.getElementById("analyze-btn").addEventListener("click", runAnalysis);
});
