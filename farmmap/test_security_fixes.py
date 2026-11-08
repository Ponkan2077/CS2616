"""Regression tests for the review fixes (security, bugs, input validation).

Each test reproduces a problem found in the review and asserts the fixed
behaviour. Run with:  python manage.py test farmmap.test_security_fixes
"""
import datetime
from unittest import mock

from botocore.exceptions import ClientError
from django.contrib.auth.models import Permission, User
from django.core.cache import cache
from django.test import TestCase, SimpleTestCase
from django.urls import reverse

from farmmap import direct_upload, views
from farmmap.models import DiseaseClass, Farm, Intervention, RubberTree
from farmmap.photo_fixtures import ROOT_PHOTO

GOOD_KEY = "scans/roots/2026/11/" + "a" * 32 + ".webp"
GOOD_TRUNK_KEY = "scans/trunks/2026/11/" + "b" * 32 + ".webp"
AJAX = {"HTTP_X_REQUESTED_WITH": "XMLHttpRequest"}


class Base(TestCase):
    def setUp(self):
        cache.clear()
        DiseaseClass.objects.get_or_create(
            name="Healthy", defaults=dict(is_healthy=True, marker_key="healthy", danger_rank=0))
        DiseaseClass.objects.get_or_create(
            name="Pink Disease", defaults=dict(marker_key="pink", danger_rank=2))
        self.a = User.objects.create_user("a", password="pw-Strong-123")
        self.b = User.objects.create_user("b", password="pw-Strong-123")
        self.client.raise_request_exception = False
        self.client.login(username="a", password="pw-Strong-123")
        self.farm = Farm.objects.create(owner=self.a, farm_id="F1", name="Farm", owner_name="o")

    def save(self, farm=None, **kw):
        data = dict(farm_pk=(farm or self.farm).pk, disease="Pink Disease", confidence="55",
                    lat="6.9", lng="122.0")
        data.update(kw)
        return self.client.post("/detection/save/", data, **AJAX)


class TreeIdTests(Base):
    def test_slash_in_tree_id_rejected_and_pages_still_work(self):
        r = self.save(tree_id="X/Y")
        self.assertEqual(r.status_code, 400)
        self.assertFalse(RubberTree.objects.exists())
        self.assertEqual(self.client.get("/").status_code, 200)

    def test_other_bad_characters_rejected(self):
        for bad in ("a?b", "a#b", "a%b", "<b>", "x" * 60):
            self.assertEqual(self.save(tree_id=bad).status_code, 400, bad)

    def test_normal_ids_accepted(self):
        for ok in ("T1", "Row3-12", "Tree 5", "A.B_C"):
            self.assertEqual(self.save(tree_id=ok, lat=str(6.9 + len(ok) / 1000)).status_code, 200, ok)

    def test_bad_farm_id_rejected_when_creating_farm(self):
        self.client.post("/farms/create/", dict(farm_id="A/B", name="n", owner_name="o"))
        self.assertFalse(Farm.objects.filter(farm_id="A/B").exists())

    def test_legacy_tree_with_slash_does_not_break_notification_bell(self):
        RubberTree.objects.create(farm=self.farm, tree_id="F1-X/Y", lat=6.9, lng=122.0,
                                  disease="Pink Disease", confidence=80,
                                  date_scanned=datetime.date.today())
        request = mock.Mock(user=self.a)
        self.assertEqual(views._build_notifications(request), [])


