import datetime
import math

from django.contrib.auth.models import User
from django.test import TestCase, override_settings
from django.urls import reverse

from .models import (
    Farm, RubberTree, _clean_points, _expand_polygon, _convex_hull, get_min_gps_points,
)
from .views import _farm_map_bounds

# ~1 degree of latitude in meters; used to build test coordinates in meters.
M_PER_DEG = 111320.0
BASE_LAT, BASE_LNG = 6.9214, 122.0790


def _grid(rows=5, cols=5, spacing_m=10.0):
    """A small rectangular grid of (lat, lng) points, spacing_m apart."""
    cos_lat = math.cos(math.radians(BASE_LAT))
    return [
        (BASE_LAT + r * spacing_m / M_PER_DEG, BASE_LNG + c * spacing_m / (M_PER_DEG * cos_lat))
        for r in range(rows) for c in range(cols)
    ]


def _point_in_polygon(lat, lng, polygon):
    """Ray-casting point-in-polygon test (polygon is a list of [lat, lng])."""
    inside = False
    n = len(polygon)
    j = n - 1
    for i in range(n):
        yi, xi = polygon[i]
        yj, xj = polygon[j]
        if (xi > lng) != (xj > lng) and lat < (yj - yi) * (lng - xi) / (xj - xi) + yi:
            inside = not inside
        j = i
    return inside


class CleanPointsTests(TestCase):
    def test_keeps_normal_points(self):
        pts = _grid()
        self.assertEqual(len(_clean_points(pts)), len(pts))

    def test_drops_null_island_and_out_of_range_and_non_finite(self):
        pts = _grid() + [(0.0, 0.0), (95.0, 10.0), (10.0, 200.0), (float("nan"), 1.0), (float("inf"), 1.0)]
        cleaned = _clean_points(pts)
        self.assertEqual(len(cleaned), 25)
        self.assertNotIn((0.0, 0.0), cleaned)

    def test_drops_far_outlier_but_keeps_real_spread(self):
        # One tree ~50 km away from a compact farm.
        far = (BASE_LAT + 0.45, BASE_LNG)
        cleaned = _clean_points(_grid() + [far])
        self.assertNotIn(far, cleaned)
        self.assertEqual(len(cleaned), 25)

    def test_large_farm_keeps_all_its_trees(self):
        # A 2 km x 2 km farm must not lose trees to the outlier filter.
        pts = _grid(rows=5, cols=5, spacing_m=500.0)
        self.assertEqual(len(_clean_points(pts)), len(pts))

    def test_too_few_points_are_not_filtered(self):
        pts = [(BASE_LAT, BASE_LNG), (BASE_LAT + 0.2, BASE_LNG)]
        self.assertEqual(len(_clean_points(pts)), 2)


class ExpandPolygonTests(TestCase):
    def _distance_to_hull_m(self, hull, expanded):
        # Radial distance (meters) each vertex moved outward.
        cos_lat = math.cos(math.radians(BASE_LAT))
        return [
            math.hypot((e[0] - h[0]) * M_PER_DEG, (e[1] - h[1]) * M_PER_DEG * cos_lat)
            for h, e in zip(hull, expanded)
        ]

    def test_small_farm_gets_minimum_margin_in_meters(self):
        pts = _grid(rows=3, cols=3, spacing_m=5.0)  # 10 m x 10 m farm
        hull = _convex_hull(pts)
        c_lat = sum(p[0] for p in pts) / len(pts)
        c_lng = sum(p[1] for p in pts) / len(pts)
        moved = self._distance_to_hull_m(hull, _expand_polygon(hull, c_lat, c_lng))
        # The old 6% scale would have moved a corner of a 10 m farm by < 1 m.
        self.assertTrue(all(m >= 9.5 for m in moved), moved)

    def test_expanded_polygon_contains_every_tree(self):
        pts = _grid()
        hull = _convex_hull(pts)
        c_lat = sum(p[0] for p in pts) / len(pts)
        c_lng = sum(p[1] for p in pts) / len(pts)
        expanded = _expand_polygon(hull, c_lat, c_lng)
        for lat, lng in pts:
            self.assertTrue(_point_in_polygon(lat, lng, expanded), (lat, lng))


class FarmBoundaryTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user("owner", password="pw")
        self.farm = Farm.objects.create(owner=self.user, farm_id="F1", name="Farm One", owner_name="Owner")

    def _add_tree(self, n, lat, lng):
        return RubberTree.objects.create(
            farm=self.farm, tree_id=f"F1-RT-{n:04d}", lat=lat, lng=lng,
            disease="Healthy", confidence=90.0, date_scanned=datetime.date.today(),
        )

    def test_boundary_encloses_all_trees(self):
        for i, (lat, lng) in enumerate(_grid(), start=1):
            self._add_tree(i, lat, lng)
        polygon = self.farm.get_boundary_polygon()
        self.assertGreaterEqual(len(polygon), 3)
        for lat, lng in _grid():
            self.assertTrue(_point_in_polygon(lat, lng, polygon))

    def test_bad_gps_tree_does_not_stretch_boundary_or_bounds(self):
        for i, (lat, lng) in enumerate(_grid(), start=1):
            self._add_tree(i, lat, lng)
        self._add_tree(100, 0.0, 0.0)  # failed GPS fix
        polygon = self.farm.get_boundary_polygon()
        lats = [p[0] for p in polygon]
        # Polygon stays on the farm (a few hundred meters at most), not
        # stretched ~770 km down toward the equator.
        self.assertLess(max(lats) - min(lats), 0.01)
        bounds = _farm_map_bounds(self.farm, polygon)
        self.assertLess(bounds["max_lat"] - bounds["min_lat"], 0.02)

    def test_bounds_fully_contain_the_boundary_polygon(self):
        # Regression: bounds used to be fitted to the raw trees, which sit
        # inside the (expanded) border, so the border's edge was clipped.
        for i, (lat, lng) in enumerate(_grid(), start=1):
            self._add_tree(i, lat, lng)
        polygon = self.farm.get_boundary_polygon()
        bounds = _farm_map_bounds(self.farm, polygon)
        for lat, lng in polygon:
            self.assertGreaterEqual(lat, bounds["min_lat"])
            self.assertLessEqual(lat, bounds["max_lat"])
            self.assertGreaterEqual(lng, bounds["min_lng"])
            self.assertLessEqual(lng, bounds["max_lng"])

    def test_farm_with_no_trees_gets_fallback_square(self):
        polygon = self.farm.get_boundary_polygon()
        self.assertEqual(len(polygon), 4)
        bounds = _farm_map_bounds(self.farm, polygon)
        self.assertLess(bounds["min_lat"], self.farm.center_lat)
        self.assertGreater(bounds["max_lat"], self.farm.center_lat)

    def test_farm_with_collinear_trees_gets_fallback_square(self):
        for i in range(1, 6):
            self._add_tree(i, BASE_LAT, BASE_LNG + i * 0.0001)
        self.assertEqual(len(self.farm.get_boundary_polygon()), 4)

    def test_farm_map_page_renders_with_trees(self):
        for i, (lat, lng) in enumerate(_grid(), start=1):
            self._add_tree(i, lat, lng)
        self.client.login(username="owner", password="pw")
        response = self.client.get(reverse("farm_map"), {"farm": "F1"})
        self.assertEqual(response.status_code, 200)


class SaveDetectionGpsValidationTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user("owner", password="pw")
        self.farm = Farm.objects.create(owner=self.user, farm_id="F1", name="Farm One", owner_name="Owner")
        self.client.login(username="owner", password="pw")

    def _post(self, lat, lng):
        return self.client.post(
            reverse("save_detection"),
            {"farm_pk": self.farm.pk, "tree_id": "T1", "disease": "Healthy", "confidence": "90",
             "lat": lat, "lng": lng},
            HTTP_X_REQUESTED_WITH="XMLHttpRequest",
        )

    def test_rejects_invalid_coordinates(self):
        for lat, lng in [("0", "0"), ("nan", "122.0"), ("inf", "122.0"), ("91", "122.0"), ("6.9", "181")]:
            response = self._post(lat, lng)
            self.assertEqual(response.status_code, 400, (lat, lng))
        self.assertEqual(RubberTree.objects.count(), 0)

    def test_accepts_valid_coordinates(self):
        response = self._post("6.9214", "122.0790")
        self.assertNotEqual(response.status_code, 400)
        self.assertEqual(RubberTree.objects.count(), 1)


def _spread_points(k):
    """k distinct, non-collinear locations ~10 m apart (a zig-zag, never a straight line)."""
    return [(BASE_LAT + (i % 2) * 0.0001, BASE_LNG + i * 0.0001) for i in range(k)]


