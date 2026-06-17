from django.shortcuts import render

# ─────────────────────────────────────────────
# MOCK DATA — replace with DB queries later
# ─────────────────────────────────────────────

TREES = [
    {
        "tree_id": "RT-001", "lat": 6.9214, "lng": 122.0790,
        "disease": "Healthy", "disease_key": "healthy",
        "confidence": 97.3, "date_scanned": "2025-06-01",
        "color": "#28a745", "block": "A",
        "recommended_action": "No action needed. Continue regular monitoring every 30 days.",
        "notes": "Tree is in excellent condition. Strong bark, no visible lesions.",
        "history": [
            {"date": "2025-06-01", "disease": "Healthy", "confidence": 97.3, "inspector": "J. Reyes"},
            {"date": "2025-03-15", "disease": "Healthy", "confidence": 95.1, "inspector": "J. Reyes"},
            {"date": "2024-12-10", "disease": "Healthy", "confidence": 96.8, "inspector": "M. Santos"},
        ],
        "images": ["tree_sample.jpg"],
    },
    {
        "tree_id": "RT-021", "lat": 6.9228, "lng": 122.0805,
        "disease": "Pink Disease", "disease_key": "pink",
        "confidence": 91.6, "date_scanned": "2025-06-05",
        "color": "#dc3545", "block": "A",
        "recommended_action": "Apply fungicide (Mancozeb 80% WP) immediately. Remove infected bark and treat with copper-based paste. Re-inspect in 14 days.",
        "notes": "Pink corticioid fungus visible on lower trunk. Bark discoloration noted.",
        "history": [
            {"date": "2025-06-05", "disease": "Pink Disease", "confidence": 91.6, "inspector": "J. Reyes"},
            {"date": "2025-03-20", "disease": "Healthy", "confidence": 88.4, "inspector": "J. Reyes"},
            {"date": "2024-12-15", "disease": "Healthy", "confidence": 93.2, "inspector": "M. Santos"},
        ],
        "images": ["tree_sample.jpg"],
    },
    {
        "tree_id": "RT-045", "lat": 6.9201, "lng": 122.0778,
        "disease": "White Root Rot", "disease_key": "white_root",
        "confidence": 85.9, "date_scanned": "2025-06-03",
        "color": "#8b5a2b", "block": "B",
        "recommended_action": "Uproot and destroy infected roots. Treat soil with Trichoderma-based biocontrol. Quarantine surrounding trees within 5m radius.",
        "notes": "White mycelial fans found under bark near soil line. Severe root infection suspected.",
        "history": [
            {"date": "2025-06-03", "disease": "White Root Rot", "confidence": 85.9, "inspector": "M. Santos"},
            {"date": "2025-02-10", "disease": "White Root Rot", "confidence": 72.4, "inspector": "M. Santos"},
            {"date": "2024-11-05", "disease": "Healthy", "confidence": 90.1, "inspector": "J. Reyes"},
        ],
        "images": ["tree_sample.jpg"],
    },
    {
        "tree_id": "RT-078", "lat": 6.9240, "lng": 122.0820,
        "disease": "Stem Bleeding", "disease_key": "stem_bleeding",
        "confidence": 88.2, "date_scanned": "2025-06-07",
        "color": "#8b0000", "block": "B",
        "recommended_action": "Scrape off infected bark. Apply Metalaxyl paste to wound. Avoid tapping for 60 days. Monitor latex flow.",
        "notes": "Dark reddish exudate observed on main trunk. Phytophthora palmivora suspected.",
        "history": [
            {"date": "2025-06-07", "disease": "Stem Bleeding", "confidence": 88.2, "inspector": "J. Reyes"},
            {"date": "2025-04-01", "disease": "Stem Bleeding", "confidence": 76.5, "inspector": "M. Santos"},
            {"date": "2025-01-20", "disease": "Healthy", "confidence": 92.7, "inspector": "J. Reyes"},
        ],
        "images": ["tree_sample.jpg"],
    },
    {
        "tree_id": "RT-099", "lat": 6.9195, "lng": 122.0760,
        "disease": "Healthy", "disease_key": "healthy",
        "confidence": 99.1, "date_scanned": "2025-06-01",
        "color": "#28a745", "block": "C",
        "recommended_action": "No action needed. Continue regular monitoring every 30 days.",
        "notes": "Prime tapping tree. High latex yield observed.",
        "history": [
            {"date": "2025-06-01", "disease": "Healthy", "confidence": 99.1, "inspector": "J. Reyes"},
            {"date": "2025-03-10", "disease": "Healthy", "confidence": 98.3, "inspector": "M. Santos"},
        ],
        "images": ["tree_sample.jpg"],
    },
    {
        "tree_id": "RT-105", "lat": 6.9255, "lng": 122.0835,
        "disease": "White Root Rot", "disease_key": "white_root",
        "confidence": 82.4, "date_scanned": "2025-06-06",
        "color": "#8b5a2b", "block": "C",
        "recommended_action": "Uproot and destroy infected roots. Treat soil with Trichoderma-based biocontrol. Quarantine surrounding trees within 5m radius.",
        "notes": "Early-stage infection. White mycelia strands visible near base.",
        "history": [
            {"date": "2025-06-06", "disease": "White Root Rot", "confidence": 82.4, "inspector": "M. Santos"},
            {"date": "2025-03-22", "disease": "Healthy", "confidence": 91.0, "inspector": "J. Reyes"},
        ],
        "images": ["tree_sample.jpg"],
    },
    {
        "tree_id": "RT-112", "lat": 6.9180, "lng": 122.0745,
        "disease": "Healthy", "disease_key": "healthy",
        "confidence": 94.7, "date_scanned": "2025-06-02",
        "color": "#28a745", "block": "D",
        "recommended_action": "No action needed. Continue regular monitoring every 30 days.",
        "notes": "Young mature tree. Growth rate normal.",
        "history": [
            {"date": "2025-06-02", "disease": "Healthy", "confidence": 94.7, "inspector": "J. Reyes"},
        ],
        "images": ["tree_sample.jpg"],
    },
    {
        "tree_id": "RT-134", "lat": 6.9268, "lng": 122.0852,
        "disease": "Pink Disease", "disease_key": "pink",
        "confidence": 87.3, "date_scanned": "2025-06-08",
        "color": "#dc3545", "block": "D",
        "recommended_action": "Apply fungicide (Mancozeb 80% WP) immediately. Remove infected bark and treat with copper-based paste. Re-inspect in 14 days.",
        "notes": "Mild pink corticioid infection on upper trunk branches.",
        "history": [
            {"date": "2025-06-08", "disease": "Pink Disease", "confidence": 87.3, "inspector": "M. Santos"},
            {"date": "2025-04-15", "disease": "Healthy", "confidence": 89.5, "inspector": "J. Reyes"},
        ],
        "images": ["tree_sample.jpg"],
    },
    {
        "tree_id": "RT-150", "lat": 6.9210, "lng": 122.0800,
        "disease": "Healthy", "disease_key": "healthy",
        "confidence": 96.0, "date_scanned": "2025-06-01",
        "color": "#28a745", "block": "A",
        "recommended_action": "No action needed. Continue regular monitoring every 30 days.",
        "notes": "Excellent bark condition. High tapping potential.",
        "history": [
            {"date": "2025-06-01", "disease": "Healthy", "confidence": 96.0, "inspector": "J. Reyes"},
        ],
        "images": ["tree_sample.jpg"],
    },
    {
        "tree_id": "RT-167", "lat": 6.9235, "lng": 122.0770,
        "disease": "Stem Bleeding", "disease_key": "stem_bleeding",
        "confidence": 80.5, "date_scanned": "2025-06-09",
        "color": "#8b0000", "block": "B",
        "recommended_action": "Scrape off infected bark. Apply Metalaxyl paste to wound. Avoid tapping for 60 days. Monitor latex flow.",
        "notes": "Borderline confidence — manual review recommended. Brown streaks on bark.",
        "history": [
            {"date": "2025-06-09", "disease": "Stem Bleeding", "confidence": 80.5, "inspector": "M. Santos"},
        ],
        "images": ["tree_sample.jpg"],
    },
]

