/* Renders the charts on the reports page: the severity split, the disease
   distribution (headline, bar and ranked disease rows) and the monthly trend
   line. Expects REPORTS_DATA defined inline before this script loads.

   Disease colours come from the data (DiseaseClass.color_hex via
   REPORTS_DATA); healthy classes are always neutral. The severity split, the
   distribution and the healthy-scans strip are HTML (see rg_charts.js) and
   follow the theme on their own. Only the trend line is a Chart.js canvas, and
   it is rebuilt on "themechange". */

// Series switched off in the trend legend. Kept here so a theme switch (which
// rebuilds the canvas) does not turn them back on.
const hiddenSeries = new Set();

// Destroys a chart left on this canvas (a stale render, or the previous theme)
// and returns the canvas, or null when the page doesn't have it.
function freshCanvas(id) {
  const canvas = document.getElementById(id);
  if (!canvas || typeof Chart === "undefined") return null;
  const existing = Chart.getChart(canvas);
  if (existing) existing.destroy();
  return canvas;
}

function renderSeverity(severity) {
  const host = document.getElementById("severityMix");
  if (!host) return;
  RG.splitList(host, [
    { name: "Healthy", count: severity.healthy, neutral: true },
    { name: "Mild", count: severity.mild, color: "var(--sev-mild)" },
    { name: "Moderate", count: severity.moderate, color: "var(--sev-moderate)" },
    { name: "Severe", count: severity.severe, color: "var(--sev-severe)" },
  ]);
}

function renderDiseaseMix(diseaseStats) {
  const host = document.getElementById("diseaseMix");
  if (host) RG.diseaseMix(host, diseaseStats);
}

// Diseased classes with at least one detection in the window. Healthy scans
// are far more numerous and would flatten every other line, so they get their
// own strip under the chart instead of sharing the axis.
function trendSeries(monthly, diseaseStats) {
  return diseaseStats
    .filter(d => !d.isHealthy)
    .map(d => ({ name: d.name, color: d.color, data: monthly.map(m => Number(m.diseases[d.name]) || 0) }))
    .filter(s => s.data.some(v => v > 0));
}

function renderTrendLegend(series) {
  const host = document.getElementById("trendLegend");
  if (!host) return;
  RG.legendChips(
    host,
    series.map(s => ({ name: s.name, color: s.color, total: s.data.reduce((a, b) => a + b, 0) })),
    hiddenSeries,
    (i, visible) => {
      if (visible) hiddenSeries.delete(series[i].name); else hiddenSeries.add(series[i].name);
      const canvas = document.getElementById("reportTrend");
      const chart = canvas && Chart.getChart(canvas);
      if (!chart) return;
      chart.setDatasetVisibility(i, visible);
      chart.update();
    }
  );
}

function renderTrend(monthly, series) {
  if (!monthly.length || !series.length) return;
  // freshCanvas() destroys a Chart.js instance already attached to this canvas
  // (a stale render); Chart.js can otherwise produce an empty-looking chart.
  const canvas = freshCanvas("reportTrend");
  if (!canvas) return;
  const t = RG.tokens();
  const scale = RG.chartScale();

  const datasets = series.map(s => ({
    label: s.name,
    data: s.data,
    borderColor: s.color,
    backgroundColor: s.color,
    borderWidth: 2,
    tension: 0.3,
    pointRadius: 0,
    pointHoverRadius: 5,
    pointHitRadius: 14,
    pointHoverBackgroundColor: s.color,
    pointHoverBorderColor: t.cardBg,
    pointHoverBorderWidth: 2,
    hidden: hiddenSeries.has(s.name),
  }));

  const tooltip = RG.chartTooltip();
  Object.assign(tooltip, {
    mode: "index", intersect: false, boxWidth: 14, boxHeight: 3, boxPadding: 6,
    itemSort: (a, b) => b.parsed.y - a.parsed.y,
    filter: item => item.parsed.y > 0,
    callbacks: {
      // The number leads, the disease name follows.
      label: c => `${RG.fmt(c.parsed.y)}   ${c.dataset.label}`,
      labelColor: c => ({ borderColor: c.dataset.borderColor, backgroundColor: c.dataset.borderColor, borderWidth: 0, borderRadius: 1 }),
    },
  });

  new Chart(canvas, {
    type: "line",
    data: { labels: monthly.map(m => m.month), datasets },
    plugins: [RG.crosshair],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: RG.lineAnimation(),
      layout: { padding: { top: 8, right: 8 } },
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: false }, tooltip },
      scales: {
        x: {
          ...scale, grid: { display: false }, border: { color: t.border },
          ticks: { ...scale.ticks, maxRotation: 0, autoSkip: true, maxTicksLimit: 7 },
        },
        y: {
          ...scale, beginAtZero: true, border: { display: false },
          grid: { color: t.border, drawTicks: false },
          ticks: { ...scale.ticks, precision: 0, maxTicksLimit: 5, padding: 8 },
        },
      },
    },
  });
}

function renderHealthyStrip(monthly, diseaseStats) {
  const host = document.getElementById("healthySpark");
  if (!host || !monthly.length) return;
  const names = diseaseStats.filter(d => d.isHealthy).map(d => d.name);
  const values = monthly.map(m => names.reduce((sum, n) => sum + (Number(m.diseases[n]) || 0), 0));
  RG.spark(host, monthly.map(m => m.month), values);
  const latest = document.getElementById("healthySparkLatest");
  if (latest) latest.textContent = `Latest: ${RG.fmt(values[values.length - 1])} (${monthly[monthly.length - 1].month})`;
}

document.addEventListener("DOMContentLoaded", () => {
  const d = REPORTS_DATA;
  const series = trendSeries(d.monthly, d.diseaseStats);

  renderSeverity(d.severity);
  renderDiseaseMix(d.diseaseStats);
  renderTrendLegend(series);
  renderHealthyStrip(d.monthly, d.diseaseStats);
  renderTrend(d.monthly, series);

  // Only the canvas needs rebuilding; everything else follows the CSS variables.
  RG.onThemeChange(() => renderTrend(d.monthly, series));
});
