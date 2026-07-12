/* ============================================================
   main.js — Global behavior shared across every page.
   Loaded once in base.html.

   Sidebar behavior:
   - Mobile (<992px): overlay-based. Hamburger opens it, overlay/
     close-button/nav-link click closes it.
   - Desktop (>=992px): sidebar is visible by default, pushing
     content over. Clicking the toggle button simply hides it
     off-screen and lets content expand to fill the space.
     Clicking again shows it. No overlay, no blocking — just a
     plain collapsible sidebar.
   ============================================================ */

// Opens the mobile sidebar and shows the dimming overlay.
function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebar-overlay').classList.add('show');
}

// Closes the mobile sidebar and hides the dimming overlay.
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('show');
}

// Toggles the mobile sidebar open/closed.
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
}

// Toggles the desktop sidebar between visible and hidden, with content
// expanding or contracting to match. Persists the choice across pages.
function toggleDesktopSidebar() {
  const sidebar = document.getElementById('sidebar');
  const mainWrapper = document.getElementById('main-wrapper');
  const hidden = sidebar.classList.toggle('desktop-hidden');
  mainWrapper.classList.toggle('sidebar-hidden', hidden);
  localStorage.setItem('rg-sidebar-hidden', hidden ? '1' : '0');
}

/* ============================================================
   TREE MARKER ICON — shared Google-Maps-style pin used on every
   Leaflet map in the app (farm map, interventions map, tree
   detail mini-map). A teardrop pin with a dark, high-contrast
   border reads far better against both basemaps than a plain
   circle, and its tapered shape leaves more clear space between
   neighboring trees so individual markers stay clickable even
   when a block is planted densely.
   ============================================================ */
const RG_PIN_BORDER = '#1a2535';

// Builds a divIcon pin at the given pixel size. `size` is the pin's
// width in px; height and anchor are derived to keep the classic
// teardrop proportions and point the tip at the tree's exact coordinate.
function rgPinIcon(color, size) {
  size = size || 26;
  const h = Math.round(size * 1.34);
  return L.divIcon({
    className: 'rg-pin-icon',
    html: `
      <svg width="${size}" height="${h}" viewBox="0 0 24 32" xmlns="http://www.w3.org/2000/svg" style="display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45));">
        <path d="M12 0.75C5.79 0.75 0.75 5.79 0.75 12c0 8.25 11.25 19.25 11.25 19.25S23.25 20.25 23.25 12C23.25 5.79 18.21 0.75 12 0.75z"
          fill="${color}" stroke="${RG_PIN_BORDER}" stroke-width="1.75"/>
        <circle cx="12" cy="12" r="4.25" fill="#fff"/>
      </svg>`,
    iconSize: [size, h],
    iconAnchor: [size / 2, h],
    popupAnchor: [0, -h * 0.82],
  });
}

// Returns a pin pixel size for the given zoom level, scaled between the
// map's own min/max zoom. Smaller when zoomed out (less crowding, easier
// to tell trees apart), larger when zoomed in (easier to tap precisely).
function rgPinSizeForZoom(map) {
  const zoom = map.getZoom();
  const minZoom = map.getMinZoom() || 10;
  const maxZoom = map.getMaxZoom && Number.isFinite(map.getMaxZoom()) ? map.getMaxZoom() : minZoom + 8;
  const span = Math.max(maxZoom - minZoom, 1);
  const t = Math.min(Math.max((zoom - minZoom) / span, 0), 1);
  return Math.round(14 + t * 16); // 14px fully zoomed out → 30px fully zoomed in
}

// Wires a map so every marker in markerList (each { el, tree }, el being
// an L.marker built with rgPinIcon) rescales on zoom.
function rgAttachPinScaling(map, markerList) {
  function rescale() {
    const size = rgPinSizeForZoom(map);
    markerList.forEach(({ el, tree }) => {
      if (el.setIcon) el.setIcon(rgPinIcon(tree.color, size));
    });
  }
  map.on('zoomend', rescale);
  rescale();
}

document.addEventListener('DOMContentLoaded', () => {
  const hamburger = document.getElementById('hamburger');
  const overlay = document.getElementById('sidebar-overlay');
  const closeBtn = document.getElementById('sidebar-close');
  const desktopToggle = document.getElementById('desktop-sidebar-toggle');
  const navLinks = document.querySelectorAll('#sidebar .nav-link');
  const sidebar = document.getElementById('sidebar');
  const mainWrapper = document.getElementById('main-wrapper');

  if (hamburger) hamburger.addEventListener('click', toggleSidebar);
  if (overlay) overlay.addEventListener('click', closeSidebar);
  if (closeBtn) closeBtn.addEventListener('click', closeSidebar);
  if (desktopToggle) desktopToggle.addEventListener('click', toggleDesktopSidebar);

  // Closes the mobile sidebar automatically once a nav link is tapped.
  navLinks.forEach(link => link.addEventListener('click', closeSidebar));

  // Restores the desktop hidden/visible state from the last session.
  if (localStorage.getItem('rg-sidebar-hidden') === '1') {
    sidebar.classList.add('desktop-hidden');
    mainWrapper.classList.add('sidebar-hidden');
  }
});
