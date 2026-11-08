"""Tests for account separation, roles and the hardening fixes from the
security review.

Run with:  python manage.py test farmmap.test_access_and_hardening

Covers: every page needs a login; one farmer can't reach another's data
through any page, form, export or upload key; who may use the staff page;
login throttling; the daily AI-call cap; photo validation; the AI result no
longer being taken from the browser when the model is on; spreadsheet
formula guarding in exports; and the per-account offline-queue markup.
"""
import datetime
import io
import shutil
import tempfile
from unittest import mock

from django.contrib.auth.models import Permission, User
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import SimpleTestCase, TestCase, override_settings
from openpyxl import load_workbook

from farmmap import ai_inference, views
from farmmap.imaging import is_valid_image
from farmmap.models import DiseaseClass, Farm, Intervention, RubberTree, ScanHistory
from farmmap.photo_fixtures import ROOT_PHOTO, TRUNK_PHOTO, image_bytes

AJAX = {"HTTP_X_REQUESTED_WITH": "XMLHttpRequest"}
PW = "pw-Strong-123"
MODEL_RESULT = {"disease": "Pink Disease", "confidence": 72.0, "root_condition": ""}


class TwoFarmers(TestCase):
    """Alice and Bob, each with a farm, a tree, a scan and an intervention."""

    def setUp(self):
        cache.clear()
        # Saved photos go to a throwaway folder, never the project's media/.
        media_root = tempfile.mkdtemp()
        media = override_settings(MEDIA_ROOT=media_root)
        media.enable()
        self.addCleanup(media.disable)
        self.addCleanup(shutil.rmtree, media_root, True)
        DiseaseClass.objects.get_or_create(
            name="Healthy", defaults=dict(is_healthy=True, marker_key="healthy", danger_rank=0))
        DiseaseClass.objects.get_or_create(
            name="Pink Disease", defaults=dict(marker_key="pink", danger_rank=2))
        self.client.raise_request_exception = False
        self.alice = User.objects.create_user("alice", password=PW)
        self.bob = User.objects.create_user("bob", password=PW)
        today = datetime.date.today()
        self.alice_farm = Farm.objects.create(
            owner=self.alice, farm_id="ALICE-FARM", name="ALICE-SECRET-FARM", owner_name="Alice Owner")
        self.bob_farm = Farm.objects.create(
            owner=self.bob, farm_id="BOB-FARM", name="Bob Farm", owner_name="Bob Owner")
        self.alice_tree = RubberTree.objects.create(
            farm=self.alice_farm, tree_id="ALICE-FARM-RT-0001", lat=6.92, lng=122.07,
            disease="Pink Disease", confidence=80, date_scanned=today)
        ScanHistory.objects.create(tree=self.alice_tree, date=today, disease="Pink Disease",
                                   confidence=80, inspector="alice")
        Intervention.objects.create(tree=self.alice_tree, performed_by=self.alice, action="Quarantine",
                                    date_performed=today, notes="ALICE-PRIVATE-NOTE")
        self.today = today

    def login(self, username):
        self.client.logout()
        self.assertTrue(self.client.login(username=username, password=PW))

    def save(self, farm, **kw):
        data = dict(farm_pk=farm.pk, disease="Pink Disease", confidence="55", lat="6.9", lng="122.0")
        data.update(kw)
        return self.client.post("/detection/save/", data, **AJAX)


PROTECTED = [
    ("GET", "/"), ("GET", "/map/"), ("GET", "/map/marker/x/"), ("GET", "/detection/"),
    ("GET", "/detection/bulk/"), ("GET", "/detection/sw.js"), ("POST", "/detection/analyze/"),
    ("POST", "/detection/upload-url/"), ("POST", "/detection/save/"), ("GET", "/inventory/"),
    ("GET", "/inventory/x/"), ("GET", "/reports/"), ("GET", "/reports/export/csv/"),
    ("GET", "/reports/export/excel/"), ("GET", "/reports/export/pdf/"), ("GET", "/interventions/"),
    ("GET", "/interventions/map/"), ("POST", "/interventions/create/"), ("GET", "/farms/"),
    ("POST", "/farms/create/"), ("GET", "/farms/x/"), ("POST", "/select-farm/"), ("GET", "/settings/"),
    ("GET", "/admin-dashboard/"), ("POST", "/api/notifications/dismiss/"),
]