class MapGateTestCase(TestCase):
    """Shared setup: one user, one farm, and a helper to add trees at given points."""

    def setUp(self):
        self.user = User.objects.create_user("owner", password="pw")
        self.farm = Farm.objects.create(owner=self.user, farm_id="F1", name="Farm One", owner_name="Owner")

    def add_trees(self, points, disease="Healthy"):
        start = self.farm.trees.count()
        for i, (lat, lng) in enumerate(points, start=start + 1):
            RubberTree.objects.create(
                farm=self.farm, tree_id=f"F1-RT-{i:04d}", lat=lat, lng=lng,
                disease=disease, confidence=90.0, date_scanned=datetime.date.today(),
            )


class MapStatusTests(MapGateTestCase):
    def test_default_threshold_is_five(self):
        self.assertEqual(get_min_gps_points(), 5)

    @override_settings(FARM_MAP_MIN_GPS_POINTS=1)
    def test_threshold_never_drops_below_three(self):
        # Fewer than 3 points can't enclose an area, whatever the setting says.
        self.assertEqual(get_min_gps_points(), 3)

    @override_settings(FARM_MAP_MIN_GPS_POINTS=8)
    def test_threshold_is_configurable(self):
        self.add_trees(_spread_points(7))
        status = self.farm.get_map_status()
        self.assertEqual((status["required"], status["needed"], status["ready"]), (8, 1, False))

    def test_farm_with_no_trees(self):
        status = self.farm.get_map_status()
        self.assertFalse(status["ready"])
        self.assertEqual((status["usable"], status["needed"], status["reason"]), (0, 5, "count"))

    def test_counts_down_to_ready(self):
        for k, needed in [(1, 4), (2, 3), (3, 2), (4, 1), (5, 0)]:
            self.farm.trees.all().delete()
            self.add_trees(_spread_points(k))
            status = self.farm.get_map_status()
            self.assertEqual(status["needed"], needed, k)
            self.assertEqual(status["ready"], needed == 0, k)

    def test_trees_sharing_one_gps_fix_count_once(self):
        # GPS caching can reuse one reading for a whole scanning session.
        self.add_trees([(BASE_LAT, BASE_LNG)] * 30)
        status = self.farm.get_map_status()
        self.assertEqual((status["usable"], status["total"], status["ready"]), (1, 30, False))

    def test_readings_within_a_meter_count_once(self):
        # 0.000002 deg is about 0.2 m: the same spot to a phone's GPS.
        self.add_trees([(6.92140, 122.07900), (6.921402, 122.079002)] + _spread_points(3)[1:])
        self.assertEqual(self.farm.get_map_status()["usable"], 3)

    def test_invalid_and_stray_readings_are_ignored_and_reported(self):
        self.add_trees(_spread_points(4) + [(0.0, 0.0), (BASE_LAT + 0.5, BASE_LNG)])
        status = self.farm.get_map_status()
        self.assertEqual((status["usable"], status["ignored"], status["total"]), (4, 2, 6))
        self.assertFalse(status["ready"])

    def test_enough_locations_on_one_line_is_not_ready(self):
        self.add_trees([(BASE_LAT, BASE_LNG + i * 0.0001) for i in range(7)])
        status = self.farm.get_map_status()
        self.assertEqual((status["usable"], status["needed"], status["reason"], status["ready"]),
                         (7, 1, "collinear", False))

    def test_accepts_points_the_caller_already_queried(self):
        # No tree rows at all; status comes from the points passed in.
        status = self.farm.get_map_status(points=_spread_points(6))
        self.assertTrue(status["ready"])


