/* ============================================================
   rg_charts.js — the shared chart pieces for RubberGuard.
   Loaded by base.html right after theme.js, so window.RG already exists.

   Segmented bars, ranked bars, split lists and sparklines are plain HTML
   (no canvas), so they follow the light/dark theme through the CSS variables
   on their own and need no rebuild on "themechange". Only the two line charts
   (reports trend, tree confidence) use Chart.js; the helpers for those are at
   the bottom.

   Colour rules, same as the rest of the app:
   - A disease colour (DiseaseClass.color_hex) only ever marks a disease: a dot,
     a bar, a segment. Healthy classes are always neutral.
   - Text never wears a data colour. Names and numbers use the text tokens.
   - Class names come from the database, so everything is built with
     textContent, never innerHTML.

   API (all on window.RG):
     RG.fmt(n)                          1,234
     RG.pct(part, whole)                "3.2%"
     RG.segBar(parts)                   thin segmented bar element
     RG.diseaseMix(host, stats)         headline + bar + ranked disease rows
     RG.splitList(host, parts)          bar + one row per part (name, count, %)
     RG.spark(host, labels, values)     small neutral column strip
     RG.legendChips(host, items, onToggle)
     RG.crosshair                       Chart.js plugin
     RG.lineAnimation()                 Chart.js animation option (0 if reduced motion)
   ============================================================ */
