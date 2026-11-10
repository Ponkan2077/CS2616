import hashlib
import json
import logging
import math
import re
import datetime
from django.conf import settings
from django.core import signing
from django.shortcuts import render, get_object_or_404, redirect
from django.http import JsonResponse
from django.contrib.auth.decorators import login_required
from django.contrib.admin.views.decorators import staff_member_required
from django.contrib.auth import login
from django.contrib.auth import views as auth_views
from django.contrib.auth.forms import UserCreationForm
from django.contrib import messages
from django.core.exceptions import PermissionDenied
from django.urls import reverse, NoReverseMatch
from django.utils import timezone
from django.utils.http import url_has_allowed_host_and_scheme
from django.core.cache import cache
from django.core.paginator import Paginator
from django.db.models import Count, Q, Prefetch, Min, Max, Avg, Exists, OuterRef
from .models import (
    Farm, RubberTree, ScanHistory, Intervention, DiseaseClass, UserSettings,
    NotificationDismissal, get_disease_lookup, get_healthy_names, get_min_gps_points,
)
from .imaging import resize_for_storage, is_valid_image
from . import ai_inference
from . import storage_stats
from . import direct_upload

logger = logging.getLogger(__name__)

# --- small shared helpers (input validation / safe JSON for <script>) ------

# Tree and farm IDs end up in URL paths (/inventory/<tree_id>/), so they may
# not contain "/", "?", "#", "%" and similar. Letters (any language), digits,
# spaces, dashes, dots and underscores are allowed; must start with a letter
# or digit.
_ID_RE = re.compile(r"\w[\w .\-]*")
TREE_ID_MAX_LENGTH = 40   # RubberTree.tree_id max_length
FARM_ID_MAX_LENGTH = 20   # leaves room for "-RT-0001" style suffixes

# Max presigned-upload URLs one user can request per day (2 per scan).
UPLOAD_URLS_PER_DAY = 1000
# Max AI model calls one user can trigger per day (analyze, plus the fallback
# run at save). Each call costs a request to the hosted model, and sign-up is
# open, so one account must not be able to run it up. Above UPLOAD_URLS_PER_DAY
# / 2 scans so a long bulk-upload day is never blocked.
ANALYZE_CALLS_PER_DAY = 800
# Max issued upload keys remembered per session (see request_upload_url).
ISSUED_KEYS_KEPT = 500

# Largest single photo accepted through the normal (multipart) upload. The
# phone shrinks photos to ~100 KB WebP before sending, so this is only a
# ceiling for older browsers that send the original.
MAX_PHOTO_UPLOAD_BYTES = 12 * 1024 * 1024

# Login throttling: after this many wrong passwords for one username, further
# attempts for it are refused until the window passes. Counted per username
# (not per IP) because behind PythonAnywhere's proxy the IP can't be trusted.
LOGIN_MAX_FAILURES = 10
LOGIN_FAILURE_WINDOW_S = 15 * 60

# Longest a disease class name may be (DiseaseClass.name max_length) and the
# characters it may use. It is shown all over the app and must match the
# model's class label, so plain words only.
DISEASE_NAME_MAX_LENGTH = 50
_DISEASE_NAME_RE = re.compile(r"\w[\w .\-()]*")

_JS_ESCAPES = {
    ord("<"): "\\u003c", ord(">"): "\\u003e", ord("&"): "\\u0026",
    0x2028: "\\u2028", 0x2029: "\\u2029",
}


def _json_for_script(obj, **kwargs):
    # json.dumps() output that is safe to drop inside an inline <script>
    # block with |safe: "<", ">" and "&" become \uXXXX escapes (still valid
    # JSON/JS), so a value like "</script><script>..." can't end the block.
    return json.dumps(obj, **kwargs).translate(_JS_ESCAPES)


def _is_valid_id(value, max_length):
    return bool(value) and len(value) <= max_length and _ID_RE.fullmatch(value) is not None


def _take_daily_slot(name, user, limit):
    # Counts one use of a per-user daily allowance (cache key per user and
    # day). Returns False once `limit` uses have been taken today.
    key = f"{name}:{user.pk}:{timezone.localdate().isoformat()}"
    cache.add(key, 0, timeout=86400)
    try:
        used_today = cache.incr(key)
    except ValueError:  # key expired between add() and incr()
        cache.set(key, 1, timeout=86400)
        used_today = 1
    return used_today <= limit


class PhotoError(ValueError):
    """An uploaded photo is too big or isn't a JPEG/PNG/WebP image."""


def _read_photo(upload):
    # Reads one uploaded photo into bytes, after checking its size and that it
    # really is an image. Used before the bytes go to the AI model or storage,
    # so a file that only claims to be a photo is stopped here.
    if upload.size > MAX_PHOTO_UPLOAD_BYTES:
        raise PhotoError("One of the photos is too large. Please use a smaller photo.")
    data = upload.read()
    upload.seek(0)
    if not is_valid_image(data):
        raise PhotoError("One of the files isn't a valid photo (use JPEG, PNG or WebP).")
    return data


def _safe_cell(value):
    # Spreadsheet programs run a cell that starts with = + - @ (or tab / CR) as
    # a formula. Farm names and disease names are typed by users or admins, so
    # an export prefixes such text with an apostrophe to keep it plain text.
    if isinstance(value, str) and value[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + value
    return value


class ThrottledLoginView(auth_views.LoginView):
    """Django's login with a limit on wrong passwords per username. Stops
    password guessing: after LOGIN_MAX_FAILURES misses the account's login is
    paused for LOGIN_FAILURE_WINDOW_S seconds, and a correct sign-in resets
    the count."""

    @staticmethod
    def _failure_key(username):
        digest = hashlib.sha256(username.strip().lower().encode("utf-8")).hexdigest()
        return f"login-failures:{digest}"

    def post(self, request, *args, **kwargs):
        username = request.POST.get("username", "")
        if cache.get(self._failure_key(username), 0) >= LOGIN_MAX_FAILURES:
            messages.error(
                request,
                "Too many failed sign-in attempts. Please wait 15 minutes, then try again.",
            )
            return redirect("login")
        return super().post(request, *args, **kwargs)

    def form_invalid(self, form):
        key = self._failure_key(self.request.POST.get("username", ""))
        cache.add(key, 0, timeout=LOGIN_FAILURE_WINDOW_S)
        try:
            cache.incr(key)
        except ValueError:  # expired between add() and incr()
            cache.set(key, 1, timeout=LOGIN_FAILURE_WINDOW_S)
        return super().form_invalid(form)

    def form_valid(self, form):
        cache.delete(self._failure_key(self.request.POST.get("username", "")))
        return super().form_valid(form)


def _parse_confidence(value):
    # float() accepts "nan"/"inf"; the DB column is NOT NULL and the value
    # is a percentage, so anything non-finite is rejected (None) and the
    # rest is clamped to 0-100.
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return max(0.0, min(100.0, number))


def _parse_gps_accuracy(value):
    # Optional horizontal accuracy (metres) that came with a scan's GPS fix.
    # Anything that isn't a sane, non-negative number counts as "unknown"
    # (None) instead of failing the save.
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number) or number < 0:
        return None
    return number


def _distance_km(lat1, lng1, lat2, lng2):
    # Great-circle (haversine) distance in kilometres.
    to_rad = math.radians
    d_lat = to_rad(lat2 - lat1)
    d_lng = to_rad(lng2 - lng1)
    a = math.sin(d_lat / 2) ** 2 + math.cos(to_rad(lat1)) * math.cos(to_rad(lat2)) * math.sin(d_lng / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(a))


def _distance_from_farm_km(farm, lat, lng):
    # Distance from (lat, lng) to the average position of the farm's trees,
    # or None when the farm doesn't have enough trees yet to judge (its first
    # few trees are what define where the farm is). One cheap aggregate query.
    stats = farm.trees.aggregate(n=Count("id"), mean_lat=Avg("lat"), mean_lng=Avg("lng"))
    if (stats["n"] or 0) < settings.FARM_DISTANCE_CHECK_MIN_TREES:
        return None
    return _distance_km(lat, lng, stats["mean_lat"], stats["mean_lng"])


# --- signed analysis result -------------------------------------------------
# /detection/analyze/ already ran the model on these two photos. Instead of
# running it a second time at save, it hands back a signed token that holds
# the result plus a fingerprint of the exact photos and the user it was made
# for. save_detection() trusts the result only if the signature is valid, it's
# recent, and the photos being saved are byte-for-byte the ones analysed --
# so it still can't be forged or reused for different photos.
ANALYSIS_TOKEN_SALT = "rubberguard.analysis-result"


def _analysis_fingerprint(root_bytes, trunk_bytes):
    digest = hashlib.sha256()
    digest.update(len(root_bytes).to_bytes(8, "big"))  # so root/trunk can't be shifted into each other
    digest.update(root_bytes)
    digest.update(trunk_bytes)
    return digest.hexdigest()


def _make_analysis_token(user, root_bytes, trunk_bytes, result):
    return signing.dumps(
        {
            "u": user.pk,
            "h": _analysis_fingerprint(root_bytes, trunk_bytes),
            "d": result["disease"],
            "c": result["confidence"],
            "r": result.get("root_condition") or "",
        },
        salt=ANALYSIS_TOKEN_SALT,
    )


def _read_analysis_token(token, user, root_bytes, trunk_bytes):
    # Returns {"disease", "confidence", "root_condition"} when the token is
    # genuine, fresh, for this user and for exactly these photos; else None
    # (the caller then simply runs the model again).
    try:
        data = signing.loads(token, salt=ANALYSIS_TOKEN_SALT, max_age=settings.ANALYSIS_TOKEN_MAX_AGE_S)
    except signing.BadSignature:  # includes SignatureExpired
        return None
    if not isinstance(data, dict) or data.get("u") != user.pk:
        return None
    if data.get("h") != _analysis_fingerprint(root_bytes, trunk_bytes):
        return None
    if not data.get("d"):
        return None
    return {"disease": data["d"], "confidence": data.get("c", 0), "root_condition": data.get("r", "")}


def _next_auto_tree_id(farm):
    # Next free "<farm_id>-RT-0001"-style ID for this farm. Uses the highest
    # existing number + 1 (not the row count, which re-issues an existing ID
    # after any deletion) and skips any ID that already exists anywhere.
    # Farm IDs are only unique per owner, so if another farm already uses
    # this prefix, this farm's IDs include the owner's id to stay distinct.
    base = f"{farm.farm_id}-RT-"
    if RubberTree.objects.filter(tree_id__startswith=base).exclude(farm=farm).exists():
        base = f"{farm.farm_id}-U{farm.owner_id}-RT-"
    highest = 0
    for existing_id in farm.trees.filter(tree_id__startswith=base).values_list("tree_id", flat=True):
        suffix = existing_id[len(base):]
        if suffix.isdigit():
            highest = max(highest, int(suffix))
    number = highest + 1
    while RubberTree.objects.filter(tree_id=f"{base}{number:04d}").exists():
        number += 1
    return f"{base}{number:04d}"


def _get_monthly_trend(request, farm=None):
    # Groups the user's actual scan history by month, counting each disease
    # type per month, for the "Reports Over Time" line chart. Keyed by
    # disease name (not a fixed field per disease) so any disease in the
    # live catalog shows up without code changes here.
    from collections import OrderedDict

    qs = ScanHistory.objects.filter(tree__farm__owner=request.user)
    if farm:
        qs = qs.filter(tree__farm=farm)
    qs = qs.select_related("tree").order_by("date")

    disease_names = [d.name for d in get_disease_lookup().values()]
    months = OrderedDict()
    for h in qs:
        key = h.date.strftime("%b %Y")
        if key not in months:
            months[key] = {"month": key, "diseases": {name: 0 for name in disease_names}}
        if h.disease in months[key]["diseases"]:
            months[key]["diseases"][h.disease] += 1

    return list(months.values())


