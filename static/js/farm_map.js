// Shared canvas renderer for every circle marker on this map — draws all
// visible markers into one <canvas> instead of one DOM element per tree.
const FARM_MAP_CANVAS = L.canvas({ padding: 0.5 });

// Matches the app's CSS disease color tokens, used to color cluster
// bubbles by their dominant disease.
const DISEASE_COLOR_MAP = {
  'Healthy':        '#34d399',
  'Pink Disease':   '#f87171',
  'White Root Rot': '#d0995f',
  'Stem Bleeding':  '#fb7185',
};

// Builds one canvas-rendered circle marker for a tree, with the same
// lazy-loaded popup detail (fetched only on click, cached afterward) as
// before.
function buildTreeCircleMarker(tree, detailCache) {
  const marker = L.circleMarker([tree.lat, tree.lng], {
    renderer: FARM_MAP_CANVAS,
    radius: 6,
    weight: 2,
    color: '#1a2535',       // dark border so markers stay visible against both basemaps
    opacity: 1,
    fillColor: tree.color || DISEASE_COLOR_MAP[tree.disease] || '#94a3b8',
    fillOpacity: 0.92,
  });
  marker.treeId = tree.tree_id;
  marker.diseaseKey = tree.disease;

  marker.bindPopup('<div style="font-size:12px;padding:4px;">Loading…</div>', { maxWidth: 270 });
  marker.on('popupopen', async () => {
    if (detailCache[tree.tree_id]) {
      marker.setPopupContent(buildPopupHtml(detailCache[tree.tree_id]));
      return;
    }
    try {
      const res = await fetch(`/map/marker/${tree.tree_id}/`);
      if (!res.ok) throw new Error('fetch failed');
      const detail = await res.json();
      detailCache[tree.tree_id] = detail;
      marker.setPopupContent(buildPopupHtml(detail));
    } catch (err) {
      marker.setPopupContent('<div style="font-size:12px;color:#dc3545;padding:4px;">Failed to load details. Try again.</div>');
    }
  });

  return marker;
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

// Cluster bubble icon — colored by whichever disease dominates that
// cluster's child markers (trivial/uniform when a single category filter
// is active; a real mix only when "All Diseases" is selected), sized in
// three tiers so a 900-tree cluster visibly reads as "bigger" than a
// 12-tree one.
function makeClusterIcon(cluster) {
  const children = cluster.getAllChildMarkers();
  const count = children.length;

  const tally = {};
  children.forEach(m => { tally[m.diseaseKey] = (tally[m.diseaseKey] || 0) + 1; });
  let dominant = 'Healthy', max = -1;
  Object.keys(tally).forEach(k => { if (tally[k] > max) { max = tally[k]; dominant = k; } });
  const color = DISEASE_COLOR_MAP[dominant] || '#4ade80';
  const mixed = Object.keys(tally).length > 1;

  let sizeClass = 'cluster-sm', px = 36;
  if (count >= 250) { sizeClass = 'cluster-lg'; px = 58; }
  else if (count >= 40) { sizeClass = 'cluster-md'; px = 46; }

  return L.divIcon({
    html: `<div class="cluster-bubble ${sizeClass}" style="background:${color};${mixed ? 'border-style:dashed;' : ''}">${count}</div>`,
    className: 'marker-cluster-custom',
    iconSize: L.point(px, px),
  });
}

// A single vivid severity gradient (Mild → Moderate → Severe → Critical)
// shared by every disease's heat layer, matching the labeled scale in the
// legend below the map. Using one consistent scale — instead of a
// different, more muted tint per disease — makes intensity comparable
// across diseases and reads with far more color against the dark
// heatmap basemap.
const SEVERITY_HEAT_GRADIENT = {
  0.15: '#fde047', 0.35: '#fbbf24', 0.55: '#fb923c', 0.75: '#f87171', 1.0: '#dc2626',
};

// Builds a heat layer for a single disease type only, using the minimal
// marker data already available on the page (no extra fetch needed).
// Heatmap mode never renders individual circle markers or clusters —
// this is the only layer added to the map while it's active.
function buildHeatLayerForDisease(markers, disease) {
  // Detection confidence for flagged trees is almost always 75–99.5%, so
  // dividing by 100 alone crushed every point into the top sliver of the
  // gradient — the map read as a near-solid red blob with no visible
  // contrast. Stretching that narrow real-world range across the FULL
  // 0–1 weight range makes mild/moderate/severe cases actually look
  // different from each other, the whole point of a heatmap.
  const CONF_MIN = 70, CONF_MAX = 100;
  const points = markers
    .filter(t => t.disease === disease)
    .map(t => {
      const stretched = (t.confidence - CONF_MIN) / (CONF_MAX - CONF_MIN);
      return [t.lat, t.lng, Math.min(Math.max(stretched, 0.12), 1.0)];
    });
  return L.heatLayer(points, {
    radius: 30, blur: 22, maxZoom: 18, max: 1.0, minOpacity: 0.25,
    gradient: SEVERITY_HEAT_GRADIENT,
  });
}

function updateHeatmapLegendLabel(disease) {
  const label = document.getElementById('heatmap-disease-label');
  if (label) label.textContent = disease;
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
    preferCanvas: true,
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
  const grayBasemap = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors, © CARTO', maxZoom: 19, subdomains: 'abcd',
  });
  colorBasemap.addTo(map);

  // ------------------------------------------------------------
  // Clustered marker layer
  // ------------------------------------------------------------
  const detailCache = {};
  let activeClusterGroup = null;

  function buildClusterGroup() {
    return L.markerClusterGroup({
      maxClusterRadius: 60,
      disableClusteringAtZoom: 19,   // matches basemap maxZoom — individual trees always show once fully zoomed in
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      zoomToBoundsOnClick: true,
      chunkedLoading: true,
      iconCreateFunction: makeClusterIcon,
    });
  }

  // Rebuilds the on-map cluster group from just the given subset of
  // trees — used for every filter/search change so picking a category,
  // or "All Diseases", never has to render all 1,500 markers to show a
  // filtered handful.
  function rebuildClusterGroup(subsetTrees) {
    if (activeClusterGroup) map.removeLayer(activeClusterGroup);
    activeClusterGroup = buildClusterGroup();
    const layers = subsetTrees.map(tree => buildTreeCircleMarker(tree, detailCache));
    activeClusterGroup.addLayers(layers);
    return activeClusterGroup;
  }

  // ------------------------------------------------------------
  // Toolbar: search, disease filter, markers/heatmap toggle, reset
  // ------------------------------------------------------------
  const searchInput = document.getElementById('map-search');
  const filterSelect = document.getElementById('map-filter');
  const resetBtn = document.getElementById('map-reset');
  const markersBtn = document.getElementById('view-markers-btn');
  const heatmapBtn = document.getElementById('view-heatmap-btn');
  const legendMarkers = document.getElementById('legend-markers');
  const legendHeatmap = document.getElementById('legend-heatmap');
  const allDiseasesOption = filterSelect ? filterSelect.querySelector('option[value=""]') : null;
  const diseaseOptions = ['Pink Disease', 'White Root Rot', 'Stem Bleeding'];

  let activeView = 'markers';
  let currentHeatLayer = null;

  function currentSubset() {
    const q = (searchInput && searchInput.value ? searchInput.value : '').trim().toLowerCase();
    const d = filterSelect ? filterSelect.value : '';
    return markers.filter(t => (!d || t.disease === d) && (!q || t.tree_id.toLowerCase().includes(q)));
  }

  // Rebuilds the cluster group for the current search+filter state. If
  // the search box narrows things down to exactly one tree, zoom/spiderfy
  // straight to it and open its popup — clustering means a matching tree
  // could be buried inside a bubble, so this keeps search feeling instant.
  function applyMarkerFilters() {
    if (activeView !== 'markers') return;
    const subset = currentSubset();
    rebuildClusterGroup(subset);
    activeClusterGroup.addTo(map);

    const q = (searchInput && searchInput.value ? searchInput.value : '').trim();
    if (q && subset.length === 1) {
      const [only] = activeClusterGroup.getLayers();
      if (only) activeClusterGroup.zoomToShowLayer(only, () => only.openPopup());
    }
  }

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
    activeView = 'markers';
    clearHeatLayer();
    if (map.hasLayer(grayBasemap)) map.removeLayer(grayBasemap);
    if (!map.hasLayer(colorBasemap)) colorBasemap.addTo(map);
    if (allDiseasesOption) allDiseasesOption.hidden = false;
    applyMarkerFilters();
    markersBtn.classList.add('active');
    heatmapBtn.classList.remove('active');
    legendMarkers.style.display = '';
    legendHeatmap.style.display = 'none';
  }

  function showHeatmap() {
    activeView = 'heatmap';
    // Heatmap mode never renders individual circle markers or clusters.
    if (activeClusterGroup && map.hasLayer(activeClusterGroup)) map.removeLayer(activeClusterGroup);
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
    if (activeView === 'heatmap') drawHeatForCurrentDisease();
    else applyMarkerFilters();
  });

  // Debounced so rebuilding the cluster group doesn't fire on every single
  // keystroke while typing a tree ID.
  let searchDebounce = null;
  if (searchInput) searchInput.addEventListener('input', () => {
    if (activeView !== 'markers') return;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(applyMarkerFilters, 180);
  });

  if (resetBtn) resetBtn.addEventListener('click', () => {
    if (searchInput) searchInput.value = '';
    if (filterSelect) filterSelect.value = '';
    if (activeView === 'heatmap') drawHeatForCurrentDisease();
    else applyMarkerFilters();
    map.fitBounds(leafletBounds);
  });

  // ------------------------------------------------------------
  // Initial view: "All Diseases" selected, showing the summarized
  // clustered view of all 1,500 trees rather than every marker at once.
  // ------------------------------------------------------------
  applyMarkerFilters();
});
