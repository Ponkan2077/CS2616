/* Renders the disease distribution pie chart on the farm detail page.
   Expects FARM_DETAIL_DISEASE_STATS (array of {name, count, color,
   isHealthy}) defined inline before this script loads. */

function renderFarmPie(diseaseStats) {
  const canvas = document.getElementById("farmPie");
  if (!canvas) return;
  new Chart(canvas, {
    type: "doughnut",
    data: {
      labels: diseaseStats.map(d => d.name),
      datasets: [{
        data: diseaseStats.map(d => d.count),
        backgroundColor: diseaseStats.map(d => d.color),
        borderWidth: 2, borderColor: "#1a2535",
      }]
    },
    options: {
      responsive: true,
      cutout: "60%",
      plugins: { legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 11 } } } },
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  if (typeof FARM_DETAIL_DISEASE_STATS !== "undefined") {
    renderFarmPie(FARM_DETAIL_DISEASE_STATS);
  }
});
