import math
import statistics

from django.conf import settings
from django.db import models
from django.db.models import Avg
from django.contrib.auth.models import User
from django.core.cache import cache
from django.db.models.signals import post_save, post_delete
from django.dispatch import receiver


_METERS_PER_DEG_LAT = 111320.0

# Default for how many distinct, usable GPS locations a farm needs before the
# live map is shown (see Farm.get_map_status). Override with
# FARM_MAP_MIN_GPS_POINTS in project/settings.py.
#
# Why 5: 3 non-collinear points is the mathematical minimum for any farm
# border at all, but a 3-point "farm" is just a triangle and a heatmap over
# it says nothing. 5 gives a border with real shape and enough points for a
# heatmap pattern, while still unlocking after a handful of scans.
DEFAULT_MIN_GPS_POINTS = 5

# Two readings closer than this are one location for counting purposes (GPS
# caching can reuse one fix across a whole scanning session, and phone GPS
# is only good to a few meters anyway). 5 decimal places is about 1.1 m.
_LOCATION_DEDUPE_DECIMALS = 5


def get_min_gps_points():
    return max(int(getattr(settings, "FARM_MAP_MIN_GPS_POINTS", DEFAULT_MIN_GPS_POINTS)), 3)


def _clean_points(points):
    # Filters a farm's tree coordinates down to the ones the boundary and
    # map bounds should actually be built from. One bad GPS fix (a 0,0
    # "null island" reading, an out-of-range value, or a stray point far
    # from everything else) would otherwise stretch the convex hull and the
    # zoom lock across the whole map, so the farm shrinks to a speck and its
    # border looks wrong. Those trees still show up as markers; they just
    # don't get to define the farm's outline.
    valid = []
    for lat, lng in points:
        if lat is None or lng is None:
            continue
        lat, lng = float(lat), float(lng)
        if not (math.isfinite(lat) and math.isfinite(lng)):
            continue
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            continue
        if abs(lat) < 1e-4 and abs(lng) < 1e-4:
            continue
        valid.append((lat, lng))

    # Too few points to tell an outlier from a normal spread.
    if len(valid) < 4:
        return valid

    med_lat = statistics.median(p[0] for p in valid)
    med_lng = statistics.median(p[1] for p in valid)
    cos_lat = max(math.cos(math.radians(med_lat)), 0.01)
    dists = [
        math.hypot((lat - med_lat) * _METERS_PER_DEG_LAT, (lng - med_lng) * _METERS_PER_DEG_LAT * cos_lat)
        for lat, lng in valid
    ]
    # Generous on purpose: a real farm that is simply large or elongated
    # keeps all its trees; only points far beyond the farm's own spread
    # (and at least 1 km out) are dropped.
    limit = max(1000.0, 8 * statistics.median(dists))
    return [p for p, d in zip(valid, dists) if d <= limit]


def _convex_hull(points):
    # Computes the convex hull of a set of (lat, lng) points using Andrew's
    # monotone chain algorithm. Pure Python, no external dependencies
    # (scipy isn't guaranteed to be available on all hosting tiers).
    points = sorted(set(points))
    if len(points) <= 2:
        return points

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower = []
    for p in points:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)

    upper = []
    for p in reversed(points):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)

    return lower[:-1] + upper[:-1]


def _expand_polygon(hull, center_lat, center_lng, factor=1.06, min_margin_m=10.0):
    # Pushes each hull point outward from the farm's center, so the drawn
    # boundary sits just outside the outermost trees instead of passing
    # directly through them. The push is at least `factor` (a percentage of
    # the point's distance from the center) AND at least `min_margin_m`
    # meters -- a pure percentage left a small farm's border only a couple
    # of meters past its edge trees, i.e. underneath their markers.
    # Every point moves along its own ray from the center, so the expanded
    # polygon always fully contains the original hull.
    cos_lat = max(math.cos(math.radians(center_lat)), 0.01)
    expanded = []
    for lat, lng in hull:
        d_lat = lat - center_lat
        d_lng = lng - center_lng
        dist_m = math.hypot(d_lat * _METERS_PER_DEG_LAT, d_lng * _METERS_PER_DEG_LAT * cos_lat)
        scale = max(factor, 1 + min_margin_m / dist_m) if dist_m > 0 else factor
        expanded.append([center_lat + d_lat * scale, center_lng + d_lng * scale])
    return expanded


