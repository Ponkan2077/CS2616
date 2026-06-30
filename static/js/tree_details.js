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
  }).bindPopup(`<b>${tree.tree_id}</b><br>${tree.disease}`).addTo(miniMap).openPopup();
}

// Renders a line chart of confidence scores across scan history.
function renderHistoryChart(tree, history) {
  if (!history.length) return;
  const dates = history.map(h => h.date).reverse();
  const confidences = history.map(h => h.confidence).reverse();

  new Chart(document.getElementById('historyChart'), {
    type: 'line',
    data: {
      labels: dates,
      datasets: [{
        label: 'Confidence %',
        data: confidences,
        borderColor: tree.color,
        backgroundColor: tree.color + '22',
        tension: .4, fill: true, pointRadius: 5,
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
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
