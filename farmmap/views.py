import json
from django.shortcuts import render, get_object_or_404, redirect
from django.contrib.auth.decorators import login_required
from django.contrib.auth import login
from django.contrib.auth.forms import UserCreationForm
from django.contrib import messages
from django.urls import reverse
from django.utils import timezone
from django.db.models import Count, Q, Prefetch, Min, Max
from .models import Farm, RubberTree, ScanHistory, Intervention

# Icon and color shown in the notification bell for each disease type.
NOTIFICATION_STYLE = {
    "Pink Disease": {"icon": "bi-exclamation-triangle-fill", "color": "text-danger"},
    "White Root Rot": {"icon": "bi-exclamation-triangle-fill", "color": "text-warning"},
    "Stem Bleeding": {"icon": "bi-exclamation-triangle-fill", "color": "text-danger"},
}

DISEASE_FIELD_MAP = {
    "Healthy": "healthy", "Pink Disease": "pink",
    "White Root Rot": "white_root", "Stem Bleeding": "stem",
}


def _get_monthly_trend(request, farm=None):
    # Groups the user's actual scan history by month, counting each disease
    # type per month, for the "Reports Over Time" line chart.
    from collections import OrderedDict

    qs = ScanHistory.objects.filter(tree__farm__owner=request.user)
    if farm:
        qs = qs.filter(tree__farm=farm)
    qs = qs.select_related("tree").order_by("date")

    months = OrderedDict()
    for h in qs:
        key = h.date.strftime("%b %Y")
        if key not in months:
            months[key] = {"month": key, "healthy": 0, "pink": 0, "white_root": 0, "stem": 0}
        field = DISEASE_FIELD_MAP.get(h.disease)
        if field:
            months[key][field] += 1

    return list(months.values())


def _get_severity_counts(request, farm=None):
    # Returns tree counts by severity tier, using database-level filtering
    # on the stored severity_score instead of iterating every tree row and
    # computing severity_label in Python.
    qs = RubberTree.objects.filter(farm=farm) if farm else RubberTree.objects.filter(farm__owner=request.user)
    return {
        "Healthy": qs.filter(disease="Healthy").count(),
        "Mild": qs.exclude(disease="Healthy").filter(severity_score__lt=34).count(),
        "Moderate": qs.exclude(disease="Healthy").filter(severity_score__gte=34, severity_score__lt=67).count(),
        "Severe": qs.exclude(disease="Healthy").filter(severity_score__gte=67).count(),
    }