class AutoIdTests(Base):
    def test_two_users_with_same_farm_id_can_both_scan(self):
        self.assertEqual(self.save().json()["tree_id"], "F1-RT-0001")
        self.client.logout(); self.client.login(username="b", password="pw-Strong-123")
        farm_b = Farm.objects.create(owner=self.b, farm_id="F1", name="B farm", owner_name="b")
        r = self.save(farm=farm_b)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["tree_id"], f"F1-U{self.b.pk}-RT-0001")
        self.assertEqual(self.save(farm=farm_b, lat="6.95").json()["tree_id"], f"F1-U{self.b.pk}-RT-0002")

    def test_deleting_a_tree_never_causes_an_overwrite(self):
        for i in range(3):
            self.save(lat=str(6.9 + i / 1000))
        RubberTree.objects.filter(tree_id="F1-RT-0002").delete()
        r = self.save(lat="6.95", disease="Healthy", confidence="0")
        self.assertEqual(r.json()["tree_id"], "F1-RT-0004")
        self.assertEqual(r.json()["verb"], "saved")
        third = RubberTree.objects.get(tree_id="F1-RT-0003")
        self.assertEqual(third.disease, "Pink Disease")
        self.assertEqual(third.history.count(), 1)

    def test_typed_id_owned_by_other_user_gets_generic_message(self):
        self.save(tree_id="T1")
        self.client.logout(); self.client.login(username="b", password="pw-Strong-123")
        farm_b = Farm.objects.create(owner=self.b, farm_id="F1", name="B", owner_name="b")
        r = self.save(farm=farm_b, tree_id="T1")
        self.assertEqual(r.status_code, 400)
        self.assertNotIn("different farm", r.json()["error"])


class ResultValidationTests(Base):
    def test_nan_and_garbage_confidence_rejected_not_500(self):
        for bad in ("nan", "inf", "abc"):
            self.assertEqual(self.save(tree_id="C", confidence=bad).status_code, 400, bad)

    def test_confidence_clamped(self):
        self.save(tree_id="C9", confidence="9999")
        self.assertEqual(RubberTree.objects.get(tree_id="F1-C9").confidence, 100.0)

    def test_missing_or_unknown_disease_rejected(self):
        self.assertEqual(self.save(disease="").status_code, 400)
        self.assertEqual(self.save(disease="Not A Disease").status_code, 400)
        self.assertFalse(RubberTree.objects.exists())

    def test_server_errors_do_not_leak_details(self):
        with mock.patch("farmmap.views.RubberTree.objects.create", side_effect=RuntimeError("SECRET-DB-DETAIL")):
            r = self.save()
        self.assertEqual(r.status_code, 500)
        self.assertNotIn("SECRET-DB-DETAIL", r.content.decode())


class UploadKeyTests(Base):
    def test_unissued_or_malformed_keys_rejected(self):
        with mock.patch.object(direct_upload, "CLOUD_STORAGE_ENABLED", True), \
             mock.patch("farmmap.direct_upload.fetch_uploaded_bytes", return_value=ROOT_PHOTO) as fetch:
            for key in ("private/other-user-object.webp", "../../etc/passwd", GOOD_KEY):
                r = self.save(root_image_key=key)
                self.assertEqual(r.status_code, 400, key)
            fetch.assert_not_called()

    def test_wrong_kind_rejected_even_if_issued(self):
        s = self.client.session; s["issued_upload_keys"] = [GOOD_KEY]; s.save()
        r = self.save(trunk_image_key=GOOD_KEY)  # a "roots" key used as the trunk photo
        self.assertEqual(r.status_code, 400)

    def test_issued_key_accepted(self):
        s = self.client.session; s["issued_upload_keys"] = [GOOD_KEY, GOOD_TRUNK_KEY]; s.save()
        with mock.patch("farmmap.direct_upload.fetch_uploaded_bytes", return_value=ROOT_PHOTO):
            r = self.save(tree_id="K1", root_image_key=GOOD_KEY, trunk_image_key=GOOD_TRUNK_KEY)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(RubberTree.objects.get(tree_id="F1-K1").root_image.name, GOOD_KEY)

    def test_storage_failure_is_a_clean_error_not_500_page(self):
        s = self.client.session; s["issued_upload_keys"] = [GOOD_KEY]; s.save()
        boom = ClientError({"Error": {"Code": "NoSuchKey", "Message": "no"}}, "GetObject")
        with mock.patch("farmmap.direct_upload.fetch_uploaded_bytes", side_effect=boom):
            r = self.save(root_image_key=GOOD_KEY)
        self.assertEqual(r.status_code, 502)
        self.assertIn("error", r.json())

    def test_upload_url_endpoint_records_keys_and_rate_limits(self):
        fake = {"key": GOOD_KEY, "upload_url": "https://example.test/x", "expires_in": 600}
        with mock.patch("farmmap.direct_upload.generate_upload_url", return_value=fake) as gen:
            r = self.client.post("/detection/upload-url/", {"kind": "roots", "size": "5000"})
            self.assertEqual(r.status_code, 200)
            gen.assert_called_with("roots", size=5000)
            self.assertIn(GOOD_KEY, self.client.session["issued_upload_keys"])
            with mock.patch.object(views, "UPLOAD_URLS_PER_DAY", 1):
                self.assertEqual(self.client.post("/detection/upload-url/", {"kind": "roots"}).status_code, 429)

    def test_upload_url_endpoint_rejects_bad_size(self):
        self.assertEqual(self.client.post("/detection/upload-url/", {"kind": "roots", "size": "abc"}).status_code, 400)


