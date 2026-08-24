# Adds structured Region/Province/City-Municipality/Barangay fields to
# Farm, populated via the new PSGC cascading-select Add Farm form. The
# old free-text `location` field is kept as-is for sub-barangay detail
# (sitio/purok/landmark) and as the fallback for farms created before
# this existed.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('farmmap', '0009_dynamic_notification_prefs'),
    ]

    operations = [
        migrations.AddField(
            model_name='farm',
            name='region',
            field=models.CharField(blank=True, max_length=100),
        ),
        migrations.AddField(
            model_name='farm',
            name='province',
            field=models.CharField(blank=True, max_length=100),
        ),
        migrations.AddField(
            model_name='farm',
            name='city_municipality',
            field=models.CharField(blank=True, max_length=100),
        ),
        migrations.AddField(
            model_name='farm',
            name='barangay',
            field=models.CharField(blank=True, max_length=100),
        ),
    ]
