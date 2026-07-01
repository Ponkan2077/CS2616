// Renders the doughnut chart showing disease distribution.
function renderReportPie(counts) {
  new Chart(document.getElementById('reportPie'), {
    type: 'doughnut',
    data: {
      labels: ['Healthy', 'Pink Disease', 'White Root Rot', 'Stem Bleeding'],
      datasets: [{
        data: [counts.healthy, counts.pink, counts.white_root, counts.stem],
        backgroundColor: ['#28a745', '#dc3545', '#8b5a2b', '#8b0000'],
        borderWidth: 2,
        borderColor: '#fff',
      }]
    },
    options: { responsive: true, cutout: '60%', plugins: { legend: { display: false } } }
  });
}

// Renders the bar chart comparing raw disease counts.
function renderReportBar(counts) {
  new Chart(document.getElementById('reportBar'), {
    type: 'bar',
    data: {
      labels: ['Healthy', 'Pink Disease', 'White Root Rot', 'Stem Bleeding'],
      datasets: [{
        data: [counts.healthy, counts.pink, counts.white_root, counts.stem],
        backgroundColor: ['#28a745', '#dc3545', '#8b5a2b', '#8b0000'],
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

// Renders the line chart showing monthly detection trends.
function renderReportTrend(monthly) {
  new Chart(document.getElementById('reportTrend'), {
    type: 'line',
    data: {
      labels: monthly.map(m => m.month),
      datasets: [
        { label: 'Healthy',        data: monthly.map(m => m.healthy),    borderColor: '#28a745', backgroundColor: 'rgba(40,167,69,.1)',  tension: .4, fill: true,  pointRadius: 4 },
        { label: 'Pink Disease',   data: monthly.map(m => m.pink),       borderColor: '#dc3545', backgroundColor: 'rgba(220,53,69,.08)', tension: .4, fill: false, pointRadius: 4 },
        { label: 'White Root Rot', data: monthly.map(m => m.white_root), borderColor: '#8b5a2b', backgroundColor: 'rgba(139,90,43,.08)', tension: .4, fill: false, pointRadius: 4 },
        { label: 'Stem Bleeding',  data: monthly.map(m => m.stem),       borderColor: '#8b0000', backgroundColor: 'rgba(139,0,0,.08)',  tension: .4, fill: false, pointRadius: 4 },
      ]
    },
    options: {
      responsive: true,
      plugins: { legend: { position: 'bottom', labels: { font: { size: 11 }, boxWidth: 12 } } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 11 } } },
        y: { beginAtZero: true, ticks: { font: { size: 11 } } }
      }
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  renderReportPie(REPORTS_DATA.counts);
  renderReportBar(REPORTS_DATA.counts);
  renderReportTrend(REPORTS_DATA.monthly);
});
