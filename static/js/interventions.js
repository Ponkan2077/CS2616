/* Handles the Log Intervention form.

   A farm is mandatory: until one is chosen, neither the ID range nor the
   checklist is shown (a message takes their place), because both only mean
   something for one farm's trees.

   The checklist is filled from intervention_tree_options() (the data-options-url
   on the form) with the tree-ID search, disease and status filters applied on
   the server, so a farm with thousands of trees is searchable instead of cut
   off. Ticked trees are remembered across filter changes and are written into
   the form as hidden tree_ids fields when it is submitted. */

const IV_SEARCH_DEBOUNCE_MS = 250;

// Tree IDs ticked so far, kept across filter changes and re-renders.
const ivSelected = new Set();
// Trees currently listed (after the filters), for "Select all shown".
let ivShown = [];
let ivTotalMatching = 0;
let ivLoadToken = 0;       // ignores a slow response that a newer request replaced
let ivSearchTimer = null;

const ivEl = id => document.getElementById(id);

function ivMode() { return ivEl("selection-mode-input").value; }
function ivFarm() { return ivEl("iv-farm").value; }

// Shows only what the current farm + mode allow: the "select a farm" message
// while no farm is chosen, otherwise the ID range or the checklist.
function applySelectionState() {
  const hasFarm = !!ivFarm();
  const mode = ivMode();
  ivEl("iv-farm-gate").hidden = hasFarm;
  ivEl("range-mode-fields").hidden = !(hasFarm && mode === "range");
  ivEl("checklist-mode-fields").hidden = !(hasFarm && mode === "single");
  if (hasFarm && mode === "single") loadChecklist();
}

// Switches between range and checklist selection modes.
function setSelectionMode(mode) {
  ivEl("selection-mode-input").value = mode;
  document.querySelectorAll(".view-toggle-btn[data-mode]").forEach(btn => {
    const on = btn.dataset.mode === mode;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  });
  applySelectionState();
}

function updateCount() {
  const picked = ivSelected.size;
  const parts = [`${picked} selected`];
  if (ivTotalMatching > ivShown.length) {
    parts.push(`showing the first ${ivShown.length} of ${ivTotalMatching} matching trees`);
  } else {
    parts.push(`${ivTotalMatching} tree${ivTotalMatching === 1 ? "" : "s"} shown`);
  }
  ivEl("iv-checklist-count").textContent = parts.join(" · ");
  ivEl("iv-select-shown").disabled = !ivShown.length;
  ivEl("iv-clear-selected").disabled = picked === 0;
}

function showChecklistMessage(text) {
  const box = ivEl("tree-checklist");
  box.innerHTML = "";
  const msg = document.createElement("div");
  msg.className = "text-muted text-sm-rg p-2";
  msg.textContent = text;
  box.appendChild(msg);
}

// Built with DOM calls (not innerHTML) because tree IDs and disease names are
// user-entered text.
function renderChecklist() {
  const box = ivEl("tree-checklist");
  box.innerHTML = "";
  if (!ivShown.length) {
    const filtered = ivEl("iv-tree-search").value.trim() || ivEl("iv-disease-filter").value || ivEl("iv-status-filter").value;
    showChecklistMessage(filtered
      ? "No trees match these filters. Change or clear them to see more."
      : "No trees on this farm yet. Scan a tree first, then log interventions.");
    updateCount();
    return;
  }
  ivShown.forEach(t => {
    const label = document.createElement("label");
    label.className = "tree-checklist-item";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = t.tree_id;
    input.checked = ivSelected.has(t.tree_id);
    input.addEventListener("change", () => {
      if (input.checked) ivSelected.add(t.tree_id); else ivSelected.delete(t.tree_id);
      ivEl("iv-selection-error").hidden = true;
      updateCount();
    });

    const idText = document.createElement("span");
    idText.className = "tree-checklist-id";
    idText.textContent = t.tree_id;

    const diseaseText = document.createElement("span");
    diseaseText.className = "text-muted text-sm-rg";
    diseaseText.textContent = t.disease;

    label.append(input, idText, diseaseText);
    if (t.has_intervention) {
      const done = document.createElement("span");
      done.className = "tree-checklist-done text-sm-rg";
      done.textContent = "Action logged";
      label.appendChild(done);
    }
    box.appendChild(label);
  });
  updateCount();
}

