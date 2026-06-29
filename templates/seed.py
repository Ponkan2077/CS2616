"""
Run once to populate the database with sample farms and trees.

Usage:
    python manage.py shell < farmmap/seed.py
  OR create a management command and run:
    python manage.py seed_data
"""

from farmmap.models import Farm, RubberTree, ScanHistory
import datetime

# Clear existing data
ScanHistory.objects.all().delete()
RubberTree.objects.all().delete()
Farm.objects.all().delete()

# ── Farms ──────────────────────────────────────────────────────────────────
farms_data = [
    {
        "farm_id": "FARM-001",
        "name": "Reyes Rubber Estate",
        "owner_name": "Jose Reyes",
        "location": "Brgy. Mampang, Zamboanga City",
        "center_lat": 6.9214,
        "center_lng": 122.0790,
    },
    {
        "farm_id": "FARM-002",
        "name": "Santos Plantation",
        "owner_name": "Maria Santos",
        "location": "Brgy. Sinunoc, Zamboanga City",
        "center_lat": 6.9350,
        "center_lng": 122.0900,
    },
    {
        "farm_id": "FARM-003",
        "name": "Cruz Family Farm",
        "owner_name": "Pedro Cruz",
        "location": "Brgy. Talon-Talon, Zamboanga City",
        "center_lat": 6.9100,
        "center_lng": 122.0650,
    },
]

farms = {}
for fd in farms_data:
    f = Farm.objects.create(**fd)
    farms[fd["farm_id"]] = f
    print(f"Created farm: {f}")

