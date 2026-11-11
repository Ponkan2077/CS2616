"""Tests for the UI/UX fixes: search terms in pagination links, the farm
search empty state, login/register keeping what was typed, and the markup the
scan page relies on.

Run with:  python manage.py test farmmap.test_ui_fixes
"""
import datetime

from django.contrib.auth.models import User
from django.core.cache import cache
from django.test import TestCase
from django.urls import reverse

from farmmap.models import DiseaseClass, Farm, RubberTree

PW = "pw-Strong-123"


class FarmListSearchTests(TestCase):
    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user("alice", password=PW)
        # 30 farms > one page (25), every name containing characters that
        # break an unencoded query string: a space, "&" and "#".
        for i in range(30):
            Farm.objects.create(
                owner=self.user, farm_id=f"F{i:03d}", name=f"Smith & Co #{i}", owner_name="Alice")
        self.client.force_login(self.user)

    def test_pagination_link_encodes_the_search_term(self):
        html = self.client.get(reverse("farm_list"), {"q": "& Co #"}).content.decode()
        # %26 = &, %23 = #. Unencoded, "#" would cut the link and "&" would
        # split the term, so page 2 would lose the search.
        self.assertIn('href="?q=%26%20Co%20%23&page=2"', html)
        self.assertNotIn("?q=& Co #", html)
        self.assertNotIn("?q=&amp; Co #", html)

    def test_pagination_arrows_are_labelled(self):
        html = self.client.get(reverse("farm_list")).content.decode()
        self.assertIn('role="navigation" aria-label="Pagination"', html)
        self.assertIn('aria-label="Next page"', html)
        self.assertIn('aria-current="page"', html)

    def test_search_with_no_match_does_not_say_no_farms_registered(self):
        html = self.client.get(reverse("farm_list"), {"q": "zzz-nothing"}).content.decode()
        self.assertIn("No farms match", html)
        self.assertNotIn("No farms registered yet", html)

    def test_empty_account_still_says_no_farms_registered(self):
        Farm.objects.all().delete()
        html = self.client.get(reverse("farm_list")).content.decode()
        self.assertIn("No farms registered yet", html)

    def test_search_box_has_a_label(self):
        html = self.client.get(reverse("farm_list")).content.decode()
        self.assertIn('aria-label="Search farms"', html)


class AuthFormTests(TestCase):
    def setUp(self):
        cache.clear()
        User.objects.create_user("alice", password=PW)

    def test_failed_login_keeps_the_username(self):
        resp = self.client.post(reverse("login"), {"username": "alice", "password": "wrong"})
        html = resp.content.decode()
        self.assertIn('value="alice"', html)
        self.assertIn('autocomplete="current-password"', html)
        self.assertIn('role="alert"', html)

    def test_fresh_login_page_has_autocomplete_hints(self):
        html = self.client.get(reverse("login")).content.decode()
        self.assertIn('autocomplete="username"', html)

    def test_register_keeps_username_and_lists_each_error_separately(self):
        resp = self.client.post(reverse("register"), {
            "username": "newfarmer", "password1": "12345678", "password2": "12345678"})
        html = resp.content.decode()
        self.assertIn('value="newfarmer"', html)
        # "too common" and "entirely numeric" are two errors -> two lines
        self.assertGreaterEqual(html.count('<div><i class="bi bi-exclamation-circle-fill"'), 2)
        self.assertIn('aria-invalid="true"', html)

    def test_register_shows_the_password_rules_up_front(self):
        html = self.client.get(reverse("register")).content.decode()
        self.assertIn("At least 8 characters", html)
        self.assertIn('autocomplete="new-password"', html)


class ScanPageMarkupTests(TestCase):
    def setUp(self):
        DiseaseClass.objects.get_or_create(
            name="Healthy", defaults=dict(is_healthy=True, marker_key="healthy", danger_rank=0))
        self.user = User.objects.create_user("alice", password=PW)
        Farm.objects.create(owner=self.user, farm_id="F1", name="Farm One", owner_name="Alice")
        self.client.force_login(self.user)

    def test_result_panel_can_take_focus_and_has_a_name(self):
        html = self.client.get(reverse("disease_detection")).content.decode()
        self.assertIn('id="result-box"', html)
        self.assertIn('tabindex="-1"', html)
        self.assertIn('aria-labelledby="result-heading"', html)

    def test_location_banner_is_not_a_clickable_div(self):
        html = self.client.get(reverse("disease_detection")).content.decode()
        self.assertIn('id="location-recheck-btn"', html)
        self.assertNotIn("is-clickable", html)


class AccountLabelTests(TestCase):
    """The account menu says what the account is, not a fixed office name."""

    def _menu_text(self, user):
        self.client.force_login(user)
        return self.client.get(reverse("farm_list")).content.decode()

    def test_staff_account_is_labelled_administrator(self):
        html = self._menu_text(User.objects.create_user("boss", password=PW, is_staff=True))
        self.assertIn("Administrator", html)
        self.assertNotIn("Farm owner", html)

    def test_regular_account_is_labelled_farm_owner(self):
        html = self._menu_text(User.objects.create_user("farmer", password=PW))
        self.assertIn("Farm owner", html)
        self.assertNotIn("Administrator", html)

    def test_no_hardcoded_office_in_the_account_menu(self):
        html = self._menu_text(User.objects.create_user("farmer", password=PW))
        self.assertNotIn("DA Field Office IX \u00b7 PRRI", html)


class DiseaseClassHelpTextTests(TestCase):
    def test_help_text_allows_one_healthy_class_per_model(self):
        # Trunk and root models each have a healthy class, so the admin must
        # not tell people there should be exactly one.
        text = DiseaseClass._meta.get_field("is_healthy").help_text
        self.assertNotIn("Exactly one", text)
        self.assertIn("more than one", text)


class TreeDetailsAndModalTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user("alice", password=PW)
        self.farm = Farm.objects.create(owner=self.user, farm_id="F1", name="Farm One", owner_name="Alice")
        DiseaseClass.objects.get_or_create(
            name="Healthy", defaults=dict(is_healthy=True, marker_key="healthy", danger_rank=0))
        self.client.force_login(self.user)

    def _tree(self, notes):
        return RubberTree.objects.create(
            farm=self.farm, tree_id="F1-RT-0001", lat=6.92, lng=122.07, disease="Healthy",
            confidence=90, date_scanned=datetime.date.today(), notes=notes)

    def test_empty_notes_show_a_dash_not_a_blank(self):
        tree = self._tree("")
        html = self.client.get(reverse("tree_details", args=[tree.tree_id])).content.decode()
        self.assertRegex(html, r'Notes</span>\s*<span class="text-sm-rg">\u2014</span>')

    def test_real_notes_are_still_shown(self):
        tree = self._tree("Leaning trunk")
        html = self.client.get(reverse("tree_details", args=[tree.tree_id])).content.decode()
        self.assertIn("Leaning trunk", html)

    def test_log_intervention_fields_stack_on_phones(self):
        html = self.client.get(reverse("interventions_log")).content.decode()
        # tree-ID range (2) + action/date (2): full width on phones so the
        # select and placeholders aren't cut off, half width from sm up
        self.assertEqual(html.count('<div class="col-12 col-sm-6">'), 4)
