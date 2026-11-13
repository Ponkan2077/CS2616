/* Renders the interventions map: only trees that have at least one
   logged intervention, with the latest action shown in each popup.
   Expects INTERVENTION_TREES defined inline before this loads. Colours come
   from the CSS variables (see rgPinIcon in main.js). */

document.addEventListener("DOMContentLoaded", () => {
  const container = document.getElementById("intervention-map");
  if (!container || typeof L === "undefined") return;

  const trees = INTERVENTION_TREES || [];

  // Farm names, diseases and intervention types are user/admin-entered text;
  // escape them before they go into popup HTML.
  const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
  const defaultLat = trees.length ? trees[0].lat : 6.9214;
  const defaultLng = trees.length ? trees[0].lng : 122.0790;

  const map = L.map("intervention-map").setView([defaultLat, defaultLng], 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap", maxZoom: 19,
  }).addTo(map);

  // Every pin on this map is a tree that has been treated, so they all use the
  // primary teal (the same "action taken" colour as the farm map's
  // Interventions view). It is read from the CSS variable each time a pin is
  // built, so the pins follow the theme (rgAttachPinScaling rebuilds them on
  // "themechange").
  const treatedTree = { get color() { return RG.tokens().primary; } };

  // Treated trees sit only metres apart, so at farm zoom the pins would pile
  // on top of each other. Group them into numbered bubbles (the same bubble
  // style as the farm map) that split apart as the map is zoomed in. If the
  // cluster plugin didn't load, fall back to plain pins on the map.
  const clustered = typeof L.markerClusterGroup === "function";
  const group = clustered ? L.markerClusterGroup({
    showCoverageOnHover: false,
    maxClusterRadius: 45,
    iconCreateFunction: cluster => {
      const count = cluster.getChildCount();
      const [sizeClass, px] = count >= 250 ? ["cluster-lg", 58] : count >= 40 ? ["cluster-md", 46] : ["cluster-sm", 36];
      return L.divIcon({
        html: `<div class="cluster-bubble ${sizeClass}" style="background:${RG.tokens().primary};">${count}</div>`,
        className: "marker-cluster-custom",
        iconSize: L.point(px, px),
      });
    },
  }) : null;
  if (group) {
    group.addTo(map);
    // Bubbles use the theme colour, so redraw them after a theme switch.
    RG.onThemeChange(() => group.refreshClusters());
  }

  const markerList = [];
  trees.forEach(tree => {
    const more = tree.intervention_count > 1
      ? `<div class="tp-sub">${esc(tree.intervention_count)} total actions logged</div>` : "";
    const marker = L.marker([tree.lat, tree.lng], {
      icon: rgPinIcon(treatedTree.color, 22),
      title: `Tree ${tree.tree_id}`,
      alt: `Tree ${tree.tree_id}, ${tree.disease}`,
    }).bindPopup(`
      <div class="tp-head">${esc(tree.tree_id)}</div>
      <div class="tp-disease">${esc(tree.farm_id)} — ${esc(tree.farm_name)}</div>
      <dl class="tp-grid"><dt>Disease</dt><dd>${esc(tree.disease)}</dd></dl>
      <div class="tp-note ok"><i class="bi bi-check-circle-fill"></i> ${esc(tree.latest_intervention)} (${esc(tree.latest_intervention_date)})</div>
      ${more}
      <a class="tp-link" href="/inventory/${encodeURIComponent(tree.tree_id)}/"><i class="bi bi-eye" aria-hidden="true"></i> View full information</a>
    `, { maxWidth: 260, className: "rg-popup" });
    if (group) group.addLayer(marker); else marker.addTo(map);
    markerList.push({ el: marker, tree: treatedTree });
  });

  setTimeout(() => {
    map.invalidateSize();
    // Start zoomed to where the treated trees are, instead of a fixed zoom
    // centred on the first one (which can leave most of them off screen).
    if (trees.length) {
      map.fitBounds(L.latLngBounds(trees.map(t => [t.lat, t.lng])), { padding: [30, 30], maxZoom: 18 });
    }
    rgAttachPinScaling(map, markerList);
  }, 150);
});
