/* Renders the disease distribution pie chart on the farm detail page.
   Expects FARM_DETAIL_COUNTS (healthy, pink, white_root, stem) defined
   inline before this script loads. */

const DISEASE_COLORS = { healthy: "#28a745", pink: "#dc3545", white_root: "#8b5a2b", stem: "#8b0000" };

function renderFarmPie(counts) {
  const canvas = document.getElementById("farmPie");
  if (!canvas) return;
  new Chart(canvas, {
    type: "doughnut",
    data: {
      labels: ["Healthy", "Pink Disease", "White Root Rot", "Stem Bleeding"],
      datasets: [{
        data: [counts.healthy, counts.pink, counts.white_root, counts.stem],
        backgroundColor: [DISEASE_COLORS.healthy, DISEASE_COLORS.pink, DISEASE_COLORS.white_root, DISEASE_COLORS.stem],
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
  if (typeof FARM_DETAIL_COUNTS !== "undefined") {
    renderFarmPie(FARM_DETAIL_COUNTS);
  }
});
