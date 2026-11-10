/* Renders the disease distribution on the farm detail page: the headline, the
   one-bar split of the whole farm and the ranked disease rows (see
   rg_charts.js). Expects FARM_DETAIL_DISEASE_STATS (array of {name, count,
   color, isHealthy}) defined inline before this script loads. Disease colours
   come from the data; healthy classes are neutral. It is plain HTML, so it
   follows the light/dark theme with no rebuild. */

document.addEventListener("DOMContentLoaded", () => {
  if (typeof FARM_DETAIL_DISEASE_STATS === "undefined") return;
  const host = document.getElementById("farmMix");
  if (host) RG.diseaseMix(host, FARM_DETAIL_DISEASE_STATS);
});