NOTIFICATIONS = [
    {"icon": "bi-exclamation-triangle-fill", "color": "text-danger", "msg": "Pink Disease detected at Tree RT-021", "time": "2 hrs ago"},
    {"icon": "bi-exclamation-triangle-fill", "color": "text-warning", "msg": "White Root Rot detected at Tree RT-105", "time": "5 hrs ago"},
    {"icon": "bi-exclamation-triangle-fill", "color": "text-danger", "msg": "Stem Bleeding detected at Tree RT-078", "time": "1 day ago"},
    {"icon": "bi-info-circle-fill", "color": "text-success", "msg": "Scan completed — Block A (50 trees)", "time": "2 days ago"},
]

MONTHLY_DETECTIONS = [
    {"month": "Jan", "healthy": 48, "pink": 2, "white_root": 1, "stem": 0},
    {"month": "Feb", "healthy": 47, "pink": 2, "white_root": 1, "stem": 1},
    {"month": "Mar", "healthy": 46, "pink": 3, "white_root": 2, "stem": 1},
    {"month": "Apr", "healthy": 45, "pink": 3, "white_root": 2, "stem": 2},
    {"month": "May", "healthy": 44, "pink": 4, "white_root": 2, "stem": 2},
    {"month": "Jun", "healthy": 43, "pink": 4, "white_root": 3, "stem": 2},
]


