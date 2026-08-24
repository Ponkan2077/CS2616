# Replaces UserSettings' 3 fixed disease booleans with a muted-list, so
# notification prefs automatically cover any disease added to
# DiseaseClass later instead of needing a new field + migration each time.

from django.db import migrations, models


def migrate_existing_prefs(apps, schema_editor):
    UserSettings = apps.get_model("farmmap", "UserSettings")
    field_to_name = {
        "notify_pink_disease": "Pink Disease",
        "notify_white_root_rot": "White Root Rot",
        "notify_stem_bleeding": "Stem Bleeding",
    }
    for settings_row in UserSettings.objects.all():
        muted = [
            name for field, name in field_to_name.items()
            if not getattr(settings_row, field)
        ]
        settings_row.notify_muted_diseases = muted
        settings_row.save(update_fields=["notify_muted_diseases"])


def reverse_migrate(apps, schema_editor):
    UserSettings = apps.get_model("farmmap", "UserSettings")
    name_to_field = {
        "Pink Disease": "notify_pink_disease",
        "White Root Rot": "notify_white_root_rot",
        "Stem Bleeding": "notify_stem_bleeding",
    }
    for settings_row in UserSettings.objects.all():
        muted = settings_row.notify_muted_diseases or []
        for name, field in name_to_field.items():
            setattr(settings_row, field, name not in muted)
        settings_row.save(update_fields=list(name_to_field.values()))


class Migration(migrations.Migration):

    dependencies = [
        ('farmmap', '0008_add_captured_at'),
    ]

    operations = [
        migrations.AddField(
            model_name='usersettings',
            name='notify_muted_diseases',
            field=models.JSONField(blank=True, default=list),
        ),
        migrations.RunPython(migrate_existing_prefs, reverse_migrate),
        migrations.RemoveField(model_name='usersettings', name='notify_pink_disease'),
        migrations.RemoveField(model_name='usersettings', name='notify_white_root_rot'),
        migrations.RemoveField(model_name='usersettings', name='notify_stem_bleeding'),
    ]