def _get_most_affected_farms(request, limit=8):
    # Returns farms ranked by diseased tree count, with a pre-computed bar
    # percentage relative to the worst-affected farm, for the "Most
    # Affected Areas" chart. Avoids divide-by-zero when nothing is diseased.
    ranked = []
    for f in Farm.objects.filter(owner=request.user):
        total, counts, pcts, diseased = f.get_stats()
        ranked.append({"label": f.name or f.farm_id, "farm_id": f.farm_id, "diseased": diseased, "total": total})
    ranked.sort(key=lambda r: r["diseased"], reverse=True)
    ranked = ranked[:limit]
    max_diseased = max((r["diseased"] for r in ranked), default=0)
    for r in ranked:
        r["bar_pct"] = round(r["diseased"] / max_diseased * 100, 1) if max_diseased else 0
    return ranked


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
    # Aggregates disease counts and percentages for one farm or all the
    # user's farms, using a single GROUP BY-style query instead of looping
    # over every tree row in Python (matters once farms have thousands of
    # trees each).
    qs = RubberTree.objects.filter(farm=farm) if farm else RubberTree.objects.filter(farm__owner=request.user)
    total = qs.count()
    raw_counts = dict(qs.values_list("disease").annotate(n=Count("id")).values_list("disease", "n"))
    counts = {
        "Healthy": raw_counts.get("Healthy", 0),
        "Pink_Disease": raw_counts.get("Pink Disease", 0),
        "White_Root_Rot": raw_counts.get("White Root Rot", 0),
        "Stem_Bleeding": raw_counts.get("Stem Bleeding", 0),
    }
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
        boundary_radius_m = request.POST.get("boundary_radius_m") or 300

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
            boundary_radius_m=int(boundary_radius_m),
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
    # Renders the dashboard: summary cards, recent detections, and a map preview.
    farm = _get_farm_or_none(request)
    total, counts, pcts, diseased = _get_stats(request, farm)
    severity_counts = _get_severity_counts(request, farm)
    trees = list(
        _get_trees(request, farm).select_related("farm")
        .prefetch_related(
            Prefetch("history", queryset=ScanHistory.objects.order_by("-date")),
            Prefetch("interventions", queryset=Intervention.objects.order_by("-date_performed")),
        )
        .order_by("-date_scanned")[:6]
    )
    recent = [t.to_dict() for t in trees]

    # Dashboard map is a quick-glance preview, not the full farm map, so cap
    # it to a bounded sample instead of serializing every tree (which would
    # be thousands of rows once farms have realistic data volumes).
    map_trees = list(
        _get_trees(request, farm).select_related("farm")
        .exclude(disease="Healthy").order_by("-date_scanned")[:200]
    )
    farm_count = Farm.objects.filter(owner=request.user).count()

    ctx = _base_context(request, farm)
    ctx.update({
        "page": "dashboard",
        "total": total, "counts": counts, "pcts": pcts, "diseased": diseased,
        "severity_counts": severity_counts,
        "healthy_count": counts["Healthy"],
        "areas_with_cases": Farm.objects.filter(owner=request.user, trees__disease__in=[
            "Pink Disease", "White Root Rot", "Stem Bleeding"
        ]).distinct().count() if not farm else (1 if diseased else 0),
        "farm_count": farm_count,
        "recent": recent,
        "trees_json": json.dumps([t.to_map_dict() for t in map_trees]),
        "latest_scan": recent[0]["date_scanned"] if recent else "—",
    })
    return render(request, "dashboard.html", ctx)


@login_required
def farm_map(request):
    # Renders the interactive Leaflet map for exactly one farm at a time.
    # If no farm is explicitly selected, defaults to the user's first farm
    # (by farm_id) rather than showing every farm's trees together, since
    # combining thousands of trees from multiple farms onto one map doesn't
    # scale visually or performance-wise.
    farm = _get_farm_or_none(request)
    if not farm:
        farm = Farm.objects.filter(owner=request.user).order_by("farm_id").first()

    if not farm:
        ctx = _base_context(request, None)
        ctx.update({"page": "farm_map", "no_farms": True})
        return render(request, "farm_map.html", ctx)

    total, counts, pcts, diseased = farm.get_stats()
    trees_qs = farm.trees.all()
    markers_json = json.dumps([t.to_marker_dict() for t in trees_qs])

    # Bounding box around this farm's actual trees (falling back to the
    # farm's boundary radius if it has no trees yet), used to lock the map
    # so the user can zoom in freely but not zoom out past their own farm.
    bounds = trees_qs.aggregate(
        min_lat=Min("lat"), max_lat=Max("lat"),
        min_lng=Min("lng"), max_lng=Max("lng"),
    )
    if bounds["min_lat"] is None:
        # No trees yet — build a small bounding box around the farm center
        # using its boundary radius (roughly converting meters to degrees).
        deg_pad = max(farm.boundary_radius_m, 200) / 111000
        bounds = {
            "min_lat": farm.center_lat - deg_pad, "max_lat": farm.center_lat + deg_pad,
            "min_lng": farm.center_lng - deg_pad, "max_lng": farm.center_lng + deg_pad,
        }

    ctx = _base_context(request, farm)
    ctx.update({
        "page": "farm_map",
        "markers_json": markers_json,
        "map_bounds": json.dumps(bounds),
        "total": total, "counts": counts, "diseased": diseased,
    })
    return render(request, "farm_map.html", ctx)


