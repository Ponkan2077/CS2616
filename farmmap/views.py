import json
from django.shortcuts import render, get_object_or_404, redirect
from django.contrib.auth.decorators import login_required
from django.contrib.auth import login
from django.contrib.auth.forms import UserCreationForm
from django.contrib import messages
from django.urls import reverse
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


def _get_farm_or_none(request):
    # Retrieves the currently selected Farm from the session, scoped to the
    # logged-in user, or returns None if nothing is selected or it isn't theirs.
    farm_id = request.session.get("selected_farm_id")
    if farm_id:
        return Farm.objects.filter(pk=farm_id, owner=request.user).first()
    return None


def _get_trees(request, farm=None):
    # Returns a queryset of trees belonging to the logged-in user's farms,
    # optionally filtered down to a single farm.
    qs = RubberTree.objects.select_related("farm").filter(farm__owner=request.user)
    if farm:
        qs = qs.filter(farm=farm)
    return qs


def _get_stats(request, farm=None):
    # Aggregates disease counts and percentages for the selected farm, or
    # across all of the logged-in user's farms if none is selected.
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
    # Builds the base template context shared across all views, scoped to
    # the logged-in user's own farms.
    all_farms = Farm.objects.filter(owner=request.user).order_by("farm_id")
    return {
        "notifications": NOTIFICATIONS,
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
        # Only allow selecting a farm the logged-in user actually owns.
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
    # Displays the details, stats, and tree list for a single farm owned by the user.
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
    # Renders the full tree inventory table, filtered by the selected farm if set.
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
    # Renders the detail page for a single tree owned by the user, including its scan history.
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