class Farm(models.Model):
    owner = models.ForeignKey(User, on_delete=models.CASCADE, related_name="farms")
    farm_id = models.CharField(max_length=20)
    name = models.CharField(max_length=100)
    owner_name = models.CharField(max_length=100)
    # Structured PH address (Region -> Province -> City/Municipality ->
    # Barangay), picked via cascading selects on Add Farm -- see psgc.py
    # and farm_list.html. Stored as plain names, not PSGC codes: nothing
    # else in the app needs to join back against the PSGC dataset, so a
    # code would just be an extra layer of indirection for no benefit here.
    region = models.CharField(max_length=100, blank=True)
    province = models.CharField(max_length=100, blank=True)
    city_municipality = models.CharField(max_length=100, blank=True)
    barangay = models.CharField(max_length=100, blank=True)
    # Free-text detail below barangay level (sitio/purok, landmark, etc.)
    # -- the PSGC hierarchy above doesn't go any finer than barangay.
    location = models.CharField(max_length=200, blank=True)
    # These two are NOT user-editable and no longer represent "the" farm
    # center once real trees exist -- get_center() below computes the live
    # centroid of scanned trees instead. They only matter as a placeholder
    # anchor point for the brief window between farm creation and its first
    # tree scan (e.g. so a map has somewhere to sit before there's any real
    # data), and default to a general Zamboanga City point for that reason.
    center_lat = models.FloatField(default=6.9214)
    center_lng = models.FloatField(default=122.0790)
    # Same story -- only used for the pre-first-scan fallback square in
    # get_boundary_polygon() below, never shown to or set by the user.
    boundary_radius_m = models.PositiveIntegerField(default=300)
    created_at = models.DateTimeField(auto_now_add=True)

    def full_address(self):
        # Human-readable address built from the structured fields, falling
        # back to the old free-text location for farms created before this
        # existed (or if the person skipped the picker entirely).
        parts = [self.location, self.barangay, self.city_municipality, self.province]
        parts = [p for p in parts if p]
        return ", ".join(parts) if parts else (self.location or "—")

    class Meta:
        # farm_id only needs to be unique within a single user's farms,
        # not globally, since each user manages their own farm IDs.
        unique_together = ("owner", "farm_id")

    def __str__(self):
        # Returns a readable string representation of the farm.
        return f"{self.farm_id} — {self.name} ({self.owner_name})"

    def get_stats(self):
        # Returns total tree count, disease counts, percentages, and diseased
        # count for this farm, using a single GROUP BY-style query instead of
        # looping over every tree row in Python.
        from django.db.models import Count
        total = self.trees.count()
        raw_counts = dict(self.trees.values_list("disease").annotate(n=Count("id")).values_list("disease", "n"))
        counts = {
            "Healthy": raw_counts.get("Healthy", 0),
            "Pink_Disease": raw_counts.get("Pink Disease", 0),
            "White_Root_Rot": raw_counts.get("White Root Rot", 0),
            "Stem_Bleeding": raw_counts.get("Stem Bleeding", 0),
        }
        pcts = {k: round(v / total * 100, 1) if total else 0 for k, v in counts.items()}
        # total - Healthy rather than summing the 3 named keys above, so a
        # tree with a disease added after these 3 (e.g. Brown Bast) still
        # counts as diseased instead of silently vanishing from this total.
        diseased = total - counts["Healthy"]
        return total, counts, pcts, diseased

    def get_severity_stats(self):
        # Returns counts of trees by severity tier (Healthy/Mild/Moderate/Severe) for this farm.
        counts = {"Healthy": 0, "Mild": 0, "Moderate": 0, "Severe": 0}
        for t in self.trees.all():
            counts[t.severity_label] += 1
        return counts

    def get_center(self):
        # Returns (lat, lng) -- the farm's live center. Computed as the mean
        # position of every tree on the farm, recalculated fresh from the DB
        # on every call (same live-query approach as get_stats() above, no
        # caching, so it's never stale by even one scan). Only falls back to
        # the fixed anchor point on center_lat/center_lng for a brand new
        # farm that has no trees yet to average.
        agg = self.trees.aggregate(avg_lat=Avg("lat"), avg_lng=Avg("lng"))
        if agg["avg_lat"] is None:
            return self.center_lat, self.center_lng
        return agg["avg_lat"], agg["avg_lng"]

    def get_map_status(self, points=None):
        # Decides whether this farm has enough GPS data to show the live map.
        # Counts distinct, usable locations only -- the same filtered set the
        # boundary is built from (_clean_points), de-duplicated -- so a farm
        # with 50 scans that all share 2 GPS fixes (or are all 0,0) still
        # reads as having 2 locations, not 50. Pass `points` (a list of
        # (lat, lng)) if the caller already queried them.
        #
        # Returns a dict:
        #   ready     -- True when the live map can be drawn
        #   required  -- the minimum (get_min_gps_points())
        #   usable    -- distinct usable locations found
        #   needed    -- how many more locations to unlock the map (0 if ready)
        #   ignored   -- trees left out for an invalid / far-off GPS reading
        #   total     -- trees on the farm
        #   reason    -- "" when ready, "count" when short on locations, or
        #                "collinear" when there are enough but they all sit on
        #                one line, so they can't enclose an area
        raw = list(self.trees.values_list("lat", "lng")) if points is None else list(points)
        usable_points = _clean_points(raw)
        distinct = {
            (round(lat, _LOCATION_DEDUPE_DECIMALS), round(lng, _LOCATION_DEDUPE_DECIMALS))
            for lat, lng in usable_points
        }
        required = get_min_gps_points()
        usable = len(distinct)
        needed = max(required - usable, 0)
        reason = "count" if needed else ""
        if not needed and len(_convex_hull(usable_points)) < 3:
            needed, reason = 1, "collinear"
        return {
            "ready": needed == 0,
            "required": required,
            "usable": usable,
            "needed": needed,
            "ignored": len(raw) - len(usable_points),
            "total": len(raw),
            "reason": reason,
        }

    def get_boundary_polygon(self, points=None):
        # Returns the convex hull of this farm's tree coordinates as a list
        # of [lat, lng] points, forming a boundary that actually follows the
        # shape of the planted area instead of a fixed-radius circle. Falls
        # back to a small square around get_center() whenever the hull
        # doesn't come out to at least 3 points -- checked on the hull's
        # actual output, not the raw tree count, since _convex_hull()
        # dedupes internally: e.g. 5 trees sharing just 2 distinct GPS
        # readings (GPS caching reusing a fix across a scanning session is
        # a real way this happens) would pass a raw-count check but still
        # collapse to a 2-point non-polygon. Exactly-collinear points
        # degenerate the same way and are caught by the same check.
        points = _clean_points(self.trees.values_list("lat", "lng") if points is None else points)
        hull = _convex_hull(points) if points else []
        if points:
            # Center of the usable trees only -- get_center() averages every
            # tree, so a single bad GPS fix would drag it off the farm.
            center_lat = sum(p[0] for p in points) / len(points)
            center_lng = sum(p[1] for p in points) / len(points)
        else:
            center_lat, center_lng = self.center_lat, self.center_lng
        if len(hull) < 3:
            pad = max(self.boundary_radius_m, 200) / 111000
            return [
                [center_lat - pad, center_lng - pad],
                [center_lat - pad, center_lng + pad],
                [center_lat + pad, center_lng + pad],
                [center_lat + pad, center_lng - pad],
            ]

        # Expand the hull outward slightly so the boundary sits just
        # outside the outermost trees rather than clipping through them.
        return _expand_polygon(hull, center_lat, center_lng, factor=1.06)


