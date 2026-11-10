/* Renders the disease mix (headline, bar and ranked disease rows), the
   severity split and (when the page has one) the compact "Disease Cases by
   Location" map on the dashboard.
   Uses the minimal marker payload for a fast initial load; full detail
   for a tree is fetched lazily only when its marker is clicked. Expects
   DASHBOARD_DISEASE_STATS (and, for the map, DASHBOARD_MARKERS) defined
   inline in dashboard.html before this loads.

   Disease colours come from the data. The mix and the severity split are HTML
   (see rg_charts.js), so they follow the theme without a rebuild; only the
   map marker outline is re-read on "themechange". */

// Escapes text before it goes into popup HTML.
function dashEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

function renderDashboardMix(diseaseStats) {
  const host = document.getElementById("dashboardMix");
  if (host) RG.diseaseMix(host, diseaseStats);
}

function renderDashboardSeverity(sev) {
  const host = document.getElementById("dashboardSeverity");
  if (!host) return;
  RG.splitList(host, [
    { name: "Healthy", count: sev.healthy, neutral: true },
    { name: "Mild", count: sev.mild, color: "var(--sev-mild)" },
    { name: "Moderate", count: sev.moderate, color: "var(--sev-moderate)" },
    { name: "Severe", count: sev.severe, color: "var(--sev-severe)" },
  ]);
}

document.addEventListener("DOMContentLoaded", () => {
  if (typeof DASHBOARD_DISEASE_STATS !== "undefined") renderDashboardMix(DASHBOARD_DISEASE_STATS);
  if (typeof DASHBOARD_SEVERITY !== "undefined") renderDashboardSeverity(DASHBOARD_SEVERITY);

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
    circle.bindPopup(`<b>${dashEscape(tree.tree_id)}</b><br>${dashEscape(tree.disease)} · ${dashEscape(tree.confidence)}%`);

    circle.on("popupopen", async () => {
      if (detailCache[tree.tree_id]) {
        circle.setPopupContent(detailCache[tree.tree_id]);
        return;
      }
      try {
        const res = await fetch(`/map/marker/${encodeURIComponent(tree.tree_id)}/`);
        if (!res.ok) throw new Error("fetch failed");
        const detail = await res.json();
        const html = `
          <b>${dashEscape(detail.tree_id)}</b><br>
          ${dashEscape(detail.disease)} · ${dashEscape(detail.confidence)}%<br>
          <a href="/inventory/${encodeURIComponent(detail.tree_id)}/" class="small">View Details →</a>
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
