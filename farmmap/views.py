import json
from django.shortcuts import render, get_object_or_404, redirect
from django.contrib.auth.decorators import login_required
from django.contrib.auth import login
from django.contrib.auth.forms import UserCreationForm
from django.contrib import messages
from django.urls import reverse
from django.utils import timezone
from .models import Farm, RubberTree, ScanHistory

# Icon and color shown in the notification bell for each disease type.
NOTIFICATION_STYLE = {
    "Pink Disease": {"icon": "bi-exclamation-triangle-fill", "color": "text-danger"},
    "White Root Rot": {"icon": "bi-exclamation-triangle-fill", "color": "text-warning"},
    "Stem Bleeding": {"icon": "bi-exclamation-triangle-fill", "color": "text-danger"},
}

MONTHLY_DETECTIONS = [
    {"month": "Jan", "healthy": 48, "pink": 2, "white_root": 1, "stem": 0},
    {"month": "Feb", "healthy": 47, "pink": 2, "white_root": 1, "stem": 1},
    {"month": "Mar", "healthy": 46, "pink": 3, "white_root": 2, "stem": 1},
    {"month": "Apr", "healthy": 45, "pink": 3, "white_root": 2, "stem": 2},
    {"month": "May", "healthy": 44, "pink": 4, "white_root": 2, "stem": 2},
    {"month": "Jun", "healthy": 43, "pink": 4, "white_root": 3, "stem": 2},
]


def _humanize_days_ago(days):
    # Converts a day count into a short "time ago" string.
    if days <= 0:
        return "Today"
    if days == 1:
        return "1 day ago"
    if days < 30:
        return f"{days} days ago"
    months = days // 30
    return f"{months} month{'s' if months > 1 else ''} ago"


def _build_notifications(request):
    # Builds clickable notifications from the user's most recently scanned diseased trees.
    diseased_trees = (
        RubberTree.objects.select_related("farm")
        .filter(farm__owner=request.user)
        .exclude(disease="Healthy")
        .order_by("-date_scanned")[:6]
    )
    today = timezone.localdate()
    notifications = []
    for t in diseased_trees:
        style = NOTIFICATION_STYLE.get(t.disease, {"icon": "bi-info-circle-fill", "color": "text-success"})
        days_ago = (today - t.date_scanned).days
        notifications.append({
            "icon": style["icon"],
            "color": style["color"],
            "msg": f"{t.disease} detected at Tree {t.tree_id}",
            "time": _humanize_days_ago(days_ago),
            "url": reverse("tree_details", args=[t.tree_id]),
        })
    return notifications


def _get_farm_or_none(request):
    # Returns the logged-in user's currently selected Farm, or None.
    farm_id = request.session.get("selected_farm_id")
    if farm_id:
        return Farm.objects.filter(pk=farm_id, owner=request.user).first()
    return None


def _get_trees(request, farm=None):
    # Returns the logged-in user's trees, optionally filtered to one farm.
    qs = RubberTree.objects.select_related("farm").filter(farm__owner=request.user)
    if farm:
        qs = qs.filter(farm=farm)
    return qs


def _get_stats(request, farm=None):
    # Aggregates disease counts and percentages for one farm or all the user's farms.
    if farm:
        return farm.get_stats()
    trees = RubberTree.objects.filter(farm__owner=request.user)
    total = trees.count()
    counts = {"Healthy": 0, "Pink_Disease": 0, "White_Root_Rot": 0, "Stem_Bleeding": 0}
    disease_key_map = {
        "Healthy": "Healthy",
        "Pink Disease": "Pink_Disease",
        "White Root Rot": "White_Root_Rot",
        "Stem Bleeding": "Stem_Bleeding",
    }
    for t in trees:
        counts[disease_key_map[t.disease]] += 1
    pcts = {k: round(v / total * 100, 1) if total else 0 for k, v in counts.items()}
    diseased = counts["Pink_Disease"] + counts["White_Root_Rot"] + counts["Stem_Bleeding"]
    return total, counts, pcts, diseased


def _base_context(request, farm=None):
    # Builds the context shared across all views, scoped to the logged-in user.
    all_farms = Farm.objects.filter(owner=request.user).order_by("farm_id")
    return {
        "notifications": _build_notifications(request),
        "all_farms": all_farms,
        "selected_farm": farm,
    }


def register(request):
    # Handles new user sign-up and logs them in immediately on success.
    if request.user.is_authenticated:
        return redirect("dashboard")
    if request.method == "POST":
        form = UserCreationForm(request.POST)
        if form.is_valid():
            user = form.save()
            login(request, user)
            messages.success(request, "Account created. Welcome to RubberGuard!")
            return redirect("dashboard")
    else:
        form = UserCreationForm()
    return render(request, "register.html", {"form": form})


