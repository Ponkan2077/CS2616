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
    radius: 10, color: '#fff', weight: 2,
    fillColor: tree.color, fillOpacity: 0.9,
  }).bindPopup(`<b>${tree.tree_id}</b><br>${tree.disease}<br><i style="font-size:11px;color:#666;">Managed by ${tree.farm_owner}</i>`).addTo(miniMap).openPopup();
}

// Renders a line chart of confidence scores across scan history, with each
// point and line segment colored by that scan's own detected disease
// rather than the tree's current disease.
function renderHistoryChart(tree, history) {
  if (!history.length) return;
  const points = [...history].reverse();
  const dates = points.map(h => h.date);
  const confidences = points.map(h => h.confidence);
  const pointColors = points.map(h => DISEASE_COLOR_MAP[h.disease] || tree.color);

  new Chart(document.getElementById('historyChart'), {
    type: 'line',
    data: {
      labels: dates,
      datasets: [{
        label: 'Confidence %',
        data: confidences,
        borderColor: '#9ca3af',
        backgroundColor: 'rgba(156, 163, 175, 0.12)',
        pointBackgroundColor: pointColors,
        pointBorderColor: '#fff',
        pointBorderWidth: 2,
        segment: {
          borderColor: ctx => pointColors[ctx.p0DataIndex] || '#9ca3af',
        },
        tension: .3, fill: true, pointRadius: 6, pointHoverRadius: 8,
      }]
    },
    options: {
      responsive: true,
      layout: {
        // Reserves room above/below the plot area so points sitting
        // exactly at 0 or 100 render as full circles instead of having
        // half their radius clipped by the canvas edge.
        padding: { top: 10, bottom: 4, left: 4, right: 10 },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
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