class AnonymousAccessTests(TwoFarmers):
    def test_every_protected_url_sends_a_signed_out_visitor_to_login(self):
        self.client.logout()
        for method, url in PROTECTED:
            r = self.client.generic(method, url)
            self.assertEqual(r.status_code, 302, (method, url))
            self.assertIn("login", r["Location"], (method, url))


class AccountSeparationTests(TwoFarmers):
    """Bob is signed in and tries everything he can to reach Alice's data."""

    LEAKS = ("ALICE-SECRET-FARM", "Alice Owner", "ALICE-FARM-RT-0001", "ALICE-PRIVATE-NOTE")

    def setUp(self):
        super().setUp()
        self.login("bob")

    def test_alices_tree_farm_and_marker_pages_are_404_for_bob(self):
        for url in ("/inventory/ALICE-FARM-RT-0001/", "/map/marker/ALICE-FARM-RT-0001/", "/farms/ALICE-FARM/"):
            self.assertEqual(self.client.get(url).status_code, 404, url)

    def test_no_page_or_export_shown_to_bob_contains_alices_data(self):
        for url in ("/", "/reports/", "/inventory/", "/interventions/", "/interventions/map/", "/farms/",
                    "/settings/", "/map/", "/map/?farm=ALICE-FARM", "/detection/", "/detection/bulk/",
                    "/reports/export/csv/"):
            r = self.client.get(url)
            self.assertLess(r.status_code, 500, url)
            body = r.content.decode()
            for needle in self.LEAKS:
                self.assertNotIn(needle, body, f"{needle!r} leaked on {url}")
        sheet = load_workbook(io.BytesIO(self.client.get("/reports/export/excel/").content)).active
        text = " ".join(str(c.value) for row in sheet.iter_rows() for c in row if c.value is not None)
        for needle in self.LEAKS:
            self.assertNotIn(needle, text)

    def test_bob_cannot_select_alices_farm(self):
        self.client.post("/select-farm/", {"farm_pk": str(self.alice_farm.pk), "next": "/"})
        self.assertNotIn("selected_farm_id", self.client.session)

    def test_bob_cannot_dismiss_a_notification_for_alices_tree(self):
        r = self.client.post("/api/notifications/dismiss/",
                             {"tree_pk": str(self.alice_tree.pk), "date_scanned": str(self.today)})
        self.assertEqual(r.status_code, 404)

    def test_bob_cannot_log_an_intervention_on_alices_farm(self):
        before = Intervention.objects.count()
        r = self.client.post("/interventions/create/", {
            "farm_pk": str(self.alice_farm.pk), "action": "Other", "selection_mode": "single",
            "tree_ids": ["ALICE-FARM-RT-0001"]})
        self.assertEqual(r.status_code, 404)
        self.assertEqual(Intervention.objects.count(), before)

    def test_bob_cannot_save_a_scan_into_alices_farm(self):
        before = RubberTree.objects.filter(farm=self.alice_farm).count()
        r = self.save(self.alice_farm, tree_id="HIJACK")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(RubberTree.objects.filter(farm=self.alice_farm).count(), before)

    def test_an_upload_key_issued_to_alice_cannot_be_used_by_bob(self):
        key = "scans/roots/2026/11/" + "a" * 32 + ".webp"
        fake = {"key": key, "upload_url": "https://example.test/x", "expires_in": 600}
        self.login("alice")
        with mock.patch("farmmap.direct_upload.generate_upload_url", return_value=fake):
            self.client.post("/detection/upload-url/", {"kind": "roots"})
        self.login("bob")
        r = self.save(self.bob_farm, root_image_key=key)
        self.assertEqual(r.status_code, 400)
        self.assertIn("couldn't be verified", r.json()["error"])


