// Draws a dashed circle marker for each farm's center point,
// used when viewing "All Farms" to show farm boundaries.
function renderFarmLayers(map, farms) {
  const farmColors = ['#0d6efd', '#6f42c1', '#fd7e14', '#20c997', '#e83e8c'];
  farms.forEach((farm, i) => {
    const color = farmColors[i % farmColors.length];
    L.circleMarker([farm.lat, farm.lng], {
      radius: 18, color, weight: 2, fillColor: color, fillOpacity: 0.12, dashArray: '6,4',
    }).bindPopup(`<b>${farm.farm_id}</b><br>${farm.name}<br><i>${farm.owner}</i>`).addTo(map);
  });
}

// Draws a circle marker with a popup for each tree, returning
// the list of { el, tree } pairs used by the filter logic.
function renderTreeMarkers(map, trees) {
  const markers = [];
  trees.forEach(tree => {
    const circle = L.circleMarker([tree.lat, tree.lng], {
      radius: 10, color: '#fff', weight: 2, fillColor: tree.color, fillOpacity: 0.9,
    });
    circle.bindPopup(`
      <div style="font-weight:700;font-size:14px;">${tree.tree_id}</div>
      <div style="font-size:11px;color:#666;margin-bottom:4px;">${tree.farm_id} — ${tree.farm_name}</div>
      <div style="font-size:12px;">Disease: <b>${tree.disease}</b></div>
      <div style="font-size:12px;">Confidence: <b>${tree.confidence}%</b></div>
      <div style="font-size:12px;">Scanned: ${tree.date_scanned}</div>
      <div style="font-size:12px;">Block: ${tree.block}</div>
      <a href="/inventory/${tree.tree_id}/" style="display:inline-block;margin-top:8px;padding:4px 10px;
        background:#2563eb;color:#fff;text-decoration:none;border-radius:4px;font-size:11px;">View Details</a>
    `, { maxWidth: 260 });
    markers.push({ el: circle, tree });
  });
  return markers;
}

// Builds the leaflet.heat layer from tree severity_weight values.
// Healthy trees (weight 0) contribute nothing, so the heatmap
// highlights disease hotspots rather than tree density overall.
function buildHeatLayer(trees) {
  const points = trees
    .filter(t => t.severity_weight > 0)
    .map(t => [t.lat, t.lng, Math.max(t.severity_weight, 0.15)]);
  return L.heatLayer(points, {
    radius: 32, blur: 24, maxZoom: 18, max: 1.0,
    gradient: { 0.2: '#2563eb', 0.4: '#28a745', 0.6: '#fbbf24', 0.8: '#dc3545', 1.0: '#7f1d1d' },
  });
}

// Wires up the search box and dropdown filters to show/hide
// tree markers on the map based on the current filter values.
// Only affects the marker layer; the heatmap layer is unfiltered
// since it represents farm-wide severity at a glance.
function setupMapFilters(map, markers, defaultLat, defaultLng, getActiveLayer) {
  const searchInput = document.getElementById('map-search');
  const filterSelect = document.getElementById('map-filter');
  const farmLayerFilter = document.getElementById('farm-layer-filter');
  const resetBtn = document.getElementById('map-reset');

  function applyFilters() {
    if (getActiveLayer() !== 'markers') return;
    const q = searchInput ? searchInput.value.toLowerCase() : '';
    const d = filterSelect ? filterSelect.value : '';
    const f = farmLayerFilter ? farmLayerFilter.value : '';
    markers.forEach(({ el, tree }) => {
      const show = (!q || tree.tree_id.toLowerCase().includes(q))
                && (!d || tree.disease === d)
                && (!f || tree.farm_id === f);
      show ? (!map.hasLayer(el) && el.addTo(map)) : (map.hasLayer(el) && map.removeLayer(el));
    });
  }

  if (searchInput) searchInput.addEventListener('input', applyFilters);
  if (filterSelect) filterSelect.addEventListener('change', applyFilters);
  if (farmLayerFilter) farmLayerFilter.addEventListener('change', applyFilters);
  if (resetBtn) resetBtn.addEventListener('click', () => {
    if (searchInput) searchInput.value = '';
    if (filterSelect) filterSelect.value = '';
    if (farmLayerFilter) farmLayerFilter.value = '';
    markers.forEach(({ el }) => { if (!map.hasLayer(el)) el.addTo(map); });
    map.setView([defaultLat, defaultLng], 16);
  });
}

// Wires up the Markers/Heatmap toggle buttons, swapping the
// active map layer and the visible legend.
function setupViewToggle(map, markers, heatLayer) {
  const markersBtn = document.getElementById('view-markers-btn');
  const heatmapBtn = document.getElementById('view-heatmap-btn');
  const legendMarkers = document.getElementById('legend-markers');
  const legendHeatmap = document.getElementById('legend-heatmap');
  let activeLayer = 'markers';

  function showMarkers() {
    activeLayer = 'markers';
    if (map.hasLayer(heatLayer)) map.removeLayer(heatLayer);
    markers.forEach(({ el }) => { if (!map.hasLayer(el)) el.addTo(map); });
    markersBtn.classList.add('active');
    heatmapBtn.classList.remove('active');
    legendMarkers.style.display = '';
    legendHeatmap.style.display = 'none';
  }

  function showHeatmap() {
    activeLayer = 'heatmap';
    markers.forEach(({ el }) => { if (map.hasLayer(el)) map.removeLayer(el); });
    if (!map.hasLayer(heatLayer)) heatLayer.addTo(map);
    heatmapBtn.classList.add('active');
    markersBtn.classList.remove('active');
    legendMarkers.style.display = 'none';
    legendHeatmap.style.display = '';
  }

  if (markersBtn) markersBtn.addEventListener('click', showMarkers);
  if (heatmapBtn) heatmapBtn.addEventListener('click', showHeatmap);

  return () => activeLayer;
}

document.addEventListener('DOMContentLoaded', () => {
  const { trees, farms, showFarmLayers } = FARM_MAP_DATA;

  const defaultLat = trees.length ? trees[0].lat : 6.9220;
  const defaultLng = trees.length ? trees[0].lng : 122.0795;

  const map = L.map('map-container').setView([defaultLat, defaultLng], 16);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors', maxZoom: 19,
  }).addTo(map);

  setTimeout(() => map.invalidateSize(), 150);

  if (showFarmLayers) renderFarmLayers(map, farms);

  const markers = renderTreeMarkers(map, trees);
  markers.forEach(({ el }) => el.addTo(map));

  const heatLayer = buildHeatLayer(trees);

  const getActiveLayer = setupViewToggle(map, markers, heatLayer);
  setupMapFilters(map, markers, defaultLat, defaultLng, getActiveLayer);
});
