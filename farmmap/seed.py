"""
Populates the database with a demo user, 3 farms, and ~1,500 trees per
farm (~4,500 total) with realistic scan history and intervention records.

Usage:
    python manage.py shell < farmmap/seed.py

Only deletes and recreates data belonging to the demo user (username
'demo'), so it's safe to re-run without touching any other user's data.
Uses bulk_create for performance since this generates thousands of rows.
"""

import random
import math
import datetime
from django.contrib.auth.models import User
from farmmap.models import Farm, RubberTree, ScanHistory, Intervention

random.seed(42)  # reproducible seed data across runs

TREES_PER_FARM = 1500
DISEASE_WEIGHTS = [("Healthy", 70), ("Pink Disease", 12), ("White Root Rot", 10), ("Stem Bleeding", 8)]
SEVERITY_MAP = {"Healthy": 0, "Pink Disease": 1, "White Root Rot": 2, "Stem Bleeding": 3}
BLOCKS = ["A", "B", "C", "D", "E", "F"]
INSPECTORS = ["J. Reyes", "M. Santos", "P. Cruz", "A. Lopez"]
ACTIONS = [a for a, _ in Intervention.ACTION_CHOICES]

RECOMMENDED_ACTIONS = {
    "Healthy": "No action needed. Continue regular monitoring every 30 days.",
    "Pink Disease": "Apply fungicide (Mancozeb 80% WP) immediately. Remove infected bark.",
    "White Root Rot": "Uproot and destroy infected roots. Treat soil with Trichoderma biocontrol.",
    "Stem Bleeding": "Scrape off infected bark. Apply Metalaxyl paste. Avoid tapping 60 days.",
}


def weighted_disease():
    # Picks a disease using the DISEASE_WEIGHTS distribution above.
    diseases, weights = zip(*DISEASE_WEIGHTS)
    return random.choices(diseases, weights=weights, k=1)[0]


def compute_severity_score(disease, confidence):
    # Mirrors RubberTree._compute_severity_score, since bulk_create skips save().
    base = SEVERITY_MAP.get(disease, 0)
    if base == 0:
        return 0.0
    return round((base / 3) * confidence, 1)


def random_date(start, end):
    # Returns a random date between start and end (inclusive).
    delta_days = (end - start).days
    return start + datetime.timedelta(days=random.randint(0, delta_days))


def jitter(base, spread):
    # Returns base +/- a small random offset, for scattering tree GPS points.
    return round(base + random.uniform(-spread, spread), 6)


def generate_grid_positions(center_lat, center_lng, count, row_spacing_m=6, col_spacing_m=3, jitter_m=0.8):
    # Places trees on a grid matching real rubber plantation spacing
    # (6m x 3m rows, ~555 trees/hectare, a standard configuration per
    # agricultural planting guides) instead of uniform random scatter,
    # which produced unrealistic dense clumps and empty gaps. A small
    # jitter is added per tree so the layout doesn't look robotically
    # perfect. NOTE: this places trees purely relative to the farm's
    # center coordinate with no coastline/land-use awareness — if a
    # farm's center_lat/center_lng is set too close to open water,
    # trees can still end up over water. Verify each farm's center
    # point is inland before relying on this for a real deployment.
    m_per_deg_lat = 111320
    m_per_deg_lng = 111320 * math.cos(math.radians(center_lat))
    row_spacing_deg = row_spacing_m / m_per_deg_lat
    col_spacing_deg = col_spacing_m / m_per_deg_lng
    jitter_lat_deg = jitter_m / m_per_deg_lat
    jitter_lng_deg = jitter_m / m_per_deg_lng

    cols = math.ceil(math.sqrt(count))
    rows = math.ceil(count / cols)
    positions = []
    start_lat = center_lat - (rows / 2) * row_spacing_deg
    start_lng = center_lng - (cols / 2) * col_spacing_deg

    for r in range(rows):
        for c in range(cols):
            if len(positions) >= count:
                break
            lat = start_lat + r * row_spacing_deg + random.uniform(-jitter_lat_deg, jitter_lat_deg)
            lng = start_lng + c * col_spacing_deg + random.uniform(-jitter_lng_deg, jitter_lng_deg)
            positions.append((round(lat, 6), round(lng, 6)))
    return positions


# Create (or reuse) the demo user that owns all seeded data.
demo_user, created = User.objects.get_or_create(username="demo")
if created:
    demo_user.set_password("demo12345")
    demo_user.save()
    print("Created demo user: username='demo', password='demo12345'")
else:
    print("Using existing demo user: username='demo'")

# Clear only the demo user's existing data, not any other user's.
Intervention.objects.filter(tree__farm__owner=demo_user).delete()
ScanHistory.objects.filter(tree__farm__owner=demo_user).delete()
RubberTree.objects.filter(farm__owner=demo_user).delete()
Farm.objects.filter(owner=demo_user).delete()