def _healthy_color_hex():
    # The admin-set color of the first (by display order) is_healthy class,
    # so the "Healthy" slice in charts follows whatever the admin picked
    # instead of a hardcoded green. Neutral grey if no class is flagged.
    for d in get_disease_lookup().values():
        if d.is_healthy:
            return d.color_hex
    return "#6c757d"


def _get_severity_counts(request, farm=None):
    # Returns tree counts by severity tier, using database-level filtering
    # on the stored severity_score instead of iterating every tree row and
    # computing severity_label in Python.
    qs = RubberTree.objects.filter(farm=farm) if farm else RubberTree.objects.filter(farm__owner=request.user)
    # Every class flagged is_healthy counts as Healthy (trunk "Healthy" and
    # "Healthy Roots" alike), not just the literal name "Healthy".
    healthy = get_healthy_names()
    unhealthy = qs.exclude(disease__in=healthy)
    return {
        "Healthy": qs.filter(disease__in=healthy).count(),
        "Mild": unhealthy.filter(severity_score__lt=34).count(),
        "Moderate": unhealthy.filter(severity_score__gte=34, severity_score__lt=67).count(),
        "Severe": unhealthy.filter(severity_score__gte=67).count(),
    }


# Current AI model + report template version, surfaced in the PDF report's
# metadata footer so a reader knows exactly which detector produced the
# underlying classifications and which report layout generated the file.
AI_MODEL_VERSION = "MobileNetV3-Large v2.3 (CNN Trunk Disease Classifier)"
REPORT_VERSION = "3.0"


def _get_intervention_effectiveness(request, farm=None):
    # For each intervention action type, estimates how often the treated
    # tree's CURRENT status is Healthy — a proxy for how effective that
    # action has been at resolving disease. Also returns the most recent
    # interventions logged, for a "recent activity" list.
    qs = Intervention.objects.select_related("tree", "tree__farm").filter(tree__farm__owner=request.user)
    if farm:
        qs = qs.filter(tree__farm=farm)

    healthy = set(get_healthy_names())
    by_action = {}
    for iv in qs.select_related("tree"):
        action = iv.action
        if action not in by_action:
            by_action[action] = {"action": action, "treated": 0, "recovered": 0}
        by_action[action]["treated"] += 1
        if iv.tree.disease in healthy:
            by_action[action]["recovered"] += 1

    effectiveness = []
    for row in by_action.values():
        row["recovery_pct"] = round(row["recovered"] / row["treated"] * 100, 1) if row["treated"] else 0
        effectiveness.append(row)
    effectiveness.sort(key=lambda r: r["treated"], reverse=True)

    recent = list(qs.order_by("-date_performed")[:8])
    return effectiveness, recent


def _get_intervention_effectiveness_by_disease(request, farm=None):
    # Same recovery-proxy metric as _get_intervention_effectiveness above
    # (tree.disease == "Healthy" today), but broken out per disease so a
    # reader can see which intervention actually worked best for THIS
    # disease, not just overall. "The disease being treated" is taken from
    # the tree's most recent scan on or before the intervention's date --
    # i.e. whatever the diagnosis was that prompted the intervention --
    # falling back to the tree's current disease if no earlier scan exists.
    # Interventions on trees that were already Healthy at that point are
    # excluded, since there's no disease response to measure.
    #
    # Returns {disease_name: [{"action", "treated", "recovered",
    # "recovery_pct"}, ...]}, each list sorted by treated count desc.
    qs = Intervention.objects.select_related("tree").filter(tree__farm__owner=request.user)
    if farm:
        qs = qs.filter(tree__farm=farm)
    interventions = list(qs)
    if not interventions:
        return {}

    tree_ids = {iv.tree_id for iv in interventions}
    history_by_tree = {}
    for h in ScanHistory.objects.filter(tree_id__in=tree_ids).order_by("tree_id", "-date"):
        history_by_tree.setdefault(h.tree_id, []).append(h)

    healthy = set(get_healthy_names())
    by_disease = {}
    for iv in interventions:
        treated_disease = None
        for h in history_by_tree.get(iv.tree_id, []):
            if h.date <= iv.date_performed:
                treated_disease = h.disease
                break
        if not treated_disease:
            treated_disease = iv.tree.disease
        if treated_disease in healthy:
            continue

        bucket = by_disease.setdefault(treated_disease, {})
        row = bucket.setdefault(iv.action, {"action": iv.action, "treated": 0, "recovered": 0})
        row["treated"] += 1
        if iv.tree.disease in healthy:
            row["recovered"] += 1

    result = {}
    for disease, actions in by_disease.items():
        rows = list(actions.values())
        for r in rows:
            r["recovery_pct"] = round(r["recovered"] / r["treated"] * 100, 1) if r["treated"] else 0
        rows.sort(key=lambda r: r["treated"], reverse=True)
        result[disease] = rows
    return result


def _get_best_intervention_per_disease(by_disease, min_sample=3):
    # Collapses the per-disease breakdown above into one "what actually
    # worked" row per disease: the action with the highest recovery rate
    # for that disease. Prefers actions tried on at least `min_sample`
    # trees so a single lucky recovery (100% of 1) doesn't outrank a
    # consistent performer over a dozen trees; falls back to whatever was
    # tried most if nothing clears that bar, and flags the row as
    # low-sample so the report doesn't overstate confidence in it.
    best = []
    for disease, rows in by_disease.items():
        if not rows:
            continue
        reliable = [r for r in rows if r["treated"] >= min_sample]
        pool = reliable if reliable else rows
        top = max(pool, key=lambda r: (r["recovery_pct"], r["treated"]))
        best.append({
            "disease": disease,
            "best_action": top["action"],
            "recovery_pct": top["recovery_pct"],
            "recovered": top["recovered"],
            "treated": top["treated"],
            "low_sample": top["treated"] < min_sample,
        })
    best.sort(key=lambda r: r["recovery_pct"], reverse=True)
    return best


def _get_confidence_summary(request, farm=None):
    # One-number reliability snapshot for the Key Insights list: how
    # confident the model was on average, and how many detections fell
    # low enough (<70%) that an agricultural technician should double
    # check them. Deliberately just these two numbers, not a full new
    # report section -- confidence is worth surfacing, but doesn't need
    # more room than that.
    qs = RubberTree.objects.filter(farm=farm) if farm else RubberTree.objects.filter(farm__owner=request.user)
    agg = qs.aggregate(avg=Avg("confidence"))
    avg_confidence = round(agg["avg"], 1) if agg["avg"] is not None else None
    low_threshold = 70
    low_count = qs.filter(confidence__lt=low_threshold).count()
    return {"avg": avg_confidence, "low_count": low_count, "low_threshold": low_threshold}


def _get_key_insights(total, counts, pcts, diseased, effectiveness, disease_breakdown, confidence_summary=None):
    # Builds a short list of plain-language, data-driven takeaways from
    # the current stats. Used on the reports page and in the PDF export
    # so a non-technical reader gets the "so what" up front.
    insights = []
    if total == 0:
        return ["No trees have been scanned yet — insights will appear once detection data is available."]

    insights.append(
        f"{pcts.get('Healthy', 0)}% of monitored trees ({counts.get('Healthy', 0)} of {total}) are currently Healthy."
    )

    if diseased and disease_breakdown:
        top = max(disease_breakdown, key=lambda d: d["count"])
        if top["count"] > 0:
            insights.append(
                f"{top['name']} is the most common issue detected, accounting for "
                f"{top['count']} case(s) ({top['pct']}% of all trees)."
            )
    else:
        insights.append("No active disease cases detected across the monitored trees.")

    if effectiveness:
        best = max(effectiveness, key=lambda r: (r["recovery_pct"], r["treated"]))
        if best["recovery_pct"] > 0:
            insights.append(
                f"\"{best['action']}\" is the most effective intervention on record, with "
                f"{best['recovery_pct']}% of treated trees ({best['recovered']} of {best['treated']}) now Healthy."
            )
        else:
            total_treated = sum(r["treated"] for r in effectiveness)
            insights.append(
                f"{total_treated} intervention(s) have been logged, but none of the treated trees are currently "
                f"marked Healthy yet — recovery may take longer than the current scan history covers."
            )
    else:
        insights.append("No interventions have been logged yet — recommendations below are detection-based only.")

    if confidence_summary and confidence_summary["avg"] is not None:
        c = confidence_summary
        if c["low_count"] > 0:
            insights.append(
                f"Average detection confidence is {c['avg']}%; {c['low_count']} scan(s) came in below "
                f"{c['low_threshold']}% and may be worth a manual second look."
            )
        else:
            insights.append(f"Average detection confidence is {c['avg']}%, with no low-confidence scans on record.")

    return insights[:6]


def _get_key_insight_cards(total, counts, pcts, diseased, effectiveness, disease_breakdown, confidence_summary=None):
    # The same four takeaways as _get_key_insights(), split into label /
    # headline value / one supporting line so the reports page can show them
    # as tiles instead of a bullet list. Web only: the PDF export keeps using
    # the plain sentences from _get_key_insights(). Returns [] when there is
    # nothing scanned yet, so the template can show its empty message.
    if total == 0:
        return []

    cards = [{
        "icon": "bi-heart-pulse-fill",
        "label": "Healthy trees",
        "value": f"{pcts.get('Healthy', 0)}%",
        "detail": f"{counts.get('Healthy', 0):,} of {total:,} trees",
    }]

    top = max(disease_breakdown, key=lambda d: d["count"]) if disease_breakdown else None
    if diseased and top and top["count"] > 0:
        cards.append({
            "icon": "bi-exclamation-triangle-fill",
            "label": "Most common issue",
            "value": top["name"],
            "color": top["color"],  # the disease's own colour, for the dot beside its name
            "detail": f"{top['count']:,} case{'' if top['count'] == 1 else 's'} \u00b7 {top['pct']}% of all trees",
        })
    else:
        cards.append({
            "icon": "bi-exclamation-triangle-fill",
            "label": "Most common issue",
            "value": "None detected",
            "detail": "No active disease cases in the monitored trees.",
        })

    if effectiveness:
        best = max(effectiveness, key=lambda r: (r["recovery_pct"], r["treated"]))
        if best["recovery_pct"] > 0:
            cards.append({
                "icon": "bi-bandaid-fill",
                "label": "Top intervention",
                "value": best["action"],
                "detail": f"{best['recovery_pct']}% recovered \u00b7 {best['recovered']} of {best['treated']} treated trees now healthy",
            })
        else:
            total_treated = sum(r["treated"] for r in effectiveness)
            cards.append({
                "icon": "bi-bandaid-fill",
                "label": "Top intervention",
                "value": "None yet",
                "detail": f"{total_treated} logged, but none of the treated trees are healthy yet. Recovery may take longer than the scan history covers.",
            })
    else:
        cards.append({
            "icon": "bi-bandaid-fill",
            "label": "Top intervention",
            "value": "None logged",
            "detail": "Recommendations below are based on detections only.",
        })

    if confidence_summary and confidence_summary["avg"] is not None:
        c = confidence_summary
        if c["low_count"] > 0:
            cards.append({
                "icon": "bi-bullseye",
                "label": "Avg. confidence",
                "value": f"{c['avg']}%",
                "detail": f"{c['low_count']:,} scan{'' if c['low_count'] == 1 else 's'} below {c['low_threshold']}%, worth a manual second look",
                "attention": True,
            })
        else:
            cards.append({
                "icon": "bi-bullseye",
                "label": "Avg. confidence",
                "value": f"{c['avg']}%",
                "detail": "No low-confidence scans on record",
            })

    return cards