async function loadChecklist() {
  const farm = ivFarm();
  if (!farm) return;
  const token = ++ivLoadToken;
  const box = ivEl("tree-checklist");
  box.setAttribute("aria-busy", "true");
  showChecklistMessage("Loading trees…");

  const params = new URLSearchParams({
    farm_pk: farm,
    q: ivEl("iv-tree-search").value.trim(),
    disease: ivEl("iv-disease-filter").value,
    status: ivEl("iv-status-filter").value,
  });
  try {
    const res = await fetch(`${ivEl("intervention-form").dataset.optionsUrl}?${params}`, {
      headers: { "X-Requested-With": "XMLHttpRequest" },
      credentials: "same-origin",
    });
    if (!res.ok) throw new Error("bad response");
    const data = await res.json();
    if (token !== ivLoadToken) return;   // a newer request is in flight
    ivShown = data.trees || [];
    ivTotalMatching = data.total || 0;
    renderChecklist();
  } catch (err) {
    if (token !== ivLoadToken) return;
    ivShown = [];
    ivTotalMatching = 0;
    showChecklistMessage("Couldn't load the trees. Check your connection and try again.");
    updateCount();
  } finally {
    if (token === ivLoadToken) box.setAttribute("aria-busy", "false");
  }
}

// A different farm means different trees: forget the ticks and the filters.
function resetChecklist() {
  ivSelected.clear();
  ivShown = [];
  ivTotalMatching = 0;
  ivEl("iv-tree-search").value = "";
  ivEl("iv-disease-filter").value = "";
  ivEl("iv-status-filter").value = "";
  ivEl("iv-selection-error").hidden = true;
  ivEl("tree-checklist").innerHTML = "";
  updateCount();
}

// Writes the ticked trees into the form as tree_ids just before it is sent.
function writeSelectedInputs() {
  const holder = ivEl("iv-selected-inputs");
  holder.innerHTML = "";
  ivSelected.forEach(id => {
    const hidden = document.createElement("input");
    hidden.type = "hidden";
    hidden.name = "tree_ids";
    hidden.value = id;
    holder.appendChild(hidden);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  const form = ivEl("intervention-form");
  if (!form) return;

  document.querySelectorAll(".view-toggle-btn[data-mode]").forEach(btn => {
    btn.addEventListener("click", () => setSelectionMode(btn.dataset.mode));
  });

  ivEl("iv-farm").addEventListener("change", () => {
    resetChecklist();
    applySelectionState();
  });

  ivEl("iv-tree-search").addEventListener("input", () => {
    clearTimeout(ivSearchTimer);
    ivSearchTimer = setTimeout(loadChecklist, IV_SEARCH_DEBOUNCE_MS);
  });
  ivEl("iv-disease-filter").addEventListener("change", loadChecklist);
  ivEl("iv-status-filter").addEventListener("change", loadChecklist);

  ivEl("iv-select-shown").addEventListener("click", () => {
    ivShown.forEach(t => ivSelected.add(t.tree_id));
    ivEl("iv-selection-error").hidden = true;
    renderChecklist();
  });
  ivEl("iv-clear-selected").addEventListener("click", () => {
    ivSelected.clear();
    renderChecklist();
  });

  form.addEventListener("submit", e => {
    if (ivMode() !== "single") return;
    if (!ivSelected.size) {
      e.preventDefault();
      const err = ivEl("iv-selection-error");
      err.hidden = false;
      err.scrollIntoView({ block: "nearest" });
      return;
    }
    writeSelectedInputs();
  });

  // Start fresh each time the modal opens.
  const modal = ivEl("logInterventionModal");
  if (modal) modal.addEventListener("hidden.bs.modal", () => {
    form.reset();
    resetChecklist();
    setSelectionMode("range");
    setDefaultDate();
  });

  function setDefaultDate() {
    const dateInput = ivEl("date_performed");
    if (!dateInput) return;
    // Local date, not toISOString() (UTC): in the Philippines (UTC+8) that
    // would show yesterday's date for the first 8 hours of every day.
    const now = new Date();
    const pad = n => String(n).padStart(2, "0");
    dateInput.value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }
  setDefaultDate();
  applySelectionState();
});