# ── Farms ──────────────────────────────────────────────────────────────────
farms_data = [
    {
        "farm_id": "FARM-001", "name": "Reyes Rubber Estate", "owner_name": "Jose Reyes",
        "location": "Brgy. Mampang, Zamboanga City",
        "center_lat": 6.9214, "center_lng": 122.0790, "boundary_radius_m": 200,
    },
    {
        "farm_id": "FARM-002", "name": "Santos Plantation", "owner_name": "Maria Santos",
        "location": "Brgy. Sinunoc, Zamboanga City",
        "center_lat": 6.9350, "center_lng": 122.0900, "boundary_radius_m": 180,
    },
    {
        "farm_id": "FARM-003", "name": "Cruz Family Farm", "owner_name": "Pedro Cruz",
        "location": "Brgy. Talon-Talon, Zamboanga City",
        "center_lat": 6.9100, "center_lng": 122.0650, "boundary_radius_m": 160,
    },
]

farms = {}
for fd in farms_data:
    f = Farm.objects.create(owner=demo_user, **fd)
    farms[fd["farm_id"]] = f
    print(f"Created farm: {f}")

SCAN_WINDOW_START = datetime.date(2025, 1, 1)
SCAN_WINDOW_END = datetime.date(2026, 6, 30)

# ── Trees, scan history, and interventions (bulk-created for speed) ───────
for farm_id, farm in farms.items():
    positions = generate_grid_positions(farm.center_lat, farm.center_lng, TREES_PER_FARM)
    tree_objs = []
    for i in range(1, TREES_PER_FARM + 1):
        disease = weighted_disease()
        confidence = round(random.uniform(75, 99.5), 1)
        date_scanned = random_date(SCAN_WINDOW_START, SCAN_WINDOW_END)
        lat, lng = positions[i - 1]
        tree_objs.append(RubberTree(
            farm=farm,
            tree_id=f"{farm_id}-RT-{i:04d}",
            lat=lat,
            lng=lng,
            disease=disease,
            confidence=confidence,
            severity_score=compute_severity_score(disease, confidence),
            date_scanned=date_scanned,
            block=random.choice(BLOCKS),
            recommended_action=RECOMMENDED_ACTIONS[disease],
            notes="",
        ))

    RubberTree.objects.bulk_create(tree_objs, batch_size=500)
    print(f"Bulk-created {len(tree_objs)} trees for {farm_id}")

    # Reload with real PKs for building related ScanHistory/Intervention rows.
    created_trees = list(RubberTree.objects.filter(farm=farm).order_by("tree_id"))

    scan_objs = []
    intervention_objs = []
    for tree in created_trees:
        # Each tree gets 1-3 scan history entries, most recent matching
        # the tree's current disease/confidence/date.
        num_scans = random.randint(1, 3)
        scan_objs.append(ScanHistory(
            tree=tree, date=tree.date_scanned, disease=tree.disease,
            confidence=tree.confidence, inspector=random.choice(INSPECTORS),
        ))
        for _ in range(num_scans - 1):
            earlier_date = random_date(SCAN_WINDOW_START, tree.date_scanned)
            earlier_disease = weighted_disease()
            scan_objs.append(ScanHistory(
                tree=tree, date=earlier_date, disease=earlier_disease,
                confidence=round(random.uniform(70, 99), 1),
                inspector=random.choice(INSPECTORS),
            ))

        # ~40% of diseased trees have at least one logged intervention.
        if tree.disease != "Healthy" and random.random() < 0.4:
            iv_date = random_date(tree.date_scanned, min(tree.date_scanned + datetime.timedelta(days=30), SCAN_WINDOW_END))
            intervention_objs.append(Intervention(
                tree=tree, performed_by=demo_user,
                action=random.choice(ACTIONS), date_performed=iv_date,
                notes="",
            ))

    ScanHistory.objects.bulk_create(scan_objs, batch_size=1000)
    Intervention.objects.bulk_create(intervention_objs, batch_size=500)
    print(f"Bulk-created {len(scan_objs)} scan records and {len(intervention_objs)} interventions for {farm_id}")

print("\nSeed complete.")
print(f"  Demo user: demo / demo12345 (only set on first creation)")
print(f"  Farms: {Farm.objects.filter(owner=demo_user).count()}")
print(f"  Trees: {RubberTree.objects.filter(farm__owner=demo_user).count()}")
print(f"  Scan records: {ScanHistory.objects.filter(tree__farm__owner=demo_user).count()}")
print(f"  Interventions: {Intervention.objects.filter(tree__farm__owner=demo_user).count()}")
