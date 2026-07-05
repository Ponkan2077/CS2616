// Draws a lightweight circle marker for each tree using only the minimal
// marker data sent on page load. Full popup detail (recommended action,
// notes, inspector, interventions) is fetched via AJAX only when the
// marker is actually clicked, cached afterward so repeat clicks are free.
function renderTreeMarkers(map, markers, farmId) {
  const detailCache = {};
  const markerList = [];

  markers.forEach(tree => {
    const circle = L.circleMarker([tree.lat, tree.lng], {
      radius: 10, color: '#fff', weight: 2, fillColor: tree.color, fillOpacity: 0.9,
    });

    circle.bindPopup('<div style="font-size:12px;padding:4px;">Loading…</div>', { maxWidth: 270 });

    circle.on('popupopen', async () => {
      if (detailCache[tree.tree_id]) {
        circle.setPopupContent(buildPopupHtml(detailCache[tree.tree_id]));
        return;
      }
      try {
        const res = await fetch(`/map/marker/${tree.tree_id}/`);
        if (!res.ok) throw new Error('fetch failed');
        const detail = await res.json();
        detailCache[tree.tree_id] = detail;
        circle.setPopupContent(buildPopupHtml(detail));
      } catch (err) {
        circle.setPopupContent('<div style="font-size:12px;color:#dc3545;padding:4px;">Failed to load details. Try again.</div>');
      }
    });

    markerList.push({ el: circle, tree });
  });

  return markerList;
}

// Builds the popup HTML from a full tree detail payload fetched on demand.
function buildPopupHtml(tree) {
  return `
    <div style="font-weight:700;font-size:14px;">${tree.tree_id}</div>
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
  `;
}

// Per-disease color used for that disease's heatmap gradient.
const DISEASE_HEAT_GRADIENTS = {
  'Pink Disease':    { 0.3: '#fecaca', 0.6: '#f87171', 1.0: '#b91c1c' },
  'White Root Rot':  { 0.3: '#e7d3b8', 0.6: '#c08a4e', 1.0: '#6b4423' },
  'Stem Bleeding':   { 0.3: '#f4b8b8', 0.6: '#b91c1c', 1.0: '#450a0a' },
};

// Builds a heat layer for a single disease type only, using the minimal
// marker data already available on the page (no extra fetch needed).
function buildHeatLayerForDisease(markers, disease) {
  const points = markers
    .filter(t => t.disease === disease)
    .map(t => [t.lat, t.lng, Math.max(t.confidence / 100, 0.35)]);
  return L.heatLayer(points, {
    radius: 38, blur: 28, maxZoom: 18, max: 1.0, minOpacity: 0.45,
    gradient: DISEASE_HEAT_GRADIENTS[disease] || DISEASE_HEAT_GRADIENTS['Pink Disease'],
  });
}

// Wires up the search box and disease filter to show/hide tree markers.
function setupMapFilters(map, markerList, bounds, getActiveLayer, onDiseaseChange) {
  const searchInput = document.getElementById('map-search');
  const filterSelect = document.getElementById('map-filter');
  const resetBtn = document.getElementById('map-reset');

  function applyFilters() {
    if (getActiveLayer() !== 'markers') return;
    const q = searchInput ? searchInput.value.toLowerCase() : '';
    const d = filterSelect ? filterSelect.value : '';
    markerList.forEach(({ el, tree }) => {
      const show = (!q || tree.tree_id.toLowerCase().includes(q)) && (!d || tree.disease === d);
      show ? (!map.hasLayer(el) && el.addTo(map)) : (map.hasLayer(el) && map.removeLayer(el));
    });
  }

  if (searchInput) searchInput.addEventListener('input', applyFilters);
  if (resetBtn) resetBtn.addEventListener('click', () => {
    if (searchInput) searchInput.value = '';
    if (getActiveLayer() === 'markers') {
      if (filterSelect) filterSelect.value = '';
      markerList.forEach(({ el }) => { if (!map.hasLayer(el)) el.addTo(map); });
    } else if (onDiseaseChange) {
      onDiseaseChange();
    }
    map.fitBounds(bounds);
  });
}

