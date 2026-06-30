from django.db import models


class Farm(models.Model):
    farm_id = models.CharField(max_length=20, unique=True)
    name = models.CharField(max_length=100)
    owner_name = models.CharField(max_length=100)
    location = models.CharField(max_length=200, blank=True)
    center_lat = models.FloatField(default=6.9214)
    center_lng = models.FloatField(default=122.0790)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        # Returns a readable string representation of the farm.
        return f"{self.farm_id} — {self.name} ({self.owner_name})"

    def get_stats(self):
        # Returns total tree count, disease counts, percentages, and diseased count for this farm.
        trees = self.trees.all()
        total = trees.count()
        disease_map = {
            "Healthy": "Healthy",
            "Pink Disease": "Pink_Disease",
            "White Root Rot": "White_Root_Rot",
            "Stem Bleeding": "Stem_Bleeding",
        }
        counts = {v: 0 for v in disease_map.values()}
        for t in trees:
            key = disease_map.get(t.disease, "Healthy")
            counts[key] += 1
        pcts = {k: round(v / total * 100, 1) if total else 0 for k, v in counts.items()}
        diseased = counts["Pink_Disease"] + counts["White_Root_Rot"] + counts["Stem_Bleeding"]
        return total, counts, pcts, diseased


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

    farm = models.ForeignKey(Farm, on_delete=models.CASCADE, related_name="trees")
    tree_id = models.CharField(max_length=20, unique=True)
    lat = models.FloatField()
    lng = models.FloatField()
    disease = models.CharField(max_length=30, choices=DISEASE_CHOICES, default="Healthy")
    confidence = models.FloatField(default=0.0)
    date_scanned = models.DateField()
    block = models.CharField(max_length=10, blank=True)
    recommended_action = models.TextField(blank=True)
    notes = models.TextField(blank=True)

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

    def to_dict(self):
        # Returns a JSON-serializable dict of the tree's data for map and JS usage.
        return {
            "tree_id": self.tree_id,
            "farm_id": self.farm.farm_id,
            "farm_name": self.farm.name,
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
            "severity_weight": round((self.severity / 3) * (self.confidence / 100), 3) if self.severity else 0,
        }


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
