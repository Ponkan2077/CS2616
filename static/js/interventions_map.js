/* Renders the interventions map: only trees that have at least one
   logged intervention, with the latest action shown in each popup.
   Expects INTERVENTION_TREES defined inline before this loads. Colours come
   from the CSS variables (see rgPinIcon in main.js). */

document.addEventListener("DOMContentLoaded", () => {
  const container = document.getElementById("intervention-map");
  if (!container || typeof L === "undefined") return;

  const trees = INTERVENTION_TREES || [];

  // Farm names, diseases and intervention types are user/admin-entered text;
  // escape them before they go into popup HTML.
  const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
  const defaultLat = trees.length ? trees[0].lat : 6.9214;
  const defaultLng = trees.length ? trees[0].lng : 122.0790;

  const map = L.map("intervention-map").setView([defaultLat, defaultLng], 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap", maxZoom: 19,
  }).addTo(map);

  // Every pin on this map is a tree that has been treated, so they all use the
  // primary teal (the same "action taken" colour as the farm map's
  // Interventions view). It is read from the CSS variable each time a pin is
  // built, so the pins follow the theme (rgAttachPinScaling rebuilds them on
  // "themechange").
  const treatedTree = { get color() { return RG.tokens().primary; } };

  const markerList = [];
  trees.forEach(tree => {
    const more = tree.intervention_count > 1
      ? `<div class="tp-sub">${esc(tree.intervention_count)} total actions logged</div>` : "";
    const marker = L.marker([tree.lat, tree.lng], {
      icon: rgPinIcon(treatedTree.color, 22),
      title: `Tree ${tree.tree_id}`,
      alt: `Tree ${tree.tree_id}, ${tree.disease}`,
    }).bindPopup(`
      <div class="tp-head">${esc(tree.tree_id)}</div>
      <div class="tp-disease">${esc(tree.farm_id)} — ${esc(tree.farm_name)}</div>
      <dl class="tp-grid"><dt>Disease</dt><dd>${esc(tree.disease)}</dd></dl>
      <div class="tp-note ok"><i class="bi bi-check-circle-fill"></i> ${esc(tree.latest_intervention)} (${esc(tree.latest_intervention_date)})</div>
      ${more}
      <a class="tp-link" href="/inventory/${encodeURIComponent(tree.tree_id)}/">View details</a>
    `, { maxWidth: 260, className: "rg-popup" }).addTo(map);
    markerList.push({ el: marker, tree: treatedTree });
  });

  setTimeout(() => {
    map.invalidateSize();
    rgAttachPinScaling(map, markerList);
  }, 150);
});