class RoleTests(TwoFarmers):
    def staff(self, with_permission):
        user = User.objects.create_user("staffer", password=PW, is_staff=True)
        if with_permission:
            user.user_permissions.add(Permission.objects.get(codename="add_diseaseclass"))
        self.login("staffer")
        return user

    def new_class(self, **kw):
        data = dict(name="Leaf Blight", color_hex="#112233", danger_rank="2")
        data.update(kw)
        return self.client.post("/admin-dashboard/", data)

    def test_a_farmer_cannot_open_or_use_the_staff_page(self):
        self.login("bob")
        self.assertEqual(self.client.get("/admin-dashboard/").status_code, 302)
        self.new_class()
        self.assertFalse(DiseaseClass.objects.filter(name="Leaf Blight").exists())

    def test_a_farmer_cannot_open_django_admin(self):
        self.login("bob")
        self.assertEqual(self.client.get("/admin/").status_code, 302)

    def test_staff_without_the_permission_can_look_but_not_add(self):
        self.staff(with_permission=False)
        r = self.client.get("/admin-dashboard/")
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.context["can_add_disease"])
        self.assertNotContains(r, 'name="recommendation_mild"')
        self.assertEqual(self.new_class().status_code, 403)
        self.assertFalse(DiseaseClass.objects.filter(name="Leaf Blight").exists())

    def test_staff_with_the_permission_can_add(self):
        self.staff(with_permission=True)
        r = self.client.get("/admin-dashboard/")
        self.assertTrue(r.context["can_add_disease"])
        self.assertContains(r, 'name="recommendation_mild"')
        self.assertEqual(self.new_class().status_code, 302)
        self.assertTrue(DiseaseClass.objects.filter(name="Leaf Blight").exists())

    def test_superuser_can_add(self):
        User.objects.create_superuser("root", password=PW)
        self.login("root")
        self.assertEqual(self.new_class().status_code, 302)
        self.assertTrue(DiseaseClass.objects.filter(name="Leaf Blight").exists())

    def test_disease_names_with_markup_or_too_long_are_refused(self):
        self.staff(with_permission=True)
        for bad in ('<img src=x onerror=alert(1)>', 'a"b', "x" * 51, "<script>"):
            self.new_class(name=bad)
        self.assertEqual(DiseaseClass.objects.filter(name__regex=r"[<>\"]|^x{51}$").count(), 0)
        self.new_class(name="White Root Rot (WRR)")
        self.assertTrue(DiseaseClass.objects.filter(name="White Root Rot (WRR)").exists())

    def test_self_registration_makes_a_plain_account(self):
        self.client.logout()
        self.client.post("/register/", {"username": "newbie", "password1": "Newbie-pass-98765",
                                        "password2": "Newbie-pass-98765"})
        user = User.objects.get(username="newbie")
        self.assertFalse(user.is_staff or user.is_superuser)


class LoginThrottleTests(TwoFarmers):
    def attempt(self, username, password):
        return self.client.post("/login/", {"username": username, "password": password})

    def test_guessing_is_stopped_after_too_many_wrong_passwords(self):
        with mock.patch.object(views, "LOGIN_MAX_FAILURES", 3):
            for n in range(3):
                self.assertEqual(self.attempt("alice", f"wrong-{n}").status_code, 200)
            # Even the right password is refused while the pause lasts.
            r = self.attempt("alice", PW)
            self.assertEqual(r.status_code, 302)
            self.assertEqual(r["Location"], "/login/")
            self.assertNotIn("_auth_user_id", self.client.session)

    def test_the_pause_is_per_username(self):
        with mock.patch.object(views, "LOGIN_MAX_FAILURES", 3):
            for n in range(3):
                self.attempt("alice", f"wrong-{n}")
            self.assertEqual(self.attempt("bob", PW).status_code, 302)
            self.assertEqual(self.client.session["_auth_user_id"], str(self.bob.pk))

    def test_a_correct_login_resets_the_count(self):
        with mock.patch.object(views, "LOGIN_MAX_FAILURES", 3):
            self.attempt("alice", "wrong-1")
            self.attempt("alice", "wrong-2")
            self.assertEqual(self.attempt("alice", PW).status_code, 302)
            self.client.logout()
            for n in range(2):
                self.attempt("alice", f"wrong-again-{n}")
            self.assertEqual(self.attempt("alice", PW).status_code, 302)
            self.assertEqual(self.client.session["_auth_user_id"], str(self.alice.pk))


