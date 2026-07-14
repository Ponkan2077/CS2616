from django.db import models
from django.contrib.auth.models import User


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


def _expand_polygon(hull, center_lat, center_lng, factor=1.06):
    # Scales each hull point outward from the farm's center by a small
    # factor, so the drawn boundary sits just outside the outermost trees
    # instead of passing directly through them.
    return [
        [center_lat + (lat - center_lat) * factor, center_lng + (lng - center_lng) * factor]
        for lat, lng in hull
    ]


class Farm(models.Model):
    owner = models.ForeignKey(User, on_delete=models.CASCADE, related_name="farms")
    farm_id = models.CharField(max_length=20)
    name = models.CharField(max_length=100)
    owner_name = models.CharField(max_length=100)
    location = models.CharField(max_length=200, blank=True)
    center_lat = models.FloatField(default=6.9214)
    center_lng = models.FloatField(default=122.0790)
    # Approximate farm boundary radius in meters, used to draw a territory
    # circle on the map. Not a precise survey boundary, just a visual aid.
    boundary_radius_m = models.PositiveIntegerField(default=300)
    created_at = models.DateTimeField(auto_now_add=True)

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
        diseased = counts["Pink_Disease"] + counts["White_Root_Rot"] + counts["Stem_Bleeding"]
        return total, counts, pcts, diseased

    def get_severity_stats(self):
        # Returns counts of trees by severity tier (Healthy/Mild/Moderate/Severe) for this farm.
        counts = {"Healthy": 0, "Mild": 0, "Moderate": 0, "Severe": 0}
        for t in self.trees.all():
            counts[t.severity_label] += 1
        return counts

    def get_boundary_polygon(self):
        # Returns the convex hull of this farm's tree coordinates as a list
        # of [lat, lng] points, forming a boundary that actually follows the
        # shape of the planted area instead of a fixed-radius circle. Falls
        # back to a small square around the farm center if there are fewer
        # than 3 trees (not enough points to form a hull).
        points = list(self.trees.values_list("lat", "lng"))
        if len(points) < 3:
            pad = max(self.boundary_radius_m, 200) / 111000
            return [
                [self.center_lat - pad, self.center_lng - pad],
                [self.center_lat - pad, self.center_lng + pad],
                [self.center_lat + pad, self.center_lng + pad],
                [self.center_lat + pad, self.center_lng - pad],
            ]

        hull = _convex_hull(points)
        # Expand the hull outward slightly so the boundary sits just
        # outside the outermost trees rather than clipping through them.
        return _expand_polygon(hull, self.center_lat, self.center_lng, factor=1.06)


