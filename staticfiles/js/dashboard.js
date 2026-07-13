/* Renders the compact "Disease Cases by Location" map on the dashboard.
   Uses the minimal marker payload for a fast initial load; full detail
   for a tree is fetched lazily only when its marker is clicked. Expects
   DASHBOARD_MARKERS defined inline in dashboard.html before this loads. */

document.addEventListener("DOMContentLoaded", () => {
  const container = document.getElementById("dashboard-mini-map");
  if (!container || typeof L === "undefined") return;

  const markers = DASHBOARD_MARKERS || [];
  const defaultLat = markers.length ? markers[0].lat : 6.9214;
  const defaultLng = markers.length ? markers[0].lng : 122.0790;

  const map = L.map("dashboard-mini-map", { zoomControl: true, scrollWheelZoom: false })
    .setView([defaultLat, defaultLng], 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap", maxZoom: 19,
  }).addTo(map);

  const detailCache = {};

  markers.forEach(tree => {
    const circle = L.circleMarker([tree.lat, tree.lng], {
      radius: 7, color: "#fff", weight: 1.5, fillColor: tree.color, fillOpacity: 0.9,
    });
    circle.bindPopup(`<b>${tree.tree_id}</b><br>${tree.disease} · ${tree.confidence}%`);

    circle.on("popupopen", async () => {
      if (detailCache[tree.tree_id]) {
        circle.setPopupContent(detailCache[tree.tree_id]);
        return;
      }
      try {
        const res = await fetch(`/map/marker/${tree.tree_id}/`);
        if (!res.ok) throw new Error("fetch failed");
        const detail = await res.json();
        const html = `
          <b>${detail.tree_id}</b><br>
          ${detail.disease} · ${detail.confidence}%<br>
          <span style="font-size:11px;color:#666;">Block ${detail.block}</span><br>
          <a href="/inventory/${detail.tree_id}/" style="font-size:11px;">View Details →</a>
        `;
        detailCache[tree.tree_id] = html;
        circle.setPopupContent(html);
      } catch (err) {
        // Keep the lightweight popup content on failure — not critical
        // enough to show an error state for a dashboard preview map.
      }
    });

    circle.addTo(map);
  });

  setTimeout(() => map.invalidateSize(), 150);
});
