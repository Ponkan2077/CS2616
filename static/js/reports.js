/* Renders every chart on the reports page: severity doughnut, detection
   summary bar, disease-count bar, trend line, and the interactive
   disease-location map. Expects REPORTS_DATA defined inline before
   this script loads. */

const SEVERITY_COLORS = { healthy: "#28a745", mild: "#fbbf24", moderate: "#f97316", severe: "#dc2626" };
const DISEASE_COLORS = { healthy: "#28a745", pink: "#dc3545", white_root: "#8b5a2b", stem: "#8b0000" };

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
        borderWidth: 2, borderColor: "#fff",
      }]
    },
    options: { responsive: true, cutout: "65%", plugins: { legend: { display: false } } }
  });
}

function renderDetectionSummary(counts) {
  const canvas = document.getElementById("detectionSummary");
  if (!canvas) return;
  const diseased = counts.pink + counts.white_root + counts.stem;
  new Chart(canvas, {
    type: "bar",
    data: {
      labels: ["Healthy Trees", "Diseased Trees"],
      datasets: [{
        data: [counts.healthy, diseased],
        backgroundColor: [DISEASE_COLORS.healthy, "#dc3545"],
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

function renderDiseaseBar(counts) {
  const canvas = document.getElementById("reportBar");
  if (!canvas) return;
  new Chart(canvas, {
    type: "bar",
    data: {
      labels: ["Healthy", "Pink Disease", "White Root Rot", "Stem Bleeding"],
      datasets: [{
        data: [counts.healthy, counts.pink, counts.white_root, counts.stem],
        backgroundColor: [DISEASE_COLORS.healthy, DISEASE_COLORS.pink, DISEASE_COLORS.white_root, DISEASE_COLORS.stem],
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

function renderTrend(monthly) {
  const canvas = document.getElementById("reportTrend");
  if (!canvas || !monthly.length) return;
  new Chart(canvas, {
    type: "line",
    data: {
      labels: monthly.map(m => m.month),
      datasets: [
        { label: "Healthy",        data: monthly.map(m => m.healthy),    borderColor: DISEASE_COLORS.healthy,    backgroundColor: "rgba(40,167,69,.1)",  tension: .4, fill: true,  pointRadius: 4 },
        { label: "Pink Disease",   data: monthly.map(m => m.pink),       borderColor: DISEASE_COLORS.pink,       backgroundColor: "rgba(220,53,69,.08)", tension: .4, fill: false, pointRadius: 4 },
        { label: "White Root Rot", data: monthly.map(m => m.white_root), borderColor: DISEASE_COLORS.white_root, backgroundColor: "rgba(139,90,43,.08)", tension: .4, fill: false, pointRadius: 4 },
        { label: "Stem Bleeding",  data: monthly.map(m => m.stem),       borderColor: DISEASE_COLORS.stem,       backgroundColor: "rgba(139,0,0,.08)",   tension: .4, fill: false, pointRadius: 4 },
      ]
    },
    options: {
      responsive: true,
      plugins: { legend: { position: "bottom", labels: { font: { size: 11 }, boxWidth: 12 } } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 11 } } },
        y: { beginAtZero: true, ticks: { font: { size: 11 } } }
      }
    }
  });
}

function renderLocationMap(trees) {
  const container = document.getElementById("report-map");
  if (!container || typeof L === "undefined") return;

  const defaultLat = trees.length ? trees[0].lat : 6.9214;
  const defaultLng = trees.length ? trees[0].lng : 122.0790;
  const map = L.map("report-map").setView([defaultLat, defaultLng], 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap", maxZoom: 19,
  }).addTo(map);

  trees.forEach(tree => {
    L.circleMarker([tree.lat, tree.lng], {
      radius: 8, color: "#fff", weight: 1.5, fillColor: tree.color, fillOpacity: 0.9,
    }).bindPopup(`<b>${tree.tree_id}</b><br>${tree.disease}<br>Severity: ${tree.severity_label}`).addTo(map);
  });

  setTimeout(() => map.invalidateSize(), 150);
}

document.addEventListener("DOMContentLoaded", () => {
  renderSeverityPie(REPORTS_DATA.severity);
  renderDetectionSummary(REPORTS_DATA.counts);
  renderDiseaseBar(REPORTS_DATA.counts);
  renderTrend(REPORTS_DATA.monthly);
  renderLocationMap(REPORTS_DATA.trees);
});
