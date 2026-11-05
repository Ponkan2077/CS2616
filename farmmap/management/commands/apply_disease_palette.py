"""Apply the RubberGuard disease colour palette to existing DiseaseClass rows.

Run once after deploying the restyle:

    python manage.py apply_disease_palette

Only ``color_hex`` is ever changed. Classes are matched by name, ignoring case
and extra spaces, and a few alternate spellings are accepted (see PALETTE).
Missing classes are NOT created, and classes that are not in the palette are
left exactly as they are. Safe to run more than once: a class that already has
the right colour is reported as unchanged and not saved again.
"""
from django.core.management.base import BaseCommand
from django.db import transaction

from farmmap.models import DiseaseClass

# (name, [alternate names], colour). The first name is the one printed.
PALETTE = [
    ("Healthy", ["Trunk Healthy", "Healthy Trunk"], "#16a34a"),
    ("Healthy Roots", ["Roots Healthy", "Exposed Roots Healthy"], "#65a30d"),
    ("Pink Disease", [], "#ec4899"),
    ("White Root Rot", ["White Root Disease"], "#9a8460"),
    ("Red Root Rot", [], "#dc2626"),
    ("Stem Bleeding", [], "#ea580c"),
    ("Brown Bast", [], "#a8530f"),
    ("Canker Disease", ["Canker"], "#a855f7"),
    ("Dry Crust", [], "#b87d00"),
]


def _norm(name):
    # "  white   ROOT rot " -> "white root rot"
    return " ".join((name or "").split()).casefold()


class Command(BaseCommand):
    help = "Set color_hex on the known disease classes to the RubberGuard palette (matches by name, never creates classes)."

    def handle(self, *args, **options):
        # Every row in the table, keyed by normalised name. Names are unique,
        # but two spellings can normalise to the same key, so keep a list.
        by_name = {}
        for dc in DiseaseClass.objects.all():
            by_name.setdefault(_norm(dc.name), []).append(dc)

        matched_pks = set()
        not_found = []
        updated = unchanged = 0

        with transaction.atomic():
            for canonical, aliases, new_hex in PALETTE:
                found = []
                for candidate in [canonical, *aliases]:
                    for dc in by_name.get(_norm(candidate), []):
                        if dc.pk not in {f.pk for f in found}:
                            found.append(dc)

                if not found:
                    not_found.append(canonical)
                    continue

                for dc in found:
                    matched_pks.add(dc.pk)
                    old_hex = dc.color_hex
                    if old_hex.lower() == new_hex.lower():
                        unchanged += 1
                        self.stdout.write(f"  unchanged  {dc.name}: {old_hex}")
                        continue
                    dc.color_hex = new_hex
                    # A real save() (not queryset.update) so the post_save
                    # signal runs and clears the cached disease lookup.
                    dc.save(update_fields=["color_hex"])
                    updated += 1
                    self.stdout.write(self.style.SUCCESS(f"  updated    {dc.name}: {old_hex} -> {new_hex}"))

        for name in not_found:
            self.stdout.write(self.style.WARNING(f"  not found  {name} (no class with this name or its alternates; not created)"))

        extra = [dc.name for dc in DiseaseClass.objects.all() if dc.pk not in matched_pks]
        for name in extra:
            self.stdout.write(f"  not in palette  {name} (left as is)")

        self.stdout.write(
            f"Done: {updated} updated, {unchanged} unchanged, "
            f"{len(not_found)} not found, {len(extra)} not in palette."
        )