@login_required
def select_farm(request):
    # Saves the selected farm to the session and redirects back to the current page.
    farm_pk = request.POST.get("farm_pk", "")
    if farm_pk:
        if Farm.objects.filter(pk=farm_pk, owner=request.user).exists():
            request.session["selected_farm_id"] = int(farm_pk)
    else:
        request.session.pop("selected_farm_id", None)
    next_url = request.POST.get("next", "/")
    return redirect(next_url)


@login_required
def farm_list(request):
    # Displays a list of all farms owned by the logged-in user.
    farms = Farm.objects.filter(owner=request.user).order_by("farm_id")
    ctx = _base_context(request)
    ctx.update({"page": "farm_list", "farms": farms})
    return render(request, "farm_list.html", ctx)


@login_required
def farm_create(request):
    # Handles the Add Farm form, creating a new farm owned by the logged-in user.
    if request.method == "POST":
        farm_id = request.POST.get("farm_id", "").strip()
        name = request.POST.get("name", "").strip()
        owner_name = request.POST.get("owner_name", "").strip()
        location = request.POST.get("location", "").strip()
        center_lat = request.POST.get("center_lat") or 6.9214
        center_lng = request.POST.get("center_lng") or 122.0790

        if not farm_id or not name or not owner_name:
            messages.error(request, "Farm ID, name, and owner name are required.")
            return redirect("farm_list")

        if Farm.objects.filter(owner=request.user, farm_id=farm_id).exists():
            messages.error(request, f"You already have a farm with ID '{farm_id}'.")
            return redirect("farm_list")

        Farm.objects.create(
            owner=request.user,
            farm_id=farm_id,
            name=name,
            owner_name=owner_name,
            location=location,
            center_lat=float(center_lat),
            center_lng=float(center_lng),
        )
        messages.success(request, f"Farm '{name}' added successfully.")
        return redirect("farm_list")

    return redirect("farm_list")


@login_required
def farm_detail(request, farm_id):
    # Displays details, stats, and trees for a single farm owned by the user.
    farm = get_object_or_404(Farm, farm_id=farm_id, owner=request.user)
    total, counts, pcts, diseased = farm.get_stats()
    trees = farm.trees.all().order_by("tree_id")
    ctx = _base_context(request)
    ctx.update({
        "page": "farm_list",
        "farm": farm,
        "trees": trees,
        "total": total, "counts": counts, "pcts": pcts, "diseased": diseased,
    })
    return render(request, "farm_detail.html", ctx)


@login_required
def dashboard(request):
    # Renders the main dashboard with disease stats and recently scanned trees.
    farm = _get_farm_or_none(request)
    total, counts, pcts, diseased = _get_stats(request, farm)
    trees = list(_get_trees(request, farm).order_by("-date_scanned")[:6])
    recent = [t.to_dict() for t in trees]
    ctx = _base_context(request, farm)
    ctx.update({
        "page": "dashboard",
        "total": total, "counts": counts, "pcts": pcts, "diseased": diseased,
        "recent": recent,
        "monthly": MONTHLY_DETECTIONS,
        "latest_scan": recent[0]["date_scanned"] if recent else "—",
    })
    return render(request, "dashboard.html", ctx)


@login_required
def farm_map(request):
    # Renders the interactive Leaflet map with tree markers and farm center layers.
    farm = _get_farm_or_none(request)
    total, counts, pcts, diseased = _get_stats(request, farm)
    trees_qs = _get_trees(request, farm)
    trees_json = json.dumps([t.to_dict() for t in trees_qs])
    farms_json = json.dumps([
        {
            "farm_id": f.farm_id,
            "name": f.name,
            "owner": f.owner_name,
            "lat": f.center_lat,
            "lng": f.center_lng,
        }
        for f in Farm.objects.filter(owner=request.user)
    ])
    ctx = _base_context(request, farm)
    ctx.update({
        "page": "farm_map",
        "trees_json": trees_json,
        "farms_json": farms_json,
        "total": total, "counts": counts, "diseased": diseased,
    })
    return render(request, "farm_map.html", ctx)


@login_required
def disease_detection(request):
    # Renders the disease detection upload page.
    farm = _get_farm_or_none(request)
    ctx = _base_context(request, farm)
    ctx.update({"page": "disease_detection"})
    return render(request, "disease_detection.html", ctx)


