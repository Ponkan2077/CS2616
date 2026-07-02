/* Handles the Log Intervention form: toggling between ID-range and
   checklist selection modes, and building the tree checklist for the
   selected farm. Expects FARM_TREES_BY_ID defined inline before this
   script loads. */

// Switches between range and checklist selection modes, updating the
// hidden selection_mode field and toggling which fields are visible.
function setSelectionMode(mode) {
  document.getElementById("selection-mode-input").value = mode;
  document.getElementById("range-mode-fields").style.display = mode === "range" ? "" : "none";
  document.getElementById("checklist-mode-fields").style.display = mode === "single" ? "" : "none";
  document.querySelectorAll(".view-toggle-btn[data-mode]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });
}

// Rebuilds the tree checklist for whichever farm is currently selected.
function rebuildChecklist() {
  const farmSelect = document.getElementById("iv-farm");
  const container = document.getElementById("tree-checklist");
  const farmPk = farmSelect.value;
  container.innerHTML = "";

  const trees = FARM_TREES_BY_ID[farmPk] || [];
  if (!trees.length) {
    container.innerHTML = '<div class="text-muted" style="font-size:12px;">No trees on this farm yet.</div>';
    return;
  }

  trees.forEach(t => {
    const label = document.createElement("label");
    label.className = "tree-checklist-item";
    label.innerHTML = `
      <input type="checkbox" name="tree_ids" value="${t.tree_id}">
      <span>${t.tree_id}</span>
      <span class="text-muted" style="font-size:10px;">${t.disease}</span>
    `;
    container.appendChild(label);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".view-toggle-btn[data-mode]").forEach(btn => {
    btn.addEventListener("click", () => setSelectionMode(btn.dataset.mode));
  });

  const farmSelect = document.getElementById("iv-farm");
  if (farmSelect) farmSelect.addEventListener("change", rebuildChecklist);

  const dateInput = document.getElementById("date_performed");
  if (dateInput && !dateInput.value) {
    dateInput.value = new Date().toISOString().split("T")[0];
  }
});