class DirectUploadModuleTests(SimpleTestCase):
    def test_is_valid_key(self):
        self.assertTrue(direct_upload.is_valid_key(GOOD_KEY))
        self.assertTrue(direct_upload.is_valid_key(GOOD_KEY, "roots"))
        self.assertFalse(direct_upload.is_valid_key(GOOD_KEY, "trunks"))
        for bad in ("", None, "scans/roots/2026/11/abc.webp", GOOD_KEY + "\n", "x/" + GOOD_KEY,
                    GOOD_KEY.replace("scans", "..")):
            self.assertFalse(direct_upload.is_valid_key(bad), bad)

    def test_build_key_matches_validator(self):
        self.assertTrue(direct_upload.is_valid_key(direct_upload.build_key("roots"), "roots"))

    def _presign(self, size):
        with mock.patch.multiple(direct_upload, CLOUD_STORAGE_ENABLED=True,
                                 STORAGE_ENDPOINT_URL="https://acct.r2.cloudflarestorage.com",
                                 STORAGE_ACCESS_KEY="AKIAEXAMPLE", STORAGE_SECRET_KEY="secret",
                                 STORAGE_BUCKET_NAME="bucket", STORAGE_REGION="auto"):
            return direct_upload.generate_upload_url("roots", size=size)

    def test_declared_size_is_signed_into_url(self):
        url = self._presign(12345)["upload_url"]
        self.assertIn("content-length", url.lower())

    def test_oversize_or_zero_size_refused(self):
        for bad in (0, -5, direct_upload.MAX_UPLOAD_BYTES + 1):
            with self.assertRaises(direct_upload.UploadTooLarge):
                self._presign(bad)

    def test_fetch_refuses_foreign_key_and_oversize_object(self):
        with mock.patch.object(direct_upload, "CLOUD_STORAGE_ENABLED", True):
            with self.assertRaises(direct_upload.InvalidUploadKey):
                direct_upload.fetch_uploaded_bytes("private/secret.webp")
            fake = mock.Mock()
            fake.head_object.return_value = {"ContentLength": direct_upload.MAX_UPLOAD_BYTES + 1}
            with mock.patch.object(direct_upload, "_client", return_value=fake):
                with self.assertRaises(direct_upload.UploadTooLarge):
                    direct_upload.fetch_uploaded_bytes(GOOD_KEY)
            fake.get_object.assert_not_called()


class InterventionTests(Base):
    def setUp(self):
        super().setUp()
        self.save(tree_id="T1")
        self.tid = self.farm.trees.first().tree_id

    def log(self, **kw):
        data = dict(farm_pk=self.farm.pk, selection_mode="single", tree_ids=[self.tid],
                    action="Fungicide Application", date_performed="2026-10-01")
        data.update(kw)
        return self.client.post("/interventions/create/", data)

    def test_good_request_saved(self):
        self.assertEqual(self.log().status_code, 302)
        self.assertEqual(Intervention.objects.count(), 1)

    def test_bad_date_is_a_message_not_a_500(self):
        self.assertEqual(self.log(date_performed="not-a-date").status_code, 302)
        self.assertEqual(Intervention.objects.count(), 0)

    def test_unknown_action_not_stored(self):
        self.assertEqual(self.log(action="<img src=x>").status_code, 302)
        self.assertEqual(Intervention.objects.count(), 0)

    def test_non_numeric_farm_not_a_500(self):
        self.assertEqual(self.log(farm_pk="abc").status_code, 302)


