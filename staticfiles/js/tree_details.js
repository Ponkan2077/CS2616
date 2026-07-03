const DISEASE_COLOR_MAP = {
  'Healthy': '#28a745', 'Pink Disease': '#dc3545',
  'White Root Rot': '#8b5a2b', 'Stem Bleeding': '#8b0000',
};

// Renders a small Leaflet map centered on the tree's GPS point.
function renderMiniMap(tree) {
  const miniMap = L.map('mini-map', { zoomControl: true, scrollWheelZoom: false })
    .setView([tree.lat, tree.lng], 17);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap',
  }).addTo(miniMap);
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
        backgroundColor: 'transparent',
        pointBackgroundColor: pointColors,
        pointBorderColor: '#fff',
        pointBorderWidth: 2,
        segment: {
          borderColor: ctx => pointColors[ctx.p0DataIndex] || '#9ca3af',
        },
        tension: .3, fill: false, pointRadius: 6, pointHoverRadius: 8,
      }]
    },
    options: {
      responsive: true,
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
  renderMiniMap(tree);
  renderHistoryChart(tree, history);
});
