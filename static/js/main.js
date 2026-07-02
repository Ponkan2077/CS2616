/* ============================================================
   main.js — Global behavior shared across every page.
   Loaded once in base.html.
   ============================================================ */

// Opens the mobile sidebar and shows the overlay.
function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebar-overlay').classList.add('show');
}

// Closes the mobile sidebar and hides the overlay.
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('show');
}

// Toggles the mobile sidebar open/closed.
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
}

// Applies the collapsed/expanded desktop sidebar state and persists it.
function setDesktopCollapsed(collapsed) {
  const sidebar = document.getElementById('sidebar');
  const mainWrapper = document.getElementById('main-wrapper');
  sidebar.classList.toggle('collapsed', collapsed);
  mainWrapper.classList.toggle('sidebar-collapsed', collapsed);
  localStorage.setItem('rg-sidebar-collapsed', collapsed ? '1' : '0');
}

// Toggles the desktop sidebar between full and icon-only widths.
function toggleDesktopSidebar() {
  const sidebar = document.getElementById('sidebar');
  setDesktopCollapsed(!sidebar.classList.contains('collapsed'));
}

document.addEventListener('DOMContentLoaded', () => {
  const hamburger = document.getElementById('hamburger');
  const overlay = document.getElementById('sidebar-overlay');
  const closeBtn = document.getElementById('sidebar-close');
  const desktopToggle = document.getElementById('desktop-sidebar-toggle');
  const navLinks = document.querySelectorAll('#sidebar .nav-link');

  if (hamburger) hamburger.addEventListener('click', toggleSidebar);
  if (overlay) overlay.addEventListener('click', closeSidebar);
  if (closeBtn) closeBtn.addEventListener('click', closeSidebar);
  if (desktopToggle) desktopToggle.addEventListener('click', toggleDesktopSidebar);

  // Closes the mobile sidebar automatically once a nav link is tapped.
  navLinks.forEach(link => link.addEventListener('click', closeSidebar));

  // Restores the desktop collapsed state from the last session.
  if (localStorage.getItem('rg-sidebar-collapsed') === '1') {
    setDesktopCollapsed(true);
  }
});
