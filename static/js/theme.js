/* ============================================================
   theme.js — light/dark toggle, shared by base.html, login.html
   and register.html (the last two don't load main.js).

   The tiny inline script in each page's <head> has already set
   data-theme / data-bs-theme on <html> before first paint, so this
   file only wires the toggle button(s):
   - the icon and the word ("Light" / "Dark", the mode the button
     switches TO) are swapped by CSS from data-theme, so they are
     right from first paint; only the aria-label is set here;
   - the choice is remembered in localStorage under "rg-theme";
   - every switch dispatches a "themechange" event on document
     (it bubbles, so window listeners get it too) with
     { detail: { theme: "dark" | "light" } }.

   It also exposes a small window.RG helper so charts and maps read their
   colours from the CSS variables instead of hardcoding hex:
     RG.theme()            "dark" | "light"
     RG.cssVar('--x')      the current computed value of a CSS variable
     RG.tokens()           the colours the JS needs, read from the variables
     RG.toRgb(color)       [r, g, b] for any CSS colour string
     RG.alpha(color, a)    "rgba(r,g,b,a)" for any CSS colour string
     RG.onThemeChange(fn)  fn(theme) after every switch (rebuild charts/layers)
     RG.chartTooltip()     Chart.js tooltip options in the current theme
     RG.chartScale()       Chart.js axis options (ticks, grid, border)
   Disease colours are NOT here: they come from the data (DiseaseClass).
   ============================================================ */
(function () {
  'use strict';

  var KEY = 'rg-theme';
  var root = document.documentElement;

  function currentTheme() {
    return root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  // localStorage can throw (blocked storage, private mode); the toggle must
  // still work for the current page when it does.
  function remember(theme) {
    try { localStorage.setItem(KEY, theme); } catch (_) { /* choice just isn't remembered */ }
  }

  function syncLabels() {
    var next = currentTheme() === 'light' ? 'dark' : 'light';
    document.querySelectorAll('.theme-toggle').forEach(function (btn) {
      btn.setAttribute('aria-label', 'Switch to ' + next + ' mode');
    });
  }

  function setTheme(theme) {
    root.setAttribute('data-theme', theme);
    root.setAttribute('data-bs-theme', theme);
    remember(theme);
    syncLabels();
    document.dispatchEvent(new CustomEvent('themechange', {
      bubbles: true,
      detail: { theme: theme }
    }));
  }

  function init() {
    syncLabels();
    document.querySelectorAll('.theme-toggle').forEach(function (btn) {
      btn.addEventListener('click', function () {
        setTheme(currentTheme() === 'light' ? 'dark' : 'light');
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ----------------------------------------------------------
  // window.RG: colours for canvas / Leaflet code, read from CSS
  // ----------------------------------------------------------
  var RG = window.RG = window.RG || {};

  RG.theme = currentTheme;

  RG.cssVar = function (name, fallback) {
    try {
      var v = getComputedStyle(root).getPropertyValue(name);
      v = v ? v.trim() : '';
      return v || fallback || '';
    } catch (_) {
      return fallback || '';
    }
  };

  // Every colour the JS needs, by role. The values live in style.css and
  // change with the theme, so call tokens() again after a "themechange".
  var TOKENS = {
    surface: '--surface', cardBg: '--card-bg', cardBgAlt: '--card-bg-alt',
    border: '--border', borderStrong: '--border-strong',
    textMain: '--text-main', textMuted: '--text-muted', textFaint: '--text-faint',
    primary: '--primary', primaryText: '--primary-text', secondary: '--secondary',
    danger: '--danger-bar', dangerText: '--danger-text', dangerTint: '--danger-tint',
    barTrack: '--bar-track', hover: '--hover',
    sevNone: '--sev-none', sevMild: '--sev-mild', sevModerate: '--sev-moderate', sevSevere: '--sev-severe', sevPeak: '--sev-peak',
    mapRing: '--map-ring', mapRingInv: '--map-ring-inv',
    mapBoundary: '--map-boundary', mapBoundaryOnDark: '--map-boundary-on-dark'
  };

  RG.tokens = function () {
    var out = {};
    Object.keys(TOKENS).forEach(function (k) {
      // "gray" only if the stylesheet failed to load, so a canvas never gets ''.
      out[k] = RG.cssVar(TOKENS[k], 'gray');
    });
    return out;
  };

  // Any CSS colour string (#rrggbb, rgb(), rgba(), a named colour) to [r, g, b].
  var swatch = null;
  RG.toRgb = function (color) {
    if (!swatch) {
      var c = document.createElement('canvas');
      c.width = c.height = 1;
      swatch = c.getContext('2d', { willReadFrequently: true });
    }
    swatch.clearRect(0, 0, 1, 1);
    swatch.fillStyle = '#000';
    swatch.fillStyle = color;
    swatch.fillRect(0, 0, 1, 1);
    var d = swatch.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]];
  };

  RG.alpha = function (color, a) {
    return 'rgba(' + RG.toRgb(color).join(',') + ',' + a + ')';
  };

  RG.onThemeChange = function (fn) {
    document.addEventListener('themechange', function (e) {
      fn((e.detail && e.detail.theme) || currentTheme());
    });
  };

  RG.chartTooltip = function () {
    var t = RG.tokens();
    return {
      backgroundColor: t.cardBg, borderColor: t.borderStrong, borderWidth: 1,
      titleColor: t.textMain, bodyColor: t.textMain, padding: 10,
      titleFont: { size: 12 }, bodyFont: { size: 12 }
    };
  };

  RG.chartScale = function () {
    var t = RG.tokens();
    return {
      ticks: { color: t.textMuted, font: { size: 12 } },
      grid: { color: t.border },
      border: { color: t.borderStrong }
    };
  };
})();