class RubberTree(models.Model):
    DISEASE_CHOICES = [
        ("Healthy", "Healthy"),
        ("Pink Disease", "Pink Disease"),
        ("White Root Rot", "White Root Rot"),
        ("Stem Bleeding", "Stem Bleeding"),
    ]
    COLOR_MAP = {
        "Healthy": "#28a745",
        "Pink Disease": "#dc3545",
        "White Root Rot": "#8b5a2b",
        "Stem Bleeding": "#8b0000",
    }
    DISEASE_KEY_MAP = {
        "Healthy": "healthy",
        "Pink Disease": "pink",
        "White Root Rot": "white_root",
        "Stem Bleeding": "stem_bleeding",
    }
    SEVERITY_MAP = {
        "Healthy": 0,
        "Pink Disease": 1,
        "White Root Rot": 2,
        "Stem Bleeding": 3,
    }
    # Recommendations now vary by severity tier, not just disease. Block/farm
    # "spread" recommendations are handled separately in views._get_recommendations().
    SEVERITY_RECOMMENDATIONS = {
        "Healthy": {
            "Healthy": "No action needed. Continue regular monitoring every 30 days.",
        },
        "Pink Disease": {
            "Mild": "Early-stage Pink Disease. Apply a copper-based fungicide preventively and monitor weekly.",
            "Moderate": "Apply fungicide (Mancozeb 80% WP) and remove infected bark. Recheck in 2 weeks.",
            "Severe": "Advanced spread — remove and destroy severely affected bark/branches, apply systemic fungicide immediately, and suspend tapping on this tree.",
        },
        "White Root Rot": {
            "Mild": "Early signs of White Root Rot. Improve soil drainage and apply Trichoderma biocontrol preventively.",
            "Moderate": "Uproot and destroy infected roots. Treat soil with Trichoderma biocontrol.",
            "Severe": "High risk of spread to neighboring trees — uproot and destroy the tree and connected root system, quarantine the block, treat soil, and inspect adjacent trees.",
        },
        "Stem Bleeding": {
            "Mild": "Minor bark lesions. Scrape and apply Metalaxyl paste; resume tapping after 30 days.",
            "Moderate": "Scrape off infected bark. Apply Metalaxyl paste. Avoid tapping for 60 days.",
            "Severe": "Severe stem bleeding — halt tapping entirely, apply systemic fungicide, and consult an agricultural technician about possible removal.",
        },
    }

    farm = models.ForeignKey(Farm, on_delete=models.CASCADE, related_name="trees")
    tree_id = models.CharField(max_length=40, unique=True)
    lat = models.FloatField()
    lng = models.FloatField()
    disease = models.CharField(max_length=30, choices=DISEASE_CHOICES, default="Healthy")
    confidence = models.FloatField(default=0.0)
    # Stored severity score (0-100). Auto-derived from disease + confidence
    # today; a future detection model can write to this field directly
    # instead of relying on the derived property.
    severity_score = models.FloatField(default=0.0, blank=True)
    date_scanned = models.DateField()
    block = models.CharField(max_length=10, blank=True)
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
        # tier (Mild/Moderate/Severe), rather than one generic action per
        # disease. Falls back to the Moderate tier text if severity_label
        # ever produces an unexpected value.
        tiers = self.SEVERITY_RECOMMENDATIONS.get(self.disease, {})
        return tiers.get(self.severity_label) or tiers.get("Moderate", "")

    def _compute_severity_score(self):
        # Severity tier is driven by detection confidence, not disease type.
        # (Disease-type danger ranking is separate — see the `severity`
        # property below, used only for heatmap/marker intensity.)
        #
        # NOTE: the previous formula was `(base/3) * confidence`, where base
        # is the disease's 0-3 danger rank. That mathematically capped Pink
        # Disease (base=1) at a max score of 33.3 — always "Mild" — and
        # White Root Rot (base=2) at max 66.7 — never "Severe" — no matter
        # how high the confidence. This also silently affected the Reports
        # page's severity distribution chart/table and the PDF export,
        # which both filter on this same field.
        if self.disease == "Healthy":
            return 0.0
        return round(self.confidence, 1)

    def __str__(self):
        # Returns a readable string representation of the tree.
        return f"{self.tree_id} [{self.disease}] @ {self.farm.farm_id}"

    @property
    def color(self):
        # Returns the hex color code corresponding to the tree's disease status.
        return self.COLOR_MAP.get(self.disease, "#28a745")

    @property
    def disease_key(self):
        # Returns a URL-safe key for the disease, used in templates and JS.
        return self.DISEASE_KEY_MAP.get(self.disease, "healthy")

    @property
    def severity(self):
        # Returns a 0-3 severity score used for heatmap intensity (0=healthy, 3=most severe).
        return self.SEVERITY_MAP.get(self.disease, 0)

    @property
    def severity_label(self):
        # Converts severity_score (0-100) into a Healthy/Mild/Moderate/Severe tier.
        score = self.severity_score
        if self.disease == "Healthy" or score == 0:
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
        # does, keeping both in sync with a single source of truth
        # (SEVERITY_MAP) rather than duplicating tier thresholds.
        recent = list(self.history.all()[:2])
        if len(recent) < 2:
            return {"trend": "Insufficient data", "detail": "Needs at least 2 scans to compare."}

        current, previous = recent[0], recent[1]

        def score_of(scan):
            base = self.SEVERITY_MAP.get(scan.disease, 0)
            return round((base / 3) * scan.confidence, 1) if base else 0.0

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
            "block": self.block,
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
            "block": self.block,
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
    disease = models.CharField(max_length=30)
    confidence = models.FloatField()
    inspector = models.CharField(max_length=100, blank=True)

    class Meta:
        ordering = ["-date"]

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