@login_required
def tree_inventory(request):
    # Renders the tree inventory table, filtered by the selected farm if set.
    farm = _get_farm_or_none(request)
    total, counts, pcts, diseased = _get_stats(request, farm)
    trees = _get_trees(request, farm).order_by("tree_id")
    ctx = _base_context(request, farm)
    ctx.update({
        "page": "tree_inventory",
        "trees": trees,
        "total": total, "counts": counts, "diseased": diseased,
    })
    return render(request, "tree_inventory.html", ctx)


@login_required
def tree_details(request, tree_id):
    # Renders the detail page for a single tree, including its scan history.
    tree = get_object_or_404(
        RubberTree.objects.select_related("farm"),
        tree_id=tree_id, farm__owner=request.user,
    )
    history = tree.history.all()
    farm = _get_farm_or_none(request)
    ctx = _base_context(request, farm)
    ctx.update({
        "page": "tree_inventory",
        "tree": tree,
        "history": history,
    })
    return render(request, "tree_details.html", ctx)


@login_required
def reports(request):
    # Renders the reports page with disease stats and a per-farm breakdown table.
    farm = _get_farm_or_none(request)
    total, counts, pcts, diseased = _get_stats(request, farm)
    farm_summaries = []
    for f in Farm.objects.filter(owner=request.user).order_by("farm_id"):
        ft, fc, fp, fd = f.get_stats()
        farm_summaries.append({
            "farm": f,
            "total": ft,
            "counts": fc,
            "pcts": fp,
            "diseased": fd,
        })
    ctx = _base_context(request, farm)
    ctx.update({
        "page": "reports",
        "total": total, "counts": counts, "pcts": pcts, "diseased": diseased,
        "monthly": MONTHLY_DETECTIONS,
        "farm_summaries": farm_summaries,
    })
    return render(request, "reports.html", ctx)


def _export_rows(request):
    # Returns the user's trees and a filename-safe label for the current export.
    farm = _get_farm_or_none(request)
    trees = _get_trees(request, farm).order_by("farm__farm_id", "tree_id")
    label = farm.farm_id if farm else "all_farms"
    return trees, label


@login_required
def export_csv(request):
    # Exports a summary-only CSV: overall disease totals and a per-farm breakdown.
    import csv
    from django.http import HttpResponse

    farm = _get_farm_or_none(request)
    total, counts, pcts, diseased = _get_stats(request, farm)
    label = farm.farm_id if farm else "all_farms"

    response = HttpResponse(content_type="text/csv")
    response["Content-Disposition"] = f'attachment; filename="rubberguard_summary_{label}.csv"'

    writer = csv.writer(response)
    writer.writerow(["RubberGuard Disease Detection Summary"])
    writer.writerow(["Scope", farm.name if farm else "All Farms"])
    writer.writerow([])
    writer.writerow(["Disease Class", "Count", "Percentage"])
    writer.writerow(["Healthy", counts["Healthy"], f'{pcts["Healthy"]}%'])
    writer.writerow(["Pink Disease", counts["Pink_Disease"], f'{pcts["Pink_Disease"]}%'])
    writer.writerow(["White Root Rot", counts["White_Root_Rot"], f'{pcts["White_Root_Rot"]}%'])
    writer.writerow(["Stem Bleeding", counts["Stem_Bleeding"], f'{pcts["Stem_Bleeding"]}%'])
    writer.writerow(["Total", total, "100%"])

    if not farm:
        writer.writerow([])
        writer.writerow(["Per-Farm Breakdown"])
        writer.writerow(["Farm ID", "Farm Name", "Owner", "Total Trees", "Healthy", "Pink Disease", "White Root Rot", "Stem Bleeding"])
        for f in Farm.objects.filter(owner=request.user).order_by("farm_id"):
            ft, fc, fp, fd = f.get_stats()
            writer.writerow([f.farm_id, f.name, f.owner_name, ft, fc["Healthy"], fc["Pink_Disease"], fc["White_Root_Rot"], fc["Stem_Bleeding"]])

    return response


