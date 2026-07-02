/* Renders the interventions map: only trees that have at least one
   logged intervention, with the latest action shown in each popup.
   Expects INTERVENTION_TREES defined inline before this loads. */

document.addEventListener("DOMContentLoaded", () => {
  const container = document.getElementById("intervention-map");
  if (!container || typeof L === "undefined") return;

  const trees = INTERVENTION_TREES || [];
  const defaultLat = trees.length ? trees[0].lat : 6.9214;
  const defaultLng = trees.length ? trees[0].lng : 122.0790;

  const map = L.map("intervention-map").setView([defaultLat, defaultLng], 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap", maxZoom: 19,
  }).addTo(map);

  trees.forEach(tree => {
    L.circleMarker([tree.lat, tree.lng], {
      radius: 9, color: "#fff", weight: 2, fillColor: "#166534", fillOpacity: 0.9,
    }).bindPopup(`
      <div style="font-weight:700;font-size:14px;">${tree.tree_id}</div>
      <div style="font-size:11px;color:#666;margin-bottom:4px;">${tree.farm_id} — ${tree.farm_name}</div>
      <div style="font-size:12px;">Disease: <b>${tree.disease}</b></div>
      <div style="font-size:12px;color:#166534;margin-top:4px;">
        <i class="bi bi-check-circle-fill"></i> ${tree.latest_intervention} (${tree.latest_intervention_date})
      </div>
      ${tree.intervention_count > 1 ? `<div style="font-size:11px;color:#666;">${tree.intervention_count} total actions logged</div>` : ""}
      <a href="/inventory/${tree.tree_id}/" style="display:inline-block;margin-top:8px;padding:4px 10px;
        background:#2563eb;color:#fff;text-decoration:none;border-radius:4px;font-size:11px;">View Details</a>
    `, { maxWidth: 260 }).addTo(map);
  });

  setTimeout(() => map.invalidateSize(), 150);
});
