// Draws a dashed circle marker for each farm's center point,
// used when viewing "All Farms" to show farm boundaries.
function renderFarmLayers(map, farms) {
  const farmColors = ['#0d6efd', '#6f42c1', '#fd7e14', '#20c997', '#e83e8c'];
  farms.forEach((farm, i) => {
    const color = farmColors[i % farmColors.length];
    L.circle([farm.lat, farm.lng], {
      radius: farm.radius || 300,
      color, weight: 2.5, fillColor: color, fillOpacity: 0.08,
    })
      .bindPopup(`<b>${farm.farm_id}</b><br>${farm.name}<br><i>${farm.owner}</i>`)
      .bindTooltip(farm.farm_id, { permanent: true, direction: 'center', className: 'farm-boundary-label' })
      .addTo(map);
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
      <hr style="margin:6px 0;border-color:#eee;">
      <div style="font-size:11px;color:#666;"><i>Managed by ${tree.farm_owner}</i></div>
      ${tree.inspector ? `<div style="font-size:11px;color:#666;">Last inspected by ${tree.inspector}</div>` : ''}
      ${tree.latest_intervention ? `
        <div style="font-size:11px;color:#166534;margin-top:4px;">
          <i class="bi bi-check-circle-fill"></i> ${tree.latest_intervention} (${tree.latest_intervention_date})
          ${tree.intervention_count > 1 ? ` · ${tree.intervention_count} total actions` : ''}
        </div>` : `<div style="font-size:11px;color:#92400e;margin-top:4px;">No interventions logged yet</div>`}
      <a href="/inventory/${tree.tree_id}/" style="display:inline-block;margin-top:8px;padding:4px 10px;
        background:#2563eb;color:#fff;text-decoration:none;border-radius:4px;font-size:11px;">View Details</a>
    `, { maxWidth: 270 });
    markers.push({ el: circle, tree });
  });
  return markers;
}

// Per-disease color used for that disease's heatmap gradient. Each map
// uses shades from transparent up to the disease's signature color so
// hotspots are clearly readable against the basemap.
const DISEASE_HEAT_GRADIENTS = {
  'Pink Disease':    { 0.3: '#fecaca', 0.6: '#f87171', 1.0: '#b91c1c' },
  'White Root Rot':  { 0.3: '#e7d3b8', 0.6: '#c08a4e', 1.0: '#6b4423' },
  'Stem Bleeding':   { 0.3: '#f4b8b8', 0.6: '#b91c1c', 1.0: '#450a0a' },
};

// Builds a heat layer for a single disease type only, using that
// disease's own color gradient so overlapping hotspots stay legible.
function buildHeatLayerForDisease(trees, disease) {
  const points = trees
    .filter(t => t.disease === disease)
    .map(t => [t.lat, t.lng, Math.max(t.confidence / 100, 0.35)]);
  return L.heatLayer(points, {
    radius: 38, blur: 28, maxZoom: 18, max: 1.0, minOpacity: 0.45,
    gradient: DISEASE_HEAT_GRADIENTS[disease] || DISEASE_HEAT_GRADIENTS['Pink Disease'],
  });
}

// Wires up the search box and dropdown filters to show/hide
// tree markers on the map based on the current filter values.
// The marker filter only affects marker mode; onDiseaseChange lets the
// caller redraw the heat layer when the disease dropdown changes while
// heatmap mode is active.
function setupMapFilters(map, markers, defaultLat, defaultLng, getActiveLayer, onDiseaseChange) {
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
  if (farmLayerFilter) farmLayerFilter.addEventListener('change', applyFilters);
  if (resetBtn) resetBtn.addEventListener('click', () => {
    if (searchInput) searchInput.value = '';
    if (farmLayerFilter) farmLayerFilter.value = '';
    if (getActiveLayer() === 'markers') {
      if (filterSelect) filterSelect.value = '';
      markers.forEach(({ el }) => { if (!map.hasLayer(el)) el.addTo(map); });
    } else if (onDiseaseChange) {
      onDiseaseChange();
    }
    map.setView([defaultLat, defaultLng], 16);
  });
}

// Per-disease CSS gradient strings for the heatmap legend bar, matching
// the Leaflet heat layer gradients used for each disease.
const DISEASE_GRADIENT_CSS = {
  'Pink Disease':   'linear-gradient(to right, #fecaca, #f87171, #b91c1c)',
  'White Root Rot': 'linear-gradient(to right, #e7d3b8, #c08a4e, #6b4423)',
  'Stem Bleeding':  'linear-gradient(to right, #f4b8b8, #b91c1c, #450a0a)',
};

// Updates the heatmap legend's disease name and gradient bar color.
function updateHeatmapLegendLabel(disease) {
  const label = document.getElementById('heatmap-disease-label');
  if (label) label.textContent = disease;
  const bar = document.querySelector('.heatmap-gradient-bar');
  if (bar) bar.style.setProperty('--heatmap-gradient', DISEASE_GRADIENT_CSS[disease] || '');
}

// Wires up the Markers/Heatmap toggle buttons. Heatmap mode requires a
// specific disease to be selected (no "All Diseases" option there), since
// mixing diseases into one blob was illegible; switching disease while in
// heatmap mode rebuilds the layer for that disease only.
function setupViewToggle(map, markers, trees, colorBasemap, grayBasemap) {
  const markersBtn = document.getElementById('view-markers-btn');
  const heatmapBtn = document.getElementById('view-heatmap-btn');
  const legendMarkers = document.getElementById('legend-markers');
  const legendHeatmap = document.getElementById('legend-heatmap');
  const filterSelect = document.getElementById('map-filter');
  const allDiseasesOption = filterSelect ? filterSelect.querySelector('option[value=""]') : null;

  let activeLayer = 'markers';
  let currentHeatLayer = null;
  const diseaseOptions = ['Pink Disease', 'White Root Rot', 'Stem Bleeding'];

  function clearHeatLayer() {
    if (currentHeatLayer && map.hasLayer(currentHeatLayer)) map.removeLayer(currentHeatLayer);
    currentHeatLayer = null;
  }

  function drawHeatForCurrentDisease() {
    clearHeatLayer();
    let disease = filterSelect ? filterSelect.value : '';
    if (!disease || !diseaseOptions.includes(disease)) {
      disease = diseaseOptions[0];
      if (filterSelect) filterSelect.value = disease;
    }
    currentHeatLayer = buildHeatLayerForDisease(trees, disease);
    currentHeatLayer.addTo(map);
    updateHeatmapLegendLabel(disease);
  }

  function showMarkers() {
    activeLayer = 'markers';
    clearHeatLayer();
    if (map.hasLayer(grayBasemap)) map.removeLayer(grayBasemap);
    if (!map.hasLayer(colorBasemap)) colorBasemap.addTo(map);
    if (allDiseasesOption) allDiseasesOption.hidden = false;
    markers.forEach(({ el }) => { if (!map.hasLayer(el)) el.addTo(map); });
    markersBtn.classList.add('active');
    heatmapBtn.classList.remove('active');
    legendMarkers.style.display = '';
    legendHeatmap.style.display = 'none';
  }

  function showHeatmap() {
    activeLayer = 'heatmap';
    markers.forEach(({ el }) => { if (map.hasLayer(el)) map.removeLayer(el); });
    if (map.hasLayer(colorBasemap)) map.removeLayer(colorBasemap);
    if (!map.hasLayer(grayBasemap)) grayBasemap.addTo(map);
    if (allDiseasesOption) allDiseasesOption.hidden = true;
    drawHeatForCurrentDisease();
    heatmapBtn.classList.add('active');
    markersBtn.classList.remove('active');
    legendMarkers.style.display = 'none';
    legendHeatmap.style.display = '';
  }

  if (markersBtn) markersBtn.addEventListener('click', showMarkers);
  if (heatmapBtn) heatmapBtn.addEventListener('click', showHeatmap);
  if (filterSelect) filterSelect.addEventListener('change', () => {
    if (activeLayer === 'heatmap') drawHeatForCurrentDisease();
  });

  return { getActiveLayer: () => activeLayer, redrawHeat: drawHeatForCurrentDisease };
}

document.addEventListener('DOMContentLoaded', () => {
  const { trees, farms, showFarmLayers } = FARM_MAP_DATA;

  const defaultLat = trees.length ? trees[0].lat : 6.9220;
  const defaultLng = trees.length ? trees[0].lng : 122.0795;

  const map = L.map('map-container').setView([defaultLat, defaultLng], 16);

  const colorBasemap = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors', maxZoom: 19,
  });
  const grayBasemap = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors, © CARTO', maxZoom: 19, subdomains: 'abcd',
  });
  colorBasemap.addTo(map);

  setTimeout(() => map.invalidateSize(), 150);

  if (showFarmLayers) renderFarmLayers(map, farms);

  const markers = renderTreeMarkers(map, trees);
  markers.forEach(({ el }) => el.addTo(map));

  const { getActiveLayer, redrawHeat } = setupViewToggle(map, markers, trees, colorBasemap, grayBasemap);
  setupMapFilters(map, markers, defaultLat, defaultLng, getActiveLayer, redrawHeat);
});
