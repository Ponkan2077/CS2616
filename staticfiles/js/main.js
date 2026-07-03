// Opens the sidebar (used both for mobile and for desktop's
// mobile-preview mode) and shows the dimming overlay.
function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebar-overlay').classList.add('show');
}

// Closes the sidebar and hides the dimming overlay.
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('show');
}

// Toggles the sidebar open/closed (mobile, or desktop while in preview mode).
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
}

// Switches the desktop sidebar into "mobile preview" mode: it becomes an
// overlay like the mobile sidebar, starting closed so the toggle button
// itself acts as the open/close control.
function enterMobilePreview() {
  document.body.classList.add('mobile-preview');
  closeSidebar();
}

// Exits mobile-preview mode, restoring the normal always-visible desktop
// sidebar that pushes page content over instead of overlaying it.
function exitMobilePreview() {
  document.body.classList.remove('mobile-preview');
  closeSidebar();
}

// Toggles the desktop sidebar between its normal always-on state and
// mobile-preview mode, and updates the toggle button's icon to reflect
// the current mode.
function toggleDesktopSidebarMode() {
  const inPreview = document.body.classList.contains('mobile-preview');
  const icon = document.querySelector('#desktop-sidebar-toggle i');
  if (inPreview) {
    exitMobilePreview();
    if (icon) icon.className = 'bi bi-layout-sidebar-inset';
  } else {
    enterMobilePreview();
    openSidebar();
    if (icon) icon.className = 'bi bi-layout-sidebar';
  }
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
  if (desktopToggle) desktopToggle.addEventListener('click', toggleDesktopSidebarMode);

  // Closes the sidebar automatically once a nav link is tapped/clicked,
  // whether on mobile or in desktop mobile-preview mode.
  navLinks.forEach(link => link.addEventListener('click', () => {
    if (window.innerWidth < 992 || document.body.classList.contains('mobile-preview')) {
      closeSidebar();
    }
  }));
});