def _get_stats():
    total = len(TREES)
    counts = {"healthy": 0, "pink": 0, "white_root": 0, "stem": 0}
    disease_key_map = {
        "Healthy": "healthy",
        "Pink Disease": "pink",
        "White Root Rot": "white_root",
        "Stem Bleeding": "stem",
    }
    for t in TREES:
        counts[disease_key_map[t["disease"]]] += 1
    pcts = {k: round(v / total * 100, 1) for k, v in counts.items()}
    diseased = counts["pink"] + counts["white_root"] + counts["stem"]
    return total, counts, pcts, diseased


def dashboard(request):
    total, counts, pcts, diseased = _get_stats()
    recent = sorted(TREES, key=lambda t: t["date_scanned"], reverse=True)[:6]
    context = {
        "page": "dashboard",
        "total": total, 
        "counts": counts, 
        "pcts": pcts, 
        "diseased": diseased, # This variable already holds the sum
        "recent": recent, 
        "notifications": NOTIFICATIONS,
        "monthly": MONTHLY_DETECTIONS, 
        "latest_scan": "June 9, 2025",
    }
    return render(request, "dashboard.html", context)


def farm_map(request):
    import json
    total, counts, pcts, diseased = _get_stats()
    context = {
        "page": "farm_map",
        "trees_json": json.dumps(TREES),
        "notifications": NOTIFICATIONS,
        "total": total, "counts": counts, "diseased": diseased,
    }
    return render(request, "farm_map.html", context)


def disease_detection(request):
    context = {"page": "disease_detection", "notifications": NOTIFICATIONS}
    return render(request, "disease_detection.html", context)


def tree_inventory(request):
    total, counts, pcts, diseased = _get_stats()
    context = {
        "page": "tree_inventory",
        "trees": TREES, "notifications": NOTIFICATIONS,
        "total": total, "counts": counts, "diseased": diseased,
    }
    return render(request, "tree_inventory.html", context)


def tree_details(request, tree_id):
    tree = next((t for t in TREES if t["tree_id"] == tree_id), None)
    if tree is None:
        from django.http import Http404
        raise Http404("Tree not found")
    context = {"page": "tree_inventory", "tree": tree, "notifications": NOTIFICATIONS}
    return render(request, "tree_details.html", context)


def reports(request):
    total, counts, pcts, diseased = _get_stats()
    context = {
        "page": "reports",
        "total": total, "counts": counts, "pcts": pcts, "diseased": diseased,
        "notifications": NOTIFICATIONS, "monthly": MONTHLY_DETECTIONS,
    }
    return render(request, "reports.html", context)