class DiseaseClass(models.Model):
    """
    Dynamic disease catalog. What used to be hardcoded dicts (colors, danger
    ranks, per-severity recommendations) on RubberTree now lives here and is
    editable through the Django admin — since the real disease list depends
    on whatever the trained CNN model ends up covering, which depends on
    dataset/field availability, not something fixed at development time.
    Add, edit, or remove a disease here and every part of the app (badges,
    heatmap, recommendations) picks it up automatically.
    """
    name = models.CharField(max_length=50, unique=True, help_text="Must match the CNN model's class label exactly.")
    description = models.TextField(
        blank=True, help_text="Shown in the Disease Class Reference card, e.g. causal pathogen + visible symptoms."
    )
    display_order = models.PositiveIntegerField(default=0)
    color_hex = models.CharField(max_length=7, default="#6c757d", help_text="e.g. #dc3545")
    marker_key = models.SlugField(max_length=30, help_text="URL-safe key used in templates/JS, e.g. 'pink_disease'")
    danger_rank = models.PositiveSmallIntegerField(
        default=1, help_text="0=healthy. Used only for heatmap/marker intensity, not severity tiering."
    )
    is_healthy = models.BooleanField(default=False, help_text="Exactly one disease class should be marked Healthy.")
    recommendation_mild = models.TextField(blank=True)
    recommendation_moderate = models.TextField(blank=True)
    recommendation_severe = models.TextField(blank=True)

    class Meta:
        ordering = ["display_order", "name"]
        verbose_name_plural = "Disease classes"

    def __str__(self):
        return self.name

    def recommendation_for(self, severity_label):
        if self.is_healthy:
            return self.recommendation_mild or "No action needed. Continue regular monitoring every 30 days."
        return {
            "Mild": self.recommendation_mild,
            "Moderate": self.recommendation_moderate,
            "Severe": self.recommendation_severe,
        }.get(severity_label) or self.recommendation_moderate or self.recommendation_mild or ""