class ModelUseTests(TwoFarmers):
    """The AI model is only called for real photos, within a daily cap, and
    its answer is never replaced by what the browser says."""

    def setUp(self):
        super().setUp()
        self.login("alice")
        on = mock.patch.object(ai_inference, "AI_MODEL_ENABLED", True)
        on.start()
        self.addCleanup(on.stop)
        infer = mock.patch.object(ai_inference, "classify_images", return_value=dict(MODEL_RESULT))
        self.infer = infer.start()
        self.addCleanup(infer.stop)

    def analyze(self, root=ROOT_PHOTO, trunk=TRUNK_PHOTO):
        return self.client.post("/detection/analyze/", {
            "root_image": SimpleUploadedFile("root.webp", root, "image/webp"),
            "trunk_image": SimpleUploadedFile("trunk.webp", trunk, "image/webp"),
        })

    def test_analyze_has_a_daily_cap(self):
        with mock.patch.object(views, "ANALYZE_CALLS_PER_DAY", 2):
            self.assertEqual(self.analyze().status_code, 200)
            self.assertEqual(self.analyze().status_code, 200)
            r = self.analyze()
        self.assertEqual(r.status_code, 429)
        self.assertEqual(self.infer.call_count, 2)

    def test_the_cap_is_per_user(self):
        with mock.patch.object(views, "ANALYZE_CALLS_PER_DAY", 1):
            self.assertEqual(self.analyze().status_code, 200)
            self.assertEqual(self.analyze().status_code, 429)
            self.login("bob")
            self.assertEqual(self.analyze().status_code, 200)

    def test_analyze_refuses_a_file_that_is_not_a_photo(self):
        r = self.analyze(root=b"MZ-not-an-image")
        self.assertEqual(r.status_code, 400)
        self.infer.assert_not_called()

    def test_failed_model_call_does_not_save_the_browsers_answer(self):
        self.infer.side_effect = ai_inference.InferenceError("down")
        r = self.save(self.alice_farm, tree_id="CLAIM", disease="Pink Disease", confidence="99",
                      root_image=SimpleUploadedFile("r.webp", ROOT_PHOTO, "image/webp"),
                      trunk_image=SimpleUploadedFile("t.webp", TRUNK_PHOTO, "image/webp"))
        self.assertEqual(r.status_code, 503)
        self.assertFalse(RubberTree.objects.filter(tree_id__endswith="CLAIM").exists())

    def test_model_on_but_no_photos_does_not_save_the_browsers_answer(self):
        r = self.save(self.alice_farm, tree_id="NOPHOTO", disease="Pink Disease", confidence="99")
        self.assertEqual(r.status_code, 400)
        self.assertFalse(RubberTree.objects.filter(tree_id__endswith="NOPHOTO").exists())
        self.infer.assert_not_called()

    def test_saving_without_a_token_counts_against_the_cap(self):
        with mock.patch.object(views, "ANALYZE_CALLS_PER_DAY", 1):
            files = lambda: dict(  # noqa: E731
                root_image=SimpleUploadedFile("r.webp", ROOT_PHOTO, "image/webp"),
                trunk_image=SimpleUploadedFile("t.webp", TRUNK_PHOTO, "image/webp"))
            self.assertEqual(self.save(self.alice_farm, tree_id="S1", **files()).status_code, 200)
            r = self.save(self.alice_farm, tree_id="S2", **files())
        self.assertEqual(r.status_code, 429)
        self.assertEqual(self.infer.call_count, 1)

    def test_model_off_still_saves_the_submitted_result(self):
        # No endpoint configured (local development): behaves as before.
        with mock.patch.object(ai_inference, "AI_MODEL_ENABLED", False):
            self.assertEqual(self.save(self.alice_farm, tree_id="DEV").status_code, 200)