def _get_recommendations(disease_breakdown, effectiveness):
    # Builds short, actionable recommendations per disease based on what
    # share of all trees currently show it, plus a general intervention
    # recommendation drawn from the least-effective logged action (if any).
    recs = []
    for d in sorted(disease_breakdown, key=lambda r: r["pct"], reverse=True):
        if d["count"] == 0:
            continue
        if d["pct"] >= 20:
            recs.append(f"Apply treatment for {d['name']} — {d['pct']}% of all trees show symptoms ({d['count']} tree(s)); prioritize immediate intervention.")
        elif d["pct"] >= 5:
            recs.append(f"Schedule a follow-up inspection for {d['name']} — {d['count']} tree(s) affected ({d['pct']}%).")
        else:
            recs.append(f"Monitor for {d['name']} — isolated case(s) detected ({d['count']} tree(s)); recheck on the next scheduled scan.")

    if effectiveness:
        weakest = min(effectiveness, key=lambda r: r["recovery_pct"])
        if weakest["treated"] >= 2 and weakest["recovery_pct"] < 50:
            recs.append(f"Reassess the \"{weakest['action']}\" protocol — only {weakest['recovery_pct']}% of treated trees have recovered so far.")

    if not recs:
        recs.append("No disease cases at this time — maintain routine monitoring on the standard scan schedule.")

    return recs[:6]