_DISEASE_CACHE_KEY = "disease_class_lookup_v1"


def get_disease_lookup():
    # Cached {name: DiseaseClass} dict, invalidated automatically whenever a
    # DiseaseClass is saved/deleted (see the signal handlers below). This
    # avoids a DB query per tree when rendering lists of hundreds of trees
    # (heatmap, dashboard, reports) while still reflecting admin edits
    # immediately.
    lookup = cache.get(_DISEASE_CACHE_KEY)
    if lookup is None:
        lookup = {d.name: d for d in DiseaseClass.objects.all()}
        cache.set(_DISEASE_CACHE_KEY, lookup, timeout=None)
    return lookup


def get_disease_choices():
    # Callable choices (Django 5.0+): evaluated lazily each time, so newly
    # added/removed DiseaseClass rows show up in forms/admin without a
    # migration or code change. Wrapped in try/except because Django's
    # system checks evaluate this against the CURRENT database state —
    # which means it can run before this table exists yet (a fresh install,
    # or while makemigrations itself is being generated).
    try:
        return [(d.name, d.name) for d in DiseaseClass.objects.all().order_by("display_order", "name")]
    except Exception:
        return []


@receiver([post_save, post_delete], sender=DiseaseClass)
def _clear_disease_cache(sender, **kwargs):
    cache.delete(_DISEASE_CACHE_KEY)