class PhotoValidationTests(TwoFarmers):
    def test_only_jpeg_png_and_webp_are_accepted(self):
        for fmt in ("JPEG", "PNG", "WEBP"):
            self.assertTrue(is_valid_image(image_bytes(fmt=fmt)), fmt)
        for fmt in ("GIF", "BMP", "TIFF"):
            self.assertFalse(is_valid_image(image_bytes(fmt=fmt)), fmt)
        for junk in (b"", b"x", b"%!PS-Adobe-3.0 EPSF-3.0\n", b"\x89PNG\r\n\x1a\nbroken", b"<svg/>"):
            self.assertFalse(is_valid_image(junk), junk)

    def test_a_non_photo_in_the_normal_upload_is_refused_not_a_500(self):
        self.login("alice")
        r = self.save(self.alice_farm, tree_id="BAD",
                      root_image=SimpleUploadedFile("r.webp", b"not an image", "image/webp"),
                      trunk_image=SimpleUploadedFile("t.webp", TRUNK_PHOTO, "image/webp"))
        self.assertEqual(r.status_code, 400)
        self.assertFalse(RubberTree.objects.filter(tree_id__endswith="BAD").exists())

    def test_a_non_photo_read_back_from_storage_is_refused(self):
        self.login("alice")
        key = "scans/roots/2026/11/" + "c" * 32 + ".webp"
        s = self.client.session
        s["issued_upload_keys"] = [key]
        s.save()
        with mock.patch("farmmap.direct_upload.fetch_uploaded_bytes", return_value=b"MZ-program-bytes"):
            r = self.save(self.alice_farm, tree_id="PLANTED", root_image_key=key)
        self.assertEqual(r.status_code, 400)
        self.assertFalse(RubberTree.objects.filter(tree_id__endswith="PLANTED").exists())

    def test_an_oversized_photo_is_refused(self):
        self.login("alice")
        with mock.patch.object(views, "MAX_PHOTO_UPLOAD_BYTES", 10):
            r = self.save(self.alice_farm, tree_id="BIG",
                          root_image=SimpleUploadedFile("r.webp", ROOT_PHOTO, "image/webp"),
                          trunk_image=SimpleUploadedFile("t.webp", TRUNK_PHOTO, "image/webp"))
        self.assertEqual(r.status_code, 400)
        self.assertIn("too large", r.json()["error"])

    def test_a_real_photo_is_stored_as_webp(self):
        self.login("alice")
        r = self.save(self.alice_farm, tree_id="OK",
                      root_image=SimpleUploadedFile("r.png", image_bytes(fmt="PNG"), "image/png"),
                      trunk_image=SimpleUploadedFile("t.jpg", image_bytes(fmt="JPEG"), "image/jpeg"))
        self.assertEqual(r.status_code, 200, r.content)
        tree = RubberTree.objects.get(tree_id="ALICE-FARM-OK")
        self.assertTrue(tree.root_image.name.endswith(".webp"))
        self.assertTrue(tree.trunk_image.name.endswith(".webp"))


class ExportFormulaGuardTests(TwoFarmers):
    FORMULA = '=HYPERLINK("http://evil.example","click")'

    def setUp(self):
        super().setUp()
        Farm.objects.create(owner=self.bob, farm_id="F-2", name=self.FORMULA, owner_name="+cmd|' /C calc'!A0")
        self.login("bob")

    def test_safe_cell_prefixes_only_formula_starts(self):
        for text in ("=1+1", "+1", "-1", "@SUM(A1)", "\t=1", "\r=1"):
            self.assertEqual(views._safe_cell(text), "'" + text)
        for text in ("Farm", "North 2", "", "1=1"):
            self.assertEqual(views._safe_cell(text), text)
        self.assertEqual(views._safe_cell(5), 5)

    def test_csv_export_keeps_farm_names_plain_text(self):
        body = self.client.get("/reports/export/csv/").content.decode()
        self.assertNotIn("\n" + self.FORMULA, body)
        self.assertNotIn(',' + self.FORMULA, body)
        self.assertIn("'=HYPERLINK", body)

    def test_excel_export_keeps_farm_names_plain_text(self):
        sheet = load_workbook(io.BytesIO(self.client.get("/reports/export/excel/").content)).active
        values = [c.value for row in sheet.iter_rows() for c in row if isinstance(c.value, str)]
        self.assertIn("'" + self.FORMULA, values)
        self.assertFalse([v for v in values if v[:1] in "=+-@"])


class OfflineQueueMarkupTests(TwoFarmers):
    def test_pages_tell_the_offline_queue_who_is_signed_in(self):
        self.login("alice")
        for url in ("/", "/detection/bulk/"):
            html = self.client.get(url).content.decode()
            self.assertIn(f'<meta name="rg-user-id" content="{self.alice.pk}">', html, url)

    def test_logout_is_a_form_the_queue_script_can_hook(self):
        self.login("alice")
        html = self.client.get("/").content.decode()
        self.assertIn('action="/logout/"', html)


class SettingsHygieneTests(SimpleTestCase):
    def test_only_this_sites_own_origin_is_trusted_for_csrf(self):
        from django.conf import settings
        self.assertNotIn("https://*.pythonanywhere.com", settings.CSRF_TRUSTED_ORIGINS)
        self.assertIn("https://reyursus.pythonanywhere.com", settings.CSRF_TRUSTED_ORIGINS)

    def test_secret_key_can_come_from_the_environment(self):
        import importlib
        import os
        from django.conf import settings
        with mock.patch.dict(os.environ, {"DJANGO_SECRET_KEY": "from-the-environment-123"}):
            module = importlib.import_module("project.settings")
            module = importlib.reload(module)
            self.assertEqual(module.SECRET_KEY, "from-the-environment-123")
        importlib.reload(module)  # back to what the test run started with
        self.assertEqual(module.SECRET_KEY, settings.SECRET_KEY)
