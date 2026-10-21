// Shared canvas renderer for every circle marker on this map — draws all
// visible markers into one <canvas> instead of one DOM element per tree.
const FARM_MAP_CANVAS = L.canvas({ padding: 0.5 });

// Escapes text before it goes into popup HTML (owner/inspector names come
// from the database and shouldn't be trusted as markup).
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

// ------------------------------------------------------------
// Severity scale
// ------------------------------------------------------------
// Same tier cutoffs as RubberTree.severity_label on the server and
// everywhere else in the app: Mild < 34, Moderate < 67, Severe >= 67.
const SEVERITY_MODERATE_FROM = 34;
const SEVERITY_SEVERE_FROM = 67;

function severityTier(score) {
  if (score < SEVERITY_MODERATE_FROM) return 'mild';
  if (score < SEVERITY_SEVERE_FROM) return 'moderate';
  return 'severe';
}

// Heat ramp keyed on severity score. Each tier starts on its --sev-* color
// from style.css (yellow, orange, red) and the top end runs to a hot red, so
// the worst cases are the most vivid thing on a dark map. (The old ramp ended
// in a dark maroon, #7f1d1d, which has about 1.6:1 contrast against a dark
// basemap — the most severe trees were the hardest to see.)
const SEVERITY_STOPS = [
  { at: 0,   rgb: [253, 224, 71] },   // #fde047  mild
  { at: 34,  rgb: [251, 146, 60] },   // #fb923c  moderate
  { at: 67,  rgb: [239, 68, 68] },    // #ef4444  severe
  { at: 100, rgb: [255, 46, 99] },    // #ff2e63  most severe
];

function severityRgb(score) {
  const s = Math.min(Math.max(score, 0), 100);
  for (let i = 1; i < SEVERITY_STOPS.length; i++) {
    const a = SEVERITY_STOPS[i - 1], b = SEVERITY_STOPS[i];
    if (s <= b.at) {
      const t = (s - a.at) / (b.at - a.at);
      return a.rgb.map((v, k) => Math.round(v + (b.rgb[k] - v) * t));
    }
  }
  return SEVERITY_STOPS[SEVERITY_STOPS.length - 1].rgb;
}

