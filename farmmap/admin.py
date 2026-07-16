from django.contrib import admin
from .models import DiseaseClass


@admin.register(DiseaseClass)
class DiseaseClassAdmin(admin.ModelAdmin):
    list_display = ("name", "display_order", "color_hex", "danger_rank", "is_healthy")
    list_editable = ("display_order", "color_hex", "danger_rank", "is_healthy")
    fields = (
        "name", "description", "display_order", "color_hex", "marker_key", "danger_rank", "is_healthy",
        "recommendation_mild", "recommendation_moderate", "recommendation_severe",
    )