class SmallViewFixes(Base):
    def test_select_farm_open_redirect_blocked(self):
        r = self.client.post("/select-farm/", dict(farm_pk=self.farm.pk, next="https://evil.example/phish"))
        self.assertEqual(r["Location"], "/")
        r = self.client.post("/select-farm/", dict(farm_pk=self.farm.pk, next="//evil.example"))
        self.assertEqual(r["Location"], "/")

    def test_select_farm_keeps_local_next(self):
        r = self.client.post("/select-farm/", dict(farm_pk=self.farm.pk, next="/map/"))
        self.assertEqual(r["Location"], "/map/")

    def test_select_farm_bad_pk_not_a_500(self):
        self.assertEqual(self.client.post("/select-farm/", dict(farm_pk="abc", next="/")).status_code, 302)

    def test_map_with_unknown_farm_param_shows_a_real_farm(self):
        r = self.client.get("/map/?farm=nope")
        self.assertEqual(r.status_code, 200)
        self.assertNotContains(r, "haven't added a farm")

    def test_analyze_errors_are_generic(self):
        r = self.client.post("/detection/analyze/", {})
        self.assertEqual(r.status_code, 503)
        self.assertNotIn("AI_MODEL_ENDPOINT_URL", r.content.decode())

    def test_registration_rejects_weak_passwords(self):
        self.client.logout()
        r = self.client.post("/register/", dict(username="newbie", password1="1234", password2="1234"))
        self.assertEqual(r.status_code, 200)
        self.assertFalse(User.objects.filter(username="newbie").exists())
        r = self.client.post("/register/", dict(username="newbie", password1="Correct-horse-42", password2="Correct-horse-42"))
        self.assertEqual(r.status_code, 302)

    def test_admin_disease_form_validates(self):
        staff = User.objects.create_user("boss", password="pw-Strong-123", is_staff=True)
        # Staff alone only opens the page; adding a class needs the permission too.
        staff.user_permissions.add(Permission.objects.get(codename="add_diseaseclass"))
        self.client.login(username="boss", password="pw-Strong-123")
        base = dict(name="Leaf Blight", color_hex="#112233", danger_rank="2")
        for bad in (dict(color_hex="red\"><script>"), dict(danger_rank="x")):
            self.client.post("/admin-dashboard/", {**base, **bad})
        self.assertFalse(DiseaseClass.objects.filter(name="Leaf Blight").exists())
        self.client.post("/admin-dashboard/", base)
        self.assertTrue(DiseaseClass.objects.filter(name="Leaf Blight").exists())


class ScriptJsonTests(SimpleTestCase):
    def test_script_breakout_is_escaped(self):
        out = views._json_for_script({"a": "</script><script>alert(1)</script> &  "})
        for ch in ("<", ">", "&", " "):
            self.assertNotIn(ch, out)
        import json
        self.assertEqual(json.loads(out)["a"], "</script><script>alert(1)</script> &  ")

    def test_interventions_map_page_escapes_notes(self):
        pass  # covered below with a real page render


class ScriptJsonPageTests(Base):
    def test_notes_cannot_break_out_of_script_on_interventions_map(self):
        self.save(tree_id="N1")
        tree = self.farm.trees.first()
        Intervention.objects.create(tree=tree, performed_by=self.a, action="Quarantine",
                                    date_performed="2026-10-01", notes="</script><script>alert(2)</script>")
        r = self.client.get(reverse("interventions_map"))
        self.assertEqual(r.status_code, 200)
        self.assertNotIn("</script><script>alert(2)", r.content.decode())
