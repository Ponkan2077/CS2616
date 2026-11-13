// Colours: disease colours come from the data (tree.color). Everything else
// (marker outlines, farm boundary, the severity heat ramp, intervention status,
// the heat dots) is read from the CSS variables through window.RG (theme.js)
// and re-read on "themechange", when the markers, boundary and heat layer are
// rebuilt for the new theme.
//
// How the map is organised
//   * The farm is split into REGIONS (a few dozen trees each). In the Markers
//     and Interventions views every region is one circle on the map; clicking
//     it zooms in to that region and shows its individual trees where they
//     really are. "All regions" (or the reset button) zooms back out.
//   * The Heatmap view paints one smooth surface over the farm outline
//     (green = no cases nearby, yellow to red = the worst tree nearby) with a
//     clickable dot for every tree on top.
//   * Clicking any tree dot opens a small snapshot of that tree with a button
//     to its full page.

// Shared canvas renderer for every circle marker on this map — draws all
// visible markers into one <canvas> instead of one DOM element per tree.
// `tolerance` widens the tap/click area around each dot (they are only a few
// pixels wide), more on touch screens where a fingertip is far bigger than a cursor.
const FARM_MAP_CANVAS = L.canvas({ padding: 0.5, tolerance: L.Browser.mobile ? 14 : 6 });

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
// Where the ramp turns from "no cases" green into the mild yellow.
const SEVERITY_MILD_AT = 6;

function severityTier(score) {
  if (score < SEVERITY_MODERATE_FROM) return 'mild';
  if (score < SEVERITY_SEVERE_FROM) return 'moderate';
  return 'severe';
}

// Heat ramp keyed on severity score: green where there are no cases, then each
// tier starts on its --sev-* token from style.css (yellow, orange, red) and
// the top end runs to the --sev-peak token, so the worst cases are the most
// vivid thing on the map. Read from the CSS each time the theme changes (the
// light and dark tiers differ).
let severityStopsCache = null;

function severityStops() {
  if (!severityStopsCache) {
    const t = RG.tokens();
    severityStopsCache = [
      { at: 0,   rgb: RG.toRgb(t.sevNone) },
      { at: SEVERITY_MILD_AT, rgb: RG.toRgb(t.sevMild) },
      { at: SEVERITY_MODERATE_FROM, rgb: RG.toRgb(t.sevModerate) },
      { at: SEVERITY_SEVERE_FROM,   rgb: RG.toRgb(t.sevSevere) },
      { at: 100, rgb: RG.toRgb(t.sevPeak) },
    ];
  }
  return severityStopsCache;
}

function severityRgb(score) {
  const stops = severityStops();
  const s = Math.min(Math.max(score, 0), 100);
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1], b = stops[i];
    if (s <= b.at) {
      const t = (s - a.at) / (b.at - a.at);
      return a.rgb.map((v, k) => Math.round(v + (b.rgb[k] - v) * t));
    }
  }
  return stops[stops.length - 1].rgb;
}

