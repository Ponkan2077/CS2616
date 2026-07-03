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
