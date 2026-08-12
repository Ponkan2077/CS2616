# Adds the 4 disease classes that exist in the actual training dataset
# (datasets/Brown Bast, Canker Disease, Dry Crust, Red Root Rot) but were
# missing from the original seed migration, which only covered 4 of the
# 8 classes. A separate migration rather than editing 0004 directly,
# since that one may already be marked "applied" elsewhere -- Django
# tracks migrations by name, not content, so editing an already-applied
# one silently does nothing there.

from django.db import migrations

NEW_DISEASES = [
    dict(
        name="Brown Bast", display_order=4, color_hex="#b45309", marker_key="brown_bast",
        danger_rank=4, is_healthy=False,
        description=(
            "Also known as Tapping Panel Dryness (TPD) -- a physiological disorder, not a fungal "
            "infection. Progressive drying of the tapping panel that reduces or stops latex flow, "
            "often linked to over-tapping and nutrient imbalance (low soil calcium/magnesium)."
        ),
        recommendation_mild=(
            "Early tapping panel dryness. Reduce tapping frequency/intensity and apply balanced "
            "fertilizer -- avoid excess nitrogen, ensure adequate calcium and magnesium. Monitor "
            "cut dryness weekly."
        ),
        recommendation_moderate=(
            "Rest the tapping panel for 1-2 months and switch to the alternate panel if available. "
            "Correct any soil nutrient deficiency before resuming tapping."
        ),
        recommendation_severe=(
            "Advanced/irreversible dryness (true brown bast). No fungicide will help, since this "
            "isn't a fungal disease. Permanently discontinue tapping on the affected panel and "
            "consult an agricultural technician about a panel change or replanting."
        ),
    ),
    dict(
        name="Canker Disease", display_order=5, color_hex="#7c3aed", marker_key="canker_disease",
        danger_rank=5, is_healthy=False,
        description=(
            "Sunken, dark bark lesions caused by wound-invading fungi (commonly Phytophthora or "
            "Botryodiplodia species) entering through tapping cuts or other wounds."
        ),
        recommendation_mild=(
            "Small, isolated canker. Scrape away the affected bark down to healthy tissue and "
            "apply a copper-based protectant paint. Recheck in 2 weeks."
        ),
        recommendation_moderate=(
            "Remove infected bark with a margin of healthy tissue, then apply fungicide (Mancozeb "
            "80% WP) to the area. Sanitize tools between trees to avoid spreading it."
        ),
        recommendation_severe=(
            "Canker girdling the trunk -- halt tapping, remove and destroy severely affected "
            "bark/branches, apply systemic fungicide, and consult an agricultural technician about "
            "the tree's viability."
        ),
    ),
    dict(
        name="Dry Crust", display_order=6, color_hex="#ca8a04", marker_key="dry_crust",
        danger_rank=2, is_healthy=False,
        description=(
            "Dry, cracked, crust-like bark texture without active lesions or fungal growth -- "
            "usually an early bark-health symptom rather than a distinct pathogen, but can precede "
            "more serious tapping panel or bark disease if left untreated."
        ),
        recommendation_mild=(
            "Dry, mildly cracked bark. Apply a protective bark dressing and mulch around the base "
            "to retain soil moisture, and reduce tapping intensity while monitoring for progression."
        ),
        recommendation_moderate=(
            "Spreading dry, crusted bark. Reduce tapping frequency, correct soil moisture/nutrient "
            "levels, and inspect weekly for any developing lesions or fungal growth."
        ),
        recommendation_severe=(
            "Extensive crusting with bark starting to flake or crack deeply. Treat as at risk of "
            "secondary infection -- rest the tapping panel, apply a protective dressing, and have "
            "an agricultural technician assess for an underlying cause."
        ),
    ),
    dict(
        name="Red Root Rot", display_order=7, color_hex="#ea580c", marker_key="red_root_rot",
        danger_rank=6, is_healthy=False,
        description=(
            "Caused by Ganoderma pseudoferreum. Similar to White Root Rot but distinguished by "
            "reddish-brown rhizomorphs on the roots and orange bracket fungi at the collar in "
            "advanced stages."
        ),
        recommendation_mild=(
            "Early signs of Red Root Rot. Improve drainage around the base and apply Trichoderma "
            "biocontrol preventively, same as for White Root Rot."
        ),
        recommendation_moderate=(
            "Expose the root collar and apply a systemic fungicide soil drench. Uproot and destroy "
            "any severely infected roots found."
        ),
        recommendation_severe=(
            "High risk of spread to neighboring trees -- uproot and destroy the tree and its root "
            "system, quarantine the block, treat the soil, and inspect adjacent trees."
        ),
    ),
]


def seed_more_diseases(apps, schema_editor):
    DiseaseClass = apps.get_model("farmmap", "DiseaseClass")
    for entry in NEW_DISEASES:
        DiseaseClass.objects.get_or_create(name=entry["name"], defaults=entry)


def remove_seeded_diseases(apps, schema_editor):
    DiseaseClass = apps.get_model("farmmap", "DiseaseClass")
    DiseaseClass.objects.filter(name__in=[d["name"] for d in NEW_DISEASES]).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('farmmap', '0006_alter_scanhistory_options'),
    ]

    operations = [
        migrations.RunPython(seed_more_diseases, remove_seeded_diseases),
    ]