class FarmMapPageGateTests(MapGateTestCase):
    def get_map(self):
        self.client.login(username="owner", password="pw")
        return self.client.get(reverse("farm_map"), {"farm": "F1"})

    def test_too_few_locations_shows_how_many_more_are_needed(self):
        self.add_trees(_spread_points(2))
        response = self.get_map()
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.context["map_locked"])
        self.assertContains(response, "Need 3 more GPS locations to show the live map")
        self.assertContains(response, "2 of 5")
        self.assertEqual(response.context["map_progress_pct"], 40)
        # No map data or scripts are sent to a locked page.
        self.assertNotContains(response, "FARM_MAP_DATA")
        self.assertNotContains(response, 'id="map-container"')

    def test_singular_wording_when_one_more_is_needed(self):
        self.add_trees(_spread_points(4))
        response = self.get_map()
        self.assertContains(response, "Need 1 more GPS location to show the live map")
        self.assertNotContains(response, "Need 1 more GPS locations")

    def test_farm_with_no_trees_is_locked_not_an_error(self):
        response = self.get_map()
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Need 5 more GPS locations")
        self.assertContains(response, "no GPS locations yet")

    def test_collinear_farm_explains_why_and_hides_the_progress_bar(self):
        self.add_trees([(BASE_LAT, BASE_LNG + i * 0.0001) for i in range(7)])
        response = self.get_map()
        self.assertContains(response, "isn't in line with the others")
        self.assertNotContains(response, "map-locked-progress")

    def test_ignored_trees_are_called_out(self):
        self.add_trees(_spread_points(4) + [(0.0, 0.0)])
        response = self.get_map()
        self.assertContains(response, "1 tree not counted because the GPS reading looked invalid")

    def test_unlocks_at_the_threshold(self):
        self.add_trees(_spread_points(5))
        response = self.get_map()
        self.assertFalse(response.context["map_locked"])
        self.assertContains(response, "FARM_MAP_DATA")
        self.assertContains(response, 'id="map-container"')
        self.assertNotContains(response, "to show the live map")

    def test_locked_page_keeps_the_summary_strip(self):
        self.add_trees(_spread_points(2))
        response = self.get_map()
        self.assertEqual(response.context["total"], 2)
        # The Farm Map page shows its farm summary strip even while the map is locked.
        self.assertContains(response, "summary-item")


class AddFarmFormTests(MapGateTestCase):
    """Add Farm asks for a name only (ID suggested, owner optional, no address)."""

    def setUp(self):
        super().setUp()
        self.client.login(username="owner", password="pw")

    def test_name_alone_creates_a_farm_with_a_suggested_id(self):
        response = self.client.post(reverse("farm_create"), {"name": "North Block"})
        self.assertRedirects(response, reverse("farm_list"))
        farm = Farm.objects.get(owner=self.user, name="North Block")
        self.assertEqual(farm.farm_id, "FARM-002")
        self.assertEqual(farm.owner_name, "owner")  # falls back to the account name
        self.assertEqual((farm.region, farm.province, farm.city_municipality, farm.barangay), ("", "", "", ""))

    def test_missing_name_is_rejected(self):
        self.client.post(reverse("farm_create"), {"farm_id": "X1"})
        self.assertFalse(Farm.objects.filter(farm_id="X1").exists())

    def test_typed_id_and_owner_are_kept(self):
        self.client.post(reverse("farm_create"), {"name": "South", "farm_id": "S-9", "owner_name": "Juan"})
        farm = Farm.objects.get(farm_id="S-9")
        self.assertEqual(farm.owner_name, "Juan")

    def test_suggested_id_skips_ids_already_taken(self):
        Farm.objects.create(owner=self.user, farm_id="FARM-002", name="Taken", owner_name="o")
        response = self.client.get(reverse("farm_list"))
        self.assertEqual(response.context["suggested_farm_id"], "FARM-003")

    def test_form_has_no_address_fields_and_farm_list_shows_map_progress(self):
        self.add_trees(_spread_points(2))
        response = self.client.get(reverse("farm_list"))
        self.assertNotContains(response, "region-select")
        self.assertNotContains(response, "barangay-select")
        self.assertContains(response, "2 of 5 GPS locations")
        self.assertContains(response, "map shows once 5 GPS locations")


