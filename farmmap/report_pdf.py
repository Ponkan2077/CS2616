"""
RubberGuard PDF report renderer.

export_pdf() in views.py gathers the numbers; this module only draws them.
It takes one plain dict (see build_report_pdf) and has no Django imports, so
the layout can be tried out on its own with made-up or real figures.

Layout: landscape Letter, one typeface (Helvetica) throughout, a thin accent
bar at the top of every page and a footer with the scope, the generation
time and "Page x of y". Disease colours come from the data (DiseaseClass
colour), never hardcoded here; only the severity tiers and the neutral
palette below are fixed.
"""

from xml.sax.saxutils import escape

from reportlab.graphics.charts.barcharts import VerticalBarChart
from reportlab.graphics.charts.piecharts import Pie
from reportlab.graphics.shapes import Circle, Drawing, Rect, String
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import landscape, letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.platypus import (
    CondPageBreak, HRFlowable, KeepTogether, Paragraph, SimpleDocTemplate,
    Spacer, Table, TableStyle,
)

# ---------------------------------------------------------------- palette ---
NAVY = colors.HexColor("#1a2535")
INK = colors.HexColor("#1f2937")
MUTED = colors.HexColor("#6b7280")
LINE = colors.HexColor("#e5e7eb")
SOFT = colors.HexColor("#f8fafb")
ACCENT = colors.HexColor("#0f766e")
ACCENT_TINT = colors.HexColor("#f0fdfa")
WHITE = colors.white

# Severity tiers are fixed (same cutoffs and colours as the web app).
SEVERITY_COLORS = {"Mild": "#fbbf24", "Moderate": "#f97316", "Severe": "#dc2626"}
DANGER = "#dc2626"
GOOD, FAIR, POOR = "#16a34a", "#f59e0b", "#ef4444"

PAGE = landscape(letter)
MARGIN_X = 0.5 * inch
CONTENT_W = PAGE[0] - 2 * MARGIN_X


def _esc(value):
    return escape(str(value if value is not None else ""))


def _hex(value, fallback="#6b7280"):
    try:
        return colors.HexColor(value)
    except Exception:
        return colors.HexColor(fallback)


def _recovery_color(pct):
    return GOOD if pct >= 60 else FAIR if pct >= 30 else POOR


def _fmt_pct(pct, digits=1):
    return f"{pct:.{digits}f}%"


# ----------------------------------------------------------------- styles ---
def _styles():
    base = dict(fontName="Helvetica", textColor=INK, leading=12.5, fontSize=9)

    def s(name, **kw):
        merged = {**base, **kw}
        return ParagraphStyle(name, **merged)

    return {
        "title": s("title", fontName="Helvetica-Bold", fontSize=22, leading=26, textColor=NAVY),
        "subtitle": s("subtitle", fontSize=10, leading=14, textColor=MUTED),
        "meta": s("meta", fontSize=7.5, leading=10, textColor=MUTED),
        "h2": s("h2", fontName="Helvetica-Bold", fontSize=12.5, leading=16, textColor=NAVY,
                spaceBefore=13, spaceAfter=2),
        "h2sub": s("h2sub", fontSize=8.5, leading=11, textColor=MUTED, spaceAfter=6),
        "card_title": s("card_title", fontName="Helvetica-Bold", fontSize=10.5, leading=13, textColor=NAVY),
        "body": s("body"),
        "bullet": s("bullet", leftIndent=12, bulletIndent=0, spaceAfter=3.5),
        "note": s("note", fontSize=7.5, leading=10, textColor=MUTED),
        "kpi_label": s("kpi_label", fontName="Helvetica-Bold", fontSize=7.5, leading=10, textColor=MUTED),
        "kpi_value": s("kpi_value", fontName="Helvetica-Bold", fontSize=22, leading=26, textColor=NAVY),
        "kpi_sub": s("kpi_sub", fontSize=8, leading=10.5, textColor=MUTED),
        "th": s("th", fontName="Helvetica-Bold", fontSize=8, leading=10, textColor=WHITE, alignment=TA_CENTER),
        "th_l": s("th_l", fontName="Helvetica-Bold", fontSize=8, leading=10, textColor=WHITE, alignment=TA_LEFT),
        "td": s("td", fontSize=8.5, leading=11),
        "td_c": s("td_c", fontSize=8.5, leading=11, alignment=TA_CENTER),
        "td_b": s("td_b", fontName="Helvetica-Bold", fontSize=8.5, leading=11),
    }


