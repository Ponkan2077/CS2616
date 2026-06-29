import json
from django.shortcuts import render, get_object_or_404, redirect
from .models import Farm, RubberTree, ScanHistory

NOTIFICATIONS = [
    {"icon": "bi-exclamation-triangle-fill", "color": "text-danger",
     "msg": "Pink Disease detected at Tree RT-021", "time": "2 hrs ago"},
    {"icon": "bi-exclamation-triangle-fill", "color": "text-warning",
     "msg": "White Root Rot detected at Tree RT-105", "time": "5 hrs ago"},
    {"icon": "bi-exclamation-triangle-fill", "color": "text-danger",
     "msg": "Stem Bleeding detected at Tree RT-078", "time": "1 day ago"},
    {"icon": "bi-info-circle-fill", "color": "text-success",
     "msg": "Scan completed — Block A (50 trees)", "time": "2 days ago"},
]

MONTHLY_DETECTIONS = [
    {"month": "Jan", "healthy": 48, "pink": 2, "white_root": 1, "stem": 0},
    {"month": "Feb", "healthy": 47, "pink": 2, "white_root": 1, "stem": 1},
    {"month": "Mar", "healthy": 46, "pink": 3, "white_root": 2, "stem": 1},
    {"month": "Apr", "healthy": 45, "pink": 3, "white_root": 2, "stem": 2},
    {"month": "May", "healthy": 44, "pink": 4, "white_root": 2, "stem": 2},
    {"month": "Jun", "healthy": 43, "pink": 4, "white_root": 3, "stem": 2},
]


# Retrieves the currently selected Farm from the session, or returns None.
def _get_farm_or_none(request):
    farm_id = request.session.get("selected_farm_id")
    if farm_id:
        return Farm.objects.filter(pk=farm_id).first()
    return None


# Returns a queryset of trees filtered by farm, or all trees if no farm is given.
def _get_trees(farm=None):
    qs = RubberTree.objects.select_related("farm")
    if farm:
        qs = qs.filter(farm=farm)
    return qs


# Aggregates disease counts and percentages for the selected farm, or all farms if none is selected.
def _get_stats(farm=None):
    if farm:
        return farm.get_stats()
    trees = RubberTree.objects.all()
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


# Builds the base template context shared across all views.
def _base_context(request, farm=None):
    all_farms = Farm.objects.all().order_by("farm_id")
    return {
        "notifications": NOTIFICATIONS,
        "all_farms": all_farms,
        "selected_farm": farm,
    }


# Saves the selected farm to the session and redirects back to the current page.
def select_farm(request):
    farm_pk = request.POST.get("farm_pk", "")
    if farm_pk:
        request.session["selected_farm_id"] = int(farm_pk)
    else:
        request.session.pop("selected_farm_id", None)
    next_url = request.POST.get("next", "/")
    return redirect(next_url)


# Displays a list of all registered farms.
def farm_list(request):
    farms = Farm.objects.all().order_by("farm_id")
    ctx = _base_context(request)
    ctx.update({"page": "farm_list", "farms": farms})
    return render(request, "farm_list.html", ctx)


# Displays the details, stats, and tree list for a single farm.
def farm_detail(request, farm_id):
    farm = get_object_or_404(Farm, farm_id=farm_id)
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


# Renders the main dashboard with disease stats and recently scanned trees.
def dashboard(request):
    farm = _get_farm_or_none(request)
    total, counts, pcts, diseased = _get_stats(farm)
    trees = list(_get_trees(farm).order_by("-date_scanned")[:6])
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


# Renders the interactive Leaflet map with tree markers and farm center layers.
def farm_map(request):
    farm = _get_farm_or_none(request)
    total, counts, pcts, diseased = _get_stats(farm)
    trees_qs = _get_trees(farm)
    trees_json = json.dumps([t.to_dict() for t in trees_qs])
    farms_json = json.dumps([
        {
            "farm_id": f.farm_id,
            "name": f.name,
            "owner": f.owner_name,
            "lat": f.center_lat,
            "lng": f.center_lng,
        }
        for f in Farm.objects.all()
    ])
    ctx = _base_context(request, farm)
    ctx.update({
        "page": "farm_map",
        "trees_json": trees_json,
        "farms_json": farms_json,
        "total": total, "counts": counts, "diseased": diseased,
    })
    return render(request, "farm_map.html", ctx)


# Renders the disease detection upload page.
def disease_detection(request):
    farm = _get_farm_or_none(request)
    ctx = _base_context(request, farm)
    ctx.update({"page": "disease_detection"})
    return render(request, "disease_detection.html", ctx)


# Renders the full tree inventory table, filtered by the selected farm if set.
def tree_inventory(request):
    farm = _get_farm_or_none(request)
    total, counts, pcts, diseased = _get_stats(farm)
    trees = _get_trees(farm).order_by("tree_id")
    ctx = _base_context(request, farm)
    ctx.update({
        "page": "tree_inventory",
        "trees": trees,
        "total": total, "counts": counts, "diseased": diseased,
    })
    return render(request, "tree_inventory.html", ctx)


# Renders the detail page for a single tree, including its scan history.
def tree_details(request, tree_id):
    tree = get_object_or_404(RubberTree.objects.select_related("farm"), tree_id=tree_id)
    history = tree.history.all()
    farm = _get_farm_or_none(request)
    ctx = _base_context(request, farm)
    ctx.update({
        "page": "tree_inventory",
        "tree": tree,
        "history": history,
    })
    return render(request, "tree_details.html", ctx)


# Renders the reports page with disease stats and a per-farm breakdown table.
def reports(request):
    farm = _get_farm_or_none(request)
    total, counts, pcts, diseased = _get_stats(farm)
    farm_summaries = []
    for f in Farm.objects.all().order_by("farm_id"):
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