def _get_scan_activity(request, farm=None, days=14):
    # Compares the most recent `days`-day window of scan activity against
    # the equal-length window before it, so the dashboard can show real
    # per-scan trends (volume and outcome up/down) instead of only static
    # totals. Uses the latest scan date in the data as "today" rather than
    # the server clock, so demo/seeded data (which stops at a fixed date)
    # still shows a meaningful recent window instead of an empty one.
    import datetime
    qs = ScanHistory.objects.filter(tree__farm__owner=request.user)
    if farm:
        qs = qs.filter(tree__farm=farm)

    reference_date = qs.aggregate(Max("date"))["date__max"]
    if not reference_date:
        return None

    window_start = reference_date - datetime.timedelta(days=days)
    prev_start = window_start - datetime.timedelta(days=days)

    window_qs = qs.filter(date__gt=window_start, date__lte=reference_date)
    prev_qs = qs.filter(date__gt=prev_start, date__lte=window_start)

    # Any is_healthy class counts as a healthy scan (trunk "Healthy" and
    # "Healthy Roots" alike), not only the literal name "Healthy".
    healthy_names = get_healthy_names()
    scans_count = window_qs.count()
    healthy_scans = window_qs.filter(disease__in=healthy_names).count()
    diseased_scans = scans_count - healthy_scans
    trees_scanned = window_qs.values("tree").distinct().count()

    prev_count = prev_qs.count()
    prev_healthy = prev_qs.filter(disease__in=healthy_names).count()

    health_rate = round(healthy_scans / scans_count * 100, 1) if scans_count else None
    prev_health_rate = round(prev_healthy / prev_count * 100, 1) if prev_count else None
    health_rate_delta = round(health_rate - prev_health_rate, 1) if (health_rate is not None and prev_health_rate is not None) else None
    scans_delta = scans_count - prev_count

    # Trees whose record was first created inside this window — a proxy
    # for "newly added" trees, since new trees are only ever created via
    # a fresh Disease Detection save (see disease_detection view).
    tree_qs = RubberTree.objects.filter(farm__owner=request.user)
    if farm:
        tree_qs = tree_qs.filter(farm=farm)
    new_trees = tree_qs.filter(date_scanned__gt=window_start, date_scanned__lte=reference_date).count()

    return {
        "days": days, "reference_date": reference_date, "window_start": window_start,
        "scans_count": scans_count, "scans_delta": scans_delta, "prev_scans_count": prev_count,
        "trees_scanned": trees_scanned,
        "healthy_scans": healthy_scans, "diseased_scans": diseased_scans,
        "health_rate": health_rate, "prev_health_rate": prev_health_rate, "health_rate_delta": health_rate_delta,
        "new_trees": new_trees,
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
    # Builds clickable notifications from the user's most recently scanned
    # diseased trees, filtered by their notification preferences (which
    # disease types, and how many days back counts as "recent") from
    # UserSettings -- see the Settings page. Trees the user has already
    # clicked/dismissed (NotificationDismissal, keyed by tree + that exact
    # date_scanned) are excluded so a read notification doesn't keep
    # reappearing on every page load.
    user_settings, _ = UserSettings.objects.get_or_create(user=request.user)
    enabled_diseases = user_settings.enabled_diseases()
    if not enabled_diseases:
        return []

    today = timezone.localdate()
    cutoff = today - timezone.timedelta(days=user_settings.notify_lookback_days)
    dismissed = set(
        NotificationDismissal.objects.filter(user=request.user)
        .values_list("tree_id", "date_scanned")
    )
    diseased_trees = (
        RubberTree.objects.select_related("farm")
        .filter(farm__owner=request.user, disease__in=enabled_diseases, date_scanned__gte=cutoff)
        # "-pk" breaks same-day ties (a bulk upload saves many trees on one
        # date) so the 6 shown are the newest, not an arbitrary 6.
        .order_by("-date_scanned", "-pk")[:6 + len(dismissed)]
    )
    notifications = []
    disease_lookup = get_disease_lookup()
    for t in diseased_trees:
        if (t.pk, t.date_scanned) in dismissed:
            continue
        dc = disease_lookup.get(t.disease)
        color = dc.color_hex if dc else "#6c757d"
        days_ago = (today - t.date_scanned).days
        try:
            tree_url = reverse("tree_details", args=[t.tree_id])
        except NoReverseMatch:
            # A tree ID that can't be put in a URL (e.g. saved with a "/"
            # before IDs were validated) must not take down every page, since
            # this runs on all of them. It's skipped here; rename it in /admin/.
            continue
        notifications.append({
            "icon": "bi-exclamation-triangle-fill",
            "color": color,
            "msg": f"{t.disease} detected at Tree {t.tree_id}",
            "time": _humanize_days_ago(days_ago),
            "url": tree_url,
            # Internal numeric pk (NOT the human-readable tree.tree_id string
            # used in the URL above) -- this is what NotificationDismissal's
            # FK and the dismiss endpoint below key off of.
            "tree_pk": t.pk,
            "date_scanned": t.date_scanned.isoformat(),
        })
        if len(notifications) == 6:
            break
    return notifications


@login_required
def dismiss_notification(request):
    # Marks one notification read/dismissed so it stops showing up in the
    # bell dropdown and badge count. Called via fetch() from main.js right
    # before it follows the notification's link -- see notif-item handling
    # there. Silently no-ops (still 200s) on a repeat dismiss of the same
    # tree/date_scanned pair instead of erroring, since a double-click or a
    # retry shouldn't surface an error to the user.
    if request.method != "POST":
        return JsonResponse({"error": "POST required"}, status=405)

    tree_pk = request.POST.get("tree_pk")
    date_scanned = request.POST.get("date_scanned")
    if not tree_pk or not date_scanned:
        return JsonResponse({"error": "tree_pk and date_scanned are required"}, status=400)

    # A malformed value used to reach the ORM and surface as a 500 HTML page.
    try:
        tree_pk = int(tree_pk)
        scan_date = datetime.date.fromisoformat(date_scanned)
    except ValueError:
        return JsonResponse({"error": "tree_pk must be a number and date_scanned must be YYYY-MM-DD"}, status=400)

    tree = RubberTree.objects.filter(pk=tree_pk, farm__owner=request.user).first()
    if not tree:
        return JsonResponse({"error": "not found"}, status=404)

    NotificationDismissal.objects.get_or_create(
        user=request.user, tree=tree, date_scanned=scan_date,
    )
    return JsonResponse({"ok": True})


def _get_farm_or_none(request):
    # Returns the logged-in user's currently selected Farm, or None.
    farm_id = request.session.get("selected_farm_id")
    if farm_id:
        return Farm.objects.filter(pk=farm_id, owner=request.user).first()
    return None


RANGE_FILTER_DAYS = {"7": 7, "30": 30, "90": 90}


def _apply_range_filter(qs, range_param, date_field):
    # Shared "recent" filter used across the table pages: range_param is one
    # of "7"/"30"/"90" (days) or "" for all time.
    days = RANGE_FILTER_DAYS.get(range_param)
    if not days:
        return qs
    since = timezone.now().date() - datetime.timedelta(days=days)
    return qs.filter(**{f"{date_field}__gte": since})


def _severity_bounds(severity_param):
    # Mirrors RubberTree.severity_label's score thresholds, as a queryset filter.
    return {
        "Healthy": {"severity_score": 0},
        "Mild": {"severity_score__gt": 0, "severity_score__lt": 34},
        "Moderate": {"severity_score__gte": 34, "severity_score__lt": 67},
        "Severe": {"severity_score__gte": 67},
    }.get(severity_param)


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
    # "Healthy" is the sum over every is_healthy class (trunk "Healthy",
    # "Healthy Roots", ...), so a healthy-roots tree never counts as diseased.
    healthy_total = sum(raw_counts.get(n, 0) for n in get_healthy_names())
    counts = {
        "Healthy": healthy_total,
        "Pink_Disease": raw_counts.get("Pink Disease", 0),
        "White_Root_Rot": raw_counts.get("White Root Rot", 0),
        "Stem_Bleeding": raw_counts.get("Stem Bleeding", 0),
    }
    pcts = {k: round(v / total * 100, 1) if total else 0 for k, v in counts.items()}
    diseased = total - counts["Healthy"]
    return total, counts, pcts, diseased


def _get_full_disease_stats(request, farm=None):
    # Every disease in the live catalog (including Healthy) with
    # count/pct/color, used to drive per-disease charts that need to
    # scale to however many disease classes currently exist.
    qs = RubberTree.objects.filter(farm=farm) if farm else RubberTree.objects.filter(farm__owner=request.user)
    total = qs.count()
    raw_counts = dict(qs.values_list("disease").annotate(n=Count("id")).values_list("disease", "n"))
    stats = []
    for d in get_disease_lookup().values():
        n = raw_counts.get(d.name, 0)
        stats.append({
            "name": d.name, "count": n,
            "pct": round(n / total * 100, 1) if total else 0,
            "color": d.color_hex, "is_healthy": d.is_healthy,
        })
    return stats


def _get_disease_breakdown(request, farm=None):
    # Same as above, minus Healthy -- for picking out e.g. the single
    # most common disease rather than just a healthy/diseased split.
    return [d for d in _get_full_disease_stats(request, farm) if not d["is_healthy"]]


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
    farm_pk = request.POST.get("farm_pk", "").strip()
    if farm_pk:
        # A non-numeric value used to raise ValueError (HTTP 500); it is now
        # ignored and the current selection is left unchanged.
        if farm_pk.isdigit() and Farm.objects.filter(pk=int(farm_pk), owner=request.user).exists():
            request.session["selected_farm_id"] = int(farm_pk)
    else:
        request.session.pop("selected_farm_id", None)
    # Only ever redirect back to this site, never to a URL a POST supplied.
    next_url = request.POST.get("next", "/")
    if not url_has_allowed_host_and_scheme(
        next_url, allowed_hosts={request.get_host()}, require_https=request.is_secure(),
    ):
        next_url = "/"
    return redirect(next_url)


@login_required
def settings_view(request):
    # Account info, password change, and notification preferences, each
    # submitted as its own form (distinguished by the "form_name" field)
    # so saving one section never touches the others.
    from django.contrib.auth.forms import PasswordChangeForm
    from django.contrib.auth import update_session_auth_hash

    user_settings, _ = UserSettings.objects.get_or_create(user=request.user)
    password_form = PasswordChangeForm(request.user)

    if request.method == "POST":
        form_name = request.POST.get("form_name")

        if form_name == "account":
            request.user.email = request.POST.get("email", "").strip()
            request.user.first_name = request.POST.get("first_name", "").strip()
            request.user.last_name = request.POST.get("last_name", "").strip()
            request.user.save()
            messages.success(request, "Account info updated.")
            return redirect("settings")

        elif form_name == "password":
            password_form = PasswordChangeForm(request.user, request.POST)
            if password_form.is_valid():
                user = password_form.save()
                update_session_auth_hash(request, user)  # keeps the user logged in
                messages.success(request, "Password changed.")
                return redirect("settings")
            messages.error(request, "Please fix the errors below.")

        elif form_name == "notifications":
            try:
                user_settings.notify_lookback_days = max(1, int(request.POST.get("notify_lookback_days", 7)))
            except ValueError:
                user_settings.notify_lookback_days = 7
            # Checked box = notify (matches settings.html rendering below),
            # so anything NOT posted for a known disease name is muted.
            checked = set(request.POST.getlist("notify_disease"))
            user_settings.notify_muted_diseases = [
                d.name for d in get_disease_lookup().values()
                if not d.is_healthy and d.name not in checked
            ]
            user_settings.save()
            messages.success(request, "Notification preferences updated.")
            return redirect("settings")

    ctx = _base_context(request)
    ctx.update({
        "page": "settings",
        "password_form": password_form,
        "user_settings": user_settings,
        "notifiable_diseases": [d for d in get_disease_lookup().values() if not d.is_healthy],
    })
    return render(request, "settings.html", ctx)


@login_required
def farm_list(request):
    # Displays a list of all farms owned by the logged-in user.
    # tree_count/avg_lat/avg_lng are annotated here (one GROUP BY query for
    # the whole page) rather than calling farm.trees.count() / get_center()
    # per row in the template, which would re-query per farm card.
    farms_qs = Farm.objects.filter(owner=request.user).annotate(
        tree_count=Count("trees"),
        avg_lat=Avg("trees__lat"),
        avg_lng=Avg("trees__lng"),
    ).order_by("farm_id")
    search_q = request.GET.get("q", "").strip()
    if search_q:
        farms_qs = farms_qs.filter(
            Q(farm_id__icontains=search_q) | Q(name__icontains=search_q)
            | Q(owner_name__icontains=search_q) | Q(location__icontains=search_q)
        )
    paginator = Paginator(farms_qs, 25)
    page_number = request.GET.get("page", 1)
    farms = paginator.get_page(page_number)

    # Map-unlock progress for each farm on this page ("3 of 5 GPS locations"),
    # from ONE query for the whole page rather than one per farm.
    points_by_farm = {}
    for fid, lat, lng in RubberTree.objects.filter(farm_id__in=[f.pk for f in farms]).values_list("farm_id", "lat", "lng"):
        points_by_farm.setdefault(fid, []).append((lat, lng))
    for farm in farms:
        farm.map_status = farm.get_map_status(points_by_farm.get(farm.pk, []))

    ctx = _base_context(request)
    ctx.update({
        "page": "farm_list", "farms": farms, "search_q": search_q,
        "suggested_farm_id": _suggest_farm_id(request.user),
        "map_min_points": get_min_gps_points(),
    })
    return render(request, "farm_list.html", ctx)


def _suggest_farm_id(user):
    # Next free "FARM-NNN" for this user, pre-filled in the Add Farm form so
    # nobody has to invent an ID. Also the fallback when the ID is left blank.
    # IDs only need to be unique per owner (Farm.Meta.unique_together).
    taken = set(Farm.objects.filter(owner=user).values_list("farm_id", flat=True))
    n = len(taken) + 1
    while f"FARM-{n:03d}" in taken:
        n += 1
    return f"FARM-{n:03d}"


@login_required
def farm_create(request):
    # Handles the Add Farm form, creating a new farm owned by the logged-in user.
    if request.method == "POST":
        name = request.POST.get("name", "").strip()
        # Owner is optional; blank falls back to the account holder so lists,
        # reports and the PDF never show an empty owner.
        owner_name = (
            request.POST.get("owner_name", "").strip()
            or request.user.get_full_name().strip()
            or request.user.get_username()
        )[:100]
        # Only the name is required. The ID is pre-filled in the form, and a
        # blank one gets the next free FARM-NNN. No address is asked for: the
        # farm's place on the map comes from the GPS of its photos.
        farm_id = request.POST.get("farm_id", "").strip() or _suggest_farm_id(request.user)

        if not name:
            messages.error(request, "Please enter a farm name.")
            return redirect("farm_list")

        # The farm ID is used in URLs and as the prefix of every tree ID.
        if not _is_valid_id(farm_id, FARM_ID_MAX_LENGTH):
            messages.error(
                request,
                f"Farm ID can use letters, numbers, spaces, dashes, dots and underscores "
                f"(up to {FARM_ID_MAX_LENGTH} characters). Please remove any slashes or other symbols.",
            )
            return redirect("farm_list")

        if Farm.objects.filter(owner=request.user, farm_id=farm_id).exists():
            messages.error(request, f"You already have a farm with ID '{farm_id}'.")
            return redirect("farm_list")

        # No center/boundary here on purpose -- Farm.center_lat/center_lng
        # just take their model defaults (a general Zamboanga City point) as
        # a placeholder until this farm's first tree scan comes in, at which
        # point get_center()/get_boundary_polygon() take over and compute
        # the real thing from actual tree GPS data instead.
        Farm.objects.create(
            owner=request.user,
            farm_id=farm_id,
            name=name,
            owner_name=owner_name,
        )
        messages.success(
            request,
            f"Farm '{name}' added. Its map shows once {get_min_gps_points()} GPS locations "
            f"have been captured. Scan trees or bulk-upload photos that have GPS.",
        )
        return redirect("farm_list")

    return redirect("farm_list")


@login_required
def farm_detail(request, farm_id):
    # Displays details, stats, and trees for a single farm owned by the user.
    farm = get_object_or_404(Farm, farm_id=farm_id, owner=request.user)
    total, counts, pcts, diseased = farm.get_stats()
    disease_stats = _get_full_disease_stats(request, farm)
    trees_qs = farm.trees.all().order_by("tree_id")
    paginator = Paginator(trees_qs, 25)
    page_number = request.GET.get("page", 1)
    trees_page = paginator.get_page(page_number)
    ctx = _base_context(request)
    ctx.update({
        "page": "farm_list",
        "farm": farm,
        "trees": trees_page,
        "total": total, "counts": counts, "pcts": pcts, "diseased": diseased,
        "diseased_pct": round(diseased / total * 100, 1) if total else 0,
        "disease_stats": disease_stats,
    })
    return render(request, "farm_detail.html", ctx)


def ping(request):
    # Deliberately outside @login_required and does zero DB/template work --
    # this only exists as a cheap target for the offline-banner's real
    # connectivity probe (see offline_queue.js), which may poll every ~15s.
    from django.http import HttpResponse
    return HttpResponse(status=204)


@login_required
def dashboard(request):
    # Renders the dashboard: summary cards, recent detections, and a map preview.
    farm = _get_farm_or_none(request)
    total, counts, pcts, diseased = _get_stats(request, farm)
    severity_counts = _get_severity_counts(request, farm)
    # Bar-fill percentages for the Severity Breakdown panel, relative to
    # the largest tier so the bars are visually comparable (same approach
    # _get_most_affected_farms uses for its bar_pct field).
    severity_max = max(severity_counts.values()) or 1
    severity_bar_pcts = {k: round(v / severity_max * 100, 1) for k, v in severity_counts.items()}
    confidence_summary = _get_confidence_summary(request, farm)
    trees = list(
        _get_trees(request, farm).select_related("farm")
        .prefetch_related(
            Prefetch("history", queryset=ScanHistory.objects.order_by("-date")),
            Prefetch("interventions", queryset=Intervention.objects.order_by("-date_performed")),
        )
        .order_by("-date_scanned")[:6]
    )
    recent = [t.to_dict() for t in trees]

    farm_count = Farm.objects.filter(owner=request.user).count()
    scan_activity = _get_scan_activity(request, farm)
    effectiveness, recent_interventions = _get_intervention_effectiveness(request, farm)
    top_interventions = [e for e in effectiveness if e["treated"] > 0][:3]
    disease_stats = _get_full_disease_stats(request, farm)

    ctx = _base_context(request, farm)
    ctx.update({
        "page": "dashboard",
        "total": total, "counts": counts, "pcts": pcts, "diseased": diseased,
        "severity_counts": severity_counts,
        "severity_bar_pcts": severity_bar_pcts,
        "confidence_summary": confidence_summary,
        "healthy_count": counts["Healthy"],
        # Farms with at least one tree whose class is NOT is_healthy. (The
        # old .exclude(trees__disease="Healthy") dropped any farm that had
        # even one Healthy tree, because exclude() across a reverse FK
        # excludes the whole farm.)
        "areas_with_cases": Farm.objects.filter(
            owner=request.user,
            trees__in=RubberTree.objects.exclude(disease__in=get_healthy_names()),
        ).distinct().count() if not farm else (1 if diseased else 0),
        "farm_count": farm_count,
        "recent": recent,
        "scan_activity": scan_activity,
        "recent_interventions": recent_interventions[:6],
        "top_interventions": top_interventions,
        "disease_stats": disease_stats,
        "latest_scan": recent[0]["date_scanned"] if recent else "—",
    })
    return render(request, "dashboard.html", ctx)


# Smallest width/height (meters) the farm map will frame, so a tiny farm
# doesn't open zoomed in to a few trees.
_MIN_MAP_SPAN_M = 120.0


def _farm_map_bounds(farm, polygon=None):
    # Returns a bounding box used to zoom-lock the farm map so the user can
    # zoom in freely but not zoom out past their own farm's extent.
    #
    # Built from the farm's boundary polygon (plus a little breathing room),
    # NOT from the raw min/max of the tree coordinates: the polygon is drawn
    # outside the outermost trees, so a box fitted to the trees alone sat
    # inside the border -- the map opened with the border's edge cut off and
    # maxBounds stopped the user from panning far enough to see it. Pass the
    # polygon in if the caller already has it, to avoid computing it twice.
    if polygon is None:
        polygon = farm.get_boundary_polygon()
    lats = [p[0] for p in polygon]
    lngs = [p[1] for p in polygon]
    bounds = {
        "min_lat": min(lats), "max_lat": max(lats),
        "min_lng": min(lngs), "max_lng": max(lngs),
    }

    # Guard against a tiny box (e.g. every tree within a few meters of each
    # other) -- Leaflet's fitBounds on a near-zero-area box zooms to an
    # unusable extreme. If a side is shorter than _MIN_MAP_SPAN_M, widen it
    # evenly around its middle up to that size. (This used to ADD a full
    # 200 m on each side to any farm narrower than 200 m, which made a
    # normal ~160 m farm open at about a third of the screen -- a speck.)
    mid_lat = (bounds["min_lat"] + bounds["max_lat"]) / 2
    min_lat_span = _MIN_MAP_SPAN_M / 111320.0
    min_lng_span = _MIN_MAP_SPAN_M / (111320.0 * max(math.cos(math.radians(mid_lat)), 0.01))

    def at_least(lo, hi, span):
        if hi - lo >= span:
            return lo, hi
        mid = (lo + hi) / 2
        return mid - span / 2, mid + span / 2

    bounds["min_lat"], bounds["max_lat"] = at_least(bounds["min_lat"], bounds["max_lat"], min_lat_span)
    bounds["min_lng"], bounds["max_lng"] = at_least(bounds["min_lng"], bounds["max_lng"], min_lng_span)

    # Breathing room so the border line isn't flush against the viewport
    # edge when the map first fits to these bounds.
    pad_lat = (bounds["max_lat"] - bounds["min_lat"]) * 0.05
    pad_lng = (bounds["max_lng"] - bounds["min_lng"]) * 0.05
    bounds["min_lat"] -= pad_lat
    bounds["max_lat"] += pad_lat
    bounds["min_lng"] -= pad_lng
    bounds["max_lng"] += pad_lng
    return bounds


@login_required
def farm_map(request):
    # Renders the interactive Leaflet map for exactly one farm at a time,
    # with its own page-scoped farm selector (a ?farm=<id> query param)
    # independent of the sidebar's "Active Farm" selector. This avoids the
    # sidebar showing a specific farm as "selected" just because the map
    # needed to default to one — the sidebar keeps reflecting the user's
    # actual session-wide choice (which may genuinely be "All Farms").
    sidebar_farm = _get_farm_or_none(request)
    all_user_farms = Farm.objects.filter(owner=request.user).order_by("farm_id")

    map_farm_id = request.GET.get("farm", "")
    map_farm = all_user_farms.filter(farm_id=map_farm_id).first() if map_farm_id else None
    if map_farm is None:
        # No ?farm=, or one that isn't this user's farm: show the active farm
        # (or their first) instead of a misleading "no farms registered".
        map_farm = sidebar_farm or all_user_farms.first()

    if not map_farm:
        ctx = _base_context(request, sidebar_farm)
        ctx.update({"page": "farm_map", "no_farms": True})
        return render(request, "farm_map.html", ctx)

    total, counts, pcts, diseased = map_farm.get_stats()
    diseased_pct = round(diseased / total * 100, 1) if total else 0

    # Built fresh from the live DiseaseClass catalog (not the fixed-key
    # counts dict above) so the filter dropdown, legend, and top-disease
    # card all pick up newly added disease classes automatically -- same
    # reasoning as RubberTree.color/disease_key.
    raw_counts = dict(
        map_farm.trees.values_list("disease").annotate(n=Count("id")).values_list("disease", "n")
    )
    disease_stats = []
    top_disease = None
    for d in DiseaseClass.objects.all():
        n = raw_counts.get(d.name, 0)
        disease_stats.append({"name": d.name, "count": n, "color": d.color_hex, "is_healthy": d.is_healthy})
        if not d.is_healthy and (top_disease is None or n > top_disease["count"]):
            top_disease = {"name": d.name, "count": n, "color": d.color_hex}
    disease_colors = {d["name"]: d["color"] for d in disease_stats}

    # The live map only makes sense once the farm has enough distinct GPS
    # locations to draw a real border and a meaningful heatmap (see
    # Farm.get_map_status / FARM_MAP_MIN_GPS_POINTS). Below that, the page
    # shows how many more are needed instead of a misleading placeholder
    # map. One query for the coordinates, shared with the border below.
    raw_points = list(map_farm.trees.values_list("lat", "lng"))
    map_status = map_farm.get_map_status(raw_points)

    # Uses the sidebar's own selected_farm (not map_farm) for shared
    # context, so the sidebar dropdown never appears to change just from
    # visiting this page.
    ctx = _base_context(request, sidebar_farm)
    ctx.update({
        "page": "farm_map",
        "map_farm": map_farm,
        "all_user_farms": all_user_farms,
        "map_status": map_status,
        "map_locked": not map_status["ready"],
        "map_progress_pct": min(100, round(map_status["usable"] / map_status["required"] * 100)),
        "total": total, "counts": counts, "diseased": diseased,
        "healthy_pct": pcts["Healthy"], "diseased_pct": diseased_pct,
        "disease_stats": disease_stats,
        "top_disease": top_disease,
    })

    if map_status["ready"]:
        trees_qs = map_farm.trees.annotate(
            has_intervention=Exists(Intervention.objects.filter(tree=OuterRef("pk")))
        )
        farm_polygon = map_farm.get_boundary_polygon(raw_points)
        ctx.update({
            "markers_json": _json_for_script([t.to_marker_dict() for t in trees_qs]),
            "map_bounds": _json_for_script(_farm_map_bounds(map_farm, farm_polygon)),
            "map_farm_boundary": _json_for_script(farm_polygon),
            "disease_colors_json": _json_for_script(disease_colors),
        })
    return render(request, "farm_map.html", ctx)


@login_required
def tree_marker_detail(request, tree_id):
    # Returns full marker popup detail (recommended action, notes, latest
    # inspector, latest intervention) for a single tree as JSON. Called via
    # AJAX only when a marker is actually clicked, instead of embedding
    # this for every tree on initial map load.
    from django.http import JsonResponse, Http404
    tree = (
        RubberTree.objects.select_related("farm")
        .prefetch_related(
            Prefetch("history", queryset=ScanHistory.objects.order_by("-date")),
            Prefetch("interventions", queryset=Intervention.objects.order_by("-date_performed")),
        )
        .filter(tree_id=tree_id, farm__owner=request.user)
        .first()
    )
    if not tree:
        raise Http404("Tree not found")
    return JsonResponse(tree.to_dict())


@login_required
def service_worker_js(request):
    # Served from /detection/sw.js, not /static/js/sw.js -- see the
    # comment at the top of static/js/sw.js for why that path matters.
    from django.http import HttpResponse
    from pathlib import Path
    sw_path = Path(__file__).resolve().parent.parent / "static" / "js" / "sw.js"
    return HttpResponse(sw_path.read_text(), content_type="application/javascript")

@login_required
def disease_detection(request):
    # Renders the disease detection upload page.
    farm = _get_farm_or_none(request)
    ctx = _base_context(request, farm)
    ctx.update({
        "page": "disease_detection",
        "disease_classes": DiseaseClass.objects.all().order_by("display_order", "name"),
        # Analyze Images is disabled in the template when this is False,
        # rather than the page silently making up a result.
        "ai_enabled": ai_inference.AI_MODEL_ENABLED,
    })

    # "Scan Again" from a tree's detail page arrives here with these two,
    # so the farm/tree fields come pre-filled instead of the farmer having
    # to retype the tree's exact code from memory (see tree_details.html).
    # rescan_farm_pk is compared as an int against farm.pk in the template,
    # not just forwarded as the raw GET string, so a tampered/bad value
    # just fails to match any option instead of ever being trusted.
    rescan_tree_id = request.GET.get("rescan_tree_id", "").strip()
    try:
        rescan_farm_pk = int(request.GET.get("rescan_farm_pk", ""))
    except ValueError:
        rescan_farm_pk = None
    if rescan_tree_id:
        ctx.update({"rescan_tree_id": rescan_tree_id, "rescan_farm_pk": rescan_farm_pk})

    return render(request, "disease_detection.html", ctx)


@login_required
def bulk_upload(request):
    # Renders the bulk upload page. All the real work (clustering photos
    # into trees by timestamp/GPS, letting the user confirm/fix groups,
    # then analyzing+saving each) happens client-side in bulk_detection.js,
    # reusing the same /detection/analyze/ and /detection/save/ endpoints
    # the single-tree flow and offline sync already use -- one call per
    # confirmed tree, nothing new server-side.
    farm = _get_farm_or_none(request)
    ctx = _base_context(request, farm)
    # Each farm's live center, for defaulting the "set location manually"
    # map when a group has no GPS of its own.
    farm_centers = {str(f.pk): list(f.get_center()) for f in ctx["all_farms"]}
    ctx.update({
        "page": "bulk_upload",
        "ai_enabled": ai_inference.AI_MODEL_ENABLED,
        "farm_centers": farm_centers,
    })
    return render(request, "bulk_upload.html", ctx)


def _severity_label_for(disease, confidence):
    # Mirrors RubberTree.severity_label's thresholds (models.py), for a
    # result that hasn't been saved as a RubberTree yet -- see
    # analyze_detection() below.
    disease_class = get_disease_lookup().get(disease)
    if (disease_class and disease_class.is_healthy) or not confidence:
        return "Healthy"
    if confidence < 34:
        return "Mild"
    if confidence < 67:
        return "Moderate"
    return "Severe"


@login_required
def analyze_detection(request):
    # Runs the configured AI model on the two captured photos and returns
    # its result as JSON. Called by the Analyze Images button so what the
    # user reviews before saving is the real model output. save_detection()
    # independently re-runs this at save time too -- that copy is the one
    # actually trusted for what gets stored, since these hidden form
    # fields could still be edited in devtools before submit.
    from django.http import JsonResponse

    if request.method != "POST":
        return JsonResponse({"error": "POST required"}, status=405)

    if not ai_inference.AI_MODEL_ENABLED:
        # Server-side detail (which setting to change) goes to the log, not
        # to the farmer's screen.
        logger.warning("Detection requested but AI_MODEL_ENDPOINT_URL is not set.")
        return JsonResponse(
            {"error": "Disease detection isn't available right now. Please try again later."},
            status=503,
        )

    root_file = request.FILES.get("root_image")
    trunk_file = request.FILES.get("trunk_image")
    if not root_file or not trunk_file:
        return JsonResponse({"error": "Add both a root photo and a trunk photo, then try again."}, status=400)

    # Only real photos are forwarded to the paid model endpoint.
    try:
        root_bytes = _read_photo(root_file)
        trunk_bytes = _read_photo(trunk_file)
    except PhotoError as exc:
        return JsonResponse({"error": str(exc)}, status=400)

    if not _take_daily_slot("analyze-calls", request.user, ANALYZE_CALLS_PER_DAY):
        return JsonResponse(
            {"error": "You've reached today's limit for photo analysis. Please try again tomorrow."},
            status=429,
        )

    try:
        result = ai_inference.classify_images(root_bytes, trunk_bytes)
    except ai_inference.InferenceError as exc:
        # The exception text can contain the model endpoint's URL/host, so
        # it's logged, not returned.
        logger.warning("AI inference failed: %s", exc)
        return JsonResponse(
            {"error": "The detection service didn't respond. Please try again in a moment."},
            status=502,
        )

    disease_class = get_disease_lookup().get(result["disease"])
    severity_label = _severity_label_for(result["disease"], result["confidence"])
    result["action"] = disease_class.recommendation_for(severity_label) if disease_class else ""
    # Signed copy of this result, sent back with the save so the model
    # doesn't have to be run a second time (see _read_analysis_token).
    result["token"] = _make_analysis_token(request.user, root_bytes, trunk_bytes, result)
    return JsonResponse(result)


@login_required
def request_upload_url(request):
    # Issues a short-lived presigned R2 PUT URL for one scan photo.
    # Called twice by the frontend (once for the root photo, once for the
    # trunk) -- see startDirectUploads() in static/js/disease_detection.js.
    # Frontend has already compressed the photo to WebP itself at this
    # point, so all this endpoint does is hand back somewhere to put it.
    #
    # Each key handed out is remembered in the user's session, and
    # save_detection() only accepts keys from that list, so a client can't
    # point a scan at some other object in the bucket. Requests are capped
    # per user per day, and the optional "size" (bytes) is signed into the
    # URL so the upload can't be a different length than declared.
    from django.http import JsonResponse

    if request.method != "POST":
        return JsonResponse({"error": "POST required"}, status=405)

    kind = request.POST.get("kind")
    if kind not in ("roots", "trunks"):
        return JsonResponse({"error": "kind must be 'roots' or 'trunks'"}, status=400)

    size = None
    size_raw = request.POST.get("size", "").strip()
    if size_raw:
        try:
            size = int(size_raw)
        except ValueError:
            return JsonResponse({"error": "size must be a whole number of bytes"}, status=400)

    if not _take_daily_slot("upload-urls", request.user, UPLOAD_URLS_PER_DAY):
        return JsonResponse(
            {"error": "You've reached today's photo upload limit. Please try again tomorrow."},
            status=429,
        )

    try:
        data = direct_upload.generate_upload_url(kind, size=size)
    except direct_upload.DirectUploadUnavailable as exc:
        # Cloud storage isn't configured yet -- tell the client so it can
        # fall back to the normal multipart file upload instead.
        logger.info("Direct upload unavailable: %s", exc)
        return JsonResponse(
            {"error": "Direct upload isn't available.", "fallback": True}, status=503,
        )
    except direct_upload.UploadTooLarge as exc:
        return JsonResponse({"error": str(exc)}, status=400)

    issued = request.session.get("issued_upload_keys", [])
    issued.append(data["key"])
    request.session["issued_upload_keys"] = issued[-ISSUED_KEYS_KEPT:]

    return JsonResponse(data)


@login_required
def save_detection(request):
    # Saves a CNN detection result. Creates a
    # new tree, or — if tree_id matches an existing tree on this farm —
    # appends a new ScanHistory entry and updates that tree's current
    # state instead. The latter is what makes progression tracking
    # (comment 9) reachable through real usage, not just seeded demo data.
    import datetime
    from django.http import JsonResponse

    if request.method != "POST":
        return redirect("disease_detection")

    # The offline sync queue (offline_queue.js) replays this same endpoint
    # via fetch() instead of a real form submission, since there's no page
    # to redirect. It sends this header to ask for JSON back instead.
    is_ajax = request.headers.get("X-Requested-With") == "XMLHttpRequest"

    def fail(message, status=400):
        if is_ajax:
            return JsonResponse({"error": message}, status=status)
        messages.error(request, message)
        return redirect("disease_detection")

    farm_pk = request.POST.get("farm_pk")
    # No silent "Healthy" default: if no result was sent and the server
    # can't produce one itself, the save is refused below instead of
    # recording an unscanned tree as healthy.
    disease = request.POST.get("disease", "").strip()
    confidence = request.POST.get("confidence", "0")
    tree_id = request.POST.get("tree_id", "").strip()
    root_condition = request.POST.get("root_condition", "").strip()

    # GPS is required, not just preferred. Client-side (disease_detection.js),
    # a fresh camera capture can fall back to a live device position when
    # the photo has no EXIF GPS, but a browsed/dropped file can't -- using
    # the phone's current position for an existing photo would mislabel
    # where it was actually taken, so that path is rejected outright with
    # no location instead. Either way, this should basically always be
    # present by the time a request gets here, but it's still re-checked
    # server-side rather than trusted, same reasoning as the disease/
    # confidence re-check below.
    try:
        tree_lat = float(request.POST.get("lat") or "")
        tree_lng = float(request.POST.get("lng") or "")
    except ValueError:
        tree_lat = tree_lng = None
    if tree_lat is None or tree_lng is None:
        return fail("This scan is missing a GPS location and can't be saved. Retake the photo somewhere the camera/GPS can get a location.")
    # float() happily accepts "nan"/"inf", and a failed GPS fix often comes
    # through as 0,0. Any of those would warp the farm's boundary and map
    # bounds for every tree on the farm, so reject them here.
    if (
        not (math.isfinite(tree_lat) and math.isfinite(tree_lng))
        or not (-90 <= tree_lat <= 90 and -180 <= tree_lng <= 180)
        or (abs(tree_lat) < 1e-4 and abs(tree_lng) < 1e-4)
    ):
        return fail("This scan's GPS location isn't valid (it looks like a failed GPS fix) and can't be saved. Retake the photo somewhere the camera/GPS can get a location.")

    # Optional: how accurate that fix was, in metres. The phone already
    # refuses fixes worse than this limit, but the value comes from the
    # browser (and from scans queued before this check existed), so it is
    # enforced here too. A missing/garbage value just means "unknown".
    gps_accuracy = _parse_gps_accuracy(request.POST.get("gps_accuracy", "").strip())
    if gps_accuracy is not None and gps_accuracy > settings.GPS_MAX_ACCURACY_M:
        return fail(
            f"This scan's GPS fix is too imprecise (about {round(gps_accuracy)} m) to place the tree. "
            "Retake the photo in the open, away from thick canopy, and give the GPS a few seconds."
        )

    captured_at = None
    captured_at_raw = request.POST.get("captured_at", "").strip()
    if captured_at_raw:
        try:
            captured_at = datetime.datetime.fromisoformat(captured_at_raw.replace("Z", "+00:00"))
        except ValueError:
            pass  # bad/missing timestamp isn't worth failing the save over

    try:
        farm = Farm.objects.get(pk=farm_pk, owner=request.user)
    except (Farm.DoesNotExist, ValueError, TypeError):
        return fail("This scan has no valid farm attached and can't be saved.")

    # A fix far from every other tree on the farm is almost always a bad
    # reading (a cell-tower position, a stale fix from another place) or the
    # wrong farm picked, and one such tree stretches the farm's boundary and
    # map bounds for everybody. Only checked once the farm has enough trees to
    # know where it is (FARM_DISTANCE_CHECK_MIN_TREES).
    far_km = _distance_from_farm_km(farm, tree_lat, tree_lng)
    if far_km is not None and far_km > settings.FARM_MAX_DISTANCE_KM:
        return fail(
            f"This location is about {round(far_km)} km from the rest of this farm's trees, which usually "
            "means a bad GPS fix or the wrong farm. Check the farm, or retake the photo outdoors."
        )

    # A typed tree ID becomes part of a URL (/inventory/<tree_id>/), so a
    # "/" or "?" in it would break every page that links to the tree.
    if tree_id and not _is_valid_id(tree_id, TREE_ID_MAX_LENGTH):
        return fail(
            "Tree ID can use letters, numbers, spaces, dashes, dots and underscores "
            f"(up to {TREE_ID_MAX_LENGTH} characters). Please remove any slashes or other symbols."
        )

    # Retried syncs must not save the same scan twice. If a sync request
    # reached this point and saved, but the phone lost signal before the
    # response arrived, the queued item is (correctly) retried -- and with an
    # auto-generated tree ID that would create a second tree at the same
    # spot. Same farm + same photo timestamp + same coordinates can only be
    # that retry (two phones in one farm would differ in position), so it's
    # answered as already saved, before spending another AI call on it.
    if captured_at is not None:
        already_saved = RubberTree.objects.filter(
            farm=farm, captured_at=captured_at, lat=tree_lat, lng=tree_lng,
        ).first()
        if already_saved:
            if is_ajax:
                return JsonResponse({"ok": True, "tree_id": already_saved.tree_id, "verb": "already saved"})
            return redirect("tree_details", tree_id=already_saved.tree_id)

    root_image_resized = None
    trunk_image_resized = None
    root_file_bytes = None
    trunk_file_bytes = None

    # Preferred path: the frontend already compressed the photo to WebP
    # and uploaded it straight to R2 (see startDirectUploads() in
    # disease_detection.js), and just tells us the object key here. No
    # re-upload -- assigning the key string directly to the ImageField marks
    # it as an existing file rather than a new one to save.
    #
    # The key comes from the browser, so it's only accepted if it has the
    # exact shape direct_upload.build_key() produces AND request_upload_url()
    # issued it to this session. Anything else (another object in the
    # bucket, a path trick) is refused.
    root_image_key = request.POST.get("root_image_key", "").strip()
    trunk_image_key = request.POST.get("trunk_image_key", "").strip()
    issued_keys = set(request.session.get("issued_upload_keys", []))
    for key, kind in ((root_image_key, "roots"), (trunk_image_key, "trunks")):
        if key and (not direct_upload.is_valid_key(key, kind) or key not in issued_keys):
            return fail("A photo upload couldn't be verified. Please add the photo again and retry.")
    try:
        if root_image_key:
            root_file_bytes = direct_upload.fetch_uploaded_bytes(root_image_key)
            root_image_resized = root_image_key
        if trunk_image_key:
            trunk_file_bytes = direct_upload.fetch_uploaded_bytes(trunk_image_key)
            trunk_image_resized = trunk_image_key
    except direct_upload.DirectUploadUnavailable:
        return fail("Photo storage isn't available right now. Please try again later.", status=503)
    except direct_upload.UploadTooLarge:
        return fail("One of the photos is too large. Please use a smaller photo.")
    except Exception:
        logger.exception("Could not read an uploaded scan photo back from storage")
        return fail("We couldn't read an uploaded photo. Please add it again and retry.", status=502)

    # A presigned upload accepts any bytes, so what was read back from storage
    # is checked to be a real photo before it is stored or sent to the model.
    for uploaded in (root_file_bytes if root_image_key else None, trunk_file_bytes if trunk_image_key else None):
        if uploaded is not None and not is_valid_image(uploaded):
            return fail("One of the uploaded files isn't a valid photo (use JPEG, PNG or WebP). Please add it again.")

    # Fallback path: a raw file came through the multipart form instead
    # (older browsers without canvas/WebP support, direct uploads
    # unavailable because cloud storage isn't configured, or this is an
    # offline-queued scan being synced -- those always use this path,
    # since they were never uploaded to R2 while offline).
    try:
        if not root_image_key and request.FILES.get("root_image"):
            f = request.FILES["root_image"]
            root_file_bytes = _read_photo(f)
            root_image_resized = resize_for_storage(f, f.name)
        if not trunk_image_key and request.FILES.get("trunk_image"):
            f = request.FILES["trunk_image"]
            trunk_file_bytes = _read_photo(f)
            trunk_image_resized = resize_for_storage(f, f.name)
    except PhotoError as exc:
        return fail(str(exc))
    except OSError:
        # Pillow could not decode the file after all (cut off or corrupt).
        return fail("One of the photos couldn't be read. Please retake it and try again.")

    # The disease/confidence fields in the save form could be edited in
    # devtools before submit, so they aren't trusted outright. Normally the
    # result is taken from the signed token analyze_detection() issued for
    # these exact photos (see _read_analysis_token), which needs no second
    # model call. Only when there is no valid token (older queued scans, photos
    # changed after analysis, an expired token) is inference re-run here. If the
    # model is switched on but gives no answer, the scan is NOT saved with the
    # submitted values: they can be edited in devtools, so storing them would
    # let anyone write any diagnosis into the statistics. The phone's offline
    # queue treats the 503 as "try again later", so nothing is lost.
    used_ai = False
    analysis = None
    analysis_token = request.POST.get("analysis_token", "").strip()
    if analysis_token and root_file_bytes and trunk_file_bytes:
        analysis = _read_analysis_token(analysis_token, request.user, root_file_bytes, trunk_file_bytes)
    if analysis:
        disease = analysis["disease"]
        confidence = analysis["confidence"]
        if analysis["root_condition"]:
            root_condition = analysis["root_condition"]
        used_ai = True
    elif ai_inference.AI_MODEL_ENABLED and root_file_bytes and trunk_file_bytes:
        if not _take_daily_slot("analyze-calls", request.user, ANALYZE_CALLS_PER_DAY):
            return fail("You've reached today's limit for photo analysis. Please try again tomorrow.", status=429)
        try:
            result = ai_inference.classify_images(root_file_bytes, trunk_file_bytes)
            disease = result["disease"]
            confidence = result["confidence"]
            if result.get("root_condition"):
                root_condition = result["root_condition"]
            used_ai = True
        except ai_inference.InferenceError as exc:
            logger.warning("AI inference failed during save: %s", exc)
            return fail(
                "The detection service didn't respond, so this scan wasn't saved. Please try again in a moment.",
                status=503,
            )
    elif ai_inference.AI_MODEL_ENABLED:
        # Model is on but there is nothing to run it on (a photo is missing).
        return fail("Add both a root photo and a trunk photo, then run the analysis before saving.")

    # Whatever came from the form (not from the model just above) is
    # validated: confidence must be a real number (0-100), and the disease
    # must be one the app knows -- and must be present at all.
    confidence = _parse_confidence(confidence)
    if confidence is None:
        return fail("The detection confidence isn't a valid number. Run the analysis again, then save.")
    if not used_ai:
        if not disease:
            return fail("There's no detection result to save yet. Run the analysis first.")
        if disease not in get_disease_lookup():
            return fail("That disease result isn't recognised. Run the analysis again, then save.")

    if not tree_id:
        # Next free number for this farm (highest existing + 1, never reusing
        # an ID that exists), so a save can never silently overwrite a tree.
        tree_id = _next_auto_tree_id(farm)
    elif not tree_id.startswith(f"{farm.farm_id}-"):
        # Ensure user-typed tree IDs stay globally unique by always
        # prefixing with the farm ID, since tree_id is only unique per farm
        # at the database level but URLs/lookups treat it as the sole key.
        tree_id = f"{farm.farm_id}-{tree_id}"
    if len(tree_id) > TREE_ID_MAX_LENGTH:
        return fail(
            f"That Tree ID is too long once the farm ID is added (limit {TREE_ID_MAX_LENGTH} characters). "
            "Please use a shorter one."
        )

    try:
        existing_tree = RubberTree.objects.filter(tree_id=tree_id).first()

        if existing_tree and existing_tree.farm_id != farm.id:
            return fail(f"Tree ID '{tree_id}' is already in use. Please choose a different ID.")

        if existing_tree:
            # Rescan: update the tree's current snapshot and blank out
            # recommended_action so save() re-derives it for the new
            # disease/severity combination.
            tree = existing_tree
            tree.disease = disease
            tree.confidence = float(confidence)
            tree.root_condition = root_condition
            tree.severity_score = 0.0
            tree.recommended_action = ""
            tree.date_scanned = datetime.date.today()
            tree.captured_at = captured_at
            tree.lat = tree_lat
            tree.lng = tree_lng
            tree.gps_accuracy = gps_accuracy
            if root_image_resized:
                tree.root_image = root_image_resized
            if trunk_image_resized:
                tree.trunk_image = trunk_image_resized
            tree.save()
        else:
            tree = RubberTree.objects.create(
                farm=farm, tree_id=tree_id,
                lat=tree_lat, lng=tree_lng, gps_accuracy=gps_accuracy,
                disease=disease, confidence=float(confidence),
                root_condition=root_condition,
                date_scanned=datetime.date.today(), captured_at=captured_at,
                root_image=root_image_resized, trunk_image=trunk_image_resized,
                # recommended_action is left blank here so RubberTree.save() derives
                # it from disease + severity_label (see SEVERITY_RECOMMENDATIONS).
            )

        ScanHistory.objects.create(
            tree=tree, date=datetime.date.today(), captured_at=captured_at,
            disease=disease, confidence=float(confidence), inspector=request.user.username,
            root_condition=root_condition,
            root_image=root_image_resized, trunk_image=trunk_image_resized,
        )
    except Exception:
        # Without this, any unexpected DB/storage error here (e.g. a
        # pending migration not yet applied) returns Django's HTML error
        # page instead of JSON, which offline_queue.js can't parse. The real
        # error is logged (see the server error log); the user only gets a
        # plain message, since database/storage details don't help them.
        logger.exception("save_detection failed for tree %s", tree_id)
        return fail(
            "We couldn't save this tree. Please try again. If it keeps happening, contact your administrator.",
            status=500,
        )

    verb = "updated" if existing_tree else "saved"
    messages.success(request, f"Tree '{tree_id}' {verb}.")

    if is_ajax:
        return JsonResponse({"ok": True, "tree_id": tree_id, "verb": verb})
    return redirect("tree_details", tree_id=tree_id)


@login_required
def tree_inventory(request):
    # Renders the tree inventory table, filtered by the selected farm if
    # set, plus optional search/disease/farm query params, and paginated
    # so large datasets don't try to render thousands of rows at once.
    farm = _get_farm_or_none(request)
    total, counts, pcts, diseased = _get_stats(request, farm)
    disease_breakdown = _get_disease_breakdown(request, farm)
    top_disease = max(disease_breakdown, key=lambda d: d["count"], default=None)
    if top_disease and top_disease["count"] == 0:
        top_disease = None
    trees_qs = _get_trees(request, farm).select_related("farm").order_by("tree_id")

    search_q = request.GET.get("q", "").strip()
    disease_filter = request.GET.get("disease", "").strip()
    farm_filter = request.GET.get("farm", "").strip()
    range_filter = request.GET.get("range", "").strip()
    severity_filter = request.GET.get("severity", "").strip()

    if search_q:
        trees_qs = trees_qs.filter(tree_id__icontains=search_q)
    if disease_filter:
        trees_qs = trees_qs.filter(disease=disease_filter)
    if farm_filter:
        trees_qs = trees_qs.filter(farm__farm_id=farm_filter)
    trees_qs = _apply_range_filter(trees_qs, range_filter, "date_scanned")
    severity_bounds = _severity_bounds(severity_filter)
    if severity_bounds:
        trees_qs = trees_qs.filter(**severity_bounds)

    paginator = Paginator(trees_qs, 25)
    page_number = request.GET.get("page", 1)
    trees_page = paginator.get_page(page_number)

    ctx = _base_context(request, farm)
    ctx.update({
        "page": "tree_inventory",
        "trees": trees_page,
        "total": total, "counts": counts, "diseased": diseased,
        # Share of all trees, for the stat-card captions. Healthy is the sum
        # over every is_healthy class (see _get_stats); diseased is the rest.
        "healthy_pct": pcts["Healthy"],
        "diseased_pct": round(diseased / total * 100, 1) if total else 0,
        "top_disease": top_disease,
        "search_q": search_q, "disease_filter": disease_filter, "farm_filter": farm_filter,
        "range_filter": range_filter, "severity_filter": severity_filter,
        "disease_classes": DiseaseClass.objects.all().order_by("display_order", "name"),
    })
    return render(request, "tree_inventory.html", ctx)


@login_required
def tree_details(request, tree_id):
    # Renders the detail page for a single tree, including its scan history.
    from django.http import Http404
    tree = (
        RubberTree.objects.select_related("farm")
        .filter(tree_id=tree_id, farm__owner=request.user)
        .first()
    )
    if not tree:
        raise Http404("Tree not found")
    history_qs = tree.history.all()
    paginator = Paginator(history_qs, 25)
    page_number = request.GET.get("page", 1)
    history_page = paginator.get_page(page_number)
    farm = _get_farm_or_none(request)
    ctx = _base_context(request, farm)
    ctx.update({
        "page": "tree_inventory",
        "tree": tree,
        "history": history_page,
        # Chart needs every scan to plot an accurate trend, not just the
        # current table page -- kept separate from the paginated "history"
        # context var used for the table below.
        "history_chart_json": _json_for_script(
            [
                {"date": h.date, "confidence": h.confidence, "disease": h.disease, "is_healthy": h.is_healthy}
                for h in history_qs
            ],
            default=str,
        ),
        "progression": tree.get_progression_trend(),
        "tree_farm_boundary": _json_for_script(tree.farm.get_boundary_polygon()),
        # Legend + chart colors, pulled from the DiseaseClass catalog.
        "legend_diseases": DiseaseClass.objects.all().order_by("display_order", "name"),
        "disease_colors_json": _json_for_script({name: dc.color_hex for name, dc in get_disease_lookup().items()}),
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
    effectiveness, recent_interventions = _get_intervention_effectiveness(request, farm)
    disease_breakdown = _get_disease_breakdown(request, farm)
    disease_stats = _get_full_disease_stats(request, farm)
    confidence_summary = _get_confidence_summary(request, farm)
    insight_cards = _get_key_insight_cards(total, counts, pcts, diseased, effectiveness, disease_breakdown, confidence_summary)
    recommendations = _get_recommendations(disease_breakdown, effectiveness)

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
        "disease_stats": disease_stats,
        "healthy_color": _healthy_color_hex(),
        "severity_counts": severity_counts,
        "monthly": monthly,
        "most_affected": most_affected,
        "farm_summaries": farm_summaries,
        "effectiveness": effectiveness,
        "recent_interventions": recent_interventions,
        "insight_cards": insight_cards,
        "recommendations": recommendations,
        "ai_model_version": AI_MODEL_VERSION,
        "report_version": REPORT_VERSION,
        "generated_at": timezone.now(),
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
        "trees_json": _json_for_script([t.to_dict() for t in trees_qs]),
        "intervention_count": Intervention.objects.filter(tree__farm__owner=request.user).count(),
    })
    return render(request, "interventions_map.html", ctx)


@login_required
def interventions_log(request):
    # Lists all logged interventions for the user's trees, most recent
    # first, paginated so a farm with many interventions doesn't render
    # them all on one page.
    farm = _get_farm_or_none(request)
    qs = Intervention.objects.select_related("tree", "tree__farm", "performed_by").filter(
        tree__farm__owner=request.user
    )
    if farm:
        qs = qs.filter(tree__farm=farm)

    search_q = request.GET.get("q", "").strip()
    action_filter = request.GET.get("action", "").strip()
    farm_filter = request.GET.get("farm", "").strip()
    range_filter = request.GET.get("range", "").strip()

    if search_q:
        qs = qs.filter(tree__tree_id__icontains=search_q)
    if action_filter:
        qs = qs.filter(action=action_filter)
    if farm_filter:
        qs = qs.filter(tree__farm__farm_id=farm_filter)
    qs = _apply_range_filter(qs, range_filter, "date_performed")

    qs = qs.order_by("-date_performed", "-created_at")

    paginator = Paginator(qs, 25)
    page_number = request.GET.get("page", 1)
    interventions_page = paginator.get_page(page_number)

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
        "interventions": interventions_page,
        "farm_trees_json": _json_for_script(farm_trees),
        "search_q": search_q, "action_filter": action_filter,
        "farm_filter": farm_filter, "range_filter": range_filter,
        "action_choices": Intervention.ACTION_CHOICES,
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

    # Guard against farm_pk being missing/blank -- filtering pk="" crashes
    # with a ValueError instead of a clean 404 (every other farm_pk lookup
    # in this file already has an equivalent guard; this one didn't).
    if not farm_pk or not str(farm_pk).isdigit():
        messages.error(request, "No farm was selected for this intervention.")
        return redirect("interventions_log")

    # create() below doesn't check `choices`, and a bad date string would
    # raise at save time (HTTP 500), so both are validated here first.
    if action not in {value for value, _label in Intervention.ACTION_CHOICES}:
        messages.error(request, "Choose an action from the list.")
        return redirect("interventions_log")
    try:
        date_performed = datetime.date.fromisoformat(str(date_performed))
    except ValueError:
        messages.error(request, "Enter a valid date for this intervention.")
        return redirect("interventions_log")

    farm = get_object_or_404(Farm, pk=int(farm_pk), owner=request.user)
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
        messages.error(request, "Select at least one tree to log this intervention.")
        return redirect("interventions_log")

    created = 0
    for tree in trees:
        Intervention.objects.create(
            tree=tree, performed_by=request.user, action=action,
            date_performed=date_performed, notes=notes,
        )
        created += 1

    messages.success(request, f"Logged '{action}' on {created} tree{'s' if created != 1 else ''}.")
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
    disease_stats = _get_full_disease_stats(request, farm)
    label = farm.farm_id if farm else "all_farms"

    response = HttpResponse(content_type="text/csv")
    response["Content-Disposition"] = f'attachment; filename="rubberguard_summary_{label}.csv"'

    writer = csv.writer(response)
    writer.writerow(["RubberGuard Disease Detection Summary"])
    writer.writerow(["Scope", _safe_cell(farm.name) if farm else "All Farms"])
    writer.writerow([])
    writer.writerow(["Disease Class", "Count", "Percentage"])
    for d in disease_stats:
        writer.writerow([_safe_cell(d["name"]), d["count"], f'{d["pct"]}%'])
    writer.writerow(["Total", total, "100%"])

    if not farm:
        disease_names = [d["name"] for d in disease_stats]
        writer.writerow([])
        writer.writerow(["Per-Farm Breakdown"])
        writer.writerow(["Farm ID", "Farm Name", "Owner", "Total Trees"] + [_safe_cell(n) for n in disease_names])
        for f in Farm.objects.filter(owner=request.user).order_by("farm_id"):
            f_stats = {d["name"]: d["count"] for d in _get_full_disease_stats(request, f)}
            writer.writerow(
                [_safe_cell(f.farm_id), _safe_cell(f.name), _safe_cell(f.owner_name), f.trees.count()]
                + [f_stats.get(name, 0) for name in disease_names]
            )

    return response


@login_required
def export_excel(request):
    # Exports a summary-only Excel file: overall disease totals and a per-farm breakdown.
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill
    from django.http import HttpResponse

    farm = _get_farm_or_none(request)
    total, counts, pcts, diseased = _get_stats(request, farm)
    disease_stats = _get_full_disease_stats(request, farm)
    label = farm.farm_id if farm else "all_farms"

    header_font = Font(bold=True, color="FFFFFF")
    header_fill = PatternFill(start_color="1A2535", end_color="1A2535", fill_type="solid")
    title_font = Font(bold=True, size=13)

    wb = Workbook()
    ws = wb.active
    ws.title = "Summary"

    ws.append(["RubberGuard Disease Detection Summary"])
    ws["A1"].font = title_font
    ws.append(["Scope", _safe_cell(farm.name) if farm else "All Farms"])
    ws.append([])

    ws.append(["Disease Class", "Count", "Percentage"])
    for cell in ws[ws.max_row]:
        cell.font = header_font
        cell.fill = header_fill

    for d in disease_stats:
        ws.append([_safe_cell(d["name"]), d["count"], f'{d["pct"]}%'])
    ws.append(["Total", total, "100%"])
    for cell in ws[ws.max_row]:
        cell.font = Font(bold=True)

    if not farm:
        disease_names = [d["name"] for d in disease_stats]
        ws.append([])
        ws.append(["Per-Farm Breakdown"])
        ws[f"A{ws.max_row}"].font = Font(bold=True, size=11)
        ws.append(["Farm ID", "Farm Name", "Owner", "Total Trees"] + [_safe_cell(n) for n in disease_names])
        for cell in ws[ws.max_row]:
            cell.font = header_font
            cell.fill = header_fill
        for f in Farm.objects.filter(owner=request.user).order_by("farm_id"):
            f_stats = {d["name"]: d["count"] for d in _get_full_disease_stats(request, f)}
            ws.append(
                [_safe_cell(f.farm_id), _safe_cell(f.name), _safe_cell(f.owner_name), f.trees.count()]
                + [f_stats.get(name, 0) for name in disease_names]
            )

    for col in ws.columns:
        max_len = max((len(str(c.value)) if c.value else 0 for c in col), default=0)
        ws.column_dimensions[col[0].column_letter].width = min(max_len + 4, 40)

    response = HttpResponse(content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    response["Content-Disposition"] = f'attachment; filename="rubberguard_summary_{label}.xlsx"'
    wb.save(response)
    return response


@login_required
def export_pdf(request):
    # Gathers the numbers for the report and hands them to report_pdf, which
    # does all the drawing (layout, charts, page furniture).
    from django.http import HttpResponse
    from .report_pdf import build_report_pdf

    _, label = _export_rows(request)
    farm = _get_farm_or_none(request)
    total, counts, pcts, diseased = _get_stats(request, farm)
    disease_stats = _get_full_disease_stats(request, farm)
    effectiveness, _recent_ivs = _get_intervention_effectiveness(request, farm)
    intervention_by_disease = _get_intervention_effectiveness_by_disease(request, farm)
    disease_breakdown = _get_disease_breakdown(request, farm)
    confidence_summary = _get_confidence_summary(request, farm)
    generated_at = timezone.now()

    # Per-farm breakdown (all-farms scope only): one grouped query for every
    # farm instead of two queries per farm.
    farm_rows = None
    if not farm:
        per_farm = {}
        grouped = (RubberTree.objects.filter(farm__owner=request.user)
                   .values("farm__farm_id", "disease").annotate(n=Count("id")))
        for row in grouped:
            per_farm.setdefault(row["farm__farm_id"], {})[row["disease"]] = row["n"]
        farm_rows = [
            {"farm_id": f.farm_id, "name": f.name,
             "total": sum(per_farm.get(f.farm_id, {}).values()),
             "counts": per_farm.get(f.farm_id, {})}
            for f in Farm.objects.filter(owner=request.user).order_by("farm_id")
        ]

    intervention_qs = Intervention.objects.select_related("tree", "tree__farm").filter(tree__farm__owner=request.user)
    if farm:
        intervention_qs = intervention_qs.filter(tree__farm=farm)
    recent_interventions = [
        {"tree_id": iv.tree.tree_id, "farm_id": iv.tree.farm.farm_id, "action": iv.action,
         "date": str(iv.date_performed), "notes": iv.notes or ""}
        for iv in intervention_qs.order_by("-date_performed")[:15]
    ]

    ctx = {
        "scope": farm.name if farm else "All Farms",
        "generated_label": generated_at.strftime("%Y-%m-%d %H:%M %Z").strip(),
        "ai_model": AI_MODEL_VERSION,
        "report_version": REPORT_VERSION,
        "total": total,
        "disease_stats": disease_stats,
        "disease_colors": {d["name"]: d["color"] for d in disease_stats},
        "severity_counts": _get_severity_counts(request, farm),
        "healthy_color": _healthy_color_hex(),
        "confidence": confidence_summary,
        "key_insights": _get_key_insights(total, counts, pcts, diseased, effectiveness, disease_breakdown, confidence_summary),
        "recommendations": _get_recommendations(disease_breakdown, effectiveness),
        "monthly": _get_monthly_trend(request, farm),
        "most_affected": _get_most_affected_farms(request),
        "farm_rows": farm_rows,
        "effectiveness": effectiveness,
        "by_disease": intervention_by_disease,
        "best_per_disease": _get_best_intervention_per_disease(intervention_by_disease),
        "recent_interventions": recent_interventions,
    }

    response = HttpResponse(content_type="application/pdf")
    response["Content-Disposition"] = f'attachment; filename="rubberguard_report_{label}.pdf"'
    build_report_pdf(response, ctx)
    return response


def csrf_failure(request, reason=""):
    # A CSRF mismatch on /login/ is usually a dropped mobile connection that
    # prevented the csrftoken cookie from being set before the form was
    # submitted (see server error log: "OSError: write error" immediately
    # preceding these). Instead of showing Django's raw 403 page, send the
    # user back to a fresh login form with a friendly explanation.
    messages.error(request, "Your session expired or the connection dropped. Please log in again.")
    return redirect("login")


@staff_member_required
def admin_dashboard(request):
    # A single operational dashboard: add disease classes without leaving
    # the app's own UI (full edit of an existing one still goes through
    # /admin/ for all the fields), plus storage and AI-model status at a
    # glance. Restricted to staff accounts (create one via
    # `manage.py createsuperuser` or the /admin/ Users page).
    #
    # Being staff only opens the page. Adding a disease class changes the
    # colours and treatment advice every farmer sees, so it also needs the same
    # Django permission /admin/ asks for (superusers always have it); a staff
    # account with no permissions can look but not change.
    can_add_disease = request.user.has_perm("farmmap.add_diseaseclass")
    if request.method == "POST":
        if not can_add_disease:
            raise PermissionDenied
        name = request.POST.get("name", "").strip()
        color_hex = request.POST.get("color_hex", "#6c757d").strip()
        # Colours are written into inline styles and map-icon markup, so
        # only a plain #rrggbb value is accepted.
        color_ok = re.fullmatch(r"#[0-9a-fA-F]{6}", color_hex) is not None
        try:
            danger_rank = int(request.POST.get("danger_rank") or 1)
        except ValueError:
            danger_rank = None
        marker_key = re.sub(
            r"[^a-z0-9_]", "",
            (request.POST.get("marker_key", "").strip() or name.lower().replace(" ", "_")).lower(),
        )
        if not name:
            messages.error(request, "Disease name is required.")
        elif len(name) > DISEASE_NAME_MAX_LENGTH or _DISEASE_NAME_RE.fullmatch(name) is None:
            messages.error(
                request,
                f"Disease name can use letters, numbers, spaces, dashes, dots and brackets "
                f"(up to {DISEASE_NAME_MAX_LENGTH} characters).",
            )
        elif not color_ok:
            messages.error(request, "Pick a colour in the form #rrggbb, for example #dc2626.")
        elif danger_rank is None:
            messages.error(request, "Danger rank must be a whole number.")
        elif DiseaseClass.objects.filter(name__iexact=name).exists():
            messages.error(request, f'"{name}" already exists.')
        else:
            DiseaseClass.objects.create(
                name=name,
                description=request.POST.get("description", "").strip(),
                display_order=DiseaseClass.objects.count(),
                color_hex=color_hex,
                marker_key=marker_key or "disease",
                danger_rank=danger_rank,
                is_healthy=request.POST.get("is_healthy") == "on",
                recommendation_mild=request.POST.get("recommendation_mild", "").strip(),
                recommendation_moderate=request.POST.get("recommendation_moderate", "").strip(),
                recommendation_severe=request.POST.get("recommendation_severe", "").strip(),
            )
            messages.success(request, f'Added disease class "{name}".')
        return redirect("admin_dashboard")

    diseases = DiseaseClass.objects.all().order_by("display_order", "name")

    # AI model analytics are necessarily a stub until real per-inference
    # logging exists -- there's no trained model wired in yet for most
    # deployments of this app. What's shown is what can be known today:
    # whether an endpoint is configured, and aggregate counts as a rough
    # proxy for "how much scanning has happened."
    ai_status = {
        "enabled": ai_inference.AI_MODEL_ENABLED,
        "endpoint_host": (
            ai_inference.AI_MODEL_ENDPOINT_URL.split("//")[-1].split("/")[0]
            if ai_inference.AI_MODEL_ENABLED else None
        ),
        "total_scans": ScanHistory.objects.count(),
        "total_trees": RubberTree.objects.count(),
        "avg_confidence": round(RubberTree.objects.aggregate(avg=Avg("confidence"))["avg"] or 0, 1),
    }

    ctx = _base_context(request, _get_farm_or_none(request))
    ctx.update({
        "page": "admin_dashboard",
        "can_add_disease": can_add_disease,
        "diseases": diseases,
        "storage_summary": storage_stats.get_storage_summary(),
        "ai_status": ai_status,
    })
    return render(request, "admin_dashboard.html", ctx)