# --------------------------------------------------------------- building ---
def _section(st, title, subtitle=None):
    parts = [Paragraph(_esc(title), st["h2"])]
    parts.append(HRFlowable(width="100%", thickness=0.6, color=LINE, spaceBefore=1, spaceAfter=6))
    if subtitle:
        parts.append(Paragraph(_esc(subtitle), st["h2sub"]))
    return parts


def _place(flow, parts, rows=0, min_space=1.8 * inch, keep=True):
    """Add one report section. Small sections stay in one piece; long tables
    may split across pages (their header row repeats) once the heading and a
    few rows fit."""
    if keep and rows <= 14:
        flow.append(KeepTogether(parts))
    else:
        flow.append(CondPageBreak(min_space))
        flow.extend(parts)


def _table(rows, col_widths, extra=(), header=True, zebra=True, repeat=1):
    t = Table(rows, colWidths=col_widths, repeatRows=repeat if header else 0)
    style = [
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("LINEBELOW", (0, 0), (-1, -1), 0.4, LINE),
    ]
    if header:
        style += [("BACKGROUND", (0, 0), (-1, 0), NAVY)]
    if zebra and len(rows) > 2:
        style += [("ROWBACKGROUNDS", (0, 1 if header else 0), (-1, -1), [WHITE, SOFT])]
    t.setStyle(TableStyle(style + list(extra)))
    return t


def _kpi_row(st, cards):
    gap = 10
    n = len(cards)
    cw = (CONTENT_W - gap * (n - 1)) / n
    cells, widths, style = [], [], []
    for i, (label, value, sub, color) in enumerate(cards):
        cells.append([Paragraph(_esc(label).upper(), st["kpi_label"]),
                      Paragraph(_esc(value), st["kpi_value"]),
                      Paragraph(_esc(sub), st["kpi_sub"])])
        widths.append(cw)
        c = i * 2
        style += [
            ("BOX", (c, 0), (c, 0), 0.8, LINE),
            ("LINEBEFORE", (c, 0), (c, 0), 3.5, color),
            ("LEFTPADDING", (c, 0), (c, 0), 12),
            ("RIGHTPADDING", (c, 0), (c, 0), 10),
            ("TOPPADDING", (c, 0), (c, 0), 9),
            ("BOTTOMPADDING", (c, 0), (c, 0), 9),
        ]
        if i < n - 1:
            cells.append("")
            widths.append(gap)
            style += [("LEFTPADDING", (c + 1, 0), (c + 1, 0), 0), ("RIGHTPADDING", (c + 1, 0), (c + 1, 0), 0)]
    t = Table([cells], colWidths=widths)
    t.setStyle(TableStyle(style + [("VALIGN", (0, 0), (-1, -1), "TOP")]))
    return t


