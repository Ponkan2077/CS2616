"""Tests for the GPS-accuracy and performance fixes.

Run with:  python manage.py test farmmap.test_gps_and_performance

Covers: accuracy stored / limited on save, the far-from-farm sanity check, the
signed analysis token that stops the model being run twice per scan, and the
new database indexes and GZip middleware.
"""
import datetime
from unittest import mock

from django.contrib.auth.models import User
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import connection
from django.test import TestCase, override_settings

from farmmap import ai_inference, views
from farmmap.models import DiseaseClass, Farm, RubberTree
from farmmap.photo_fixtures import ROOT_PHOTO, TRUNK_PHOTO, OTHER_TRUNK_PHOTO

AJAX = {"HTTP_X_REQUESTED_WITH": "XMLHttpRequest"}
ROOT_KEY = "scans/roots/2026/11/" + "a" * 32 + ".webp"
TRUNK_KEY = "scans/trunks/2026/11/" + "b" * 32 + ".webp"
ROOT_BYTES = ROOT_PHOTO      # real (tiny) images: the server checks photos really are images
TRUNK_BYTES = TRUNK_PHOTO
MODEL_RESULT = {"disease": "Pink Disease", "confidence": 72.0, "root_condition": "Healthy Roots"}


class GpsBase(TestCase):
    def setUp(self):
        cache.clear()
        DiseaseClass.objects.get_or_create(
            name="Healthy", defaults=dict(is_healthy=True, marker_key="healthy", danger_rank=0))
        DiseaseClass.objects.get_or_create(
            name="Pink Disease", defaults=dict(marker_key="pink", danger_rank=2))
        self.user = User.objects.create_user("a", password="pw-Strong-123")
        self.other = User.objects.create_user("b", password="pw-Strong-123")
        self.client.raise_request_exception = False
        self.client.login(username="a", password="pw-Strong-123")
        self.farm = Farm.objects.create(owner=self.user, farm_id="F1", name="Farm", owner_name="o")

    def save(self, **kw):
        data = dict(farm_pk=self.farm.pk, disease="Pink Disease", confidence="55", lat="6.9", lng="122.0")
        data.update(kw)
        return self.client.post("/detection/save/", data, **AJAX)

    def fill_farm(self, n=10, lat=6.9, lng=122.0):
        today = datetime.date.today()
        RubberTree.objects.bulk_create([
            RubberTree(farm=self.farm, tree_id=f"F1-FILL-{i}", lat=lat + i * 0.00005, lng=lng, date_scanned=today)
            for i in range(n)
        ])


class GpsAccuracyOnSaveTests(GpsBase):
    def test_reported_accuracy_is_stored(self):
        self.assertEqual(self.save(tree_id="A1", gps_accuracy="8.5").status_code, 200)
        self.assertEqual(RubberTree.objects.get(tree_id="F1-A1").gps_accuracy, 8.5)

    def test_missing_accuracy_is_unknown_not_an_error(self):
        self.assertEqual(self.save(tree_id="A2").status_code, 200)
        self.assertIsNone(RubberTree.objects.get(tree_id="F1-A2").gps_accuracy)

    def test_garbage_accuracy_is_treated_as_unknown(self):
        for i, bad in enumerate(("nan", "inf", "-3", "abc")):
            r = self.save(tree_id=f"G{i}", gps_accuracy=bad)
            self.assertEqual(r.status_code, 200, bad)
            self.assertIsNone(RubberTree.objects.get(tree_id=f"F1-G{i}").gps_accuracy, bad)

    def test_too_imprecise_fix_is_refused(self):
        r = self.save(tree_id="B1", gps_accuracy="120")
        self.assertEqual(r.status_code, 400)
        self.assertIn("imprecise", r.json()["error"])
        self.assertFalse(RubberTree.objects.exists())

    def test_limit_is_inclusive_at_the_setting(self):
        self.assertEqual(self.save(tree_id="L1", gps_accuracy="50").status_code, 200)
        self.assertEqual(self.save(tree_id="L2", gps_accuracy="50.1").status_code, 400)

    @override_settings(GPS_MAX_ACCURACY_M=10)
    def test_limit_comes_from_settings(self):
        self.assertEqual(self.save(tree_id="S1", gps_accuracy="12").status_code, 400)
        self.assertEqual(self.save(tree_id="S2", gps_accuracy="9").status_code, 200)

    def test_rescan_replaces_the_stored_accuracy(self):
        self.save(tree_id="R1", gps_accuracy="30")
        self.save(tree_id="R1", gps_accuracy="5")
        self.assertEqual(RubberTree.objects.get(tree_id="F1-R1").gps_accuracy, 5.0)


class FarAwayLocationTests(GpsBase):
    def test_location_far_from_the_farm_is_refused(self):
        self.fill_farm(10)
        r = self.save(tree_id="FAR", lat="7.9", lng="122.0")   # ~110 km north
        self.assertEqual(r.status_code, 400)
        self.assertIn("km", r.json()["error"])
        self.assertFalse(RubberTree.objects.filter(tree_id="F1-FAR").exists())

    def test_location_near_the_farm_is_accepted(self):
        self.fill_farm(10)
        self.assertEqual(self.save(tree_id="NEAR", lat="6.9005", lng="122.0005").status_code, 200)

    def test_young_farm_is_not_judged(self):
        # Fewer than FARM_DISTANCE_CHECK_MIN_TREES trees: the first trees define where the farm is.
        self.fill_farm(9)
        self.assertEqual(self.save(tree_id="EARLY", lat="7.9", lng="122.0").status_code, 200)

    @override_settings(FARM_MAX_DISTANCE_KM=500)
    def test_distance_limit_comes_from_settings(self):
        self.fill_farm(10)
        self.assertEqual(self.save(tree_id="WIDE", lat="7.9", lng="122.0").status_code, 200)


