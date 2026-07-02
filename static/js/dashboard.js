document.addEventListener("DOMContentLoaded", () => {
  const container = document.getElementById("dashboard-mini-map");
  if (!container || typeof L === "undefined") return;

  const trees = DASHBOARD_TREES || [];
  const defaultLat = trees.length ? trees[0].lat : 6.9214;
  const defaultLng = trees.length ? trees[0].lng : 122.0790;

  const map = L.map("dashboard-mini-map", { zoomControl: true, scrollWheelZoom: false })
    .setView([defaultLat, defaultLng], 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap", maxZoom: 19,
  }).addTo(map);

  trees.forEach(tree => {
    L.circleMarker([tree.lat, tree.lng], {
      radius: 7, color: "#fff", weight: 1.5, fillColor: tree.color, fillOpacity: 0.9,
    }).bindPopup(`<b>${tree.tree_id}</b><br>${tree.disease} (${tree.severity_label})`).addTo(map);
  });

  setTimeout(() => map.invalidateSize(), 150);
});
