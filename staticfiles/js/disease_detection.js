/* Handles image upload, drag-and-drop preview, a simulated CNN analysis
   step, and populating the save form with the detected result. */

const DISEASE_INFO = {
  "Healthy": { action: "No action needed. Continue regular monitoring every 30 days.", confirmed: true },
  "Pink Disease": { action: "Apply fungicide (Mancozeb 80% WP) immediately. Remove infected bark.", confirmed: true },
  "White Root Rot": { action: "Uproot and destroy infected roots. Treat soil with Trichoderma biocontrol.", confirmed: true },
  "Stem Bleeding": { action: "Scrape off infected bark. Apply Metalaxyl paste. Avoid tapping 60 days.", confirmed: true },
};

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

// Loads the chosen file into the preview image and reveals the drop zone preview.
function loadPreview(file) {
  const dropZone = document.getElementById("drop-zone");
  const previewImg = document.getElementById("preview-img");
  const reader = new FileReader();
  reader.onload = e => {
    previewImg.src = e.target.result;
    dropZone.classList.add("has-image");
    document.getElementById("analyze-btn").disabled = false;
    setWorkflowStep(1);
  };
  reader.readAsDataURL(file);
}

// Runs a simulated CNN analysis (random pick among disease classes) since
// the trained model isn't wired into this Django app yet, then reveals
// the result panel with a randomized but realistic confidence score.
function runAnalysis() {
  setWorkflowStep(2);
  const analyzeBtn = document.getElementById("analyze-btn");
  analyzeBtn.disabled = true;
  analyzeBtn.innerHTML = '<i class="bi bi-hourglass-split"></i> Analyzing...';

  setTimeout(() => {
    const classes = Object.keys(DISEASE_INFO);
    const disease = classes[Math.floor(Math.random() * classes.length)];
    const confidence = Math.round((70 + Math.random() * 29) * 10) / 10;
    showResult(disease, confidence);
    setWorkflowStep(3);
    analyzeBtn.disabled = false;
    analyzeBtn.innerHTML = '<i class="bi bi-cpu"></i> Analyze Image';
  }, 1400);
}

// Populates and reveals the result panel, hides the class reference card,
// and fills the hidden save-form fields with the detected values.
function showResult(disease, confidence) {
  const info = DISEASE_INFO[disease];
  document.getElementById("result-disease").textContent = disease;
  document.getElementById("result-conf").textContent = `${confidence}%`;
  document.getElementById("result-fill").style.width = `${confidence}%`;
  document.getElementById("result-action").textContent = info.action;

  const badge = document.getElementById("threshold-badge-result");
  badge.innerHTML = confidence >= 80
    ? '<span class="threshold-badge threshold-confirmed"><i class="bi bi-check-circle-fill"></i> Confirmed Detection</span>'
    : '<span class="threshold-badge threshold-review"><i class="bi bi-exclamation-circle-fill"></i> Manual Review Suggested</span>';

  document.getElementById("save-disease").value = disease;
  document.getElementById("save-confidence").value = confidence;

  document.getElementById("result-box").style.display = "";
  document.getElementById("class-reference").style.display = "none";
}

document.addEventListener("DOMContentLoaded", () => {
  const dropZone = document.getElementById("drop-zone");
  const fileInput = document.getElementById("file-input");
  const analyzeBtn = document.getElementById("analyze-btn");

  dropZone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) loadPreview(fileInput.files[0]);
  });

  dropZone.addEventListener("dragover", e => { e.preventDefault(); dropZone.classList.add("dragover"); });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
  dropZone.addEventListener("drop", e => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    if (e.dataTransfer.files[0]) loadPreview(e.dataTransfer.files[0]);
  });

  analyzeBtn.addEventListener("click", runAnalysis);
});
