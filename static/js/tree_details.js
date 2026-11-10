/* ============================================================
   tree_details.js — Renders the mini Leaflet map and the
   confidence-over-time line chart on a single tree's detail
   page. Expects a TREE_DETAIL_DATA object defined inline in
   tree_details.html before this script loads.

   Disease colours come from the data (tree.color, diseaseColors).
   Everything else (boundary, outlines, axis text, tooltip, the line
   and its wash) is read from the CSS variables through window.RG
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

// Detection confidence below this is flagged for a manual second look. It is
// the same cut-off the dashboard uses for its low-confidence count.
const LOW_CONFIDENCE = 70;

// Fills the key under the chart with the results this tree actually had.
function renderHistoryLegend(points, colorFor) {
  const host = document.getElementById('historyLegend');
  if (!host) return;
  host.textContent = '';
  const seen = new Set();
  points.forEach((h, i) => {
    if (seen.has(h.disease)) return;
    seen.add(h.disease);
    const item = document.createElement('span');
    item.className = 'rg-legend-item';
    const dot = document.createElement('span');
    dot.className = 'rg-dot';
    dot.setAttribute('aria-hidden', 'true');
    dot.style.setProperty('--c', h.is_healthy ? 'var(--text-muted)' : colorFor(h));
    item.appendChild(dot);
    item.appendChild(document.createTextNode(h.disease));
    host.appendChild(item);
  });
}

// Confidence of each scan over time. One series, so no legend box: the line and
// the soft wash under it are neutral, and each point takes its scan's disease
// colour (healthy results are plain neutral dots). A hairline marks the review
// threshold and the latest value is labelled. Everything except the disease
// colours is read from the CSS variables each time the chart is built.
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
  const colorFor = h => diseaseColors[h.disease] || tree.color;
  const pointColors = points.map(h => (h.is_healthy ? t.textMuted : colorFor(h)));
  renderHistoryLegend(points, colorFor);

  const tooltip = RG.chartTooltip();
  Object.assign(tooltip, {
    usePointStyle: true, boxWidth: 8, boxHeight: 8, boxPadding: 6,
    callbacks: {
      // The number leads, the result follows.
      label: c => `${points[c.dataIndex].confidence}%   ${points[c.dataIndex].disease}`,
      labelColor: c => ({ borderColor: pointColors[c.dataIndex], backgroundColor: pointColors[c.dataIndex], borderWidth: 0 }),
    },
  });

  const scale = RG.chartScale();
  const last = points.length - 1;

  // A soft neutral wash that fades out towards the axis.
  const wash = canvas.getContext('2d').createLinearGradient(0, 0, 0, canvas.clientHeight || 240);
  wash.addColorStop(0, RG.alpha(t.textMuted, 0.16));
  wash.addColorStop(1, RG.alpha(t.textMuted, 0));

  // A solid hairline at the review threshold, and the latest value above its point.
  const guides = {
    id: 'rgHistoryGuides',
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea: area, scales } = chart;
      const tk = RG.tokens();
      const y = scales.y.getPixelForValue(LOW_CONFIDENCE);
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(area.left, y);
      ctx.lineTo(area.right, y);
      ctx.lineWidth = 1;
      ctx.strokeStyle = RG.alpha(tk.textMuted, 0.55);
      ctx.stroke();
      ctx.fillStyle = tk.textMuted;
      ctx.font = `500 12px ${Chart.defaults.font.family}`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText(`Review below ${LOW_CONFIDENCE}%`, area.right, y + 5);
      ctx.restore();
    },
    afterDatasetsDraw(chart) {
      const el = chart.getDatasetMeta(0).data[last];
      if (!el) return;
      const { ctx, chartArea: area } = chart;
      const tk = RG.tokens();
      ctx.save();
      ctx.fillStyle = tk.textMain;
      ctx.font = `700 13px ${Chart.defaults.font.family}`;
      ctx.textAlign = el.x > area.right - 28 ? 'right' : 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`${confidences[last]}%`, ctx.textAlign === 'right' ? el.x + 4 : el.x, el.y - 12);
      ctx.restore();
    },
  };

  new Chart(canvas, {
    type: 'line',
    data: {
      labels: dates,
      datasets: [{
        data: confidences,
        borderColor: t.textMuted,
        borderWidth: 2,
        backgroundColor: wash,
        fill: true,
        tension: 0.25,
        pointBackgroundColor: pointColors,
        pointBorderColor: t.cardBg,
        pointBorderWidth: 2,
        pointRadius: 6,
        pointHoverRadius: 8,
        pointHitRadius: 20,
      }],
    },
    plugins: [RG.crosshair, guides],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: RG.lineAnimation(),
      layout: { padding: { top: 24, right: 12, left: 4, bottom: 4 } },
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip },
      scales: {
        y: {
          ...scale, min: 0, max: 100, border: { display: false },
          grid: { color: t.border, drawTicks: false },
          ticks: { ...scale.ticks, stepSize: 25, padding: 8, callback: v => `${v}%` },
        },
        x: {
          ...scale, grid: { display: false }, border: { color: t.border },
          ticks: { ...scale.ticks, maxRotation: 0, autoSkip: true, maxTicksLimit: 6 },
        },
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
