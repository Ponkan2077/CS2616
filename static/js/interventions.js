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
    const empty = document.createElement("div");
    empty.className = "text-muted";
    empty.style.fontSize = "12px";
    empty.textContent = "No trees on this farm yet. Scan a tree first, then log interventions.";
    container.appendChild(empty);
    return;
  }

  // Built with DOM calls (not innerHTML) because tree IDs and disease names
  // are user-entered text.
  trees.forEach(t => {
    const label = document.createElement("label");
    label.className = "tree-checklist-item";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = "tree_ids";
    input.value = t.tree_id;

    const idText = document.createElement("span");
    idText.textContent = t.tree_id;

    const diseaseText = document.createElement("span");
    diseaseText.className = "text-muted";
    diseaseText.style.fontSize = "10px";
    diseaseText.textContent = t.disease;

    label.append(input, idText, diseaseText);
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
    // Local date, not toISOString() (UTC): in the Philippines (UTC+8) that
    // would show yesterday's date for the first 8 hours of every day.
    const now = new Date();
    const pad = n => String(n).padStart(2, "0");
    dateInput.value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }
});
