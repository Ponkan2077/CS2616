/* ─── RubberGuard — main.js ──────────────────────────────── */

// ── Sidebar toggle ────────────────────────────────────────
const sidebar  = document.getElementById('sidebar');
const overlay  = document.getElementById('sidebar-overlay');
const hamburger = document.getElementById('hamburger');

function openSidebar()  {
  sidebar.classList.add('open');
  overlay.classList.add('open');
}
function closeSidebar() {
  sidebar.classList.remove('open');
  overlay.classList.remove('open');
}
if (hamburger) hamburger.addEventListener('click', openSidebar);
if (overlay)   overlay.addEventListener('click', closeSidebar);

// ── Disease Detection page ────────────────────────────────
const dropZone   = document.getElementById('drop-zone');
const fileInput  = document.getElementById('file-input');
const previewImg = document.getElementById('preview-img');
const analyzeBtn = document.getElementById('analyze-btn');
const resultBox  = document.getElementById('result-box');
const workflowSteps = document.querySelectorAll('.workflow-step');
const uploadPlaceholder = document.getElementById('upload-placeholder');

function setStep(n) {
  workflowSteps.forEach((s, i) => {
    s.classList.remove('active', 'done');
    if (i < n)  s.classList.add('done');
    if (i === n) s.classList.add('active');
  });
}

if (dropZone) {
  dropZone.addEventListener('click', () => fileInput && fileInput.click());

  dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  });
}

if (fileInput) {
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleFile(fileInput.files[0]);
  });
}

function handleFile(file) {
  if (!file.type.startsWith('image/')) {
    alert('Please upload a valid image file (JPG, PNG, WEBP).');
    return;
  }
  const reader = new FileReader();
  reader.onload = e => {
    if (previewImg) {
      previewImg.src = e.target.result;
      previewImg.style.display = 'block';
    }
    if (uploadPlaceholder) uploadPlaceholder.style.display = 'none';
    if (analyzeBtn) analyzeBtn.disabled = false;
    setStep(1);
    if (resultBox) resultBox.style.display = 'none';
  };
  reader.readAsDataURL(file);
}

if (analyzeBtn) {
  analyzeBtn.addEventListener('click', () => {
    setStep(2);
    analyzeBtn.disabled = true;
    analyzeBtn.innerHTML = '<span class="spinner-rg"></span> Analyzing…';

    setTimeout(() => {
      // Mock CNN result
      const classes = [
        { label: 'Healthy',       conf: 97.3, key: 'healthy',    action: 'No action needed. Continue regular monitoring every 30 days.' },
        { label: 'Pink Disease',  conf: 91.6, key: 'pink',       action: 'Apply fungicide (Mancozeb 80% WP) immediately. Remove infected bark and treat with copper-based paste.' },
        { label: 'White Root Rot',conf: 85.9, key: 'white-root', action: 'Uproot and destroy infected roots. Treat soil with Trichoderma-based biocontrol agent.' },
        { label: 'Stem Bleeding', conf: 88.2, key: 'stem',       action: 'Scrape off infected bark. Apply Metalaxyl paste to wound. Avoid tapping for 60 days.' },
      ];
      const pick = classes[Math.floor(Math.random() * classes.length)];

      document.getElementById('result-disease').textContent  = pick.label;
      document.getElementById('result-conf').textContent     = pick.conf.toFixed(1) + '%';
      document.getElementById('result-action').textContent   = pick.action;
      document.getElementById('result-fill').style.width     = pick.conf + '%';

      // Color the disease label
      const labelEl = document.getElementById('result-disease');
      labelEl.className = 'text-' + pick.key;

      // Threshold badge
      const threshBadge = document.getElementById('threshold-badge');
      if (pick.conf >= 80) {
        threshBadge.className = 'threshold-badge threshold-confirmed';
        threshBadge.innerHTML = '<i class="bi bi-check-circle-fill"></i> Confirmed Detection (≥80% confidence)';
      } else {
        threshBadge.className = 'threshold-badge threshold-review';
        threshBadge.innerHTML = '<i class="bi bi-exclamation-circle-fill"></i> Requires Manual Review (<80% confidence)';
      }

      if (resultBox) resultBox.style.display = 'block';
      analyzeBtn.disabled = false;
      analyzeBtn.innerHTML = '<i class="bi bi-cpu"></i> Analyze Image';
      setStep(3);
    }, 1800);
  });
}

// ── Tree Inventory search + filter ───────────────────────
const searchInput  = document.getElementById('tree-search');
const filterSelect = document.getElementById('disease-filter');
const tableRows    = document.querySelectorAll('.tree-row');

function filterTable() {
  const q = searchInput ? searchInput.value.toLowerCase() : '';
  const d = filterSelect ? filterSelect.value : '';
  tableRows.forEach(row => {
    const id  = (row.dataset.treeid  || '').toLowerCase();
    const dis = (row.dataset.disease || '');
    const matchQ = !q || id.includes(q);
    const matchD = !d || dis === d;
    row.style.display = (matchQ && matchD) ? '' : 'none';
  });
}
if (searchInput)  searchInput.addEventListener('input', filterTable);
if (filterSelect) filterSelect.addEventListener('change', filterTable);

// ── Toast notifications ──────────────────────────────────
function showToast(msg, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const t = document.createElement('div');
  t.className = `toast align-items-center text-white bg-${type} border-0 show mb-2`;
  t.setAttribute('role', 'alert');
  t.innerHTML = `
    <div class="d-flex">
      <div class="toast-body">${msg}</div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto" onclick="this.closest('.toast').remove()"></button>
    </div>`;
  container.appendChild(t);
  setTimeout(() => t.remove(), 4500);
}

// Save result button
const saveBtn = document.getElementById('save-result-btn');
if (saveBtn) {
  saveBtn.addEventListener('click', () => {
    showToast('<i class="bi bi-check-circle-fill me-2"></i> Detection result saved successfully.', 'success');
  });
}

// Add tree button
const addTreeBtn = document.getElementById('add-tree-btn');
if (addTreeBtn) {
  addTreeBtn.addEventListener('click', () => {
    showToast('<i class="bi bi-info-circle-fill me-2"></i> Database integration required to add trees.', 'primary');
  });
}

// Export buttons
document.querySelectorAll('.export-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const fmt = btn.dataset.fmt || 'file';
    showToast(`<i class="bi bi-download me-2"></i> Export to ${fmt.toUpperCase()} — backend integration required.`, 'secondary');
  });
});