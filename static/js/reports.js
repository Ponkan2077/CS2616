/* Renders every chart on the reports page: severity doughnut, detection
   summary bar, disease-count bar and the trend line. Expects REPORTS_DATA
   defined inline before this script loads.

   Disease colours (and the Healthy colour) come from the data
   (DiseaseClass.color_hex via REPORTS_DATA). The severity tiers, axis and
   legend text, tooltip and segment borders are read from the CSS variables
   through window.RG (theme.js), and every chart is destroyed and rebuilt on
   "themechange". */

// Destroys a chart left on this canvas (a stale render, or the previous theme)
// and returns the canvas, or null when the page doesn't have it.
function freshCanvas(id) {
  const canvas = document.getElementById(id);
  if (!canvas || typeof Chart === "undefined") return null;
  const existing = Chart.getChart(canvas);
  if (existing) existing.destroy();
  return canvas;
}

function renderSeverityPie(severity, healthyColor) {
  const canvas = freshCanvas("severityPie");
  if (!canvas) return;
  const t = RG.tokens();
  new Chart(canvas, {
    type: "doughnut",
    data: {
      labels: ["Healthy", "Mild", "Moderate", "Severe"],
      datasets: [{
        data: [severity.healthy, severity.mild, severity.moderate, severity.severe],
        backgroundColor: [healthyColor, t.sevMild, t.sevModerate, t.sevSevere],
        borderWidth: 2, borderColor: t.cardBg,
      }]
    },
    options: { responsive: true, cutout: "65%", plugins: { legend: { display: false }, tooltip: RG.chartTooltip() } }
  });
}

function renderDetectionSummary(total, diseased, healthyColor) {
  const canvas = freshCanvas("detectionSummary");
  if (!canvas) return;
  const t = RG.tokens();
  const scale = RG.chartScale();
  const healthy = total - diseased;
  new Chart(canvas, {
    type: "bar",
    data: {
      labels: ["Healthy Trees", "Diseased Trees"],
      datasets: [{
        data: [healthy, diseased],
        backgroundColor: [healthyColor, t.danger],
        borderRadius: 6,
      }]
    },
    options: {
      responsive: true, indexAxis: "y",
      plugins: { legend: { display: false }, tooltip: RG.chartTooltip() },
      scales: { x: { beginAtZero: true, ...scale }, y: { ...scale, grid: { display: false } } }
    }
  });
}

function renderDiseaseBar(diseaseStats) {
  const canvas = freshCanvas("reportBar");
  if (!canvas) return;
  const scale = RG.chartScale();
  new Chart(canvas, {
    type: "bar",
    data: {
      labels: diseaseStats.map(d => d.name),
      datasets: [{
        data: diseaseStats.map(d => d.count),
        backgroundColor: diseaseStats.map(d => d.color),
        borderRadius: 6,
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false }, tooltip: RG.chartTooltip() },
      scales: {
        x: { ...scale, grid: { display: false } },
        y: { ...scale, beginAtZero: true, ticks: { ...scale.ticks, stepSize: 1 } }
      }
    }
  });
}

function renderTrend(monthly, diseaseStats) {
  if (!monthly.length) return;
  // freshCanvas() destroys a Chart.js instance already attached to this canvas
  // (a stale render) — Chart.js can otherwise silently produce a broken or
  // empty-looking chart instead of a visible error.
  const canvas = freshCanvas("reportTrend");
  if (!canvas) return;
  const t = RG.tokens();
  const scale = RG.chartScale();

  const datasets = diseaseStats.map(d => ({
    label: d.name,
    data: monthly.map(m => Number(m.diseases[d.name]) || 0),
    borderColor: d.color,
    backgroundColor: RG.alpha(d.color, 0.1),
    tension: .4,
    fill: d.isHealthy,
    pointRadius: 4,
  }));

  // Explicitly compute the y-axis max from the real data instead of
  // relying solely on Chart.js's automatic scale detection, which can
  // fail to pick up a sensible range in some edge cases.
  const allValues = datasets.flatMap(ds => ds.data);
  const dataMax = Math.max(1, ...allValues);
  const yMax = Math.ceil(dataMax * 1.15 / 10) * 10;

  new Chart(canvas, {
    type: "line",
    data: {
      labels: monthly.map(m => m.month),
      datasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom", labels: { color: t.textMain, font: { size: 12 }, boxWidth: 12 } },
        tooltip: RG.chartTooltip(),
      },
      scales: {
        x: { ...scale, grid: { display: false } },
        y: { ...scale, beginAtZero: true, min: 0, max: yMax }
      }
    }
  });
}

function renderAllReportCharts() {
  const d = REPORTS_DATA;
  renderSeverityPie(d.severity, d.healthyColor);
  renderDetectionSummary(d.total, d.diseased, d.healthyColor);
  renderDiseaseBar(d.diseaseStats);
  renderTrend(d.monthly, d.diseaseStats);
}

document.addEventListener("DOMContentLoaded", () => {
  renderAllReportCharts();
  RG.onThemeChange(renderAllReportCharts);
});
