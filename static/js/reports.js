/* Renders every chart on the reports page: severity doughnut, detection
   summary bar, disease-count bar, trend line, and the interactive
   disease-location map. Expects REPORTS_DATA defined inline before
   this script loads. */

const SEVERITY_COLORS = { healthy: "#28a745", mild: "#fbbf24", moderate: "#f97316", severe: "#dc2626" };

function renderSeverityPie(severity) {
  const canvas = document.getElementById("severityPie");
  if (!canvas) return;
  new Chart(canvas, {
    type: "doughnut",
    data: {
      labels: ["Healthy", "Mild", "Moderate", "Severe"],
      datasets: [{
        data: [severity.healthy, severity.mild, severity.moderate, severity.severe],
        backgroundColor: [SEVERITY_COLORS.healthy, SEVERITY_COLORS.mild, SEVERITY_COLORS.moderate, SEVERITY_COLORS.severe],
        borderWidth: 2, borderColor: "#1a2535",
      }]
    },
    options: { responsive: true, cutout: "65%", plugins: { legend: { display: false } } }
  });
}

function renderDetectionSummary(total, diseased) {
  const canvas = document.getElementById("detectionSummary");
  if (!canvas) return;
  const healthy = total - diseased;
  new Chart(canvas, {
    type: "bar",
    data: {
      labels: ["Healthy Trees", "Diseased Trees"],
      datasets: [{
        data: [healthy, diseased],
        backgroundColor: ["#28a745", "#dc3545"],
        borderRadius: 6,
      }]
    },
    options: {
      responsive: true, indexAxis: "y",
      plugins: { legend: { display: false } },
      scales: { x: { beginAtZero: true, ticks: { font: { size: 11 } } }, y: { ticks: { font: { size: 12 } } } }
    }
  });
}

function renderDiseaseBar(diseaseStats) {
  const canvas = document.getElementById("reportBar");
  if (!canvas) return;
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
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 11 } } },
        y: { beginAtZero: true, ticks: { font: { size: 11 }, stepSize: 1 } }
      }
    }
  });
}

function renderTrend(monthly, diseaseStats) {
  const canvas = document.getElementById("reportTrend");
  if (!canvas || !monthly.length) return;

  // If a Chart.js instance is already attached to this canvas (e.g. from
  // a stale render), destroy it first — Chart.js can otherwise silently
  // produce a broken/empty-looking chart instead of a visible error.
  const existing = Chart.getChart(canvas);
  if (existing) existing.destroy();

  const datasets = diseaseStats.map(d => ({
    label: d.name,
    data: monthly.map(m => Number(m.diseases[d.name]) || 0),
    borderColor: d.color,
    backgroundColor: d.color + "1a", // ~10% alpha, hex-with-alpha
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
      plugins: { legend: { position: "bottom", labels: { font: { size: 11 }, boxWidth: 12 } } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 11 } } },
        y: { beginAtZero: true, min: 0, max: yMax, ticks: { font: { size: 11 } } }
      }
    }
  });
}

// Computes a Healthy/Mild/Moderate/Severe label client-side from disease
// and confidence, mirroring the server's severity tier logic, since the
// lightweight marker payload used here doesn't include severity_label.
function computeSeverityLabel(disease, confidence) {
  const severityBase = { "Healthy": 0, "Pink Disease": 1, "White Root Rot": 2, "Stem Bleeding": 3 };
  const base = severityBase[disease] || 0;
  if (base === 0) return "Healthy";
  const score = (base / 3) * confidence;
  if (score < 34) return "Mild";
  if (score < 67) return "Moderate";
  return "Severe";
}

document.addEventListener("DOMContentLoaded", () => {
  renderSeverityPie(REPORTS_DATA.severity);
  renderDetectionSummary(REPORTS_DATA.total, REPORTS_DATA.diseased);
  renderDiseaseBar(REPORTS_DATA.diseaseStats);
  renderTrend(REPORTS_DATA.monthly, REPORTS_DATA.diseaseStats);
});
