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

// Severity gradient aligned to the same Mild < 34, Moderate < 67, Severe
// >= 67 tier boundaries used everywhere else in the app (severity_label),
// so a hotspot's color lines up with what "Mild/Moderate/Severe" means
// elsewhere: yellow for mild, orange through the moderate range, dark red
// for severe. The severe end runs through two darker red stops (red-600
// -> red-700 -> red-900) instead of stopping at a lighter red-500, so the
// most severe cases read as unmistakably dark red/maroon on the map
// rather than blending with the moderate-orange range.
const SEVERITY_HEAT_GRADIENT = {
  0.05: '#fde047', 0.34: '#fb923c', 0.55: '#f97316', 0.67: '#dc2626', 0.85: '#b91c1c', 1.0: '#7f1d1d',
};

// Builds a heat layer for a single disease type only, using each tree's
// severity_score (0-100, the model's affected-area/severity estimate —
// NOT how many trees are nearby) as the heat weight. This makes the
// heatmap represent how severe each case is, not how many overlapping
// diseased trees happen to sit in one spot — a cluster of many Mild
// cases should read as a soft yellow patch, not a solid red blob just
// because there are lots of them.
function buildHeatLayerForDisease(markers, disease) {
  const points = markers
    .filter(t => t.disease === disease)
    .map(t => {
      const weight = Math.min(Math.max((t.severity_score || 0) / 100, 0.05), 1.0);
      return [t.lat, t.lng, weight];
    });
  return L.heatLayer(points, {
    // Smaller radius/blur than a typical density heatmap so each tree's
    // heat contribution stays localized — nearby trees no longer bleed
    // together into one large red area, and hotspots reflect where the
    // most SEVERE cases are, not just where the most cases are.
    radius: 16, blur: 10, maxZoom: 18, max: 1.0, minOpacity: 0.2,
    gradient: SEVERITY_HEAT_GRADIENT,
  });
}

function updateHeatmapLegendLabel(disease) {
  const label = document.getElementById('heatmap-disease-label');
  if (label) label.textContent = disease;
}

// Fixed palette for block outlines, cycled by index -- deliberately not
// reusing any disease color (red/orange/yellow/gray) so a block outline
// is never mistaken for a heatmap or marker color at a glance.
const BLOCK_BOUNDARY_COLORS = ['#8b5cf6', '#06b6d4', '#f59e0b', '#84cc16', '#ec4899', '#14b8a6', '#f472b6', '#0ea5e9'];

document.addEventListener('DOMContentLoaded', () => {
  const { markers, bounds, boundaryPolygon, blockBoundaries, farmId, farmName, farmOwner } = FARM_MAP_DATA;

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

  // Block boundaries — one convex-hull outline per labeled block, nested
  // inside the farm boundary. Dashed and lightly filled so they read as
  // sub-divisions of the farm rather than competing with it; labels only
  // show on hover/tap (not permanent like the farm label) since a farm
  // can have many blocks and permanent labels for all of them would
  // clutter the view.
  if (blockBoundaries) {
    Object.keys(blockBoundaries).sort().forEach((blockName, i) => {
      const poly = blockBoundaries[blockName];
      if (!poly || poly.length < 3) return;
      const color = BLOCK_BOUNDARY_COLORS[i % BLOCK_BOUNDARY_COLORS.length];
      L.polygon(poly, {
        color, weight: 1.5, dashArray: '6,4', fillColor: color, fillOpacity: 0.05,
      })
        .bindTooltip(`Block ${blockName}`, { direction: 'center', className: 'block-boundary-label' })
        .bindPopup(`<b>Block ${blockName}</b>`)
        .addTo(map);
    });
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
