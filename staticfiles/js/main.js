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

document.addEventListener('DOMContentLoaded', () => {
  const hamburger = document.getElementById('hamburger');
  const overlay = document.getElementById('sidebar-overlay');
  const closeBtn = document.getElementById('sidebar-close');
  const navLinks = document.querySelectorAll('#sidebar .nav-link');

  if (hamburger) hamburger.addEventListener('click', toggleSidebar);
  if (overlay) overlay.addEventListener('click', closeSidebar);
  if (closeBtn) closeBtn.addEventListener('click', closeSidebar);

  // Closes the sidebar automatically once a navigation link is tapped on mobile.
  navLinks.forEach(link => link.addEventListener('click', closeSidebar));
});