# ── Trees ──────────────────────────────────────────────────────────────────
trees_data = [
    # FARM-001 trees
    {
        "farm_id": "FARM-001", "tree_id": "RT-001",
        "lat": 6.9214, "lng": 122.0790,
        "disease": "Healthy", "confidence": 97.3,
        "date_scanned": "2025-06-01", "block": "A",
        "recommended_action": "No action needed. Continue regular monitoring every 30 days.",
        "notes": "Tree is in excellent condition. Strong bark, no visible lesions.",
        "history": [
            {"date": "2025-06-01", "disease": "Healthy", "confidence": 97.3, "inspector": "J. Reyes"},
            {"date": "2025-03-15", "disease": "Healthy", "confidence": 95.1, "inspector": "J. Reyes"},
        ],
    },
    {
        "farm_id": "FARM-001", "tree_id": "RT-021",
        "lat": 6.9228, "lng": 122.0805,
        "disease": "Pink Disease", "confidence": 91.6,
        "date_scanned": "2025-06-05", "block": "A",
        "recommended_action": "Apply fungicide (Mancozeb 80% WP) immediately. Remove infected bark.",
        "notes": "Pink corticioid fungus visible on lower trunk.",
        "history": [
            {"date": "2025-06-05", "disease": "Pink Disease", "confidence": 91.6, "inspector": "J. Reyes"},
            {"date": "2025-03-20", "disease": "Healthy", "confidence": 88.4, "inspector": "J. Reyes"},
        ],
    },
    {
        "farm_id": "FARM-001", "tree_id": "RT-045",
        "lat": 6.9201, "lng": 122.0778,
        "disease": "White Root Rot", "confidence": 85.9,
        "date_scanned": "2025-06-03", "block": "B",
        "recommended_action": "Uproot and destroy infected roots. Treat soil with Trichoderma biocontrol.",
        "notes": "White mycelial fans found under bark near soil line.",
        "history": [
            {"date": "2025-06-03", "disease": "White Root Rot", "confidence": 85.9, "inspector": "M. Santos"},
            {"date": "2025-02-10", "disease": "White Root Rot", "confidence": 72.4, "inspector": "M. Santos"},
        ],
    },
    {
        "farm_id": "FARM-001", "tree_id": "RT-078",
        "lat": 6.9240, "lng": 122.0820,
        "disease": "Stem Bleeding", "confidence": 88.2,
        "date_scanned": "2025-06-07", "block": "B",
        "recommended_action": "Scrape off infected bark. Apply Metalaxyl paste. Avoid tapping 60 days.",
        "notes": "Dark reddish exudate observed on main trunk.",
        "history": [
            {"date": "2025-06-07", "disease": "Stem Bleeding", "confidence": 88.2, "inspector": "J. Reyes"},
            {"date": "2025-04-01", "disease": "Stem Bleeding", "confidence": 76.5, "inspector": "M. Santos"},
        ],
    },
    # FARM-002 trees
    {
        "farm_id": "FARM-002", "tree_id": "RT-099",
        "lat": 6.9355, "lng": 122.0905,
        "disease": "Healthy", "confidence": 99.1,
        "date_scanned": "2025-06-01", "block": "C",
        "recommended_action": "No action needed. Continue regular monitoring every 30 days.",
        "notes": "Prime tapping tree. High latex yield observed.",
        "history": [
            {"date": "2025-06-01", "disease": "Healthy", "confidence": 99.1, "inspector": "J. Reyes"},
        ],
    },
    {
        "farm_id": "FARM-002", "tree_id": "RT-105",
        "lat": 6.9362, "lng": 122.0912,
        "disease": "White Root Rot", "confidence": 82.4,
        "date_scanned": "2025-06-06", "block": "C",
        "recommended_action": "Uproot and destroy infected roots. Quarantine surrounding trees within 5m.",
        "notes": "Early-stage infection. White mycelia strands visible near base.",
        "history": [
            {"date": "2025-06-06", "disease": "White Root Rot", "confidence": 82.4, "inspector": "M. Santos"},
            {"date": "2025-03-22", "disease": "Healthy", "confidence": 91.0, "inspector": "J. Reyes"},
        ],
    },
    {
        "farm_id": "FARM-002", "tree_id": "RT-112",
        "lat": 6.9348, "lng": 122.0895,
        "disease": "Healthy", "confidence": 94.7,
        "date_scanned": "2025-06-02", "block": "D",
        "recommended_action": "No action needed. Continue regular monitoring every 30 days.",
        "notes": "Young mature tree. Growth rate normal.",
        "history": [
            {"date": "2025-06-02", "disease": "Healthy", "confidence": 94.7, "inspector": "J. Reyes"},
        ],
    },
    # FARM-003 trees
    {
        "farm_id": "FARM-003", "tree_id": "RT-134",
        "lat": 6.9108, "lng": 122.0658,
        "disease": "Pink Disease", "confidence": 87.3,
        "date_scanned": "2025-06-08", "block": "D",
        "recommended_action": "Apply fungicide (Mancozeb 80% WP). Remove infected bark with copper paste.",
        "notes": "Mild pink corticioid infection on upper trunk branches.",
        "history": [
            {"date": "2025-06-08", "disease": "Pink Disease", "confidence": 87.3, "inspector": "M. Santos"},
            {"date": "2025-04-15", "disease": "Healthy", "confidence": 89.5, "inspector": "J. Reyes"},
        ],
    },
    {
        "farm_id": "FARM-003", "tree_id": "RT-150",
        "lat": 6.9095, "lng": 122.0642,
        "disease": "Healthy", "confidence": 96.0,
        "date_scanned": "2025-06-01", "block": "A",
        "recommended_action": "No action needed. Continue regular monitoring every 30 days.",
        "notes": "Excellent bark condition. High tapping potential.",
        "history": [
            {"date": "2025-06-01", "disease": "Healthy", "confidence": 96.0, "inspector": "J. Reyes"},
        ],
    },
    {
        "farm_id": "FARM-003", "tree_id": "RT-167",
        "lat": 6.9115, "lng": 122.0670,
        "disease": "Stem Bleeding", "confidence": 80.5,
        "date_scanned": "2025-06-09", "block": "B",
        "recommended_action": "Scrape off infected bark. Apply Metalaxyl paste. Avoid tapping 60 days.",
        "notes": "Borderline confidence — manual review recommended. Brown streaks on bark.",
        "history": [
            {"date": "2025-06-09", "disease": "Stem Bleeding", "confidence": 80.5, "inspector": "M. Santos"},
        ],
    },
]

for td in trees_data:
    history = td.pop("history")
    farm = farms[td.pop("farm_id")]
    date_scanned = datetime.date.fromisoformat(td.pop("date_scanned"))
    tree = RubberTree.objects.create(farm=farm, date_scanned=date_scanned, **td)
    for h in history:
        ScanHistory.objects.create(
            tree=tree,
            date=datetime.date.fromisoformat(h["date"]),
            disease=h["disease"],
            confidence=h["confidence"],
            inspector=h.get("inspector", ""),
        )
    print(f"Created tree: {tree}")

print("\nSeed complete.")
print(f"  Farms: {Farm.objects.count()}")
print(f"  Trees: {RubberTree.objects.count()}")
print(f"  Scan records: {ScanHistory.objects.count()}")