class RubberTree(models.Model):

    ROOT_CONDITION_CHOICES = [
        ("Healthy Roots", "Healthy Roots"),
        ("Exposed Roots Detected", "Exposed Roots Detected"),
    ]

    farm = models.ForeignKey(Farm, on_delete=models.CASCADE, related_name="trees")
    tree_id = models.CharField(max_length=40, unique=True)
    lat = models.FloatField()
    lng = models.FloatField()
    disease = models.CharField(max_length=50, choices=get_disease_choices, default="Healthy")
    confidence = models.FloatField(default=0.0)
    # Root condition is captured and assessed separately from the trunk
    # disease classification (comment 1/4: exposed roots aren't yet one of
    # the 4 trained CNN disease classes, so this is a lightweight flag
    # rather than a full root-disease classifier).
    root_condition = models.CharField(max_length=30, choices=ROOT_CONDITION_CHOICES, blank=True)
    root_image = models.ImageField(upload_to="scans/roots/%Y/%m/", blank=True, null=True)
    trunk_image = models.ImageField(upload_to="scans/trunks/%Y/%m/", blank=True, null=True)
    # Stored severity score (0-100). Auto-derived from disease + confidence
    # today; a future detection model can write to this field directly
    # instead of relying on the derived property.
    severity_score = models.FloatField(default=0.0, blank=True)
    date_scanned = models.DateField()
    # When the photo was actually taken (EXIF/device GPS timestamp from the
    # browser), not when this row was saved -- matters for offline scans
    # synced hours later. Null for older rows and any scan where neither
    # source could supply one.
    captured_at = models.DateTimeField(null=True, blank=True)
    recommended_action = models.TextField(blank=True)
    notes = models.TextField(blank=True)

    def save(self, *args, **kwargs):
        # Auto-derives severity_score from disease + confidence on every save,
        # unless it was already set explicitly (e.g. by a future ML pipeline).
        if not self.severity_score:
            self.severity_score = self._compute_severity_score()
        if not self.recommended_action:
            self.recommended_action = self.get_recommended_action()
        super().save(*args, **kwargs)

    def get_recommended_action(self):
        # Looks up a recommendation tied to both the disease AND its severity
        # tier (Mild/Moderate/Severe), via the dynamic DiseaseClass catalog
        # rather than a hardcoded dict. Returns "" if the disease name isn't
        # found in the catalog (e.g. it was renamed/removed after this scan
        # was recorded).
        disease_class = get_disease_lookup().get(self.disease)
        if not disease_class:
            return ""
        return disease_class.recommendation_for(self.severity_label)

    def _compute_severity_score(self):
        # Severity tier is driven by detection confidence, not disease type.
        # (Disease-type danger ranking is separate — see the `severity`
        # property below, used only for heatmap/marker intensity.)
        disease_class = get_disease_lookup().get(self.disease)
        if disease_class and disease_class.is_healthy:
            return 0.0
        return round(self.confidence, 1)

    def __str__(self):
        # Returns a readable string representation of the tree.
        return f"{self.tree_id} [{self.disease}] @ {self.farm.farm_id}"

    @property
    def color(self):
        # Returns the hex color code corresponding to the tree's disease status.
        disease_class = get_disease_lookup().get(self.disease)
        return disease_class.color_hex if disease_class else "#6c757d"

    @property
    def disease_key(self):
        # Returns a URL-safe key for the disease, used in templates and JS.
        disease_class = get_disease_lookup().get(self.disease)
        return disease_class.marker_key if disease_class else "unknown"

    @property
    def severity(self):
        # Returns the disease's danger rank, used for heatmap intensity only
        # (NOT the same as severity_label, which is confidence-driven).
        disease_class = get_disease_lookup().get(self.disease)
        return disease_class.danger_rank if disease_class else 0

    @property
    def severity_label(self):
        # Converts severity_score (0-100) into a Healthy/Mild/Moderate/Severe tier.
        disease_class = get_disease_lookup().get(self.disease)
        score = self.severity_score
        if (disease_class and disease_class.is_healthy) or score == 0:
            return "Healthy"
        if score < 34:
            return "Mild"
        if score < 67:
            return "Moderate"
        return "Severe"

    def get_progression_trend(self):
        # Compares this tree's two most recent ScanHistory entries and
        # labels the trend (comment 9). ScanHistory has no stored severity,
        # so it's recomputed here the same way _compute_severity_score()
        # does, keeping both in sync with a single source of truth (the
        # DiseaseClass catalog) rather than duplicating tier thresholds.
        recent = list(self.history.all()[:2])
        if len(recent) < 2:
            return {"trend": "Insufficient data", "detail": "Needs at least 2 scans to compare."}

        current, previous = recent[0], recent[1]
        lookup = get_disease_lookup()

        def score_of(scan):
            disease_class = lookup.get(scan.disease)
            if disease_class and disease_class.is_healthy:
                return 0.0
            return round(scan.confidence, 1)

        current_score, previous_score = score_of(current), score_of(previous)

        if current_score < previous_score:
            trend = "Improving"
        elif current_score > previous_score:
            trend = "Worsening"
        else:
            trend = "Stable"

        return {
            "trend": trend,
            "current_disease": current.disease,
            "previous_disease": previous.disease,
            "current_date": current.date,
            "previous_date": previous.date,
            "detail": f"{previous.disease} ({previous.date}) \u2192 {current.disease} ({current.date})",
        }

    def to_marker_dict(self):
        # Returns the bare minimum needed to place and filter a marker on
        # the interactive farm map: position, disease, and search/filter
        # fields. Full detail (recommended action, notes, inspector,
        # interventions) is fetched lazily via /inventory/api/<tree_id>/
        # only when the marker is actually clicked, since most markers on
        # a map are never clicked and don't need that payload sent upfront.
        return {
            "tree_id": self.tree_id,
            "lat": self.lat,
            "lng": self.lng,
            "disease": self.disease,
            "confidence": self.confidence,
            "severity_score": self.severity_score,
            "color": self.color,
            # Only meaningful when the view annotates it with an Exists
            # subquery (see farm_map view) -- False here is just a safe
            # default for any other caller of to_marker_dict() that
            # doesn't need intervention status.
            "has_intervention": getattr(self, "has_intervention", False),
        }

    def to_map_dict(self):
        # Returns a lightweight JSON-serializable dict for plotting map
        # markers only, without the extra per-tree queries that to_dict()
        # does for inspector/intervention detail. Use this for any view
        # that renders many trees at once (e.g. a farm-wide map).
        return {
            "tree_id": self.tree_id,
            "farm_id": self.farm.farm_id,
            "farm_name": self.farm.name,
            "farm_owner": self.farm.owner_name,
            "lat": self.lat,
            "lng": self.lng,
            "disease": self.disease,
            "disease_key": self.disease_key,
            "confidence": self.confidence,
            "date_scanned": str(self.date_scanned),
            "color": self.color,
            "recommended_action": self.recommended_action,
            "notes": self.notes,
            "severity": self.severity,
            "severity_label": self.severity_label,
            "severity_weight": round((self.severity / 3) * (self.confidence / 100), 3) if self.severity else 0,
        }

    def to_dict(self):
        # Returns a JSON-serializable dict including inspector and
        # intervention detail. If the caller prefetched "history" and
        # "interventions" (each pre-ordered, most recent first), this reads
        # entirely from that cache with zero extra queries; otherwise it
        # falls back to querying them directly. Prefer to_map_dict() for
        # views plotting many trees at once without prefetching.
        history_list = list(self.history.all())
        interventions_list = list(self.interventions.all())
        latest_scan = history_list[0] if history_list else None
        latest_intervention = interventions_list[0] if interventions_list else None
        data = self.to_map_dict()
        data.update({
            "inspector": latest_scan.inspector if latest_scan else "",
            "latest_intervention": latest_intervention.action if latest_intervention else "",
            "latest_intervention_date": str(latest_intervention.date_performed) if latest_intervention else "",
            "intervention_count": len(interventions_list),
        })
        return data