// CSS gradient for the legend bar, built from the same stops the map uses so
// the legend can never drift from what's drawn.
function severityGradientCss() {
  const stops = SEVERITY_STOPS.map(s => `rgb(${s.rgb.join(',')}) ${s.at}%`);
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

// ------------------------------------------------------------
// SeverityHeatLayer
// ------------------------------------------------------------
// Replaces leaflet.heat. That plugin adds up the opacity of overlapping
// points, so a dense patch of *mild* trees saturated toward the "severe"
// color — the map showed how many trees were close together, not how bad
// they were. And its radius was a fixed number of screen pixels, so the
// blobs meant different real-world distances at every zoom level.
//
// This layer fixes both:
//   * Each tree is a soft blob colored by ITS OWN severity, drawn from least
//     to most severe so the worst case nearby always ends up on top. Color =
//     the worst severity in the neighborhood; overlap never changes the hue.
//   * The blob radius is a real distance in meters (converted to pixels at
//     the current zoom), so the picture stays truthful as you zoom.
// Blobs are pre-rendered sprites, so thousands of trees redraw instantly.
const SeverityHeatLayer = L.Layer.extend({
  options: { pane: 'heatPane', padding: 0.25 },

  initialize(points, options) {
    this._points = points;       // [{ lat, lng, sev }] sorted by sev ascending
    this._spreadM = 14;          // blob radius in meters
    this._sprites = {};
    L.setOptions(this, options);
  },

  setSpread(meters) {
    this._spreadM = meters;
    this._draw();
  },

  onAdd(map) {
    this._map = map;
    this._canvas = L.DomUtil.create('canvas', 'rg-heat-canvas leaflet-zoom-animated');
    map.getPane(this.options.pane).appendChild(this._canvas);
    map.on('moveend resize', this._update, this);
    if (map.options.zoomAnimation && L.Browser.any3d) map.on('zoomanim', this._onZoomAnim, this);
    this._update();
  },

  onRemove(map) {
    L.DomUtil.remove(this._canvas);
    map.off('moveend resize', this._update, this);
    map.off('zoomanim', this._onZoomAnim, this);
  },

  // Sizes and positions the canvas to cover the view plus some padding (so a
  // small drag doesn't reveal blank edges), then redraws. Same approach as
  // Leaflet's own canvas renderer.
  _update() {
    const map = this._map;
    const pad = this.options.padding;
    const size = map.getSize();
    const min = map.containerPointToLayerPoint(size.multiplyBy(-pad)).round();
    const full = size.multiplyBy(1 + pad * 2).round();
    this._min = min;
    this._center = map.getCenter();
    this._zoom = map.getZoom();
    this._dpr = Math.min(window.devicePixelRatio || 1, 2);

    this._canvas.width = Math.round(full.x * this._dpr);
    this._canvas.height = Math.round(full.y * this._dpr);
    this._canvas.style.width = full.x + 'px';
    this._canvas.style.height = full.y + 'px';
    this._size = full;
    L.DomUtil.setPosition(this._canvas, min);
    this._draw();
  },

  // Keeps the canvas glued to the map during an animated zoom by scaling it
  // with the tiles; the real redraw happens on moveend.
  _onZoomAnim(e) {
    const map = this._map;
    const scale = map.getZoomScale(e.zoom, this._zoom);
    const viewHalf = map.getSize().multiplyBy(0.5 + this.options.padding);
    const currentCenterPoint = map.project(this._center, e.zoom);
    const topLeftOffset = viewHalf.multiplyBy(-scale).add(currentCenterPoint)
      .subtract(map._getNewPixelOrigin(e.center, e.zoom));
    L.DomUtil.setTransform(this._canvas, topLeftOffset, scale);
  },

  // Blob radius in pixels: the real-world spread converted at the current
  // zoom, kept within a range that stays visible zoomed out and doesn't
  // flood the screen zoomed in.
  _radiusPx() {
    const lat = this._map.getCenter().lat;
    const metersPerPx = 40075016.686 * Math.cos(lat * Math.PI / 180)
      / (256 * Math.pow(2, this._map.getZoom()));
    return Math.min(Math.max(this._spreadM / metersPerPx, 7), 140);
  },

  // One pre-rendered radial blob per 5-point severity step.
  _sprite(sev) {
    const bucket = Math.round(sev / 5);
    if (this._sprites[bucket]) return this._sprites[bucket];
    const S = 96;
    const score = Math.min(bucket * 5, 100);
    const [r, g, b] = severityRgb(score);
    // More severe = more opaque as well as hotter, so prominence rises with
    // severity even though yellow is a lighter color than red.
    const alpha = 0.42 + 0.5 * (score / 100);
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const ctx = c.getContext('2d');
    const grad = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grad.addColorStop(0,    `rgba(${r},${g},${b},${alpha})`);
    grad.addColorStop(0.45, `rgba(${r},${g},${b},${alpha * 0.62})`);
    grad.addColorStop(1,    `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, S, S);
    this._sprites[bucket] = c;
    return c;
  },

  _draw() {
    if (!this._map || !this._canvas || !this._min) return;
    const map = this._map;
    const ctx = this._canvas.getContext('2d');
    const w = this._size.x, h = this._size.y;
    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const R = this._radiusPx();
    const screen = [];
    for (const p of this._points) {
      const pt = map.latLngToLayerPoint([p.lat, p.lng]).subtract(this._min);
      if (pt.x < -R || pt.y < -R || pt.x > w + R || pt.y > h + R) continue;
      screen.push({ x: pt.x, y: pt.y, sev: p.sev });
    }
    for (const p of screen) ctx.drawImage(this._sprite(p.sev), p.x - R, p.y - R, R * 2, R * 2);

    // Small dots so you can still see the individual trees under the glow.
    ctx.fillStyle = 'rgba(255,255,255,.72)';
    ctx.beginPath();
    for (const p of screen) { ctx.moveTo(p.x + 1.7, p.y); ctx.arc(p.x, p.y, 1.7, 0, Math.PI * 2); }
    ctx.fill();
  },
});

// Median distance (meters) from a tree to its nearest neighbor. Used to size
// the heat blobs from how closely this farm is actually planted, so they
// overlap just enough to read as a continuous surface. Sampled so a farm
// with thousands of trees stays instant.
function medianNearestNeighborMeters(points) {
  if (points.length < 2) return 6;
  const ky = 111320;
  const kx = 111320 * Math.cos(points[0].lat * Math.PI / 180);
  const xs = points.map(p => p.lng * kx);
  const ys = points.map(p => p.lat * ky);
  const step = Math.max(1, Math.floor(points.length / 400));
  const nearest = [];
  for (let i = 0; i < points.length; i += step) {
    let best = Infinity;
    for (let j = 0; j < points.length; j++) {
      if (j === i) continue;
      const dx = xs[i] - xs[j], dy = ys[i] - ys[j];
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
    nearest.push(Math.sqrt(best));
  }
  nearest.sort((a, b) => a - b);
  return nearest[nearest.length >> 1];
}

// ------------------------------------------------------------
// Markers, popups, clusters
// ------------------------------------------------------------
const LOADING_POPUP_HTML = '<div class="tp-disease" style="margin:0;">Loading…</div>';
const POPUP_ERROR_HTML = '<div class="tp-note todo">Failed to load details. Try again.</div>';

// Wires the lazy-loaded popup (fetched only on click, cached afterward).
function attachTreePopup(marker, tree, detailCache) {
  marker.bindPopup(LOADING_POPUP_HTML, { maxWidth: 270, className: 'rg-popup' });
  marker.on('popupopen', async () => {
    if (detailCache[tree.tree_id]) {
      marker.setPopupContent(buildPopupHtml(detailCache[tree.tree_id]));
      return;
    }
    try {
      const res = await fetch(`/map/marker/${encodeURIComponent(tree.tree_id)}/`);
      if (!res.ok) throw new Error('fetch failed');
      const detail = await res.json();
      detailCache[tree.tree_id] = detail;
      marker.setPopupContent(buildPopupHtml(detail));
    } catch (err) {
      marker.setPopupContent(POPUP_ERROR_HTML);
    }
  });
}

// Builds one canvas-rendered circle marker for a tree.
function buildTreeCircleMarker(tree, detailCache) {
  const marker = L.circleMarker([tree.lat, tree.lng], {
    renderer: FARM_MAP_CANVAS,
    radius: 6,
    weight: 2,
    color: '#1a2535',       // dark border so markers stay visible against both basemaps
    opacity: 1,
    fillColor: tree.color || '#94a3b8',
    fillOpacity: 0.92,
  });
  marker.treeId = tree.tree_id;
  marker.diseaseKey = tree.disease;
  marker.diseaseColor = tree.color;
  attachTreePopup(marker, tree, detailCache);
  return marker;
}

// Builds one canvas-rendered circle marker colored by intervention status
// instead of disease -- used only in Interventions mode, and only for
// diseased trees (healthy trees have nothing to intervene on).
function buildInterventionCircleMarker(tree, detailCache) {
  const marker = L.circleMarker([tree.lat, tree.lng], {
    renderer: FARM_MAP_CANVAS,
    radius: 6,
    weight: 2,
    color: '#1a2535',
    opacity: 1,
    fillColor: tree.has_intervention ? '#22c55e' : '#ef4444',
    fillOpacity: 0.92,
  });
  marker.treeId = tree.tree_id;
  marker.diseaseKey = tree.disease;
  marker.needsAction = !tree.has_intervention;
  attachTreePopup(marker, tree, detailCache);
  return marker;
}

// Builds the popup HTML from a full tree detail payload fetched on demand.
function buildPopupHtml(tree) {
  const confidence = Math.max(0, Math.min(100, Number(tree.confidence) || 0));
  const color = tree.color || '#94a3b8';
  const rows = [
    ['Confidence', `${confidence}%`],
    tree.severity_label ? ['Severity', tree.severity_label] : null,
    ['Scanned', tree.date_scanned],
    ['Managed by', tree.farm_owner],
    tree.inspector ? ['Last inspected by', tree.inspector] : null,
  ].filter(Boolean);

  let note = '';
  if (tree.latest_intervention) {
    const more = tree.intervention_count > 1 ? `, ${tree.intervention_count} actions in total` : '';
    note = `<div class="tp-note ok"><i class="bi bi-check-circle-fill"></i> ${esc(tree.latest_intervention)} (${esc(tree.latest_intervention_date)}${more})</div>`;
  } else if (tree.disease !== 'Healthy') {
    note = '<div class="tp-note todo">No intervention logged yet</div>';
  }

  return `
    <div class="tp-head"><span class="tp-dot" style="background:${esc(color)};"></span>${esc(tree.tree_id)}</div>
    <div class="tp-disease">${esc(tree.disease)}</div>
    <div class="tp-meter" aria-hidden="true"><i style="width:${confidence}%;background:${esc(color)};"></i></div>
    <dl class="tp-grid">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    ${note}
    <a class="tp-link" href="/inventory/${encodeURIComponent(tree.tree_id)}/">View details</a>
  `;
}

function clusterSizing(count) {
  if (count >= 250) return { sizeClass: 'cluster-lg', px: 58 };
  if (count >= 40) return { sizeClass: 'cluster-md', px: 46 };
  return { sizeClass: 'cluster-sm', px: 36 };
}

// Cluster bubble icon — colored by whichever disease dominates that
// cluster's child markers, sized in three tiers so a 900-tree cluster
// visibly reads as "bigger" than a 12-tree one.
function makeClusterIcon(cluster) {
  const children = cluster.getAllChildMarkers();
  const count = children.length;

  const tally = {};
  children.forEach(m => { tally[m.diseaseKey] = (tally[m.diseaseKey] || 0) + 1; });

  // A cluster that's mostly healthy but has even a handful of diseased
  // trees should still read as "needs attention", not blend into the
  // healthy-green background just because Healthy happens to be the
  // single largest category. So any disease category present outranks
  // Healthy when picking the bubble color -- Healthy only wins when
  // it's the ONLY category in the cluster. Among multiple disease
  // categories, the largest one still decides the color.
  const diseaseKeys = Object.keys(tally).filter(k => k !== 'Healthy');
  let dominant = 'Healthy', max = -1;
  const contenders = diseaseKeys.length > 0 ? diseaseKeys : ['Healthy'];
  contenders.forEach(k => { if (tally[k] > max) { max = tally[k]; dominant = k; } });
  const dominantMarker = children.find(m => m.diseaseKey === dominant);
  const color = (dominantMarker && dominantMarker.diseaseColor) || '#4ade80';
  const mixed = Object.keys(tally).length > 1;

  const { sizeClass, px } = clusterSizing(count);
  return L.divIcon({
    html: `<div class="cluster-bubble ${sizeClass}" style="background:${color};${mixed ? 'border-style:dashed;' : ''}">${count}</div>`,
    className: 'marker-cluster-custom',
    iconSize: L.point(px, px),
  });
}

// Cluster bubble icon for Interventions mode — red/needs-action outranks
// green/treated the same way a disease outranks Healthy above: a cluster
// is only "all clear" green when every diseased tree inside it has a
// logged intervention.
function makeInterventionClusterIcon(cluster) {
  const children = cluster.getAllChildMarkers();
  const count = children.length;
  const anyNeedsAction = children.some(m => m.needsAction);
  const color = anyNeedsAction ? '#ef4444' : '#22c55e';
  const { sizeClass, px } = clusterSizing(count);
  return L.divIcon({
    html: `<div class="cluster-bubble ${sizeClass}" style="background:${color};">${count}</div>`,
    className: 'marker-cluster-custom',
    iconSize: L.point(px, px),
  });
}

// ------------------------------------------------------------
// Page
// ------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  const { markers, bounds, boundaryPolygon, farmId, farmName, farmOwner } = FARM_MAP_DATA;
  const $ = (id) => document.getElementById(id);

  const leafletBounds = [
    [bounds.min_lat, bounds.min_lng],
    [bounds.max_lat, bounds.max_lng],
  ];

  const map = L.map('map-container', {
    maxBounds: leafletBounds,
    maxBoundsViscosity: 0.8,
    preferCanvas: true,
    // Quarter-step zoom so the first view can fit the farm snugly. With
    // whole zoom levels only, a farm could end up filling as little as half
    // of the map. (Zoom buttons and the mouse wheel still move one whole
    // level at a time.)
    zoomSnap: 0.25,
  });

  // On wide screens the legend/heatmap panel floats over the right edge of
  // the map (CSS drops it below the map under 768px, where this is 0). Fit
  // the farm into the part of the map the panel does NOT cover, so the
  // default view never hides part of the farm under it.
  const PANEL_INSET_PX = 304;  // 280px panel + 12px margin + breathing room
  const panelInset = () => (window.matchMedia('(min-width: 768px)').matches ? PANEL_INSET_PX : 0);

  // Never open (or reset) tighter than this. Tree markers stop clustering at
  // zoom 19 (disableClusteringAtZoom below) and markercluster rounds a
  // fractional zoom like 18.75 up to 19, so a tighter fit would open a dense
  // farm as ~1,500 overlapping dots instead of the summarized bubbles.
  const MAX_FIT_ZOOM = 18.25;

  function fitFarm() {
    const inset = panelInset();
    map.fitBounds(leafletBounds, { paddingBottomRight: [inset, 0], maxZoom: MAX_FIT_ZOOM, animate: false });
    // The view now reaches `inset` px past the farm's east edge. Widen the
    // pan limit by the same amount; otherwise maxBounds would pull the farm
    // back to the middle, under the panel.
    const z = map.getZoom();
    const east = map.unproject(
      map.project([bounds.min_lat, bounds.max_lng], z).add([inset, 0]), z
    ).lng;
    map.setMaxBounds([[bounds.min_lat, bounds.min_lng], [bounds.max_lat, east]]);
  }
  fitFarm();
  // getBoundsZoom needs the container's real pixel size, which isn't
  // reliably available the instant the map is created — invalidate size
  // first, then refit and compute the min zoom, with a sane fallback if
  // invalid.
  setTimeout(() => {
    map.invalidateSize();
    fitFarm();
    const boundsZoom = map.getBoundsZoom(leafletBounds);
    map.setMinZoom(Number.isFinite(boundsZoom) ? Math.max(boundsZoom - 1, 1) : 12);
  }, 150);

  // The heatmap sits under the farm boundary and the tree markers, and never
  // intercepts clicks.
  map.createPane('heatPane');
  map.getPane('heatPane').style.zIndex = 350;
  map.getPane('heatPane').style.pointerEvents = 'none';

  // Scale control — shows a ruler segment labeled with its real-world
  // distance in meters/km, so users can gauge how far apart trees are.
  L.control.scale({ metric: true, imperial: false, position: 'bottomleft' }).addTo(map);

  // Farm boundary — a convex hull around the farm's actual trees, so the
  // shape follows the planted area instead of an arbitrary circle. Dashed
  // like a survey line so it reads as an outline, not a data layer.
  // Drawn on the SAME canvas renderer as the tree markers: two separate
  // canvases stack, and only the top one receives mouse events, so with the
  // polygon on its own canvas underneath the markers' canvas its popup/hover
  // never fired. On one renderer Leaflet hit-tests both, and the marker
  // (drawn later) still wins where they overlap.
  if (boundaryPolygon && boundaryPolygon.length >= 3) {
    L.polygon(boundaryPolygon, {
      renderer: FARM_MAP_CANVAS,
      color: '#7cb4ff', weight: 2.5, dashArray: '8 6', fillColor: '#7cb4ff', fillOpacity: 0.05,
    })
      .bindPopup(`<b>${esc(farmId)}</b><br>${esc(farmName)}<br><i>${esc(farmOwner)}</i>`)
      .addTo(map);

    // Farm name sits just above the top edge of the border. (It used to be
    // centered on the farm, right on top of the markers and the heatmap.)
    const lats = boundaryPolygon.map(p => p[0]);
    const lngs = boundaryPolygon.map(p => p[1]);
    L.marker([Math.max(...lats), (Math.min(...lngs) + Math.max(...lngs)) / 2], {
      icon: L.divIcon({ className: '', iconSize: [0, 0] }),
      interactive: false, keyboard: false,
    }).bindTooltip(farmName || farmId, {
      permanent: true, direction: 'top', offset: [0, -2], className: 'farm-boundary-label',
    }).addTo(map);
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

  function buildClusterGroup(iconFn) {
    return L.markerClusterGroup({
      maxClusterRadius: 60,
      disableClusteringAtZoom: 19,   // matches basemap maxZoom — individual trees always show once fully zoomed in
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      zoomToBoundsOnClick: true,
      chunkedLoading: true,
      iconCreateFunction: iconFn || makeClusterIcon,
    });
  }

  // Rebuilds the on-map cluster group from just the given subset of
  // trees — used for every filter/search change so picking a category,
  // or "All Diseases", never has to render every marker to show a
  // filtered handful. markerFn/iconFn default to the disease-colored
  // versions; Interventions mode passes the intervention-status versions.
  function rebuildClusterGroup(subsetTrees, markerFn, iconFn) {
    if (activeClusterGroup) map.removeLayer(activeClusterGroup);
    activeClusterGroup = buildClusterGroup(iconFn);
    const build = markerFn || buildTreeCircleMarker;
    const layers = subsetTrees.map(tree => build(tree, detailCache));
    activeClusterGroup.addLayers(layers);
    return activeClusterGroup;
  }

  // ------------------------------------------------------------
  // Elements
  // ------------------------------------------------------------
  const searchInput = $('map-search');
  const filterSelect = $('map-filter');
  const resetBtn = $('map-reset');
  const markersBtn = $('view-markers-btn');
  const heatmapBtn = $('view-heatmap-btn');
  const interventionsBtn = $('view-interventions-btn');
  const panels = {
    markers: $('panel-markers'),
    heatmap: $('panel-heatmap'),
    interventions: $('panel-interventions'),
  };
  const viewButtons = { markers: markersBtn, heatmap: heatmapBtn, interventions: interventionsBtn };
  const allDiseasesOption = filterSelect ? filterSelect.querySelector('option[value=""]') : null;
  // Whatever's actually in the filter dropdown (server-rendered from the
  // live DiseaseClass catalog), minus "All Diseases" and Healthy -- a
  // heatmap of Healthy trees has no meaningful severity gradient.
  const diseaseOptions = filterSelect
    ? Array.from(filterSelect.options).map(o => o.value).filter(v => v && v !== 'Healthy')
    : [];

  let activeView = 'markers';

  // ------------------------------------------------------------
  // Panels and the "nothing matches" message
  // ------------------------------------------------------------
  function showPanel(name) {
    Object.entries(panels).forEach(([key, el]) => { if (el) el.hidden = key !== name; });
    Object.entries(viewButtons).forEach(([key, btn]) => {
      if (!btn) return;
      btn.classList.toggle('active', key === name);
      btn.setAttribute('aria-pressed', key === name ? 'true' : 'false');
    });
  }

  Object.values(panels).forEach(panel => {
    const head = panel && panel.querySelector('.map-panel-head');
    if (!head) return;
    head.addEventListener('click', () => {
      const collapsed = panel.classList.toggle('is-collapsed');
      head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    });
  });

  const emptyBox = $('map-empty');
  function showEmpty(title, body) {
    $('map-empty-title').textContent = title;
    $('map-empty-body').textContent = body || '';
    emptyBox.hidden = false;
  }
  function hideEmpty() { emptyBox.hidden = true; }

  // ------------------------------------------------------------
  // Marker view
  // ------------------------------------------------------------
  const legendRows = Array.from(document.querySelectorAll('#panel-markers .legend-row[data-disease]'));
  function syncLegendPressed() {
    const d = filterSelect ? filterSelect.value : '';
    legendRows.forEach(row => row.setAttribute('aria-pressed', row.dataset.disease === d ? 'true' : 'false'));
  }
  // Legend rows double as filters: click to show only that disease, click
  // again to clear.
  legendRows.forEach(row => row.addEventListener('click', () => {
    if (!filterSelect) return;
    filterSelect.value = filterSelect.value === row.dataset.disease ? '' : row.dataset.disease;
    filterSelect.dispatchEvent(new Event('change'));
  }));

  function currentSubset() {
    const q = (searchInput && searchInput.value ? searchInput.value : '').trim().toLowerCase();
    const d = filterSelect ? filterSelect.value : '';
    return markers.filter(t => (!d || t.disease === d) && (!q || t.tree_id.toLowerCase().includes(q)));
  }

  // Same search+filter logic as currentSubset(), further limited to
  // diseased trees only -- Interventions mode has nothing meaningful to
  // show for a healthy tree.
  function interventionSubset() {
    return currentSubset().filter(t => t.disease !== 'Healthy');
  }

  function reportEmptySubset(subset) {
    if (subset.length) { hideEmpty(); return; }
    const q = (searchInput && searchInput.value ? searchInput.value : '').trim();
    showEmpty('No trees match', q ? `Nothing matches "${q}". Check the tree ID or clear the search.` : 'Try a different disease filter.');
  }

  // If the search box narrows things down to exactly one tree, zoom/spiderfy
  // straight to it and open its popup — clustering means a matching tree
  // could be buried inside a bubble, so this keeps search feeling instant.
  function zoomToSingleMatch(subset) {
    const q = (searchInput && searchInput.value ? searchInput.value : '').trim();
    if (q && subset.length === 1) {
      const [only] = activeClusterGroup.getLayers();
      if (only) activeClusterGroup.zoomToShowLayer(only, () => only.openPopup());
    }
  }

  function applyMarkerFilters() {
    if (activeView !== 'markers') return;
    const subset = currentSubset();
    rebuildClusterGroup(subset);
    activeClusterGroup.addTo(map);
    reportEmptySubset(subset);
    syncLegendPressed();
    zoomToSingleMatch(subset);
  }

  // Same shape as applyMarkerFilters(), but for Interventions mode: builds
  // the cluster group from interventionSubset() using the red/green
  // intervention-status marker and cluster-icon builders.
  function applyInterventionFilters() {
    if (activeView !== 'interventions') return;
    const subset = interventionSubset();
    rebuildClusterGroup(subset, buildInterventionCircleMarker, makeInterventionClusterIcon);
    activeClusterGroup.addTo(map);
    fillInterventionSummary(subset);
    reportEmptySubset(subset);
    zoomToSingleMatch(subset);
  }

  // Progress numbers in the Interventions panel. Counts the trees currently
  // shown, so they always agree with the markers on the map (a disease
  // filter or search narrows both).
  function fillInterventionSummary(subset) {
    const done = subset.filter(t => t.has_intervention).length;
    $('iv-total').textContent = subset.length;
    $('iv-done').textContent = done;
    $('iv-count-done').textContent = done;
    $('iv-count-todo').textContent = subset.length - done;
    $('iv-bar').style.width = (subset.length ? Math.round(done / subset.length * 100) : 0) + '%';
  }

  // ------------------------------------------------------------
  // Heatmap view
  // ------------------------------------------------------------
  $('heat-ramp').style.background = severityGradientCss();

  const heatChipsBox = $('heat-chips');
  const heatCounts = {};
  diseaseOptions.forEach(d => { heatCounts[d] = markers.filter(t => t.disease === d).length; });
  const heatChips = diseaseOptions.map(d => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'heat-chip';
    chip.dataset.disease = d;
    chip.disabled = heatCounts[d] === 0;
    chip.setAttribute('aria-pressed', 'false');
    chip.innerHTML = `${esc(d)} <span>${heatCounts[d]}</span>`;
    chip.addEventListener('click', () => {
      filterSelect.value = d;
      drawHeatForCurrentDisease();
    });
    heatChipsBox.appendChild(chip);
    return chip;
  });

  // Blob size comes from how densely this farm is planted: about three tree
  // spacings, within a sensible range. The "Spread" slider scales it.
  const baseSpreadM = Math.min(Math.max(3 * medianNearestNeighborMeters(markers), 8), 30);
  const spreadInput = $('heat-spread');
  const spreadMeters = () => baseSpreadM * (spreadInput ? Number(spreadInput.value) : 1);

  let heatLayer = null;
  let heatPoints = [];
  let locateRing = null;

  function clearHeatLayer() {
    if (heatLayer && map.hasLayer(heatLayer)) map.removeLayer(heatLayer);
    heatLayer = null;
    if (locateRing) { map.removeLayer(locateRing); locateRing = null; }
  }

  // Most-affected disease by tree count, so entering the heatmap lands on
  // something worth looking at instead of an empty first dropdown entry.
  function defaultHeatDisease() {
    const withTrees = diseaseOptions.filter(d => heatCounts[d] > 0);
    const pool = withTrees.length ? withTrees : diseaseOptions;
    return pool.reduce((best, d) => (heatCounts[d] > (heatCounts[best] || 0) ? d : best), pool[0]);
  }

  function updateHeatSummary(points) {
    const tiers = { mild: 0, moderate: 0, severe: 0 };
    let sum = 0, peak = 0, worst = null;
    points.forEach(p => {
      tiers[severityTier(p.sev)] += 1;
      sum += p.sev;
      if (p.sev > peak) { peak = p.sev; worst = p; }
    });
    $('heat-stat-count').textContent = points.length;
    $('heat-stat-mean').textContent = points.length ? Math.round(sum / points.length) : '–';
    $('heat-stat-peak').textContent = points.length ? Math.round(peak) : '–';
    ['mild', 'moderate', 'severe'].forEach(t => { $('heat-tier-' + t).textContent = tiers[t]; });

    const bar = $('heat-tier-bar');
    bar.innerHTML = '';
    ['mild', 'moderate', 'severe'].forEach(t => {
      if (!tiers[t]) return;
      const seg = document.createElement('span');
      seg.style.flex = String(tiers[t]);
      seg.style.background = `var(--sev-${t})`;
      bar.appendChild(seg);
    });

    $('heat-locate').disabled = !worst;
    $('heat-worst').hidden = true;
    return worst;
  }

  function drawHeatForCurrentDisease() {
    clearHeatLayer();
    hideEmpty();
    if (!diseaseOptions.length) {
      showEmpty('No disease classes to map', 'Add a disease class in the admin to see its heatmap.');
      return;
    }
    let disease = filterSelect ? filterSelect.value : '';
    if (!disease || !diseaseOptions.includes(disease)) {
      disease = defaultHeatDisease();
      if (filterSelect) filterSelect.value = disease;
    }
    heatChips.forEach(c => c.setAttribute('aria-pressed', c.dataset.disease === disease ? 'true' : 'false'));

    heatPoints = markers
      .filter(t => t.disease === disease)
      .map(t => ({ id: t.tree_id, lat: t.lat, lng: t.lng, sev: Math.min(Math.max(Number(t.severity_score) || 0, 1), 100) }))
      .sort((a, b) => a.sev - b.sev);   // least to most severe: worst case paints last, on top
    updateHeatSummary(heatPoints);

    if (!heatPoints.length) {
      showEmpty(`No ${disease} trees on this farm`, 'Pick another disease to see its heat.');
      return;
    }
    heatLayer = new SeverityHeatLayer(heatPoints);
    heatLayer.setSpread(spreadMeters());
    heatLayer.addTo(map);
  }

  if (spreadInput) spreadInput.addEventListener('input', () => {
    if (heatLayer) heatLayer.setSpread(spreadMeters());
  });

  // Jump to the single most severe tree for the selected disease and ring it.
  $('heat-locate').addEventListener('click', () => {
    if (!heatPoints.length) return;
    const worst = heatPoints[heatPoints.length - 1];
    map.setView([worst.lat, worst.lng], Math.min(map.getMaxZoom() || 19, 19));
    if (locateRing) map.removeLayer(locateRing);
    locateRing = L.circleMarker([worst.lat, worst.lng], {
      renderer: FARM_MAP_CANVAS, radius: 16, weight: 2.5, color: '#ffffff', fill: false, interactive: false,
    }).addTo(map);
    const note = $('heat-worst');
    note.innerHTML = `Worst case: <a href="/inventory/${encodeURIComponent(worst.id)}/">${esc(worst.id)}</a>, severity ${Math.round(worst.sev)}`;
    note.hidden = false;
  });

  // ------------------------------------------------------------
  // View switching
  // ------------------------------------------------------------
  function showMarkers() {
    activeView = 'markers';
    clearHeatLayer();
    hideEmpty();
    if (map.hasLayer(grayBasemap)) map.removeLayer(grayBasemap);
    if (!map.hasLayer(colorBasemap)) colorBasemap.addTo(map);
    if (allDiseasesOption) allDiseasesOption.hidden = false;
    if (searchInput) { searchInput.disabled = false; searchInput.placeholder = 'Search tree ID'; }
    showPanel('markers');
    applyMarkerFilters();
  }

  function showHeatmap() {
    activeView = 'heatmap';
    // Heatmap mode never renders individual circle markers or clusters.
    if (activeClusterGroup && map.hasLayer(activeClusterGroup)) map.removeLayer(activeClusterGroup);
    if (map.hasLayer(colorBasemap)) map.removeLayer(colorBasemap);
    if (!map.hasLayer(grayBasemap)) grayBasemap.addTo(map);
    if (allDiseasesOption) allDiseasesOption.hidden = true;
    if (searchInput) { searchInput.disabled = true; searchInput.placeholder = 'Search (markers only)'; }
    showPanel('heatmap');
    drawHeatForCurrentDisease();
  }

  function showInterventions() {
    activeView = 'interventions';
    clearHeatLayer();
    hideEmpty();
    if (map.hasLayer(grayBasemap)) map.removeLayer(grayBasemap);
    if (!map.hasLayer(colorBasemap)) colorBasemap.addTo(map);
    if (allDiseasesOption) allDiseasesOption.hidden = false;
    if (searchInput) { searchInput.disabled = false; searchInput.placeholder = 'Search tree ID'; }
    showPanel('interventions');
    applyInterventionFilters();
  }

  if (markersBtn) markersBtn.addEventListener('click', showMarkers);
  if (heatmapBtn) heatmapBtn.addEventListener('click', showHeatmap);
  if (interventionsBtn) interventionsBtn.addEventListener('click', showInterventions);

  if (filterSelect) filterSelect.addEventListener('change', () => {
    if (activeView === 'heatmap') drawHeatForCurrentDisease();
    else if (activeView === 'interventions') applyInterventionFilters();
    else applyMarkerFilters();
  });

  // Debounced so rebuilding the cluster group doesn't fire on every single
  // keystroke while typing a tree ID.
  let searchDebounce = null;
  if (searchInput) searchInput.addEventListener('input', () => {
    if (activeView === 'heatmap') return;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      if (activeView === 'interventions') applyInterventionFilters();
      else applyMarkerFilters();
    }, 180);
  });

  if (resetBtn) resetBtn.addEventListener('click', () => {
    if (searchInput) searchInput.value = '';
    if (filterSelect) filterSelect.value = '';
    if (activeView === 'heatmap') drawHeatForCurrentDisease();
    else if (activeView === 'interventions') applyInterventionFilters();
    else applyMarkerFilters();
    fitFarm();
  });

  // ------------------------------------------------------------
  // Initial view: "All Diseases" selected, showing the summarized
  // clustered view of every tree rather than every marker at once.
  // ------------------------------------------------------------
  showPanel('markers');
  applyMarkerFilters();
});