class SyncAndNotificationTests(TestCase):
    """Server-side behavior behind the offline bulk-upload sync and the
    notification bell (client-side parts live in static/js)."""

    def setUp(self):
        self.user = User.objects.create_user("owner", password="pw")
        self.farm = Farm.objects.create(owner=self.user, farm_id="F1", name="Farm One", owner_name="Owner")
        self.client.login(username="owner", password="pw")

    def _save(self, **overrides):
        data = {
            "farm_pk": self.farm.pk, "tree_id": "", "disease": "Healthy", "confidence": "90",
            "lat": "6.9214", "lng": "122.079", "captured_at": "2026-10-16T09:15:30.250Z",
        }
        data.update(overrides)
        return self.client.post(reverse("save_detection"), data, HTTP_X_REQUESTED_WITH="XMLHttpRequest")

    def test_retried_sync_does_not_create_a_second_tree(self):
        first = self._save()
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.json()["verb"], "saved")
        retry = self._save()  # same photo timestamp + coordinates, tree ID still auto
        self.assertEqual(retry.status_code, 200)
        self.assertEqual(retry.json()["verb"], "already saved")
        self.assertEqual(retry.json()["tree_id"], first.json()["tree_id"])
        self.assertEqual(RubberTree.objects.count(), 1)

    def test_different_position_or_time_is_still_a_new_tree(self):
        self._save()
        self.assertEqual(self._save(lng="122.0791").json()["verb"], "saved")
        self.assertEqual(self._save(captured_at="2026-10-16T09:16:30.250Z").json()["verb"], "saved")
        self.assertEqual(RubberTree.objects.count(), 3)

    def test_scan_without_a_timestamp_is_never_deduplicated(self):
        self._save(captured_at="")
        self.assertEqual(self._save(captured_at="").json()["verb"], "saved")
        self.assertEqual(RubberTree.objects.count(), 2)

    def _diseased_tree(self, n, date):
        return RubberTree.objects.create(
            farm=self.farm, tree_id=f"F1-T{n}", lat=6.92, lng=122.07,
            disease="Pink Disease", confidence=80, date_scanned=date,
        )

    def test_dismiss_rejects_malformed_input_instead_of_crashing(self):
        tree = self._diseased_tree(1, datetime.date.today())
        url = reverse("dismiss_notification")
        self.assertEqual(self.client.post(url, {"tree_pk": "abc", "date_scanned": "2026-10-16"}).status_code, 400)
        self.assertEqual(self.client.post(url, {"tree_pk": tree.pk, "date_scanned": "not-a-date"}).status_code, 400)
        self.assertEqual(self.client.post(url, {"tree_pk": 99999, "date_scanned": "2026-10-16"}).status_code, 404)

    def test_dismissed_notification_disappears_from_the_bell(self):
        from .models import DiseaseClass
        DiseaseClass.objects.get_or_create(name="Pink Disease", defaults={"is_healthy": False})
        tree = self._diseased_tree(1, datetime.date.today())
        page = self.client.get(reverse("dashboard"))
        self.assertEqual([n["tree_pk"] for n in page.context["notifications"]], [tree.pk])
        dismissed = self.client.post(reverse("dismiss_notification"),
                                     {"tree_pk": tree.pk, "date_scanned": tree.date_scanned.isoformat()})
        self.assertEqual(dismissed.status_code, 200)
        page = self.client.get(reverse("dashboard"))
        self.assertEqual(page.context["notifications"], [])

    def test_same_day_notifications_show_the_newest_first(self):
        from .models import DiseaseClass
        DiseaseClass.objects.get_or_create(name="Pink Disease", defaults={"is_healthy": False})
        today = datetime.date.today()
        trees = [self._diseased_tree(n, today) for n in range(1, 9)]
        page = self.client.get(reverse("dashboard"))
        shown = [n["tree_pk"] for n in page.context["notifications"]]
        self.assertEqual(shown, [t.pk for t in reversed(trees)][:6])

    def test_pages_load_shared_scripts_once_and_in_order(self):
        for name in ("dashboard", "disease_detection", "bulk_upload"):
            html = self.client.get(reverse(name)).content.decode()
            self.assertEqual(html.count("js/csrf.js"), 1, name)
            self.assertEqual(html.count("js/offline_queue.js"), 1, name)
            self.assertLess(html.index("js/csrf.js"), html.index("js/main.js"), name)

    def test_take_photo_page_has_no_offline_queue_ui(self):
        html = self.client.get(reverse("disease_detection")).content.decode()
        self.assertNotIn("pending-scans-section", html)
        self.assertNotIn("serviceWorker", html)
        self.assertIn("location-enable-btn", html)

    def test_bulk_page_has_queue_ui_and_registers_the_offline_shell(self):
        html = self.client.get(reverse("bulk_upload")).content.decode()
        self.assertIn("pending-scans-section", html)
        self.assertIn("sync-now-btn", html)
        self.assertIn("enableOfflineShell", html)