(function () {
  'use strict';

  var RG = window.RG = window.RG || {};
  var nf = new Intl.NumberFormat('en-US');

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  RG.fmt = function (n) { return nf.format(Number(n) || 0); };

  RG.pct = function (part, whole) {
    if (!whole) return '0%';
    return (Math.round(part / whole * 1000) / 10).toFixed(1) + '%';
  };

  // Chart.js draws text with its own default face; use the page's.
  if (window.Chart) {
    try { Chart.defaults.font.family = getComputedStyle(document.body).fontFamily; } catch (_) { /* keep default */ }
  }

  RG.lineAnimation = function () {
    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    return reduced ? false : { duration: 450 };
  };

  // ----------------------------------------------------------
  // One shared tooltip for every HTML mark (bar, segment, row, column).
  // Value first, name second. Same readout on hover and on keyboard focus.
  // ----------------------------------------------------------
  var tip = null;
  var tipName = null;
  var tipValue = null;

  function ensureTip() {
    if (tip) return;
    tip = el('div', 'rg-tip');
    tip.setAttribute('role', 'tooltip');
    tipValue = el('div', 'v');
    tipName = el('div', 'n');
    tip.appendChild(tipValue);
    tip.appendChild(tipName);
    document.body.appendChild(tip);
  }

  function placeTip(x, y) {
    var w = tip.offsetWidth, h = tip.offsetHeight;
    var left = Math.min(Math.max(8, x + 14), window.innerWidth - w - 8);
    var top = y - h - 14;
    if (top < 8) top = y + 18;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }

  function bindTip(node, name, value) {
    function fill() {
      ensureTip();
      tipValue.textContent = value;
      tipName.textContent = name;
      tip.classList.add('is-on');
    }
    node.addEventListener('pointerenter', fill);
    node.addEventListener('pointermove', function (e) { fill(); placeTip(e.clientX, e.clientY); });
    node.addEventListener('pointerleave', function () { if (tip) tip.classList.remove('is-on'); });
    node.addEventListener('focus', function () {
      fill();
      var r = node.getBoundingClientRect();
      placeTip(r.left + r.width / 2, r.top);
    });
    node.addEventListener('blur', function () { if (tip) tip.classList.remove('is-on'); });
  }

  // ----------------------------------------------------------
  // Segmented bar: one whole split into parts, 2px surface gap between parts.
  // parts: [{ name, count, color, neutral }]  (a part at zero draws nothing)
  // ----------------------------------------------------------
  RG.segBar = function (parts) {
    var shown = parts.filter(function (p) { return p.count > 0; });
    var total = parts.reduce(function (s, p) { return s + (p.count || 0); }, 0);
    var bar = el('div', 'rg-seg');
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', shown.map(function (p) {
      return p.name + ' ' + RG.fmt(p.count) + ' (' + RG.pct(p.count, total) + ')';
    }).join(', ') || 'No data');
    if (!shown.length) bar.classList.add('is-empty');
    shown.forEach(function (p) {
      var seg = el('i');
      seg.style.setProperty('--n', p.count);
      if (p.neutral) seg.classList.add('is-neutral');
      else if (p.color) seg.style.setProperty('--c', p.color);
      bindTip(seg, p.name, RG.fmt(p.count) + ' · ' + RG.pct(p.count, total));
      p.segment = seg;
      bar.appendChild(seg);
    });
    return bar;
  };

  // Hovering or focusing a row picks out its segment and dims the others.
  function linkRow(row, bar, part) {
    if (!part.segment) return;
    function on() { bar.classList.add('has-hot'); part.segment.classList.add('is-hot'); }
    function off() { bar.classList.remove('has-hot'); part.segment.classList.remove('is-hot'); }
    row.addEventListener('pointerenter', on);
    row.addEventListener('pointerleave', off);
    row.addEventListener('focus', on);
    row.addEventListener('blur', off);
  }

  function nameCell(part) {
    var cell = el('div', 'rg-name');
    var dot = el('span', 'rg-dot');
    dot.setAttribute('aria-hidden', 'true');
    if (part.neutral) dot.classList.add('is-neutral');
    else if (part.color) dot.style.setProperty('--c', part.color);
    cell.appendChild(dot);
    var label = el('span', 't', part.name);
    label.title = part.name;
    cell.appendChild(label);
    return cell;
  }

  function valueCell(count, total) {
    var cell = el('div', 'rg-val');
    cell.appendChild(el('b', null, RG.fmt(count)));
    cell.appendChild(el('small', null, RG.pct(count, total)));
    return cell;
  }

  // ----------------------------------------------------------
  // Split list: the bar, then one row per part. Used for severity tiers.
  // ----------------------------------------------------------
  RG.splitList = function (host, parts) {
    host.textContent = '';
    var total = parts.reduce(function (s, p) { return s + (p.count || 0); }, 0);
    if (!total) { host.appendChild(el('div', 'rg-empty', 'Nothing to show yet.')); return; }
    var bar = RG.segBar(parts);
    host.appendChild(bar);
    var list = el('ul', 'rg-rows is-plain');
    parts.forEach(function (p) {
      var li = el('li', p.count ? 'rg-row' : 'rg-row is-zero');
      li.tabIndex = 0;
      li.appendChild(nameCell(p));
      li.appendChild(valueCell(p.count, total));
      bindTip(li, p.name, RG.fmt(p.count) + ' · ' + RG.pct(p.count, total));
      linkRow(li, bar, p);
      list.appendChild(li);
    });
    host.appendChild(list);
  };

  // ----------------------------------------------------------
  // Disease mix: the headline number, the whole as one bar, then the diseased
  // classes ranked by count. Healthy trees are one neutral part, so a big
  // healthy count never squashes the bars that matter.
  // stats: [{ name, count, color, isHealthy }]
  // ----------------------------------------------------------
  RG.diseaseMix = function (host, stats) {
    host.textContent = '';
    var total = 0, healthyN = 0;
    stats.forEach(function (s) { total += s.count; if (s.isHealthy) healthyN += s.count; });
    if (!total) { host.appendChild(el('div', 'rg-empty', 'No scans yet.')); return; }

    var diseaseN = total - healthyN;
    var diseased = stats.filter(function (s) { return !s.isHealthy && s.count > 0; })
      .sort(function (a, b) { return b.count - a.count; });

    var head = el('div', 'rg-mix-head');
    head.appendChild(el('span', 'rg-mix-figure', RG.pct(healthyN, total)));
    head.appendChild(el('span', 'rg-mix-sub', 'healthy · ' + RG.fmt(healthyN) + ' of ' + RG.fmt(total) + ' tree' + (total === 1 ? '' : 's')));
    host.appendChild(head);

    var parts = [{ name: 'Healthy', count: healthyN, neutral: true }].concat(diseased.map(function (s) {
      return { name: s.name, count: s.count, color: s.color };
    }));
    var bar = RG.segBar(parts);
    host.appendChild(bar);

    if (!diseased.length) {
      host.appendChild(el('div', 'rg-empty', 'No disease cases detected.'));
    } else {
      host.appendChild(el('div', 'rg-subhead', 'Disease cases · ' + RG.fmt(diseaseN) + ' tree' + (diseaseN === 1 ? '' : 's')));
      var peak = diseased[0].count;
      var list = el('ul', 'rg-rows');
      diseased.forEach(function (s, i) {
        var part = parts[i + 1];
        var li = el('li', 'rg-row');
        li.tabIndex = 0;
        li.appendChild(nameCell(part));
        var track = el('div', 'rg-track');
        var fill = el('div', 'rg-fill');
        fill.style.setProperty('--w', (s.count / peak * 100) + '%');
        fill.style.setProperty('--c', s.color || '');
        track.appendChild(fill);
        li.appendChild(track);
        li.appendChild(valueCell(s.count, total));
        bindTip(li, s.name, RG.fmt(s.count) + ' · ' + RG.pct(s.count, total) + ' of all trees');
        linkRow(li, bar, part);
        list.appendChild(li);
      });
      host.appendChild(list);
    }

    var healthyClasses = stats.filter(function (s) { return s.isHealthy && s.count > 0; });
    if (healthyClasses.length > 1) {
      host.appendChild(el('div', 'rg-note', 'Healthy: ' + healthyClasses.map(function (s) {
        return s.name + ' ' + RG.fmt(s.count);
      }).join(' · ')));
    }
  };

  // ----------------------------------------------------------
  // Small column chart: neutral columns, the latest one at full strength.
  // It carries its own scale (peak at the top rule, 0 at the baseline) and the
  // first and last month underneath, so it reads without hovering.
  // ----------------------------------------------------------
  RG.spark = function (host, labels, values) {
    host.textContent = '';
    var n = values.length;
    var peak = Math.max.apply(null, values.concat([1]));
    var wrap = el('div', 'rg-spark-wrap');
    wrap.style.setProperty('--n', n);

    var axis = el('div', 'rg-spark-axis');
    axis.setAttribute('aria-hidden', 'true');
    axis.appendChild(el('span', null, RG.fmt(peak)));
    axis.appendChild(el('span', null, '0'));

    var strip = el('div', 'rg-spark');
    strip.setAttribute('role', 'img');
    strip.setAttribute('aria-label', labels.map(function (l, i) { return l + ' ' + RG.fmt(values[i]); }).join(', '));
    values.forEach(function (v, i) {
      var col = el('i');
      col.style.setProperty('--h', Math.max(v / peak * 100, v > 0 ? 6 : 0) + '%');
      if (i === n - 1) col.classList.add('is-last');
      bindTip(col, labels[i], RG.fmt(v) + ' healthy scans');
      strip.appendChild(col);
    });

    var xs = el('div', 'rg-spark-x');
    xs.setAttribute('aria-hidden', 'true');
    if (n) xs.appendChild(el('span', null, labels[0]));
    if (n > 1) xs.appendChild(el('span', null, labels[n - 1]));

    wrap.appendChild(axis);
    wrap.appendChild(strip);
    wrap.appendChild(xs);
    host.appendChild(wrap);
  };

  // ----------------------------------------------------------
  // Legend chips that also switch a series on and off. The colour stays with
  // the disease, so switching one off never repaints the others.
  // items: [{ name, color, total }]; onToggle(index, visible)
  // ----------------------------------------------------------
  RG.legendChips = function (host, items, hidden, onToggle) {
    host.textContent = '';
    items.forEach(function (it, i) {
      var btn = el('button', 'rg-chip');
      btn.type = 'button';
      var off = hidden && hidden.has(it.name);
      btn.setAttribute('aria-pressed', off ? 'false' : 'true');
      var key = el('span', 'rg-key');
      key.setAttribute('aria-hidden', 'true');
      key.style.setProperty('--c', it.color || '');
      btn.appendChild(key);
      btn.appendChild(el('span', 't', it.name));
      if (it.total != null) btn.appendChild(el('small', null, RG.fmt(it.total)));
      btn.addEventListener('click', function () {
        var nowOn = btn.getAttribute('aria-pressed') !== 'true';
        btn.setAttribute('aria-pressed', nowOn ? 'true' : 'false');
        onToggle(i, nowOn);
      });
      host.appendChild(btn);
    });
  };

  // ----------------------------------------------------------
  // Chart.js: a 1px vertical line that snaps to the hovered X.
  // ----------------------------------------------------------
  RG.crosshair = {
    id: 'rgCrosshair',
    afterDatasetsDraw: function (chart) {
      var active = chart.tooltip && chart.tooltip.getActiveElements ? chart.tooltip.getActiveElements() : [];
      if (!active || !active.length) return;
      var x = active[0].element.x;
      var area = chart.chartArea;
      var ctx = chart.ctx;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x, area.top);
      ctx.lineTo(x, area.bottom);
      ctx.lineWidth = 1;
      ctx.strokeStyle = RG.alpha(RG.tokens().textMuted, 0.55);
      ctx.stroke();
      ctx.restore();
    }
  };
})();