class ScanHistory(models.Model):
    tree = models.ForeignKey(RubberTree, on_delete=models.CASCADE, related_name="history")
    date = models.DateField()
    captured_at = models.DateTimeField(null=True, blank=True)
    # Multiple scans can land on the same calendar date during testing/demo
    # sessions; date alone can't break ties, so it's used as a tiebreaker
    # in Meta.ordering below (most recent scan date first, then most
    # recently created for same-day scans).
    created_at = models.DateTimeField(auto_now_add=True)
    disease = models.CharField(max_length=50)
    confidence = models.FloatField()
    inspector = models.CharField(max_length=100, blank=True)
    root_condition = models.CharField(max_length=30, blank=True)
    root_image = models.ImageField(upload_to="scans/roots/%Y/%m/", blank=True, null=True)
    trunk_image = models.ImageField(upload_to="scans/trunks/%Y/%m/", blank=True, null=True)

    class Meta:
        # Ordered by actual scan date first (not just DB insertion order) so
        # get_progression_trend()'s "most recent 2 scans" and the tree-detail
        # chart/table both reflect true chronological order.
        ordering = ["-date", "-created_at"]

    def __str__(self):
        # Returns a readable string showing the tree, scan date, and detected disease.
        return f"{self.tree.tree_id} on {self.date}: {self.disease}"