class InterventionTreeOptionsTests(MapGateTestCase):
    """The Log Intervention checklist asks this endpoint for one farm's trees."""

    def setUp(self):
        super().setUp()
        from .models import DiseaseClass, Intervention
        DiseaseClass.objects.get_or_create(name="Healthy", defaults={"is_healthy": True})
        DiseaseClass.objects.get_or_create(name="Pink Disease", defaults={"is_healthy": False})
        DiseaseClass.objects.get_or_create(name="Canker Disease", defaults={"is_healthy": False})
        self.add_trees(_grid(1, 2), disease="Healthy")           # RT-0001, RT-0002
        self.add_trees(_grid(1, 2), disease="Pink Disease")      # RT-0003, RT-0004
        self.add_trees(_grid(1, 1), disease="Canker Disease")    # RT-0005
        # RT-0003 already has an action logged
        Intervention.objects.create(
            tree=self.farm.trees.get(tree_id="F1-RT-0003"), action="Fungicide Application",
            date_performed=datetime.date.today(), performed_by=self.user,
        )
        self.client.login(username="owner", password="pw")
        self.url = reverse("intervention_tree_options")

    def ids(self, **params):
        res = self.client.get(self.url, {"farm_pk": self.farm.pk, **params})
        self.assertEqual(res.status_code, 200)
        return [t["tree_id"] for t in res.json()["trees"]]

    def test_a_farm_is_mandatory(self):
        res = self.client.get(self.url)
        self.assertEqual(res.status_code, 400)
        self.assertIn("farm", res.json()["error"].lower())
        self.assertEqual(self.client.get(self.url, {"farm_pk": "abc"}).status_code, 400)

    def test_another_users_farm_is_not_found(self):
        other = User.objects.create_user("other", password="pw")
        theirs = Farm.objects.create(owner=other, farm_id="F2", name="Theirs", owner_name="Other")
        self.assertEqual(self.client.get(self.url, {"farm_pk": theirs.pk}).status_code, 404)

    def test_login_is_required(self):
        self.client.logout()
        self.assertEqual(self.client.get(self.url, {"farm_pk": self.farm.pk}).status_code, 302)

    def test_lists_the_farms_trees_in_id_order_with_totals(self):
        res = self.client.get(self.url, {"farm_pk": self.farm.pk}).json()
        self.assertEqual([t["tree_id"] for t in res["trees"]], [f"F1-RT-{n:04d}" for n in range(1, 6)])
        self.assertEqual(res["total"], 5)

    def test_search_filters_by_tree_id(self):
        self.assertEqual(self.ids(q="0004"), ["F1-RT-0004"])

    def test_disease_filter(self):
        self.assertEqual(self.ids(disease="Pink Disease"), ["F1-RT-0003", "F1-RT-0004"])

    def test_needs_action_skips_healthy_and_already_treated_trees(self):
        self.assertEqual(self.ids(status="needs_action"), ["F1-RT-0004", "F1-RT-0005"])

    def test_treated_filter_and_flag(self):
        res = self.client.get(self.url, {"farm_pk": self.farm.pk, "status": "treated"}).json()
        self.assertEqual([t["tree_id"] for t in res["trees"]], ["F1-RT-0003"])
        self.assertTrue(res["trees"][0]["has_intervention"])

    def test_response_is_capped_but_reports_the_full_total(self):
        from unittest import mock
        with mock.patch("farmmap.views.CHECKLIST_PAGE_SIZE", 2):
            res = self.client.get(self.url, {"farm_pk": self.farm.pk}).json()
        self.assertEqual(len(res["trees"]), 2)
        self.assertEqual(res["total"], 5)


class FarmGateMarkupTests(MapGateTestCase):
    """Pages that save to a farm tell the user a farm is required."""

    def test_log_intervention_modal_gates_the_checklist_on_a_farm(self):
        self.client.login(username="owner", password="pw")
        html = self.client.get(reverse("interventions_log")).content.decode()
        self.assertIn('id="iv-farm-gate"', html)
        self.assertIn("Select a farm first", html)
        self.assertIn('id="iv-disease-filter"', html)
        self.assertIn('id="iv-status-filter"', html)
        self.assertNotIn("FARM_TREES_BY_ID", html)

    def test_bulk_upload_locks_the_photo_picker_until_a_farm_is_chosen(self):
        self.client.login(username="owner", password="pw")
        html = self.client.get(reverse("bulk_upload")).content.decode()
        self.assertIn('id="bulk-farm-gate"', html)