@login_required
def tree_marker_detail(request, tree_id):
    # Returns full marker popup detail (recommended action, notes, latest
    # inspector, latest intervention) for a single tree as JSON. Called via
    # AJAX only when a marker is actually clicked, instead of embedding
    # this for every tree on initial map load.
    from django.http import JsonResponse
    tree = get_object_or_404(
        RubberTree.objects.select_related("farm")
        .prefetch_related(
            Prefetch("history", queryset=ScanHistory.objects.order_by("-date")),
            Prefetch("interventions", queryset=Intervention.objects.order_by("-date_performed")),
        ),
        tree_id=tree_id, farm__owner=request.user,
    )
    return JsonResponse(tree.to_dict())


@login_required
def disease_detection(request):
    # Renders the disease detection upload page.
    farm = _get_farm_or_none(request)
    ctx = _base_context(request, farm)
    ctx.update({"page": "disease_detection"})
    return render(request, "disease_detection.html", ctx)


@login_required
def save_detection(request):
    # Saves a simulated (or future real) CNN detection result as a new tree.
    import datetime

    if request.method != "POST":
        return redirect("disease_detection")

    farm_pk = request.POST.get("farm_pk")
    disease = request.POST.get("disease", "Healthy")
    confidence = request.POST.get("confidence", "0")
    tree_id = request.POST.get("tree_id", "").strip()
    block = request.POST.get("block", "").strip()

    farm = get_object_or_404(Farm, pk=farm_pk, owner=request.user)

    if not tree_id:
        existing = farm.trees.count()
        tree_id = f"RT-{existing + 1:04d}"

    if farm.trees.filter(tree_id=tree_id).exists():
        messages.error(request, f"Tree ID '{tree_id}' already exists on this farm.")
        return redirect("disease_detection")

    action_map = {
        "Healthy": "No action needed. Continue regular monitoring every 30 days.",
        "Pink Disease": "Apply fungicide (Mancozeb 80% WP) immediately. Remove infected bark.",
        "White Root Rot": "Uproot and destroy infected roots. Treat soil with Trichoderma biocontrol.",
        "Stem Bleeding": "Scrape off infected bark. Apply Metalaxyl paste. Avoid tapping 60 days.",
    }

    tree = RubberTree.objects.create(
        farm=farm, tree_id=tree_id,
        lat=farm.center_lat, lng=farm.center_lng,
        disease=disease, confidence=float(confidence),
        date_scanned=datetime.date.today(), block=block,
        recommended_action=action_map.get(disease, ""),
    )
    ScanHistory.objects.create(
        tree=tree, date=datetime.date.today(),
        disease=disease, confidence=float(confidence), inspector=request.user.username,
    )
    messages.success(request, f"Detection saved as tree '{tree_id}'.")
    return redirect("tree_details", tree_id=tree_id)


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
    # Renders the reports page: severity distribution, trend over time,
    # most-affected areas, detection summary, an interactive heatmap, and
    # a per-farm breakdown table.
    farm = _get_farm_or_none(request)
    total, counts, pcts, diseased = _get_stats(request, farm)
    severity_counts = _get_severity_counts(request, farm)
    monthly = _get_monthly_trend(request, farm)
    most_affected = _get_most_affected_farms(request)
    map_trees = list(
        _get_trees(request, farm).select_related("farm")
        .exclude(disease="Healthy").order_by("-date_scanned")[:200]
    )

    farm_summaries = []
    for f in Farm.objects.filter(owner=request.user).order_by("farm_id"):
        ft, fc, fp, fd = f.get_stats()
        farm_summaries.append({
            "farm": f, "total": ft, "counts": fc, "pcts": fp, "diseased": fd,
        })

    ctx = _base_context(request, farm)
    ctx.update({
        "page": "reports",
        "total": total, "counts": counts, "pcts": pcts, "diseased": diseased,
        "severity_counts": severity_counts,
        "monthly": monthly,
        "most_affected": most_affected,
        "farm_summaries": farm_summaries,
        "trees_json": json.dumps([t.to_map_dict() for t in map_trees]),
    })
    return render(request, "reports.html", ctx)