class Intervention(models.Model):
    """A manual action taken by a farmer/user to treat a diseased tree."""
    ACTION_CHOICES = [
        ("Fungicide Application", "Fungicide Application"),
        ("Bark Removal", "Bark Removal"),
        ("Root Treatment", "Root Treatment"),
        ("Uprooting", "Uprooting"),
        ("Quarantine", "Quarantine"),
        ("Soil Treatment", "Soil Treatment"),
        ("Tapping Suspended", "Tapping Suspended"),
        ("Monitoring Only", "Monitoring Only"),
        ("Other", "Other"),
    ]

    tree = models.ForeignKey(RubberTree, on_delete=models.CASCADE, related_name="interventions")
    performed_by = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, related_name="interventions")
    action = models.CharField(max_length=40, choices=ACTION_CHOICES, default="Other")
    date_performed = models.DateField()
    notes = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-date_performed"]

    def __str__(self):
        # Returns a readable string showing the tree, action, and date.
        return f"{self.tree.tree_id}: {self.action} on {self.date_performed}"

    def to_dict(self):
        # Returns a JSON-serializable dict for map/JS usage.
        return {
            "tree_id": self.tree.tree_id,
            "action": self.action,
            "date_performed": str(self.date_performed),
            "notes": self.notes,
            "performed_by": self.performed_by.username if self.performed_by else "Unknown",
        }


class UserSettings(models.Model):
    """Per-user preferences, currently just notification-bell tuning.
    Created lazily (get_or_create) the first time a user's settings are
    read or saved, so existing users never need a data migration."""
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name="settings")
    notify_lookback_days = models.PositiveIntegerField(
        default=7,
        help_text="Only scans within this many days show up as a notification.",
    )
    # Disease *names* the user has turned OFF. Default empty means every
    # non-healthy disease notifies out of the box -- including any added
    # to DiseaseClass later, with no code change needed here.
    notify_muted_diseases = models.JSONField(default=list, blank=True)

    def __str__(self):
        # Returns a readable string identifying whose settings these are.
        return f"Settings for {self.user.username}"

    def enabled_diseases(self):
        # Returns the list of disease names this user wants notifications
        # for: every non-healthy disease in the live catalog, minus the
        # ones they've muted.
        return [
            d.name for d in get_disease_lookup().values()
            if not d.is_healthy and d.name not in self.notify_muted_diseases
        ]


class NotificationDismissal(models.Model):
    """Tracks which bell notifications a user has already clicked, so a
    dismissed one stops reappearing in the dropdown/badge count.

    Notifications themselves aren't stored rows -- _build_notifications()
    in views.py derives them fresh each request from recently-scanned
    RubberTree rows. So "dismissed" is tracked separately here, keyed by
    (user, tree, date_scanned) rather than just (user, tree): a
    notification is really "this tree's scan from this date", so if the
    tree gets rescanned later (a new date_scanned, even for the same
    disease persisting), that's a fresh event worth surfacing again
    instead of staying silently dismissed forever."""
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="dismissed_notifications")
    tree = models.ForeignKey(RubberTree, on_delete=models.CASCADE, related_name="notification_dismissals")
    date_scanned = models.DateField()
    dismissed_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ("user", "tree", "date_scanned")

    def __str__(self):
        return f"{self.user.username} dismissed {self.tree.tree_id} ({self.date_scanned})"
