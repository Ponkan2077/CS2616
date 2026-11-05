/* Renders the disease distribution pie chart on the farm detail page.
   Expects FARM_DETAIL_DISEASE_STATS (array of {name, count, color,
   isHealthy}) defined inline before this script loads. Segment colours are
   the disease colours from the data; everything else (segment gap, legend
   text, tooltip) is read from the CSS variables and rebuilt on "themechange". */

function renderFarmPie(diseaseStats) {
  const canvas = document.getElementById("farmPie");
  if (!canvas || typeof Chart === "undefined") return;
  const existing = Chart.getChart(canvas);
  if (existing) existing.destroy();
  const t = RG.tokens();
  new Chart(canvas, {
    type: "doughnut",
    data: {
      labels: diseaseStats.map(d => d.name),
      datasets: [{
        data: diseaseStats.map(d => d.count),
        backgroundColor: diseaseStats.map(d => d.color),
        borderWidth: 2, borderColor: t.cardBg,
      }]
    },
    options: {
      responsive: true,
      cutout: "60%",
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 12, color: t.textMain, font: { size: 12 } } },
        tooltip: RG.chartTooltip(),
      },
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  if (typeof FARM_DETAIL_DISEASE_STATS === "undefined") return;
  renderFarmPie(FARM_DETAIL_DISEASE_STATS);
  RG.onThemeChange(() => renderFarmPie(FARM_DETAIL_DISEASE_STATS));
});
