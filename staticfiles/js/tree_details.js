/* ============================================================
   tree_details.js — Renders the mini Leaflet map and the
   confidence-over-time line chart on a single tree's detail
   page. Expects a TREE_DETAIL_DATA object defined inline in
   tree_details.html before this script loads.

   Disease colours come from the data (tree.color, diseaseColors).
   Everything else (boundary, outlines, axis text, tooltip, the line
   itself) is read from the CSS variables through window.RG
   (theme.js), and both the map and the chart are rebuilt or
   restyled on "themechange". The basemap is the same OpenStreetMap
   tile layer as before (this page never used a dark basemap).
   ============================================================ */

// Escapes text that goes into popup HTML.
function tdEscape(text) {
  const el = document.createElement('div');
  el.textContent = text == null ? '' : String(text);
  return el.innerHTML;
}

let tdMap = null;
let tdBoundary = null;
let tdMarker = null;

function tdBoundaryStyle() {
  const b = RG.tokens().mapBoundary;
  return { color: b, weight: 2, fillColor: b, fillOpacity: 0.05 };
}

// The tree's own dot: its disease colour if diseased, a neutral tone if healthy.
function tdMarkerStyle(tree) {
  const t = RG.tokens();
  return {
    radius: 9, weight: 2, opacity: 1,
    color: t.mapRing,
    fillColor: tree.isHealthy ? t.textMuted : tree.color,
    fillOpacity: 0.92,
  };
}

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
    // A tree with a bad GPS fix can sit outside its farm's own boundary
    // (the boundary ignores such outliers). Locking the map to bounds that
    // exclude the very tree being shown would push it out of view, so only
    // apply the lock when the tree is inside it.
    const inside = tree.lat >= farmBounds[0][0] && tree.lat <= farmBounds[1][0]
      && tree.lng >= farmBounds[0][1] && tree.lng <= farmBounds[1][1];
    if (!inside) farmBounds = null;
  }

  tdMap = L.map('mini-map', {
    zoomControl: true, scrollWheelZoom: false,
    ...(farmBounds ? { maxBounds: farmBounds, maxBoundsViscosity: 0.8 } : {}),
  }).setView([tree.lat, tree.lng], 17);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap',
  }).addTo(tdMap);

  L.control.scale({ metric: true, imperial: false, position: 'bottomleft' }).addTo(tdMap);

  // getBoundsZoom needs the container's real pixel size to compute
  // correctly, which isn't reliably available the instant the map is
  // created inside a grid layout — invalidateSize() first, then compute
  // the min zoom, falling back to a sane default if it comes back invalid.
  if (farmBounds) {
    setTimeout(() => {
      tdMap.invalidateSize();
      const boundsZoom = tdMap.getBoundsZoom(farmBounds);
      const minZoom = Number.isFinite(boundsZoom) ? Math.max(boundsZoom - 1, 1) : 12;
      tdMap.setMinZoom(minZoom);
    }, 150);
  } else {
    setTimeout(() => tdMap.invalidateSize(), 150);
  }

  if (hasBoundary) {
    tdBoundary = L.polygon(farmBoundary, tdBoundaryStyle())
      .bindTooltip(tree.farm_name || tree.farm_id, { permanent: false, direction: 'center', className: 'farm-boundary-label' })
      .addTo(tdMap);
  }

  tdMarker = L.circleMarker([tree.lat, tree.lng], tdMarkerStyle(tree))
    .bindPopup(
      `<b>${tdEscape(tree.tree_id)}</b><br>${tdEscape(tree.disease)}<br>` +
      `<span class="tp-sub">Managed by ${tdEscape(tree.farm_owner)}</span>`,
      { className: 'rg-popup' }
    )
    .addTo(tdMap)
    .openPopup();
}

// Renders a smooth line chart of confidence scores across scan history.
// Each point takes its scan's disease colour (so individual results stay
// easy to identify at a glance), except healthy results, which are plain
// neutral dots. The line and the soft fill under it use the primary teal
// rather than any one disease's colour, since a single scan history can span
// several diseases. Colours other than the disease colours are read from the
// CSS variables each time the chart is built.
function renderHistoryChart(tree, history, diseaseColors) {
  if (!history.length) return;
  const canvas = document.getElementById('historyChart');
  if (!canvas || typeof Chart === 'undefined') return;
  const existing = Chart.getChart(canvas);
  if (existing) existing.destroy();

  const t = RG.tokens();
  const points = [...history].reverse();
  const dates = points.map(h => new Date(h.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }));
  const confidences = points.map(h => h.confidence);
  // diseaseColors comes from the DiseaseClass catalog on the server.
  const pointColors = points.map(h => (h.is_healthy ? t.textMuted : (diseaseColors[h.disease] || tree.color)));

  const ctx = canvas.getContext('2d');
  const fillGradient = ctx.createLinearGradient(0, 0, 0, canvas.height || 220);
  fillGradient.addColorStop(0, RG.alpha(t.primary, 0.28));
  fillGradient.addColorStop(1, RG.alpha(t.primary, 0));

  const tooltip = RG.chartTooltip();
  tooltip.displayColors = false;
  tooltip.callbacks = {
    label: c => {
      const h = points[c.dataIndex];
      return `${h.disease}: ${h.confidence}%`;
    },
  };

  const scale = RG.chartScale();

  new Chart(canvas, {
    type: 'line',
    data: {
      labels: dates,
      datasets: [
        {
          label: 'Confidence %',
          data: confidences,
          borderColor: t.primary,
          borderWidth: 2.5,
          backgroundColor: fillGradient,
          fill: true,
          tension: 0.35,
          pointBackgroundColor: pointColors,
          pointBorderColor: t.cardBg,
          pointBorderWidth: 2,
          pointRadius: 6,
          pointHoverRadius: 8,
          pointHoverBorderWidth: 2,
          // Extra room so a point at 100% isn't clipped by the top edge.
          clip: { top: 12, left: 10, right: 10, bottom: 0 },
        },
      ],
    },
    options: {
      responsive: true,
      layout: {
        padding: { top: 14, bottom: 4, left: 4, right: 10 },
      },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip,
      },
      scales: {
        y: { min: 0, max: 100, ...scale },
        x: { ...scale, grid: { display: false } },
      },
    },
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const { tree, history, diseaseColors } = TREE_DETAIL_DATA;
  renderMiniMap(tree, TREE_DETAIL_DATA.farmBoundary);
  renderHistoryChart(tree, history, diseaseColors);

  RG.onThemeChange(() => {
    if (tdBoundary) tdBoundary.setStyle(tdBoundaryStyle());
    if (tdMarker) tdMarker.setStyle(tdMarkerStyle(tree));
    renderHistoryChart(tree, history, diseaseColors);
  });
});