// CSS gradient for the legend bar, built from the same stops the map uses so
// the legend can never drift from what's drawn.
function severityGradientCss() {
  const stops = severityStops().map(s => `rgb(${s.rgb.join(',')}) ${s.at}%`);
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

// Ink for the tree dots drawn on top of the heatmap and the "worst case" ring:
// light on the dark basemap, dark on the light one.
function heatInk() {
  const t = RG.tokens();
  return RG.theme() === 'light' ? t.mapRing : t.mapRingInv;
}
function heatInkEdge() {
  const t = RG.tokens();
  return RG.theme() === 'light' ? t.mapRingInv : t.mapRing;
}

// ------------------------------------------------------------
// SeverityHeatLayer
// ------------------------------------------------------------
// A smooth "zone map" of the farm, like the field maps used in precision
// agriculture: the surface is clipped to the farm outline, green where no
// case is near and warming through yellow and orange to red toward the worst
// trees.
//
// How the colour is chosen (it is the WORST tree nearby, never a sum):
//   * Each diseased tree casts a soft bump of its own severity. A cell of a
//     coarse grid takes the highest bump reaching it, so a dense patch of
//     mild trees stays yellow and never turns red just because it is crowded.
//   * The bump radius is a real distance in meters (converted to pixels at
//     the current zoom), so the picture stays truthful as you zoom.
//   * The grid is then stretched to the map with smoothing, which gives the
//     soft gradient instead of visible squares.
// The tree dots themselves are real markers (see buildHeatDot), not part of
// this layer, so they can be clicked.
const SeverityHeatLayer = L.Layer.extend({
  options: { pane: 'heatPane', padding: 0.25 },

  initialize(points, options) {
    this._points = points;       // [{ lat, lng, sev }]
    this._spreadM = 14;          // bump radius in meters
    this._clip = null;           // farm outline [[lat, lng], ...]
    this._lut = null;
    L.setOptions(this, options);
  },

  setSpread(meters) {
    this._spreadM = meters;
    this._draw();
  },

  setClip(latlngs) {
    this._clip = latlngs;
    this._draw();
  },

  // Drops the cached colour table and redraws, after the theme (and so the ramp) changed.
  refreshColors() {
    this._lut = null;
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

  // Bump radius in pixels: the real-world spread converted at the current
  // zoom, kept within a range that stays visible zoomed out and doesn't
  // flood the screen zoomed in.
  _radiusPx() {
    const lat = this._map.getCenter().lat;
    const metersPerPx = 40075016.686 * Math.cos(lat * Math.PI / 180)
      / (256 * Math.pow(2, this._map.getZoom()));
    return Math.min(Math.max(this._spreadM / metersPerPx, 10), 220);
  },

  // 256-step colour table for the 0-100 field: [r, g, b, alpha]. The surface
  // is see-through enough for the streets or satellite photo to show, and more
  // opaque toward the hot end so the worst spots stand out.
  _colorLut() {
    if (this._lut) return this._lut;
    const lut = [];
    for (let i = 0; i < 256; i++) {
      const v = (i / 255) * 100;
      const [r, g, b] = severityRgb(v);
      const a = Math.round(255 * (0.4 + 0.5 * Math.min(1, v / 55)));
      lut.push([r, g, b, a]);
    }
    this._lut = lut;
    return lut;
  },

  _draw() {
    if (!this._map || !this._canvas || !this._min) return;
    const map = this._map;
    const ctx = this._canvas.getContext('2d');
    const w = this._size.x, h = this._size.y;
    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.save();

    // Keep the surface inside the farm outline so it reads as the field itself.
    if (this._clip && this._clip.length > 2) {
      ctx.beginPath();
      this._clip.forEach((ll, i) => {
        const p = map.latLngToLayerPoint(ll).subtract(this._min);
        if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
      });
      ctx.closePath();
      ctx.clip();
    }

    // A coarse grid (about 5px cells, coarser on a very large map) of "worst
    // severity reaching this cell".
    let cell = 5;
    while ((w / cell) * (h / cell) > 70000) cell += 1;
    const gw = Math.ceil(w / cell) + 1, gh = Math.ceil(h / cell) + 1;
    const field = new Float32Array(gw * gh);
    const R = this._radiusPx();
    const rc = R / cell, rc2 = rc * rc;

    for (const p of this._points) {
      const pt = map.latLngToLayerPoint([p.lat, p.lng]).subtract(this._min);
      if (pt.x < -R || pt.y < -R || pt.x > w + R || pt.y > h + R) continue;
      const cx = pt.x / cell - 0.5, cy = pt.y / cell - 0.5;   // cell centres sit half a cell in
      const x0 = Math.max(0, Math.floor(cx - rc)), x1 = Math.min(gw - 1, Math.ceil(cx + rc));
      const y0 = Math.max(0, Math.floor(cy - rc)), y1 = Math.min(gh - 1, Math.ceil(cy + rc));
      for (let y = y0; y <= y1; y++) {
        const dy = y - cy;
        for (let x = x0; x <= x1; x++) {
          const dx = x - cx;
          const d2 = (dx * dx + dy * dy) / rc2;
          if (d2 >= 1) continue;
          const k = 1 - d2;                 // smooth bump: 1 at the tree, 0 at the edge
          const v = p.sev * k * k;
          const i = y * gw + x;
          if (v > field[i]) field[i] = v;
        }
      }
    }

    const lut = this._colorLut();
    const grid = this._grid || (this._grid = document.createElement('canvas'));
    grid.width = gw; grid.height = gh;
    const gctx = grid.getContext('2d');
    const img = gctx.createImageData(gw, gh);
    for (let i = 0; i < field.length; i++) {
      const c = lut[Math.min(255, (field[i] * 2.55) | 0)];
      const o = i * 4;
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = c[3];
    }
    gctx.putImageData(img, 0, 0);

    // Stretched up with smoothing: this is what turns the grid into a soft surface.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(grid, 0, 0, gw * cell, gh * cell);
    ctx.restore();
  },
});

// Median distance (meters) from a tree to its nearest neighbor. Used to size
// the heat bumps from how closely this farm is actually planted, so they
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
// Regions
// ------------------------------------------------------------
// The farm is cut into compact regions of roughly equal tree count by
// repeatedly halving the trees along the longer side of the area they cover
// (a k-d split). Regions never overlap, every tree belongs to exactly one,
// and they follow the planted area. A farm too small to need this (fewer than
// REGION_MIN_TREES trees) gets no regions and simply shows every tree.
const REGION_MIN_TREES = 140;
const REGION_TREES_EACH = 100;    // aim: about this many trees per region
const REGION_MAX_DEPTH = 5;       // at most 2^5 = 32 regions

// Convex hull of [[lat, lng], ...] (monotone chain), as [[lat, lng], ...].
function convexHull(points) {
  const pts = points.map(p => [p[1], p[0]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const uniq = pts.filter((p, i) => !i || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]);
  if (uniq.length < 3) return uniq.map(p => [p[1], p[0]]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of uniq) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = uniq.length - 1; i >= 0; i--) {
    const p = uniq[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper).map(p => [p[1], p[0]]);
}

// Pushes every hull point away from the centre by `factor`, so the outline
// sits just outside the outermost trees instead of through them.
function expandHull(hull, center, factor) {
  return hull.map(p => [center[0] + (p[0] - center[0]) * factor, center[1] + (p[1] - center[1]) * factor]);
}

function buildRegions(trees) {
  const n = trees.length;
  if (n < REGION_MIN_TREES) return [];
  const depth = Math.min(REGION_MAX_DEPTH, Math.max(1, Math.round(Math.log2(n / REGION_TREES_EACH))));
  const kx = Math.cos(trees[0].lat * Math.PI / 180);
  const cells = [];

  (function split(list, d) {
    if (d === 0 || list.length < 2) { cells.push(list); return; }
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    list.forEach(t => {
      if (t.lat < minLat) minLat = t.lat;
      if (t.lat > maxLat) maxLat = t.lat;
      if (t.lng < minLng) minLng = t.lng;
      if (t.lng > maxLng) maxLng = t.lng;
    });
    const key = (maxLng - minLng) * kx > (maxLat - minLat) ? 'lng' : 'lat';
    const sorted = list.slice().sort((a, b) => a[key] - b[key]);
    const mid = sorted.length >> 1;
    split(sorted.slice(0, mid), d - 1);
    split(sorted.slice(mid), d - 1);
  })(trees, depth);

  return cells.map((list, i) => {
    const lat = list.reduce((s, t) => s + t.lat, 0) / list.length;
    const lng = list.reduce((s, t) => s + t.lng, 0) / list.length;
    const pts = list.map(t => [t.lat, t.lng]);
    let hull = convexHull(pts);
    const bounds = L.latLngBounds(pts);
    if (hull.length < 3) {
      // A line of trees: fall back to the box around them, padded a little.
      const b = bounds.pad(0.2);
      hull = [[b.getSouth(), b.getWest()], [b.getSouth(), b.getEast()], [b.getNorth(), b.getEast()], [b.getNorth(), b.getWest()]];
    } else {
      hull = expandHull(hull, [lat, lng], 1.08);
    }
    return {
      id: i,
      name: `Region ${i + 1}`,
      trees: list,
      center: [lat, lng],
      bounds: L.latLngBounds(hull),
      hull,
    };
  });
}

// ------------------------------------------------------------
// Markers, popups, region circles
// ------------------------------------------------------------
const LOADING_POPUP_HTML = '<div class="tp-disease tp-loading">Loading…</div>';
const POPUP_ERROR_HTML = '<div class="tp-note todo">Failed to load details. Try again.</div>';

// Full detail for a tree is fetched only when its dot is clicked, then kept.
const treeDetailCache = {};
let treePopup = null;
let treePopupTreeId = '';

// One shared popup for every dot on the map: a quick snapshot of the tree,
// with a button to its full page.
function openTreePopup(map, tree, latlng, popupInsets) {
  if (!treePopup) {
    treePopup = L.popup({
      maxWidth: 270, className: 'rg-popup',
      autoPanPaddingTopLeft: popupInsets.topLeft, autoPanPaddingBottomRight: popupInsets.bottomRight,
    });
  }
  treePopupTreeId = tree.tree_id;
  const show = html => { if (treePopupTreeId === tree.tree_id && map.hasLayer(treePopup)) treePopup.setContent(html); };

  if (treeDetailCache[tree.tree_id]) {
    treePopup.setLatLng(latlng).setContent(buildPopupHtml(treeDetailCache[tree.tree_id])).openOn(map);
    return;
  }
  treePopup.setLatLng(latlng).setContent(LOADING_POPUP_HTML).openOn(map);
  fetch(`/map/marker/${encodeURIComponent(tree.tree_id)}/`)
    .then(res => { if (!res.ok) throw new Error('fetch failed'); return res.json(); })
    .then(detail => {
      // The dot's own data (severity score, ...) plus the full detail from the server.
      treeDetailCache[tree.tree_id] = Object.assign({}, tree, detail);
      show(buildPopupHtml(treeDetailCache[tree.tree_id]));
    })
    .catch(() => show(POPUP_ERROR_HTML));
}

// Builds one canvas-rendered circle marker for a tree.
// Healthy trees are drawn small and soft, diseased ones larger and solid, so on
// a farm that is mostly healthy the sick trees are what the eye lands on.
function buildTreeCircleMarker(tree) {
  const healthy = !!tree.is_healthy;
  const marker = L.circleMarker([tree.lat, tree.lng], {
    renderer: FARM_MAP_CANVAS,
    radius: healthy ? 4.5 : 7,
    weight: healthy ? 1.25 : 2,
    color: RG.tokens().mapRing,   // dark border so markers stay visible against both basemaps
    opacity: healthy ? 0.7 : 1,
    fillColor: tree.color || RG.tokens().secondary,
    fillOpacity: healthy ? 0.6 : 0.95,
  });
  marker.tree = tree;
  return marker;
}

// Intervention status colours: needs action = the danger colour, treated = the
// primary teal (green is reserved for healthy trees).
function interventionColor(hasIntervention) {
  const t = RG.tokens();
  return hasIntervention ? t.primary : t.danger;
}

// Builds one canvas-rendered circle marker colored by intervention status
// instead of disease -- used only in Interventions mode, and only for
// diseased trees (healthy trees have nothing to intervene on).
function buildInterventionCircleMarker(tree) {
  const marker = L.circleMarker([tree.lat, tree.lng], {
    renderer: FARM_MAP_CANVAS,
    radius: 6,
    weight: 2,
    color: RG.tokens().mapRing,
    opacity: 1,
    fillColor: interventionColor(tree.has_intervention),
    fillOpacity: 0.92,
  });
  marker.tree = tree;
  return marker;
}

// The dot for one tree in the heatmap view. Every tree gets one, so every tree
// can be clicked; trees with the disease being mapped are bigger and outlined.
function buildHeatDot(tree, selected) {
  const marker = L.circleMarker([tree.lat, tree.lng], selected ? {
    renderer: FARM_MAP_CANVAS, radius: 4.5, weight: 1.5,
    color: heatInkEdge(), opacity: 1, fillColor: heatInk(), fillOpacity: 0.95,
  } : {
    renderer: FARM_MAP_CANVAS, radius: 2.6, stroke: false,
    fillColor: heatInk(), fillOpacity: 0.5,
  });
  marker.tree = tree;
  return marker;
}

// Builds the popup HTML from a full tree detail payload fetched on demand.
function buildPopupHtml(tree) {
  const confidence = Math.max(0, Math.min(100, Number(tree.confidence) || 0));
  const color = tree.color || RG.tokens().secondary;
  const score = Number(tree.severity_score);
  const severity = tree.severity_label
    ? (score > 0 ? `${tree.severity_label} (${Math.round(score)}/100)` : tree.severity_label)
    : '';
  const rows = [
    ['Confidence', `${confidence}%`],
    severity ? ['Severity', severity] : null,
    ['Scanned', tree.date_scanned],
    ['Managed by', tree.farm_owner],
    tree.inspector ? ['Last inspected by', tree.inspector] : null,
  ].filter(Boolean);

  let note = '';
  if (tree.latest_intervention) {
    const more = tree.intervention_count > 1 ? `, ${tree.intervention_count} actions in total` : '';
    note = `<div class="tp-note ok"><i class="bi bi-check-circle-fill"></i> ${esc(tree.latest_intervention)} (${esc(tree.latest_intervention_date)}${more})</div>`;
  } else if (!tree.is_healthy) {
    note = '<div class="tp-note todo">No intervention logged yet</div>';
  }

  return `
    <div class="tp-head"><span class="tp-dot" style="--c:${esc(color)};"></span>${esc(tree.tree_id)}</div>
    <div class="tp-disease">${esc(tree.disease)}</div>
    <div class="tp-meter" aria-hidden="true"><i style="width:${confidence}%;--c:${esc(color)};"></i></div>
    <dl class="tp-grid">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    ${note}
    <a class="tp-link" href="/inventory/${encodeURIComponent(tree.tree_id)}/"><i class="bi bi-eye" aria-hidden="true"></i> View full information</a>
  `;
}

// The smallest a region circle may get: its ring plus a three-digit count.
const REGION_MIN_PX = 38;

// How far in the map may zoom (tiles are stretched past their last real level).
const MAX_MAP_ZOOM = 21;

function clusterSizing(count, donut, maxPx) {
  // The marker-view donut needs a thicker ring and a bigger centre than the
  // Interventions ring, so its slices and its number both stay readable.
  const s = donut ? [62, 50, 40] : [58, 46, 36];
  let size;
  if (count >= 250) size = { sizeClass: 'cluster-lg', px: s[0] };
  else if (count >= 40) size = { sizeClass: 'cluster-md', px: s[1] };
  else size = { sizeClass: 'cluster-sm', px: s[2] };
  // Regions packed close together at the current zoom get smaller circles so
  // they don't sit on top of each other.
  if (maxPx && size.px > maxPx) {
    const px = Math.max(maxPx, REGION_MIN_PX);
    size = { sizeClass: px >= 46 ? 'cluster-md' : 'cluster-sm', px };
  }
  return size;
}

// Region circle for the marker view: a ring with one slice per disease inside
// (diseased first, largest first; healthy last and muted), around a plain
// centre showing the tree count. It shows the mix of trees in the region
// rather than one dominant colour. Every disease present gets at least
// CLUSTER_MIN_SLICE of the ring, so a few sick trees in a mostly healthy
// region are still visible. "Healthy" means any class flagged is_healthy
// (trunk "Healthy", "Healthy Roots", ...), not one literal name.
const CLUSTER_MIN_SLICE = 0.12;

function diseaseDonut(trees, maxPx) {
  const count = trees.length;
  const groups = new Map();
  trees.forEach(t => {
    let g = groups.get(t.disease);
    if (!g) {
      // Only a plain hex colour is allowed into the inline style below.
      const raw = t.color || '';
      g = { n: 0, healthy: !!t.is_healthy, color: /^#[0-9a-fA-F]{3,8}$/.test(raw) ? raw : RG.tokens().textMuted };
      groups.set(t.disease, g);
    }
    g.n += 1;
  });

  const slices = Array.from(groups.values())
    .sort((a, b) => (a.healthy - b.healthy) || (b.n - a.n))
    .map(g => ({ ...g, w: g.healthy ? g.n / count : Math.max(g.n / count, CLUSTER_MIN_SLICE) }));
  const total = slices.reduce((sum, g) => sum + g.w, 0);
  const gap = slices.length > 1 ? 0.8 : 0;   // thin separator between slices, in % of the ring
  let at = 0;
  const stops = slices.map(g => {
    const from = at / total * 100;
    at += g.w;
    const to = at / total * 100;
    const end = Math.max(from, to - gap);
    const fill = g.healthy ? `color-mix(in srgb, ${g.color} 30%, var(--card-bg))` : g.color;
    return `${fill} ${from}% ${end}%, var(--card-bg) ${end}% ${to}%`;
  });

  const diseased = trees.filter(t => !t.is_healthy).length;
  const { sizeClass, px } = clusterSizing(count, true, maxPx);
  return {
    px,
    html: `<div class="cluster-bubble cluster-ring cluster-donut ${sizeClass}" style="background:conic-gradient(${stops.join(', ')});"><span>${count}</span></div>`,
    summary: `${count} tree${count === 1 ? '' : 's'}, ${diseased} diseased`,
  };
}

// Region circle for Interventions mode: the number is how many diseased
// trees are inside, and the ring around it is split into the share that
// already has an action logged (treated colour) and the share that still
// needs one (danger colour). A fully red ring means nothing has been done
// there yet; a fully teal ring means the region is all dealt with.
function interventionRing(trees, maxPx) {
  const count = trees.length;
  const todo = trees.filter(t => !t.has_intervention).length;
  const donePct = Math.round((count - todo) / count * 100);
  const ring = `conic-gradient(${interventionColor(true)} 0 ${donePct}%, ${interventionColor(false)} ${donePct}% 100%)`;
  const { sizeClass, px } = clusterSizing(count, false, maxPx);
  return {
    px,
    html: `<div class="cluster-bubble cluster-ring ${sizeClass}" style="background:${ring};"><span>${count}</span></div>`,
    summary: `${todo} need action, ${count - todo} done`,
  };
}

// The pin for one region: its circle, with the region's name underneath when
// the regions are far enough apart on screen for the names to fit. Packed
// closer than that, the name appears on hover/focus instead of on top of the
// circle below.
function regionPin(region, trees, view, layout) {
  const maxPx = layout && layout.maxPx;
  const { px, html, summary } = view === 'interventions' ? interventionRing(trees, maxPx) : diseaseDonut(trees, maxPx);
  const showTag = !layout || layout.showTag;
  const W = 92, H = showTag ? px + 24 : px;
  return {
    summary,
    icon: L.divIcon({
      html: `<div class="region-pin${showTag ? '' : ' tag-on-hover'}"><div class="region-bubble" style="width:${px}px;height:${px}px;">${html}</div><span class="region-tag">${esc(region.name)}</span></div>`,
      className: 'region-marker',
      iconSize: [W, H],
      iconAnchor: [W / 2, px / 2],
    }),
  };
}

// ------------------------------------------------------------
// Page
// ------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  const { markers: allMarkers, bounds, boundaryPolygon, farmId, farmName, farmOwner } = FARM_MAP_DATA;
  const $ = (id) => document.getElementById(id);
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const leafletBounds = [
    [bounds.min_lat, bounds.min_lng],
    [bounds.max_lat, bounds.max_lng],
  ];

  // Trees whose position falls outside the farm's frame have a GPS reading
  // that looked invalid (the locked-map message counts them as "not
  // counted"); they can't be drawn, so they are left out of the regions, the
  // dots and the heat numbers too.
  const markers = allMarkers.filter(t =>
    t.lat >= bounds.min_lat && t.lat <= bounds.max_lat && t.lng >= bounds.min_lng && t.lng <= bounds.max_lng
  );

  const map = L.map('map-container', {
    // On touch screens one finger scrolls the PAGE instead of dragging the
    // map (a tall map otherwise traps scrolling); two fingers pan/zoom the
    // map. Mouse users are unaffected.
    dragging: !L.Browser.mobile,
    maxBounds: leafletBounds,
    maxBoundsViscosity: 0.8,
    preferCanvas: true,
    // Quarter-step zoom so the first view can fit the farm snugly. With
    // whole zoom levels only, a farm could end up filling as little as half
    // of the map. (Zoom buttons and the mouse wheel still move one whole
    // level at a time.)
    zoomSnap: 0.25,
    // The street tiles stop at zoom 19 and the aerial ones at 18, but a region
    // is only a few dozen metres across: allow zooming past that (the tiles
    // are stretched, see maxNativeZoom below) so a region can fill the view.
    maxZoom: MAX_MAP_ZOOM,
  });

  // On wide screens the legend/heatmap panel floats over the right edge of
  // the map (CSS drops it below the map under 768px, where this is 0). Fit
  // the farm into the part of the map the panel does NOT cover, so the
  // default view never hides part of the farm under it.
  const PANEL_INSET_PX = 304;  // 280px panel + 12px margin + breathing room
  const panelInset = () => (window.matchMedia('(min-width: 768px)').matches ? PANEL_INSET_PX : 0);

  // Never open (or reset) tighter than this, so the first view of the farm
  // still shows the whole planted area with room around it.
  const MAX_FIT_ZOOM = 18.25;

  // On a phone the map buttons sit down the right edge, so keep the farm clear of them.
  const fitInset = () => panelInset() || 56;

  // The view reaches `inset` px past the farm's east edge. Widen the pan
  // limit by the same amount; otherwise maxBounds would pull the farm back to
  // the middle, under the panel. Needs the zoom the fit ended on.
  function widenMaxBounds() {
    const z = map.getZoom();
    const east = map.unproject(
      map.project([bounds.min_lat, bounds.max_lng], z).add([fitInset(), 0]), z
    ).lng;
    map.setMaxBounds([[bounds.min_lat, bounds.min_lng], [bounds.max_lat, east]]);
  }

  function fitFarm(animate) {
    const animated = !!animate && !reduceMotion;
    if (animated) map.once('moveend', widenMaxBounds);
    map.fitBounds(leafletBounds, {
      paddingBottomRight: [fitInset(), 0], maxZoom: MAX_FIT_ZOOM, animate: animated,
    });
    if (!animated) widenMaxBounds();
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

  // The heatmap sits under the farm boundary and the tree dots, and never
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
  // Drawn on the SAME canvas renderer as the tree dots: two separate
  // canvases stack, and only the top one receives mouse events, so with the
  // polygon on its own canvas underneath the dots' canvas its popup/hover
  // never fired. On one renderer Leaflet hit-tests both, and the dot
  // (drawn later) still wins where they overlap.
  // Which view is showing: 'markers', 'heatmap' or 'interventions'.
  let activeView = 'markers';
  // Heatmap background: 'streets' (muted OpenStreetMap) or 'satellite'.
  let heatBase = 'streets';

  // True while the basemap under the layers is a dark one: the dark-theme
  // streets in heatmap mode, or the satellite photo.
  function onDarkBasemap() {
    return activeView === 'heatmap' && (heatBase === 'satellite' || RG.theme() !== 'light');
  }

  // The boundary has to read against whichever basemap is under it, so its
  // colour is a token for light tiles or a token for dark tiles.
  let boundaryLayer = null;
  function boundaryStyle() {
    const t = RG.tokens();
    const c = onDarkBasemap() ? t.mapBoundaryOnDark : t.mapBoundary;
    return { color: c, weight: 2.5, dashArray: '8 6', fillColor: c, fillOpacity: 0.05 };
  }
  if (boundaryPolygon && boundaryPolygon.length >= 3) {
    boundaryLayer = L.polygon(boundaryPolygon, { renderer: FARM_MAP_CANVAS, ...boundaryStyle() })
      .bindPopup(`<b>${esc(farmId)}</b><br>${esc(farmName)}<br><i>${esc(farmOwner)}</i>`, { className: 'rg-popup' })
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
    attribution: '© OpenStreetMap contributors', maxZoom: MAX_MAP_ZOOM, maxNativeZoom: 19,
  });
  // Heatmap mode shows the same OpenStreetMap streets, muted by a CSS filter
  // (.rg-heat-tiles in style.css, a dark version in the dark theme) so the heat
  // colours stand out. It used CARTO tiles before; those now require an API
  // key and were showing an "API KEY REQUIRED" watermark across the map.
  // Same tile URLs as colorBasemap, so switching views reuses cached tiles.
  const heatBasemap = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors', maxZoom: MAX_MAP_ZOOM, maxNativeZoom: 19, className: 'rg-heat-tiles',
  });
  // Optional aerial photo behind the heatmap, like the field maps it is styled
  // after. Esri's imagery stops at zoom 18 in many rural areas, so zoom 19 is
  // stretched from 18 rather than showing "not available" tiles.
  const satelliteBasemap = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics', maxZoom: MAX_MAP_ZOOM, maxNativeZoom: 18,
  });
  // .map-heat paints the themed surface behind the tiles (while they load, or
  // if they can't be reached) and is what the heat view's dark/light look keys on.
  function syncBasemap() {
    const heat = activeView === 'heatmap';
    map.getContainer().classList.toggle('map-heat', heat);
    const want = !heat ? colorBasemap : (heatBase === 'satellite' ? satelliteBasemap : heatBasemap);
    [colorBasemap, heatBasemap, satelliteBasemap].forEach(layer => {
      if (layer !== want && map.hasLayer(layer)) map.removeLayer(layer);
    });
    if (!map.hasLayer(want)) want.addTo(map);
  }
  colorBasemap.addTo(map);

  // ------------------------------------------------------------
  // Elements
  // ------------------------------------------------------------
  const searchInput = $('map-search');
  const filterSelect = $('map-filter');
  const resetBtn = $('map-reset');
  const regionSelect = $('map-region-select');
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
  // live DiseaseClass catalog), minus "All Diseases" and every healthy
  // class -- a heatmap of healthy trees has no meaningful severity
  // gradient. Healthy names come from the markers (is_healthy) plus the
  // options' data-healthy flag, which also covers a healthy class that has
  // no trees on this farm yet.
  const healthyNames = new Set(markers.filter(t => t.is_healthy).map(t => t.disease));
  if (filterSelect) {
    Array.from(filterSelect.options).forEach(o => { if (o.dataset.healthy) healthyNames.add(o.value); });
  }
  const diseaseOptions = filterSelect
    ? Array.from(filterSelect.options).map(o => o.value).filter(v => v && !healthyNames.has(v))
    : [];

  // ------------------------------------------------------------
  // Map tools under the zoom buttons: fit the whole farm, and expand the map
  // to fill the screen. Expanded, one finger moves the map (on a phone the
  // normal map only moves with two, so the page can still scroll).
  // ------------------------------------------------------------
  const stage = document.querySelector('.map-stage');
  const MapTools = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const bar = L.DomUtil.create('div', 'leaflet-bar rg-map-tools');
      const button = (icon, label, onClick) => {
        const b = L.DomUtil.create('button', 'rg-map-btn', bar);
        b.type = 'button';
        b.title = label;
        b.setAttribute('aria-label', label);
        b.innerHTML = `<i class="bi ${icon}" aria-hidden="true"></i>`;
        L.DomEvent.disableClickPropagation(b);
        L.DomEvent.on(b, 'click', onClick);
        return b;
      };
      button('bi-bullseye', 'Fit the whole farm', () => showAllRegions());
      this._expand = button('bi-arrows-fullscreen', 'Expand the map', () => setExpanded(!stage.classList.contains('is-expanded')));
      return bar;
    },
  });
  // Wide screens: the buttons sit top-left because the legend floats top-right.
  // On a phone the legend is below the map, so they move to the top-right and
  // leave the farm's western edge uncovered.
  const toolsOnRight = panelInset() === 0;
  if (toolsOnRight) { map.zoomControl.setPosition('topright'); }
  const mapTools = new MapTools({ position: toolsOnRight ? 'topright' : 'topleft' }).addTo(map);

  function setExpanded(on) {
    stage.classList.toggle('is-expanded', on);
    document.body.classList.toggle('map-expanded', on);
    const btn = mapTools._expand;
    btn.querySelector('i').className = 'bi ' + (on ? 'bi-fullscreen-exit' : 'bi-arrows-fullscreen');
    const label = on ? 'Close the expanded map' : 'Expand the map';
    btn.title = label; btn.setAttribute('aria-label', label);
    if (L.Browser.mobile) { on ? map.dragging.enable() : map.dragging.disable(); }
    map.invalidateSize();
    if (on) btn.focus({ preventScroll: true });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && stage.classList.contains('is-expanded')) setExpanded(false);
  });

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

  // On a phone the legend sits under the map and is long, so it starts
  // collapsed (its header shows the disease colours); the heatmap and
  // interventions panels hold controls and stay open.
  if (panels.markers && window.matchMedia('(max-width: 767.98px)').matches) {
    panels.markers.classList.add('is-collapsed');
    const head = panels.markers.querySelector('.map-panel-head');
    if (head) head.setAttribute('aria-expanded', 'false');
  }

  const emptyBox = $('map-empty');
  function showEmpty(title, body) {
    $('map-empty-title').textContent = title;
    $('map-empty-body').textContent = body || '';
    emptyBox.hidden = false;
  }
  function hideEmpty() { emptyBox.hidden = true; }

  // ------------------------------------------------------------
  // Regions: pins, outlines, zooming in and out
  // ------------------------------------------------------------
  const regions = buildRegions(markers);
  const regionOfTree = new Map();
  regions.forEach(r => r.trees.forEach(t => regionOfTree.set(t, r)));

  let focusedRegion = null;   // the region zoomed into, or null for the whole farm
  let hoverRegion = null;

  const regionPins = L.layerGroup();      // the region circles
  const treeDots = L.featureGroup();      // individual trees (the focused region, or all of a small farm)
  const heatDots = L.featureGroup();      // one dot per tree in the heatmap view
  const outlines = L.layerGroup();        // every region's outline
  const outlineOf = new Map();
  regions.forEach(r => {
    const poly = L.polygon(r.hull, { renderer: FARM_MAP_CANVAS, interactive: false, ...outlineStyle(r) });
    outlineOf.set(r, poly);
    outlines.addLayer(poly);
  });

  // Where the popup may open without sliding under the legend panel, the map
  // buttons or the region card.
  const popupInsets = {
    get topLeft() { return L.point(toolsOnRight ? 16 : 64, 72); },
    get bottomRight() { return L.point(fitInset() + 8, 16); },
  };
  const onDotClick = e => {
    if (e.layer && e.layer.tree) openTreePopup(map, e.layer.tree, e.layer.getLatLng(), popupInsets);
  };
  treeDots.on('click', onDotClick);
  heatDots.on('click', onDotClick);

  function outlineStyle(region) {
    const t = RG.tokens();
    if (focusedRegion === region) {
      return { color: t.mapBoundary, weight: 3, opacity: 1, dashArray: null, fillColor: t.mapBoundary, fillOpacity: 0.07 };
    }
    if (hoverRegion === region) {
      return { color: t.mapBoundary, weight: 2.5, opacity: 0.95, dashArray: '6 5', fillColor: t.mapBoundary, fillOpacity: 0.1 };
    }
    return {
      color: t.mapRing, weight: 1.5, opacity: focusedRegion ? 0.28 : 0.55, dashArray: '5 6',
      fillColor: t.mapRing, fillOpacity: 0.03,
    };
  }
  function restyleOutlines() {
    outlineOf.forEach((poly, region) => poly.setStyle(outlineStyle(region)));
  }

  // Takes the tree layers (region circles, dots, outlines) off the map.
  function clearTreeLayers() {
    [regionPins, treeDots, outlines].forEach(g => { if (map.hasLayer(g)) map.removeLayer(g); });
    regionPins.clearLayers();
    treeDots.clearLayers();
  }

  // Healthy dots go in first so diseased ones are drawn on top of them.
  const healthyFirst = list => list.slice().sort((a, b) => (b.is_healthy === true) - (a.is_healthy === true));

  // Past the last real tile level a region's trees are spread far apart, so
  // the dots grow a little with the zoom to stay easy to see and to click.
  function scaleDots() {
    const k = Math.min(1.9, Math.max(1, 1 + (map.getZoom() - 19) * 0.6));
    treeDots.eachLayer(m => {
      if (m.baseRadius === undefined) m.baseRadius = m.options.radius;
      const r = m.baseRadius * k;
      if (m.options.radius !== r) m.setRadius(r);
    });
  }

  // How big the region circles can be, and whether their names fit beneath
  // them, at the current zoom: it depends on how close together the regions
  // are on screen. Zooming in gives them room, so the layout is re-checked
  // after every zoom (see the zoomend handler below).
  const REGION_TAG_ROOM = 30;   // the name tag: 24px tall plus a gap
  function regionLayout() {
    const pts = regions.map(r => map.latLngToContainerPoint(r.center));
    let nearest = Infinity;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) nearest = Math.min(nearest, pts[i].distanceTo(pts[j]));
    }
    if (!Number.isFinite(nearest)) nearest = 400;
    const maxPx = Math.max(REGION_MIN_PX, Math.floor(nearest - 8));
    return { maxPx, showTag: nearest >= 62 + REGION_TAG_ROOM };
  }
  let regionLayoutKey = '';
  let lastSubset = null;

  // Draws the Markers or Interventions view for `subset` (the trees that pass
  // the search and filters): one circle per region, or -- zoomed into a region,
  // or on a farm too small to need regions -- the individual trees.
  function renderTreeLayers(subset) {
    clearTreeLayers();
    const iv = activeView === 'interventions';
    const build = iv ? buildInterventionCircleMarker : buildTreeCircleMarker;
    const keep = new Set(subset);
    lastSubset = subset;

    if (!regions.length) {
      healthyFirst(subset).forEach(t => treeDots.addLayer(build(t)));
      treeDots.addTo(map);
      scaleDots();
      return;
    }

    restyleOutlines();
    outlines.addTo(map);

    if (focusedRegion) {
      healthyFirst(focusedRegion.trees.filter(t => keep.has(t))).forEach(t => treeDots.addLayer(build(t)));
      treeDots.addTo(map);
      scaleDots();
      return;
    }

    const layout = regionLayout();
    regionLayoutKey = `${layout.maxPx}|${layout.showTag}`;
    regions.forEach(region => {
      const inRegion = region.trees.filter(t => keep.has(t));
      if (!inRegion.length) return;
      const { icon, summary } = regionPin(region, inRegion, activeView, layout);
      const pin = L.marker(region.center, {
        icon, keyboard: true, riseOnHover: true,
        title: `${region.name}: ${summary}. Click to zoom in.`,
      });
      pin.on('click', () => focusRegion(region));
      pin.on('mouseover', () => { hoverRegion = region; restyleOutlines(); });
      pin.on('mouseout', () => { hoverRegion = null; restyleOutlines(); });
      regionPins.addLayer(pin);
    });
    regionPins.addTo(map);
  }

  // Zooming in or out changes how much room the region circles have, and how
  // big the dots look; redo both when it does (only when something changed).
  map.on('zoomend', () => {
    if (activeView === 'heatmap') return;
    if (focusedRegion || !regions.length) { scaleDots(); return; }
    if (!lastSubset) return;
    const layout = regionLayout();
    if (`${layout.maxPx}|${layout.showTag}` !== regionLayoutKey) renderTreeLayers(lastSubset);
  });

  // The card shown while zoomed into a region: its name, size, a tiny map of
  // where it sits on the farm, and the way back out.
  const regionBar = $('region-bar');
  function farmLocatorSvg(region) {
    const poly = boundaryPolygon && boundaryPolygon.length >= 3 ? boundaryPolygon : [
      [bounds.min_lat, bounds.min_lng], [bounds.min_lat, bounds.max_lng],
      [bounds.max_lat, bounds.max_lng], [bounds.max_lat, bounds.min_lng],
    ];
    const kx = Math.cos(poly[0][0] * Math.PI / 180);
    const xy = ([lat, lng]) => [lng * kx, -lat];
    const all = poly.map(xy);
    const minX = Math.min(...all.map(p => p[0])), maxX = Math.max(...all.map(p => p[0]));
    const minY = Math.min(...all.map(p => p[1])), maxY = Math.max(...all.map(p => p[1]));
    const size = 100, pad = 6;
    const scale = (size - pad * 2) / Math.max(maxX - minX, maxY - minY, 1e-9);
    const offX = (size - (maxX - minX) * scale) / 2, offY = (size - (maxY - minY) * scale) / 2;
    const pts = latlngs => latlngs.map(ll => {
      const [x, y] = xy(ll);
      return `${((x - minX) * scale + offX).toFixed(1)},${((y - minY) * scale + offY).toFixed(1)}`;
    }).join(' ');
    return `<svg viewBox="0 0 ${size} ${size}" aria-hidden="true" focusable="false"><polygon class="loc-farm" points="${pts(poly)}"/><polygon class="loc-region" points="${pts(region.hull)}"/></svg>`;
  }

  function syncRegionUi() {
    if (regionSelect) regionSelect.value = focusedRegion ? String(focusedRegion.id) : '';
    if (!regionBar) return;
    regionBar.hidden = !focusedRegion;
    if (!focusedRegion) return;
    const diseased = focusedRegion.trees.filter(t => !t.is_healthy).length;
    $('region-bar-name').textContent = focusedRegion.name;
    $('region-bar-meta').textContent = `${focusedRegion.trees.length} trees · ${diseased} diseased`;
    $('region-locator').innerHTML = farmLocatorSvg(focusedRegion);
  }

  // Zoom into one region: its trees appear where they really are on the farm,
  // inside the region's outline.
  function focusRegion(region, after) {
    focusedRegion = region;
    hoverRegion = null;
    map.closePopup();
    hideEmpty();
    syncRegionUi();
    if (activeView === 'markers') applyMarkerFilters({ zoomToMatch: false });
    else if (activeView === 'interventions') applyInterventionFilters({ zoomToMatch: false });

    map.flyToBounds(region.bounds, {
      paddingTopLeft: [toolsOnRight ? 16 : 64, 72],
      paddingBottomRight: [fitInset(), 28],
      maxZoom: MAX_MAP_ZOOM, duration: 0.8, animate: !reduceMotion,
    });
    if (after) {
      let done = false;
      const run = () => { if (done) return; done = true; after(); };
      map.once('moveend', run);
      setTimeout(run, reduceMotion ? 50 : 1100);   // moveend doesn't fire if the view didn't change
    }
  }

  // Back out to the whole farm: every region as a circle again.
  function showAllRegions() {
    map.closePopup();
    if (focusedRegion) {
      focusedRegion = null;
      hideEmpty();
      syncRegionUi();
      if (activeView === 'markers') applyMarkerFilters({ zoomToMatch: false });
      else if (activeView === 'interventions') applyInterventionFilters({ zoomToMatch: false });
      else restyleOutlines();
    }
    fitFarm(true);
  }

  if (regionSelect && regions.length) {
    regionSelect.hidden = false;
    regions.forEach(r => {
      const o = document.createElement('option');
      o.value = String(r.id);
      o.textContent = `${r.name} · ${r.trees.length} trees`;
      regionSelect.appendChild(o);
    });
    regionSelect.addEventListener('change', () => {
      if (regionSelect.value === '') showAllRegions();
      else focusRegion(regions[Number(regionSelect.value)]);
    });
  }
  const backBtn = $('region-back');
  if (backBtn) backBtn.addEventListener('click', showAllRegions);

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
  // show for a healthy tree. The status filter ('todo' / 'done' / '') is
  // applied on top, so the counts in the panel always describe the trees
  // before it, and the legend rows can show both numbers while one is picked.
  let ivStatus = '';
  function interventionBase() {
    return currentSubset().filter(t => !t.is_healthy);
  }
  function interventionSubset() {
    const base = interventionBase();
    if (ivStatus === 'todo') return base.filter(t => !t.has_intervention);
    if (ivStatus === 'done') return base.filter(t => t.has_intervention);
    return base;
  }

  const ivRows = Array.from(document.querySelectorAll('#panel-interventions .legend-row[data-status]'));
  function syncIvPressed() {
    ivRows.forEach(row => row.setAttribute('aria-pressed', row.dataset.status === ivStatus ? 'true' : 'false'));
  }
  // Same idea as the disease legend: tap a status to show only those trees,
  // tap it again to show all of them.
  ivRows.forEach(row => row.addEventListener('click', () => {
    ivStatus = ivStatus === row.dataset.status ? '' : row.dataset.status;
    applyInterventionFilters();
  }));

  function reportEmptySubset(subset) {
    if (!subset.length) {
      const q = (searchInput && searchInput.value ? searchInput.value : '').trim();
      showEmpty('No trees match', q ? `Nothing matches "${q}". Check the tree ID or clear the search.` : 'Try a different disease filter.');
      return;
    }
    // Zoomed into a region where nothing passes the filter, though other regions have matches.
    const inSubset = focusedRegion ? new Set(subset) : null;
    if (focusedRegion && !focusedRegion.trees.some(t => inSubset.has(t))) {
      showEmpty('Nothing here matches', `No trees in ${focusedRegion.name} match. Choose "All regions" to see where they are.`);
      return;
    }
    hideEmpty();
  }

  // If the search box narrows things down to exactly one tree, zoom straight
  // to it and open its snapshot -- the tree could be inside a region circle,
  // so this keeps search feeling instant.
  function zoomToSingleMatch(subset) {
    const q = (searchInput && searchInput.value ? searchInput.value : '').trim();
    if (!q || subset.length !== 1) return;
    const tree = subset[0];
    const region = regionOfTree.get(tree);
    const open = () => openTreePopup(map, tree, [tree.lat, tree.lng], popupInsets);
    if (region && focusedRegion !== region) { focusRegion(region, open); return; }
    if (region) { open(); return; }
    map.flyTo([tree.lat, tree.lng], 19, { animate: !reduceMotion });
    map.once('moveend', open);
  }

  function applyMarkerFilters(opts) {
    if (activeView !== 'markers') return;
    const subset = currentSubset();
    renderTreeLayers(subset);
    reportEmptySubset(subset);
    syncLegendPressed();
    if (!opts || opts.zoomToMatch !== false) zoomToSingleMatch(subset);
  }

  // Same shape as applyMarkerFilters(), but for Interventions mode: draws the
  // trees from interventionSubset() with the red/teal intervention-status
  // dots and region rings.
  function applyInterventionFilters(opts) {
    if (activeView !== 'interventions') return;
    const base = interventionBase();
    const subset = interventionSubset();
    renderTreeLayers(subset);
    fillInterventionSummary(base);
    syncIvPressed();
    if (!subset.length && base.length && ivStatus === 'todo') {
      showEmpty('All caught up', 'Every diseased tree shown has an action logged.');
    } else if (!subset.length && base.length && ivStatus === 'done') {
      showEmpty('No actions logged yet', 'None of the diseased trees shown have an action logged.');
    } else {
      reportEmptySubset(subset);
    }
    if (!opts || opts.zoomToMatch !== false) zoomToSingleMatch(subset);
  }

  // Progress numbers in the Interventions panel. Counts the diseased trees
  // that match the search and disease filter (before the status filter), so
  // the numbers stay put while a status is picked and a disease filter or
  // search narrows both the map and the panel.
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

  // Streets / Satellite switch for the heatmap background.
  const baseButtons = Array.from(document.querySelectorAll('#panel-heatmap [data-base]'));
  baseButtons.forEach(btn => btn.addEventListener('click', () => {
    heatBase = btn.dataset.base;
    baseButtons.forEach(b => {
      const on = b === btn;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    syncBasemap();
    restyleBoundary();
  }));

  // Bump size comes from how densely this farm is planted: about four tree
  // spacings, within a sensible range. The "Spread" slider scales it.
  const baseSpreadM = Math.min(Math.max(4 * medianNearestNeighborMeters(markers), 10), 40);
  const spreadInput = $('heat-spread');
  const spreadMeters = () => baseSpreadM * (spreadInput ? Number(spreadInput.value) : 1);

  let heatLayer = null;
  let heatPoints = [];
  let heatDisease = '';
  let locateRing = null;

  // One dot per tree; the ones with the mapped disease are bigger and added
  // last so they sit on top.
  function rebuildHeatDots() {
    if (map.hasLayer(heatDots)) map.removeLayer(heatDots);
    heatDots.clearLayers();
    if (activeView !== 'heatmap' || !heatDisease) return;
    const selectedLast = markers.slice().sort((a, b) => (a.disease === heatDisease) - (b.disease === heatDisease));
    selectedLast.forEach(t => heatDots.addLayer(buildHeatDot(t, t.disease === heatDisease)));
    heatDots.addTo(map);
  }

  function clearHeatLayer() {
    if (heatLayer && map.hasLayer(heatLayer)) map.removeLayer(heatLayer);
    heatLayer = null;
    if (map.hasLayer(heatDots)) map.removeLayer(heatDots);
    heatDots.clearLayers();
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
    heatDisease = disease;
    heatChips.forEach(c => c.setAttribute('aria-pressed', c.dataset.disease === disease ? 'true' : 'false'));

    heatPoints = markers
      .filter(t => t.disease === disease)
      .map(t => ({ id: t.tree_id, lat: t.lat, lng: t.lng, sev: Math.min(Math.max(Number(t.severity_score) || 0, 1), 100) }))
      .sort((a, b) => a.sev - b.sev);   // least to most severe: the worst case is last
    updateHeatSummary(heatPoints);

    // The dots show even when this disease has no trees, so the farm is still clickable.
    rebuildHeatDots();
    if (!heatPoints.length) {
      showEmpty(`No ${disease} trees on this farm`, 'Pick another disease to see its heat.');
    }
    heatLayer = new SeverityHeatLayer(heatPoints);
    heatLayer.setSpread(spreadMeters());
    if (boundaryPolygon && boundaryPolygon.length >= 3) heatLayer.setClip(boundaryPolygon);
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
      renderer: FARM_MAP_CANVAS, radius: 16, weight: 2.5, color: heatInk(), fill: false, interactive: false,
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
    map.closePopup();
    clearHeatLayer();
    hideEmpty();
    syncBasemap();
    restyleBoundary();
    if (allDiseasesOption) allDiseasesOption.hidden = false;
    if (searchInput) { searchInput.disabled = false; searchInput.placeholder = 'Search tree ID'; }
    showPanel('markers');
    applyMarkerFilters({ zoomToMatch: false });
  }

  function showHeatmap() {
    activeView = 'heatmap';
    map.closePopup();
    // Heatmap mode draws its own dots, never the region circles.
    clearTreeLayers();
    syncBasemap();
    restyleBoundary();
    if (allDiseasesOption) allDiseasesOption.hidden = true;
    if (searchInput) { searchInput.disabled = true; searchInput.placeholder = 'Search (markers only)'; }
    showPanel('heatmap');
    drawHeatForCurrentDisease();
  }

  function showInterventions() {
    activeView = 'interventions';
    map.closePopup();
    clearHeatLayer();
    hideEmpty();
    syncBasemap();
    restyleBoundary();
    if (allDiseasesOption) allDiseasesOption.hidden = false;
    if (searchInput) { searchInput.disabled = false; searchInput.placeholder = 'Search tree ID'; }
    showPanel('interventions');
    applyInterventionFilters({ zoomToMatch: false });
  }

  if (markersBtn) markersBtn.addEventListener('click', showMarkers);
  if (heatmapBtn) heatmapBtn.addEventListener('click', showHeatmap);
  if (interventionsBtn) interventionsBtn.addEventListener('click', showInterventions);

  if (filterSelect) filterSelect.addEventListener('change', () => {
    if (activeView === 'heatmap') drawHeatForCurrentDisease();
    else if (activeView === 'interventions') applyInterventionFilters();
    else applyMarkerFilters();
  });

  // Debounced so rebuilding the layers doesn't fire on every single
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
    ivStatus = '';
    focusedRegion = null;
    hoverRegion = null;
    syncRegionUi();
    if (activeView === 'heatmap') { drawHeatForCurrentDisease(); restyleOutlines(); }
    else if (activeView === 'interventions') applyInterventionFilters({ zoomToMatch: false });
    else applyMarkerFilters({ zoomToMatch: false });
    fitFarm(true);
  });

  // ------------------------------------------------------------
  // Theme switch: re-read every colour that comes from the CSS variables.
  // Region circles, dots and the heat layer are rebuilt (their colours were
  // fixed when they were drawn), and the boundary, outlines and ring are
  // restyled. The heatmap tiles follow the theme through CSS alone.
  // ------------------------------------------------------------
  function restyleBoundary() {
    if (boundaryLayer) boundaryLayer.setStyle(boundaryStyle());
  }

  RG.onThemeChange(() => {
    severityStopsCache = null;
    $('heat-ramp').style.background = severityGradientCss();
    if (activeView === 'heatmap') {
      if (heatLayer) heatLayer.refreshColors();
      rebuildHeatDots();
      if (locateRing) locateRing.setStyle({ color: heatInk() });
    } else if (activeView === 'interventions') {
      applyInterventionFilters({ zoomToMatch: false });
    } else {
      applyMarkerFilters({ zoomToMatch: false });
    }
    restyleBoundary();
    restyleOutlines();
  });

  // ------------------------------------------------------------
  // Initial view: "All Diseases" selected, every region as a circle.
  // ------------------------------------------------------------
  showPanel('markers');
  applyMarkerFilters({ zoomToMatch: false });
});