const DISEASE_GRADIENT_CSS = {
  'Pink Disease':   'linear-gradient(to right, #fecaca, #f87171, #b91c1c)',
  'White Root Rot': 'linear-gradient(to right, #e7d3b8, #c08a4e, #6b4423)',
  'Stem Bleeding':  'linear-gradient(to right, #f4b8b8, #b91c1c, #450a0a)',
};

function updateHeatmapLegendLabel(disease) {
  const label = document.getElementById('heatmap-disease-label');
  if (label) label.textContent = disease;
  const bar = document.querySelector('.heatmap-gradient-bar');
  if (bar) bar.style.setProperty('--heatmap-gradient', DISEASE_GRADIENT_CSS[disease] || '');
}

// Wires up the Markers/Heatmap toggle buttons. Heatmap mode requires a
// specific disease (no "All Diseases" there); switching disease while in
// heatmap mode rebuilds the layer for that disease only.
function setupViewToggle(map, markerList, markers, colorBasemap, grayBasemap) {
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
    currentHeatLayer = buildHeatLayerForDisease(markers, disease);
    currentHeatLayer.addTo(map);
    updateHeatmapLegendLabel(disease);
  }

  function showMarkers() {
    activeLayer = 'markers';
    clearHeatLayer();
    if (map.hasLayer(grayBasemap)) map.removeLayer(grayBasemap);
    if (!map.hasLayer(colorBasemap)) colorBasemap.addTo(map);
    if (allDiseasesOption) allDiseasesOption.hidden = false;
    markerList.forEach(({ el }) => { if (!map.hasLayer(el)) el.addTo(map); });
    markersBtn.classList.add('active');
    heatmapBtn.classList.remove('active');
    legendMarkers.style.display = '';
    legendHeatmap.style.display = 'none';
  }

  function showHeatmap() {
    activeLayer = 'heatmap';
    markerList.forEach(({ el }) => { if (map.hasLayer(el)) map.removeLayer(el); });
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
  const { markers, bounds, boundaryPolygon, farmId, farmName, farmOwner } = FARM_MAP_DATA;

  const leafletBounds = [
    [bounds.min_lat, bounds.min_lng],
    [bounds.max_lat, bounds.max_lng],
  ];

  const map = L.map('map-container', {
    maxBounds: leafletBounds,
    maxBoundsViscosity: 0.8,
  });
  map.fitBounds(leafletBounds);
  // getBoundsZoom needs the container's real pixel size, which isn't
  // reliably available the instant the map is created — invalidate size
  // first, then compute the min zoom, with a sane fallback if invalid.
  setTimeout(() => {
    map.invalidateSize();
    const boundsZoom = map.getBoundsZoom(leafletBounds);
    map.setMinZoom(Number.isFinite(boundsZoom) ? Math.max(boundsZoom - 1, 1) : 12);
  }, 150);

  // Scale control — shows a ruler segment labeled with its real-world
  // distance in meters/km, so users can gauge how far apart trees are.
  L.control.scale({ metric: true, imperial: false, position: 'bottomleft' }).addTo(map);

  // Farm boundary — a convex hull around the farm's actual trees, so the
  // shape follows the planted area instead of an arbitrary circle.
  if (boundaryPolygon && boundaryPolygon.length >= 3) {
    L.polygon(boundaryPolygon, {
      color: '#0d6efd', weight: 2.5, fillColor: '#0d6efd', fillOpacity: 0.06,
    })
      .bindTooltip(farmName || farmId, { permanent: true, direction: 'center', className: 'farm-boundary-label' })
      .bindPopup(`<b>${farmId}</b><br>${farmName}<br><i>${farmOwner}</i>`)
      .addTo(map);
  }

  const colorBasemap = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors', maxZoom: 19,
  });
  const grayBasemap = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors, © CARTO', maxZoom: 19, subdomains: 'abcd',
  });
  colorBasemap.addTo(map);

  const markerList = renderTreeMarkers(map, markers, farmId);
  markerList.forEach(({ el }) => el.addTo(map));

  const { getActiveLayer, redrawHeat } = setupViewToggle(map, markerList, markers, colorBasemap, grayBasemap);
  setupMapFilters(map, markerList, leafletBounds, getActiveLayer, redrawHeat);
});