@login_required
def export_excel(request):
    # Exports a summary-only Excel file: overall disease totals and a per-farm breakdown.
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill
    from django.http import HttpResponse

    farm = _get_farm_or_none(request)
    total, counts, pcts, diseased = _get_stats(request, farm)
    label = farm.farm_id if farm else "all_farms"

    header_font = Font(bold=True, color="FFFFFF")
    header_fill = PatternFill(start_color="1A2535", end_color="1A2535", fill_type="solid")
    title_font = Font(bold=True, size=13)

    wb = Workbook()
    ws = wb.active
    ws.title = "Summary"

    ws.append(["RubberGuard Disease Detection Summary"])
    ws["A1"].font = title_font
    ws.append(["Scope", farm.name if farm else "All Farms"])
    ws.append([])

    ws.append(["Disease Class", "Count", "Percentage"])
    for cell in ws[ws.max_row]:
        cell.font = header_font
        cell.fill = header_fill

    ws.append(["Healthy", counts["Healthy"], f'{pcts["Healthy"]}%'])
    ws.append(["Pink Disease", counts["Pink_Disease"], f'{pcts["Pink_Disease"]}%'])
    ws.append(["White Root Rot", counts["White_Root_Rot"], f'{pcts["White_Root_Rot"]}%'])
    ws.append(["Stem Bleeding", counts["Stem_Bleeding"], f'{pcts["Stem_Bleeding"]}%'])
    ws.append(["Total", total, "100%"])
    for cell in ws[ws.max_row]:
        cell.font = Font(bold=True)

    if not farm:
        ws.append([])
        ws.append(["Per-Farm Breakdown"])
        ws[f"A{ws.max_row}"].font = Font(bold=True, size=11)
        ws.append(["Farm ID", "Farm Name", "Owner", "Total Trees", "Healthy", "Pink Disease", "White Root Rot", "Stem Bleeding"])
        for cell in ws[ws.max_row]:
            cell.font = header_font
            cell.fill = header_fill
        for f in Farm.objects.filter(owner=request.user).order_by("farm_id"):
            ft, fc, fp, fd = f.get_stats()
            ws.append([f.farm_id, f.name, f.owner_name, ft, fc["Healthy"], fc["Pink_Disease"], fc["White_Root_Rot"], fc["Stem_Bleeding"]])

    for col in ws.columns:
        max_len = max((len(str(c.value)) if c.value else 0 for c in col), default=0)
        ws.column_dimensions[col[0].column_letter].width = min(max_len + 4, 40)

    response = HttpResponse(content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    response["Content-Disposition"] = f'attachment; filename="rubberguard_summary_{label}.xlsx"'
    wb.save(response)
    return response


def _build_pie_chart(counts, chart_width, chart_height):
    # Renders the disease distribution pie chart as a native ReportLab drawing.
    from reportlab.graphics.shapes import Drawing, String
    from reportlab.graphics.charts.piecharts import Pie
    from reportlab.lib import colors as rl_colors

    color_map = {
        "Healthy": rl_colors.HexColor("#28a745"),
        "Pink Disease": rl_colors.HexColor("#dc3545"),
        "White Root Rot": rl_colors.HexColor("#8b5a2b"),
        "Stem Bleeding": rl_colors.HexColor("#8b0000"),
    }

    pie_labels = ["Healthy", "Pink Disease", "White Root Rot", "Stem Bleeding"]
    pie_values = [counts["Healthy"], counts["Pink_Disease"], counts["White_Root_Rot"], counts["Stem_Bleeding"]]
    nonzero = [(l, v) for l, v in zip(pie_labels, pie_values) if v > 0]

    drawing = Drawing(chart_width, chart_height)
    drawing.add(String(chart_width / 2, chart_height - 12, "Disease Distribution",
                        fontSize=10, fontName="Helvetica-Bold", textAnchor="middle"))
    if nonzero:
        pie = Pie()
        pie.x = chart_width * 0.22
        pie.y = 10
        pie.width = chart_width * 0.56
        pie.height = chart_height * 0.75
        pie.data = [v for _, v in nonzero]
        pie.labels = [f"{l} ({v})" for l, v in nonzero]
        pie.slices.strokeWidth = 1
        pie.slices.strokeColor = rl_colors.white
        pie.simpleLabels = 0
        pie.sideLabels = 1
        for i, (label, _) in enumerate(nonzero):
            pie.slices[i].fillColor = color_map[label]
            pie.slices[i].fontSize = 6.5
        drawing.add(pie)
    else:
        drawing.add(String(chart_width / 2, chart_height / 2, "No data",
                            fontSize=9, textAnchor="middle"))
    return drawing


def _build_trend_chart(monthly, chart_width, chart_height):
    # Renders the monthly detection trend as a native ReportLab bar chart.
    from reportlab.graphics.shapes import Drawing, String
    from reportlab.graphics.charts.barcharts import VerticalBarChart
    from reportlab.graphics.charts.legends import Legend
    from reportlab.lib import colors as rl_colors

    color_map = {
        "Healthy": rl_colors.HexColor("#28a745"),
        "Pink Disease": rl_colors.HexColor("#dc3545"),
        "White Root Rot": rl_colors.HexColor("#8b5a2b"),
        "Stem Bleeding": rl_colors.HexColor("#8b0000"),
    }
    series_keys = [("healthy", "Healthy"), ("pink", "Pink Disease"),
                   ("white_root", "White Root Rot"), ("stem", "Stem Bleeding")]
    months = [m["month"] for m in monthly]
    trend_data = [[m[key] for m in monthly] for key, _ in series_keys]

    drawing = Drawing(chart_width, chart_height)
    drawing.add(String(chart_width / 2, chart_height - 12, "Monthly Detection Trend",
                        fontSize=10, fontName="Helvetica-Bold", textAnchor="middle"))

    bar = VerticalBarChart()
    bar.x = 45
    bar.y = 24
    bar.width = chart_width - 65
    bar.height = chart_height - 55
    bar.data = trend_data
    bar.categoryAxis.categoryNames = months
    bar.categoryAxis.labels.fontSize = 7
    bar.valueAxis.labels.fontSize = 7
    bar.valueAxis.valueMin = 0
    bar.valueAxis.forceZero = True
    bar.groupSpacing = 6
    bar.barSpacing = 1
    for i, (_, label) in enumerate(series_keys):
        bar.bars[i].fillColor = color_map[label]
    drawing.add(bar)

    legend = Legend()
    legend.x = chart_width - 5
    legend.y = chart_height - 20
    legend.dx = 8
    legend.dy = 8
    legend.fontSize = 6.5
    legend.alignment = "right"
    legend.columnMaximum = 4
    legend.colorNamePairs = [(color_map[label], label) for _, label in series_keys]
    drawing.add(legend)

    return drawing


@login_required
def export_pdf(request):
    # Exports a full-width PDF: KPI totals, disease/trend charts, and a per-tree table.
    from reportlab.lib.pagesizes import letter
    from reportlab.lib import colors
    from reportlab.lib.units import inch
    from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
    from reportlab.lib.styles import getSampleStyleSheet
    from django.http import HttpResponse

    trees, label = _export_rows(request)
    farm = _get_farm_or_none(request)
    total, counts, pcts, diseased = _get_stats(request, farm)

    response = HttpResponse(content_type="application/pdf")
    response["Content-Disposition"] = f'attachment; filename="rubberguard_report_{label}.pdf"'

    page_width, page_height = letter
    left_margin = right_margin = 0.5 * inch
    top_margin = bottom_margin = 0.6 * inch
    content_width = page_width - left_margin - right_margin

    doc = SimpleDocTemplate(
        response, pagesize=letter,
        leftMargin=left_margin, rightMargin=right_margin,
        topMargin=top_margin, bottomMargin=bottom_margin,
    )
    styles = getSampleStyleSheet()
    elements = []

    title = farm.name if farm else "All Farms"
    elements.append(Paragraph("RubberGuard Disease Detection Report", styles["Title"]))
    elements.append(Paragraph(f"Scope: {title}", styles["Normal"]))
    elements.append(Spacer(1, 14))

    summary_data = [
        ["Total Trees", "Healthy", "Pink Disease", "White Root Rot", "Stem Bleeding"],
        [str(total), str(counts["Healthy"]), str(counts["Pink_Disease"]), str(counts["White_Root_Rot"]), str(counts["Stem_Bleeding"])],
    ]
    summary_table = Table(summary_data, colWidths=[content_width / 5] * 5)
    summary_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1a2535")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e5e7eb")),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
    ]))
    elements.append(summary_table)
    elements.append(Spacer(1, 18))

    chart_h = 2.6 * inch
    pie_w = content_width * 0.38
    trend_w = content_width * 0.58
    pie_drawing = _build_pie_chart(counts, pie_w, chart_h)
    trend_drawing = _build_trend_chart(MONTHLY_DETECTIONS, trend_w, chart_h)
    chart_row = Table([[pie_drawing, trend_drawing]], colWidths=[content_width * 0.4, content_width * 0.6])
    chart_row.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
    ]))
    elements.append(chart_row)
    elements.append(Spacer(1, 20))

    tree_rows = [["Tree ID", "Farm", "Block", "Disease", "Conf. %", "Date Scanned"]]
    for t in trees:
        tree_rows.append([t.tree_id, t.farm.farm_id, t.block, t.disease, f"{t.confidence}%", str(t.date_scanned)])

    col_fractions = [0.16, 0.16, 0.12, 0.26, 0.14, 0.16]
    tree_table = Table(tree_rows, colWidths=[content_width * f for f in col_fractions], repeatRows=1)
    tree_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f3f4f6")),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e5e7eb")),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
    ]))
    elements.append(tree_table)

    doc.build(elements)
    return response
