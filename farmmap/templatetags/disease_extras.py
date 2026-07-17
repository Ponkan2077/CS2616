from django import template
from ..models import get_disease_lookup

register = template.Library()


@register.filter
def disease_color(disease_name):
    # Works on any disease-name string, regardless of which model it came
    # from (RubberTree.disease, ScanHistory.disease, etc.) -- unlike a
    # model property, this doesn't require the caller to be a RubberTree
    # instance. Falls back to a neutral gray for an unrecognized name
    # (e.g. a disease that's since been renamed/removed in the admin).
    disease_class = get_disease_lookup().get(disease_name)
    return disease_class.color_hex if disease_class else "#6c757d"