def _callout(st, items):
    paras = [Paragraph(_esc(text), st["bullet"], bulletText="•") for text in items]
    t = Table([[paras]], colWidths=[CONTENT_W])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), ACCENT_TINT),
        ("LINEBEFORE", (0, 0), (0, 0), 3.5, ACCENT),
        ("LEFTPADDING", (0, 0), (-1, -1), 14),
        ("RIGHTPADDING", (0, 0), (-1, -1), 12),
        ("TOPPADDING", (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return t


def _two_cards(st, left, right, left_w, gap=14):
    """Two boxed panels side by side. (title, drawing) each; one table row, so the boxes match in height."""
    def cell(title, drawing):
        return [Paragraph(_esc(title), st["card_title"]), Spacer(1, 6), drawing]

    t = Table([[cell(*left), "", cell(*right)]], colWidths=[left_w, gap, CONTENT_W - left_w - gap])
    pad = [("LEFTPADDING", (c, 0), (c, 0), 12) for c in (0, 2)] + \
          [("RIGHTPADDING", (c, 0), (c, 0), 12) for c in (0, 2)] + \
          [("BOX", (c, 0), (c, 0), 0.8, LINE) for c in (0, 2)]
    t.setStyle(TableStyle(pad + [
        ("LEFTPADDING", (1, 0), (1, 0), 0), ("RIGHTPADDING", (1, 0), (1, 0), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 10), ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    return t


# ----------------------------------------------------------------- charts ---
def _donut(d, cx, cy, radius, values, fills, center_title, center_sub, cutout=0.64):
    pie = Pie()
    pie.x, pie.y = cx - radius, cy - radius
    pie.width = pie.height = radius * 2
    pie.data = values
    pie.labels = ["" for _ in values]
    pie.simpleLabels = 0
    pie.sideLabels = 0
    pie.slices.strokeWidth = 1.5
    pie.slices.strokeColor = WHITE
    for i, fill in enumerate(fills):
        pie.slices[i].fillColor = fill
    d.add(pie)
    d.add(Circle(cx, cy, radius * cutout, fillColor=WHITE, strokeColor=None))
    d.add(String(cx, cy + 1, center_title, fontSize=15, fontName="Helvetica-Bold",
                 textAnchor="middle", fillColor=NAVY))
    d.add(String(cx, cy - 11, center_sub, fontSize=7.5, fontName="Helvetica",
                 textAnchor="middle", fillColor=MUTED))


def _severity_drawing(severity_counts, healthy_color, total, width, h=130):
    d = Drawing(width, h)
    tiers = [
        ("Healthy", severity_counts.get("Healthy", 0), _hex(healthy_color, GOOD)),
        ("Mild", severity_counts.get("Mild", 0), _hex(SEVERITY_COLORS["Mild"])),
        ("Moderate", severity_counts.get("Moderate", 0), _hex(SEVERITY_COLORS["Moderate"])),
        ("Severe", severity_counts.get("Severe", 0), _hex(SEVERITY_COLORS["Severe"])),
    ]
    if not total:
        d.add(String(width / 2, h / 2, "No data", fontSize=9, textAnchor="middle", fillColor=MUTED))
        return d

    healthy_pct = severity_counts.get("Healthy", 0) / total * 100
    nonzero = [(n, v, c) for n, v, c in tiers if v > 0]
    radius = min(56, h / 2 - 4)
    _donut(d, radius + 6, h / 2, radius, [v for _, v, _ in nonzero], [c for _, _, c in nonzero],
           _fmt_pct(healthy_pct), "Healthy")

    x0 = 2 * radius + 28
    row_h = 27
    top = h / 2 + row_h * 1.5
    for i, (name, value, color) in enumerate(tiers):
        y = top - i * row_h
        d.add(Rect(x0, y - 4, 9, 9, fillColor=color, strokeColor=None))
        d.add(String(x0 + 16, y - 3, name, fontSize=9, fontName="Helvetica", fillColor=INK))
        d.add(String(width, y - 3, f"{value:,}", fontSize=9.5, fontName="Helvetica-Bold",
                     textAnchor="end", fillColor=NAVY))
        d.add(String(width, y - 13, _fmt_pct(value / total * 100), fontSize=7.5,
                     fontName="Helvetica", textAnchor="end", fillColor=MUTED))
    return d


def _disease_bars(disease_stats, total, width):
    rows = sorted((s for s in disease_stats if not s.get("is_healthy")),
                  key=lambda s: s["count"], reverse=True)
    healthy_n = sum(s["count"] for s in disease_stats if s.get("is_healthy"))
    row_h = 19
    foot = 22
    h = max(len(rows), 1) * row_h + foot
    d = Drawing(width, h)
    if not rows:
        d.add(String(width / 2, h / 2, "No disease classes", fontSize=9, textAnchor="middle", fillColor=MUTED))
        return d

    peak = max(s["count"] for s in rows) or 1
    name_x = 15
    bar_x = 112
    val_w = 82
    bar_w = width - bar_x - val_w
    for i, s in enumerate(rows):
        y = h - (i + 1) * row_h + 3
        d.add(Rect(0, y + 1, 8, 8, fillColor=_hex(s["color"]), strokeColor=None))
        d.add(String(name_x, y + 1.5, s["name"], fontSize=8.5, fontName="Helvetica", fillColor=INK))
        d.add(Rect(bar_x, y + 1, bar_w, 8, fillColor=LINE, strokeColor=None))
        if s["count"]:
            d.add(Rect(bar_x, y + 1, max(bar_w * s["count"] / peak, 2), 8,
                       fillColor=_hex(s["color"]), strokeColor=None))
        d.add(String(width, y + 1.5, f'{s["count"]:,}  ({_fmt_pct(s["pct"])})', fontSize=8.5,
                     fontName="Helvetica-Bold", textAnchor="end", fillColor=NAVY))
    healthy_pct = healthy_n / total * 100 if total else 0
    d.add(String(0, 4, f"Healthy trees ({healthy_n:,}, {_fmt_pct(healthy_pct)}) are not shown. "
                       "Percentages are of all trees.",
                 fontSize=7.5, fontName="Helvetica", fillColor=MUTED))
    return d


def _legend(d, items, x, y, max_width):
    """Chips + names laid out left to right, wrapping at max_width. Returns the height used."""
    cx, cy, row_h = x, y, 15
    for name, color in items:
        w = 14 + stringWidth(name, "Helvetica", 8.5) + 16
        if cx + w > x + max_width:
            cx, cy = x, cy - row_h
        d.add(Rect(cx, cy, 8, 8, fillColor=color, strokeColor=None))
        d.add(String(cx + 13, cy + 0.5, name, fontSize=8.5, fontName="Helvetica", fillColor=INK))
        cx += w
    return y - cy + row_h


def _trend_drawing(months, series, width, height=170):
    d = Drawing(width, height)
    legend_h = _legend(d, [(n, c) for n, c in series], 4, height - 12, width - 8)
    bar = VerticalBarChart()
    bar.x, bar.y = 38, 20
    bar.width = width - 52
    bar.height = height - legend_h - 30
    bar.data = [[m["diseases"].get(name, 0) for m in months] for name, _ in series]
    peak = max((v for row in bar.data for v in row), default=0)
    bar.categoryAxis.categoryNames = [m["month"] for m in months]
    bar.categoryAxis.labels.fontName = "Helvetica-Bold"
    bar.categoryAxis.labels.fontSize = 9
    bar.categoryAxis.strokeColor = LINE
    bar.categoryAxis.tickDown = 0
    bar.valueAxis.labels.fontName = "Helvetica"
    bar.valueAxis.labels.fontSize = 8
    bar.valueAxis.labels.fillColor = MUTED
    bar.valueAxis.strokeColor = None
    bar.valueAxis.valueMin = 0
    bar.valueAxis.valueMax = max(peak * 1.12, 5)
    bar.valueAxis.visibleGrid = 1
    bar.valueAxis.gridStrokeColor = LINE
    bar.valueAxis.gridStrokeWidth = 0.5
    bar.groupSpacing = 20
    bar.barSpacing = 2
    bar.barLabelFormat = "%d"
    bar.barLabels.fontName = "Helvetica"
    bar.barLabels.fontSize = 7
    bar.barLabels.fillColor = INK
    bar.barLabels.dy = 5
    for i, (_, color) in enumerate(series):
        bar.bars[i].fillColor = color
        bar.bars[i].strokeColor = None
    d.add(bar)
    return d


def _affected_drawing(rows, width):
    row_h = 22
    h = max(len(rows), 1) * row_h + 4
    d = Drawing(width, h)
    peak = max((r["diseased"] for r in rows), default=0) or 1
    label_w, bar_x, val_w = 140, 150, 180
    bar_w = width - bar_x - val_w
    for i, r in enumerate(rows):
        y = h - (i + 1) * row_h + 5
        d.add(String(label_w, y + 3, r["label"], fontSize=9.5, fontName="Helvetica", textAnchor="end", fillColor=INK))
        d.add(Rect(bar_x, y, bar_w, 12, fillColor=LINE, strokeColor=None))
        if r["diseased"]:
            d.add(Rect(bar_x, y, max(bar_w * r["diseased"] / peak, 2), 12, fillColor=_hex(DANGER), strokeColor=None))
        pct = r["diseased"] / r["total"] * 100 if r["total"] else 0
        d.add(String(bar_x + bar_w + 12, y + 3, f'{r["diseased"]:,} of {r["total"]:,} trees  ({_fmt_pct(pct)})',
                     fontSize=8.5, fontName="Helvetica-Bold", fillColor=NAVY))
    return d


def _pct_bar(width, pct):
    d = Drawing(width, 14)
    track = width - 44
    d.add(Rect(0, 3, track, 8, fillColor=LINE, strokeColor=None))
    if pct > 0:
        d.add(Rect(0, 3, max(track * min(pct, 100) / 100, 2), 8, fillColor=_hex(_recovery_color(pct)), strokeColor=None))
    d.add(String(width, 4, _fmt_pct(pct), fontSize=8.5, fontName="Helvetica-Bold", textAnchor="end", fillColor=NAVY))
    return d


def _swatch(color):
    d = Drawing(10, 10)
    d.add(Rect(0, 1, 9, 9, fillColor=_hex(color), strokeColor=None))
    return d


def _shade(pct):
    """White to green, deeper with the recovery rate."""
    g = colors.HexColor(GOOD)
    k = min(max(pct, 0), 100) / 100 * 0.78
    return colors.Color(1 + (g.red - 1) * k, 1 + (g.green - 1) * k, 1 + (g.blue - 1) * k)


# ------------------------------------------------------------ page chrome ---
class _NumberedCanvas(rl_canvas.Canvas):
    """Canvas that knows the page count, so the footer can say "Page 2 of 4"."""

    footer_left = ""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._saved = []

    def showPage(self):
        self._saved.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        total = len(self._saved)
        for state in self._saved:
            self.__dict__.update(state)
            self._chrome(total)
            super().showPage()
        super().save()

    def _chrome(self, total):
        w, h = PAGE
        self.setFillColor(ACCENT)
        self.rect(0, h - 7, w, 7, stroke=0, fill=1)
        self.setStrokeColor(LINE)
        self.setLineWidth(0.6)
        self.line(MARGIN_X, 0.52 * inch, w - MARGIN_X, 0.52 * inch)
        self.setFont("Helvetica", 7.5)
        self.setFillColor(MUTED)
        self.drawString(MARGIN_X, 0.36 * inch, self.footer_left)
        self.drawRightString(w - MARGIN_X, 0.36 * inch, f"Page {self._pageNumber} of {total}")


# ------------------------------------------------------------------ build ---
def build_report_pdf(out, ctx):
    """
    Draw the report into `out` (a file object or Django response).

    ctx keys:
      scope, generated_label, ai_model, report_version
      total, disease_stats [{name, count, pct, color, is_healthy}]
      severity_counts {Healthy, Mild, Moderate, Severe}, healthy_color
      confidence {avg, low_count, low_threshold}
      key_insights [str], recommendations [str]
      monthly [{month, diseases: {name: count}}]
      most_affected [{label, diseased, total}]
      farm_rows [{farm_id, name, total, counts: {disease: n}}] or None for a single farm
      effectiveness [{action, treated, recovered, recovery_pct}]
      best_per_disease [{disease, best_action, recovery_pct, treated, low_sample}]
      by_disease {disease: [{action, treated, recovered, recovery_pct}]}
      disease_colors {name: hex}
      recent_interventions [{tree_id, farm_id, action, date, notes}]
    """
    st = _styles()
    stats = ctx["disease_stats"]
    total = ctx["total"]
    healthy_n = sum(s["count"] for s in stats if s.get("is_healthy"))
    diseased_n = total - healthy_n
    colors_by_name = ctx.get("disease_colors") or {s["name"]: s["color"] for s in stats}
    conf = ctx.get("confidence") or {}

    class Canvas(_NumberedCanvas):
        footer_left = f'RubberGuard  |  {ctx["scope"]}  |  Generated {ctx["generated_label"]}'

    doc = SimpleDocTemplate(
        out, pagesize=PAGE, leftMargin=MARGIN_X, rightMargin=MARGIN_X,
        topMargin=0.62 * inch, bottomMargin=0.7 * inch,
        title="RubberGuard Disease Detection Report", author="RubberGuard",
    )
    flow = []

    # ---- Title -------------------------------------------------------------
    flow.append(Paragraph("Disease Detection Report", st["title"]))
    flow.append(Paragraph(f'{_esc(ctx["scope"])}  ·  Generated {_esc(ctx["generated_label"])}', st["subtitle"]))
    flow.append(Paragraph(f'AI model: {_esc(ctx["ai_model"])}  ·  Report version {_esc(ctx["report_version"])}', st["meta"]))
    flow.append(Spacer(1, 12))

    # ---- KPI cards ---------------------------------------------------------
    healthy_pct = healthy_n / total * 100 if total else 0
    cards = [
        ("Trees monitored", f"{total:,}", "scanned in this scope", NAVY),
        ("Healthy", f"{healthy_n:,}", f"{_fmt_pct(healthy_pct)} of all trees", _hex(ctx.get("healthy_color"), GOOD)),
        ("Need attention", f"{diseased_n:,}", f"{_fmt_pct(100 - healthy_pct) if total else '0%'} of all trees", _hex(DANGER)),
    ]
    if conf.get("avg") is not None:
        low = conf.get("low_count", 0)
        sub = "no low-confidence scans" if not low else f'{low} scan(s) under {conf.get("low_threshold", 70)}%'
        cards.append(("Avg. confidence", f'{conf["avg"]:g}%', sub, ACCENT))
    flow.append(_kpi_row(st, cards))
    flow.append(Spacer(1, 14))

    # ---- Key insights ------------------------------------------------------
    _place(flow, _section(st, "Key insights") + [_callout(st, ctx["key_insights"])])

    # ---- Severity + disease distribution -----------------------------------
    left_w = 300
    right_w = CONTENT_W - left_w - 14
    dis = _disease_bars(stats, total, right_w - 24)
    sev = _severity_drawing(ctx["severity_counts"], ctx.get("healthy_color"), total, left_w - 24, h=dis.height)
    _place(flow, _section(st, "Severity and disease mix") + [
        _two_cards(st, ("Health and severity", sev), ("Disease distribution", dis), left_w)])

    # ---- Monthly trend -----------------------------------------------------
    months = (ctx.get("monthly") or [])[-3:]
    series = [(s["name"], _hex(s["color"])) for s in stats
              if not s.get("is_healthy") and any(m["diseases"].get(s["name"], 0) for m in months)]
    healthy_names = [s["name"] for s in stats if s.get("is_healthy")]
    parts = _section(st, "Monthly detection trend",
                     "Diseased detections per month, last 3 months. Healthy scans are left out so the disease bars stay readable.")
    if months and series:
        parts.append(_trend_drawing(months, series, CONTENT_W))
        per_month = "   \u00b7   ".join(
            f'{_esc(m["month"])}: {sum(m["diseases"].get(n, 0) for n in healthy_names):,}' for m in months)
        parts.append(Paragraph(f"Healthy scans per month  \u2014  {per_month}", st["note"]))
    else:
        parts.append(Paragraph("No scan history in this window.", st["body"]))
    _place(flow, parts)

    # ---- Most affected areas -----------------------------------------------
    affected = [r for r in (ctx.get("most_affected") or []) if r["total"] > 0]
    if affected:
        _place(flow, _section(st, "Most affected areas") + [_affected_drawing(affected, CONTENT_W)])

    # ---- Per-farm breakdown ------------------------------------------------
    farm_rows = [r for r in (ctx.get("farm_rows") or []) if r["total"] > 0]
    hidden_farms = len(ctx.get("farm_rows") or []) - len(farm_rows)
    if farm_rows:
        names = [s["name"] for s in stats]
        head_row = [Paragraph("Farm ID", st["th_l"]), Paragraph("Farm", st["th_l"]), Paragraph("Total", st["th"])]
        head_row += [Paragraph(_esc(n), st["th"]) for n in names]
        rows = [head_row]
        for r in farm_rows:
            rows.append([Paragraph(_esc(r["farm_id"]), st["td"]), Paragraph(_esc(r["name"]), st["td_b"]),
                         Paragraph(f'{r["total"]:,}', st["td_c"])]
                        + [Paragraph(f'{r["counts"].get(n, 0):,}' if r["counts"].get(n, 0) else
                                     '<font color="#9ca3af">\u2013</font>', st["td_c"]) for n in names])
        sums = [sum(r["counts"].get(n, 0) for r in farm_rows) for n in names]
        rows.append([Paragraph("", st["td"]), Paragraph("All farms", st["td_b"]),
                     Paragraph(f'<b>{sum(r["total"] for r in farm_rows):,}</b>', st["td_c"])]
                    + [Paragraph(f"<b>{v:,}</b>", st["td_c"]) for v in sums])
        fixed = [0.10, 0.20, 0.08]
        rest = (1 - sum(fixed)) / max(len(names), 1)
        widths = [CONTENT_W * f for f in fixed + [rest] * len(names)]
        parts = _section(st, "Per-farm breakdown") + [_table(rows, widths, zebra=False, extra=[
            ("ROWBACKGROUNDS", (0, 1), (-1, -2), [WHITE, SOFT]),
            ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#eef2f6")),
            ("LINEABOVE", (0, -1), (-1, -1), 0.9, NAVY),
            ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ])]
        if hidden_farms:
            parts += [Spacer(1, 4), Paragraph(f"{hidden_farms} farm(s) with no scanned trees are not shown.", st["note"])]
        _place(flow, parts, rows=len(rows))

    # ---- Recommendations ---------------------------------------------------
    _place(flow, _section(st, "Recommendations",
                          "Suggested next steps, based on how common each disease is and how past interventions worked.")
           + [_callout(st, ctx["recommendations"])])

    # ---- Intervention effectiveness ----------------------------------------
    eff = sorted(ctx.get("effectiveness") or [], key=lambda e: (e["recovery_pct"], e["treated"]), reverse=True)
    if eff:
        bar_w = CONTENT_W * 0.38 - 16
        rows = [[Paragraph("Intervention", st["th_l"]), Paragraph("Trees treated", st["th"]),
                 Paragraph("Now healthy", st["th"]), Paragraph("Recovery rate", st["th_l"])]]
        for e in eff:
            rows.append([Paragraph(_esc(e["action"]), st["td_b"]), Paragraph(f'{e["treated"]:,}', st["td_c"]),
                         Paragraph(f'{e["recovered"]:,}', st["td_c"]), _pct_bar(bar_w, e["recovery_pct"])])
        _place(flow, _section(st, "Intervention effectiveness",
                              "Share of treated trees that are Healthy now, highest recovery rate first.")
               + [_table(rows, [CONTENT_W * f for f in (0.34, 0.14, 0.14, 0.38)])], rows=len(rows))

    # ---- Best intervention per disease -------------------------------------
    best = ctx.get("best_per_disease") or []
    if best:
        bar_w = CONTENT_W * 0.22 - 16
        rows = [[Paragraph("", st["th"]), Paragraph("Disease", st["th_l"]),
                 Paragraph("Most effective intervention", st["th_l"]),
                 Paragraph("Recovery rate", st["th_l"]), Paragraph("Trees treated", st["th"])]]
        for b in best:
            mark = " *" if b.get("low_sample") else ""
            rows.append([_swatch(colors_by_name.get(b["disease"], "#6b7280")),
                         Paragraph(_esc(b["disease"]), st["td_b"]),
                         Paragraph(_esc(b["best_action"]) + mark, st["td"]),
                         _pct_bar(bar_w, b["recovery_pct"]), Paragraph(f'{b["treated"]:,}', st["td_c"])])
        parts = _section(st, "Most effective intervention per disease") + [
            _table(rows, [CONTENT_W * f for f in (0.04, 0.24, 0.32, 0.22, 0.18)])]
        if any(b.get("low_sample") for b in best):
            parts += [Spacer(1, 4), Paragraph(
                "* Based on fewer than 3 treated trees \u2014 preliminary, not yet a reliable sample.", st["note"])]
        _place(flow, parts, rows=len(rows))

        # Recovery matrix: disease x the four most-used interventions.
        by_disease = ctx.get("by_disease") or {}
        totals = {}
        for rows_ in by_disease.values():
            for r in rows_:
                totals[r["action"]] = totals.get(r["action"], 0) + r["treated"]
        actions = [a for a, _ in sorted(totals.items(), key=lambda kv: kv[1], reverse=True)[:4]]
        if actions:
            order = [b["disease"] for b in best if b["disease"] in by_disease]
            matrix = [[Paragraph("Disease", st["th_l"])] + [Paragraph(_esc(a), st["th"]) for a in actions]]
            extra = []
            for ri, disease in enumerate(order, start=1):
                row = [Paragraph(_esc(disease), st["td_b"])]
                for ci, action in enumerate(actions, start=1):
                    hit = next((r for r in by_disease[disease] if r["action"] == action), None)
                    if hit and hit["treated"]:
                        row.append(Paragraph(f'<b>{_fmt_pct(hit["recovery_pct"], 0)}</b>', st["td_c"]))
                        extra.append(("BACKGROUND", (ci, ri), (ci, ri), _shade(hit["recovery_pct"])))
                    else:
                        row.append(Paragraph('<font color="#9ca3af">\u2013</font>', st["td_c"]))
                matrix.append(row)
            first = CONTENT_W * 0.24
            widths = [first] + [(CONTENT_W - first) / len(actions)] * len(actions)
            _place(flow, [
                Spacer(1, 12),
                Paragraph("Recovery rate by intervention, per disease", st["card_title"]),
                Paragraph("Darker green means more of the treated trees recovered. A dash means that intervention "
                          "was not used for that disease.", st["note"]),
                Spacer(1, 5),
                _table(matrix, widths, zebra=False, extra=extra + [("GRID", (1, 1), (-1, -1), 1.2, WHITE)]),
            ], rows=len(matrix))

    # ---- Recent interventions ----------------------------------------------
    recent = ctx.get("recent_interventions") or []
    if recent:
        has_notes = any((r.get("notes") or "").strip() not in ("", "\u2014", "-") for r in recent)
        head_row = [Paragraph("Tree ID", st["th_l"]), Paragraph("Farm", st["th_l"]),
                    Paragraph("Action", st["th_l"]), Paragraph("Date", st["th_l"])]
        if has_notes:
            head_row.append(Paragraph("Notes", st["th_l"]))
        rows = [head_row]
        for r in recent:
            row = [Paragraph(_esc(r["tree_id"]), st["td"]), Paragraph(_esc(r["farm_id"]), st["td"]),
                   Paragraph(_esc(r["action"]), st["td_b"]), Paragraph(_esc(r["date"]), st["td"])]
            if has_notes:
                row.append(Paragraph(_esc((r.get("notes") or "\u2014")[:80]), st["td"]))
            rows.append(row)
        fr = (0.18, 0.12, 0.22, 0.14, 0.34) if has_notes else (0.26, 0.18, 0.32, 0.24)
        _place(flow, _section(st, "Recent interventions") + [_table(rows, [CONTENT_W * f for f in fr])],
               rows=len(rows), keep=False)

    doc.build(flow, canvasmaker=Canvas)
