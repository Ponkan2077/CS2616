/* ============================================================
   tree_details.js — Renders the mini Leaflet map and the
   confidence-over-time line chart on a single tree's detail
   page. Expects a TREE_DETAIL_DATA object defined inline in
   tree_details.html before this script loads.
   ============================================================ */

const DISEASE_COLOR_MAP = {
  'Healthy': '#28a745', 'Pink Disease': '#dc3545',
  'White Root Rot': '#8b5a2b', 'Stem Bleeding': '#8b0000',
};

// Renders a small Leaflet map centered on the tree's GPS point.
function renderMiniMap(tree, farmBoundary) {
  const hasBoundary = farmBoundary && farmBoundary.length >= 3;

  // Derive a bounding box from the polygon's own points for the zoom
  // lock, so this map is capped at roughly the same extent as the main
  // farm map, without needing a separate radius value.
  let farmBounds = null;
  if (hasBoundary) {
    const lats = farmBoundary.map(p => p[0]);
    const lngs = farmBoundary.map(p => p[1]);
    farmBounds = [
      [Math.min(...lats), Math.min(...lngs)],
      [Math.max(...lats), Math.max(...lngs)],
    ];
  }

  const miniMap = L.map('mini-map', {
    zoomControl: true, scrollWheelZoom: false,
    ...(farmBounds ? { maxBounds: farmBounds, maxBoundsViscosity: 0.8 } : {}),
  }).setView([tree.lat, tree.lng], 17);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap',
  }).addTo(miniMap);

  L.control.scale({ metric: true, imperial: false, position: 'bottomleft' }).addTo(miniMap);

  // getBoundsZoom needs the container's real pixel size to compute
  // correctly, which isn't reliably available the instant the map is
  // created inside a grid layout — invalidateSize() first, then compute
  // the min zoom, falling back to a sane default if it comes back invalid.
  if (farmBounds) {
    setTimeout(() => {
      miniMap.invalidateSize();
      const boundsZoom = miniMap.getBoundsZoom(farmBounds);
      const minZoom = Number.isFinite(boundsZoom) ? Math.max(boundsZoom - 1, 1) : 12;
      miniMap.setMinZoom(minZoom);
    }, 150);
  } else {
    setTimeout(() => miniMap.invalidateSize(), 150);
  }

  if (hasBoundary) {
    L.polygon(farmBoundary, {
      color: '#0d6efd', weight: 2, fillColor: '#0d6efd', fillOpacity: 0.05,
    }).bindTooltip(tree.farm_name || tree.farm_id, { permanent: false, direction: 'center', className: 'farm-boundary-label' }).addTo(miniMap);
  }

  L.circleMarker([tree.lat, tree.lng], {
    radius: 9,
    weight: 2,
    color: '#1a2535',       // dark border, same as the main farm map's circle markers
    opacity: 1,
    fillColor: tree.color,
    fillOpacity: 0.92,
  }).bindPopup(`<b>${tree.tree_id}</b><br>${tree.disease}<br><i style="font-size:11px;color:#666;">Managed by ${tree.farm_owner}</i>`).addTo(miniMap).openPopup();
}

// Renders a combo bar+line chart of confidence scores across scan
// history: one bar per scan (colored by that scan's own detected disease,
// same as before) so individual results are easy to compare at a glance,
// plus a plain trend line on top connecting the same values -- the line
// has no point markers of its own (pointRadius: 0), it's just the trend,
// so it doesn't visually compete with the bars underneath it.
function renderHistoryChart(tree, history) {
  if (!history.length) return;
  const points = [...history].reverse();
  const dates = points.map(h => new Date(h.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }));
  const confidences = points.map(h => h.confidence);
  const barColors = points.map(h => DISEASE_COLOR_MAP[h.disease] || tree.color);

  new Chart(document.getElementById('historyChart'), {
    data: {
      labels: dates,
      datasets: [
        {
          type: 'bar',
          label: 'Confidence %',
          data: confidences,
          backgroundColor: barColors,
          borderRadius: 3,
          maxBarThickness: 34,
          order: 2,
        },
        {
          type: 'line',
          label: 'Trend',
          data: confidences,
          borderColor: '#9ca3af',
          borderWidth: 2,
          pointRadius: 0,       // no circle markers on the line itself
          pointHoverRadius: 0,
          tension: 0.3,
          fill: false,
          order: 1,
        },
      ],
    },
    options: {
      responsive: true,
      layout: {
        padding: { top: 10, bottom: 4, left: 4, right: 10 },
      },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          // Only the bar (one tooltip line per scan) shows in the
          // tooltip -- the trend line duplicates the same values, so
          // showing both would just repeat every number twice.
          filter: item => item.dataset.type === 'bar',
          callbacks: {
            label: ctx => {
              const h = points[ctx.dataIndex];
              return `${h.disease}: ${h.confidence}%`;
            }
          }
        }
      },
      scales: {
        y: { min: 0, max: 100, ticks: { font: { size: 11 } } },
        x: { grid: { display: false }, ticks: { font: { size: 11 } } }
      }
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const { tree, history } = TREE_DETAIL_DATA;
  renderMiniMap(tree, TREE_DETAIL_DATA.farmBoundary);
  renderHistoryChart(tree, history);
});