@login_required
def interventions_map(request):
    # Renders a dedicated map showing every tree that has had at least one
    # intervention logged, so users can see where treatment work has
    # actually happened rather than just where disease was detected. This
    # set is naturally small (only treated trees), so the fuller to_dict()
    # with intervention/inspector detail is fine here.
    farm = _get_farm_or_none(request)
    trees_qs = (
        _get_trees(request, farm).select_related("farm")
        .prefetch_related(
            Prefetch("history", queryset=ScanHistory.objects.order_by("-date")),
            Prefetch("interventions", queryset=Intervention.objects.order_by("-date_performed")),
        )
        .filter(interventions__isnull=False).distinct()
    )
    ctx = _base_context(request, farm)
    ctx.update({
        "page": "interventions",
        "trees_json": json.dumps([t.to_dict() for t in trees_qs]),
        "intervention_count": Intervention.objects.filter(tree__farm__owner=request.user).count(),
    })
    return render(request, "interventions_map.html", ctx)


@login_required
def interventions_log(request):
    # Lists all logged interventions for the user's trees, most recent first.
    farm = _get_farm_or_none(request)
    qs = Intervention.objects.select_related("tree", "tree__farm", "performed_by").filter(
        tree__farm__owner=request.user
    )
    if farm:
        qs = qs.filter(tree__farm=farm)
    qs = qs.order_by("-date_performed", "-created_at")

    # Pre-built {farm_pk: [{tree_id, disease}, ...]} lookup for the
    # checklist-mode tree selector in the log-intervention form. Capped
    # since farms can have thousands of trees; range mode (the primary
    # selection method) has no such limit.
    CHECKLIST_TREE_LIMIT = 300
    farm_trees = {}
    for f in Farm.objects.filter(owner=request.user):
        farm_trees[str(f.pk)] = [
            {"tree_id": t.tree_id, "disease": t.disease}
            for t in f.trees.order_by("tree_id")[:CHECKLIST_TREE_LIMIT]
        ]

    ctx = _base_context(request, farm)
    ctx.update({
        "page": "interventions",
        "interventions": qs,
        "farm_trees_json": json.dumps(farm_trees),
    })
    return render(request, "interventions_log.html", ctx)


@login_required
def intervention_create(request):
    # Logs a new intervention against one or more trees, selected either by
    # a tree ID range (e.g. RT-001 to RT-005) or by explicit tree IDs
    # (e.g. checked off via the map).
    import datetime

    if request.method != "POST":
        return redirect("interventions_log")

    action = request.POST.get("action", "Other")
    date_performed = request.POST.get("date_performed") or str(datetime.date.today())
    notes = request.POST.get("notes", "").strip()
    farm_pk = request.POST.get("farm_pk")
    selection_mode = request.POST.get("selection_mode", "single")

    farm = get_object_or_404(Farm, pk=farm_pk, owner=request.user)
    trees = RubberTree.objects.none()

    if selection_mode == "range":
        start_id = request.POST.get("range_start", "").strip()
        end_id = request.POST.get("range_end", "").strip()
        all_ids = list(farm.trees.order_by("tree_id").values_list("tree_id", flat=True))
        try:
            start_i = all_ids.index(start_id)
            end_i = all_ids.index(end_id)
            selected_ids = all_ids[min(start_i, end_i):max(start_i, end_i) + 1]
            trees = farm.trees.filter(tree_id__in=selected_ids)
        except ValueError:
            messages.error(request, "Invalid tree ID range. Check that both IDs exist on this farm.")
            return redirect("interventions_log")
    else:
        tree_ids = request.POST.getlist("tree_ids")
        trees = farm.trees.filter(tree_id__in=tree_ids)

    if not trees.exists():
        messages.error(request, "No trees were selected for this intervention.")
        return redirect("interventions_log")

    created = 0
    for tree in trees:
        Intervention.objects.create(
            tree=tree, performed_by=request.user, action=action,
            date_performed=date_performed, notes=notes,
        )
        created += 1

    messages.success(request, f"Logged '{action}' on {created} tree(s).")
    return redirect("interventions_log")


