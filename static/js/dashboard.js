/* Renders the disease distribution doughnut and (when the page has one) the
   compact "Disease Cases by Location" map on the dashboard.
   Uses the minimal marker payload for a fast initial load; full detail
   for a tree is fetched lazily only when its marker is clicked. Expects
   DASHBOARD_DISEASE_STATS (and, for the map, DASHBOARD_MARKERS) defined
   inline in dashboard.html before this loads.

   Segment and marker colours are the disease colours from the data; the
   rest is read from the CSS variables, and the doughnut is rebuilt on
   "themechange". */

function renderDashboardPie(diseaseStats) {
  const canvas = document.getElementById("dashboardPie");
  if (!canvas || typeof Chart === "undefined") return;
  const existing = Chart.getChart(canvas);
  if (existing) existing.destroy();
  const t = RG.tokens();
  new Chart(canvas, {
    type: "doughnut",
    data: {
      labels: diseaseStats.map(d => d.name),
      datasets: [{
        data: diseaseStats.map(d => d.count),
        backgroundColor: diseaseStats.map(d => d.color),
        borderWidth: 2, borderColor: t.cardBg,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      cutout: "62%",
      plugins: {
        legend: { position: "right", labels: { boxWidth: 10, color: t.textMain, font: { size: 12 } } },
        tooltip: RG.chartTooltip(),
      },
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  if (typeof DASHBOARD_DISEASE_STATS !== "undefined") {
    renderDashboardPie(DASHBOARD_DISEASE_STATS);
    RG.onThemeChange(() => renderDashboardPie(DASHBOARD_DISEASE_STATS));
  }

  const container = document.getElementById("dashboard-mini-map");
  if (!container || typeof L === "undefined") return;

  const markers = (typeof DASHBOARD_MARKERS !== "undefined" && DASHBOARD_MARKERS) || [];
  const defaultLat = markers.length ? markers[0].lat : 6.9214;
  const defaultLng = markers.length ? markers[0].lng : 122.0790;

  const map = L.map("dashboard-mini-map", { zoomControl: true, scrollWheelZoom: false })
    .setView([defaultLat, defaultLng], 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap", maxZoom: 19,
  }).addTo(map);

  const detailCache = {};
  const circles = [];

  markers.forEach(tree => {
    const circle = L.circleMarker([tree.lat, tree.lng], {
      radius: 7, color: RG.tokens().mapRingInv, weight: 1.5, fillColor: tree.color, fillOpacity: 0.9,
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
          <a href="/inventory/${detail.tree_id}/" class="small">View Details →</a>
        `;
        detailCache[tree.tree_id] = html;
        circle.setPopupContent(html);
      } catch (err) {
        // Keep the lightweight popup content on failure — not critical
        // enough to show an error state for a dashboard preview map.
      }
    });

    circle.addTo(map);
    circles.push(circle);
  });

  // The marker outline is a theme colour, so re-read it on a switch.
  RG.onThemeChange(() => {
    const ring = RG.tokens().mapRingInv;
    circles.forEach(c => c.setStyle({ color: ring }));
  });

  setTimeout(() => map.invalidateSize(), 150);
});