@override_settings(ANALYSIS_TOKEN_MAX_AGE_S=3600)
class AnalysisTokenTests(GpsBase):
    """analyze -> save must run the model once, not twice, without letting a
    forged or mismatched result through."""

    def setUp(self):
        super().setUp()
        self.ai_on = mock.patch.object(ai_inference, "AI_MODEL_ENABLED", True)
        self.infer = mock.patch.object(ai_inference, "classify_images", return_value=dict(MODEL_RESULT))
        self.ai_on.start()
        self.infer_mock = self.infer.start()
        self.addCleanup(self.ai_on.stop)
        self.addCleanup(self.infer.stop)
        self.photos = {ROOT_KEY: ROOT_BYTES, TRUNK_KEY: TRUNK_BYTES}
        fetch = mock.patch("farmmap.direct_upload.fetch_uploaded_bytes", side_effect=lambda key: self.photos[key])
        fetch.start()
        self.addCleanup(fetch.stop)
        s = self.client.session
        s["issued_upload_keys"] = [ROOT_KEY, TRUNK_KEY]
        s.save()

    def analyze(self, root=ROOT_BYTES, trunk=TRUNK_BYTES):
        return self.client.post("/detection/analyze/", {
            "root_image": SimpleUploadedFile("root.webp", root, "image/webp"),
            "trunk_image": SimpleUploadedFile("trunk.webp", trunk, "image/webp"),
        })

    def save_scan(self, token, tree_id):
        # The form fields deliberately disagree with the model's answer: whatever
        # gets saved shows which of the two the server believed.
        return self.save(tree_id=tree_id, root_image_key=ROOT_KEY, trunk_image_key=TRUNK_KEY,
                         analysis_token=token, disease="Healthy", confidence="10")

    def test_analyze_returns_a_token(self):
        r = self.analyze()
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["token"])

    def test_valid_token_skips_the_second_model_call(self):
        token = self.analyze().json()["token"]
        self.assertEqual(self.infer_mock.call_count, 1)
        r = self.save_scan(token, "T1")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.infer_mock.call_count, 1, "the model must not be run again at save")
        tree = RubberTree.objects.get(tree_id="F1-T1")
        self.assertEqual((tree.disease, tree.confidence, tree.root_condition), ("Pink Disease", 72.0, "Healthy Roots"))

    def test_token_still_works_when_the_model_is_switched_off_afterwards(self):
        token = self.analyze().json()["token"]
        with mock.patch.object(ai_inference, "AI_MODEL_ENABLED", False):
            self.assertEqual(self.save_scan(token, "T2").status_code, 200)
        self.assertEqual(RubberTree.objects.get(tree_id="F1-T2").disease, "Pink Disease")

    def test_forged_token_is_ignored_and_the_model_is_run(self):
        token = self.analyze().json()["token"]
        self.save_scan(token[:-3] + "xyz", "T3")
        self.assertEqual(self.infer_mock.call_count, 2)
        self.assertEqual(RubberTree.objects.get(tree_id="F1-T3").disease, "Pink Disease")   # from the model, not the form

    def test_token_for_different_photos_is_ignored(self):
        token = self.analyze().json()["token"]
        self.photos[TRUNK_KEY] = OTHER_TRUNK_PHOTO
        self.save_scan(token, "T4")
        self.assertEqual(self.infer_mock.call_count, 2)

    def test_token_made_for_another_user_is_ignored(self):
        token = views._make_analysis_token(self.other, ROOT_BYTES, TRUNK_BYTES, MODEL_RESULT)
        self.save_scan(token, "T5")
        self.assertEqual(self.infer_mock.call_count, 1)   # one call made by save itself, none skipped

    @override_settings(ANALYSIS_TOKEN_MAX_AGE_S=-1)
    def test_expired_token_is_ignored(self):
        token = self.analyze().json()["token"]
        self.save_scan(token, "T6")
        self.assertEqual(self.infer_mock.call_count, 2)

    def test_no_token_still_works_as_before(self):
        r = self.save(tree_id="T7", root_image_key=ROOT_KEY, trunk_image_key=TRUNK_KEY, disease="Healthy", confidence="10")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.infer_mock.call_count, 1)
        self.assertEqual(RubberTree.objects.get(tree_id="F1-T7").disease, "Pink Disease")


class PerformanceSettingsTests(GpsBase):
    def test_indexes_exist(self):
        with connection.cursor() as cursor:
            tree = set(connection.introspection.get_constraints(cursor, "farmmap_rubbertree"))
            scan = set(connection.introspection.get_constraints(cursor, "farmmap_scanhistory"))
        self.assertTrue({"tree_farm_scanned_idx", "tree_farm_disease_idx"} <= tree)
        self.assertTrue({"scan_date_idx", "scan_tree_date_idx"} <= scan)

    def test_responses_are_gzipped_for_browsers_that_accept_it(self):
        self.client.logout()
        r = self.client.get("/login/", HTTP_ACCEPT_ENCODING="gzip")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers.get("Content-Encoding"), "gzip")