def _export_rows(request):
    # Returns the user's trees and a filename-safe label for the current export.
    farm = _get_farm_or_none(request)
    trees = _get_trees(request, farm).select_related("farm").order_by("farm__farm_id", "tree_id")
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
    legend.x = chart_width - 70
    legend.y = chart_height - 22
    legend.dx = 7
    legend.dy = 7
    legend.fontSize = 6.5
    legend.alignment = "right"
    legend.columnMaximum = 4
    legend.deltay = 9
    legend.colorNamePairs = [(color_map[label], label) for _, label in series_keys]
    drawing.add(legend)

    return drawing


@login_required
def export_pdf(request):
    # Exports a landscape PDF report with KPI summary, charts, and a per-tree
    # table. Landscape avoids column/text truncation that portrait caused
    # with this much side-by-side content.
    from reportlab.lib.pagesizes import letter, landscape
    from reportlab.lib import colors
    from reportlab.lib.units import inch
    from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, KeepInFrame
    from reportlab.lib.styles import getSampleStyleSheet
    from django.http import HttpResponse

    trees, label = _export_rows(request)
    farm = _get_farm_or_none(request)
    total, counts, pcts, diseased = _get_stats(request, farm)
    severity_counts = _get_severity_counts(request, farm)
    monthly = _get_monthly_trend(request, farm)

    farm_summaries = []
    if not farm:
        for f in Farm.objects.filter(owner=request.user).order_by("farm_id"):
            ft, fc, fp, fd = f.get_stats()
            farm_summaries.append((f.farm_id, f.name, ft, fc["Healthy"], fc["Pink_Disease"], fc["White_Root_Rot"], fc["Stem_Bleeding"]))

    intervention_qs = Intervention.objects.select_related("tree", "tree__farm").filter(tree__farm__owner=request.user)
    if farm:
        intervention_qs = intervention_qs.filter(tree__farm=farm)
    intervention_qs = intervention_qs.order_by("-date_performed")[:15]

    response = HttpResponse(content_type="application/pdf")
    response["Content-Disposition"] = f'attachment; filename="rubberguard_report_{label}.pdf"'

    page_size = landscape(letter)
    page_width, page_height = page_size
    left_margin = right_margin = 0.5 * inch
    top_margin = bottom_margin = 0.5 * inch
    content_width = page_width - left_margin - right_margin

    doc = SimpleDocTemplate(
        response, pagesize=page_size,
        leftMargin=left_margin, rightMargin=right_margin,
        topMargin=top_margin, bottomMargin=bottom_margin,
    )
    styles = getSampleStyleSheet()
    elements = []

    title = farm.name if farm else "All Farms"
    elements.append(Paragraph("RubberGuard Disease Detection Report", styles["Title"]))
    elements.append(Paragraph(f"Scope: {title} &nbsp;&nbsp;|&nbsp;&nbsp; Generated: {timezone.localdate()}", styles["Normal"]))
    elements.append(Spacer(1, 10))

    # KPI summary row
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
    elements.append(Spacer(1, 8))

    # Severity summary row
    severity_data = [
        ["Healthy", "Mild", "Moderate", "Severe"],
        [str(severity_counts["Healthy"]), str(severity_counts["Mild"]), str(severity_counts["Moderate"]), str(severity_counts["Severe"])],
    ]
    severity_table = Table(severity_data, colWidths=[content_width / 4] * 4)
    severity_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#dcfce7")),
        ("BACKGROUND", (1, 0), (1, -1), colors.HexColor("#fef3c7")),
        ("BACKGROUND", (2, 0), (2, -1), colors.HexColor("#fed7aa")),
        ("BACKGROUND", (3, 0), (3, -1), colors.HexColor("#fecaca")),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e5e7eb")),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
    ]))
    elements.append(Paragraph("Severity Distribution", styles["Heading4"]))
    elements.append(severity_table)
    elements.append(Spacer(1, 14))

    # Charts row — pie and trend, wrapped in KeepInFrame so they can never
    # overflow their allotted space regardless of label length.
    chart_h = 2.2 * inch
    pie_w = content_width * 0.32
    trend_w = content_width * 0.64
    pie_drawing = _build_pie_chart(counts, pie_w, chart_h)
    trend_drawing = _build_trend_chart(monthly, trend_w, chart_h)
    pie_frame = KeepInFrame(pie_w, chart_h, [pie_drawing])
    trend_frame = KeepInFrame(trend_w, chart_h, [trend_drawing])
    chart_row = Table([[pie_frame, trend_frame]], colWidths=[content_width * 0.34, content_width * 0.66])
    chart_row.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
    ]))
    elements.append(chart_row)
    elements.append(Spacer(1, 14))

    # Per-farm breakdown (only when viewing all farms)
    if farm_summaries:
        farm_rows = [["Farm ID", "Farm Name", "Total", "Healthy", "Pink Disease", "White Root Rot", "Stem Bleeding"]] + \
            [[str(v) for v in row] for row in farm_summaries]
        farm_table = Table(farm_rows, colWidths=[content_width * f for f in [0.12, 0.28, 0.12, 0.12, 0.14, 0.12, 0.10]])
        farm_table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f3f4f6")),
            ("FONTSIZE", (0, 0), (-1, -1), 8),
            ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e5e7eb")),
            ("ALIGN", (0, 0), (-1, -1), "CENTER"),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
        ]))
        elements.append(Paragraph("Per-Farm Breakdown", styles["Heading4"]))
        elements.append(farm_table)
        elements.append(Spacer(1, 14))

    # Per-tree table — capped since PDF generation gets slow and the file
    # becomes unwieldy past a few hundred rows. CSV/Excel exports remain
    # uncapped for anyone who needs the complete dataset.
    PDF_TREE_ROW_LIMIT = 300
    tree_list = list(trees[:PDF_TREE_ROW_LIMIT])
    total_tree_count = trees.count()

    heading = "Tree-Level Detail"
    if total_tree_count > PDF_TREE_ROW_LIMIT:
        heading += f" (showing {PDF_TREE_ROW_LIMIT} of {total_tree_count} — use CSV/Excel export for the full list)"
    elements.append(Paragraph(heading, styles["Heading4"]))

    tree_rows = [["Tree ID", "Farm", "Block", "Disease", "Conf. %", "Date Scanned"]]
    for t in tree_list:
        tree_rows.append([t.tree_id, t.farm.farm_id, t.block, t.disease, f"{t.confidence}%", str(t.date_scanned)])

    col_fractions = [0.14, 0.16, 0.10, 0.28, 0.14, 0.18]
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
    elements.append(Spacer(1, 14))

    # Recent interventions
    if intervention_qs:
        elements.append(Paragraph("Recent Interventions", styles["Heading4"]))
        iv_rows = [["Tree ID", "Farm", "Action", "Date", "Notes"]]
        for iv in intervention_qs:
            iv_rows.append([iv.tree.tree_id, iv.tree.farm.farm_id, iv.action, str(iv.date_performed), (iv.notes or "—")[:40]])
        iv_table = Table(iv_rows, colWidths=[content_width * f for f in [0.12, 0.12, 0.22, 0.12, 0.42]])
        iv_table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f0fdf4")),
            ("FONTSIZE", (0, 0), (-1, -1), 8),
            ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e5e7eb")),
            ("ALIGN", (0, 0), (0, -1), "CENTER"),
            ("ALIGN", (1, 0), (3, -1), "CENTER"),
            ("ALIGN", (4, 0), (4, -1), "LEFT"),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
        ]))
        elements.append(iv_table)

    doc.build(elements)
    return response
