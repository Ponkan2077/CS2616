"""
Template filters for disease display -- reconstructed after this file was
found to be missing from the GitHub repo (5 templates {% load
disease_extras %} and use |disease_color, but the module itself wasn't in
version control). If your live PythonAnywhere copy already has a working
version of this file, keep that one and ignore this -- just make sure it
ends up committed to the repo so a fresh clone doesn't lose it again.

disease_color mirrors RubberTree.color exactly (same get_disease_lookup()
cache, same "#6c757d" fallback) so a disease badge rendered via this
filter always matches the color used for that same tree's map marker.
"""

from django import template
from ..models import get_disease_lookup

register = template.Library()


@register.filter
def disease_color(disease_name):
    """Returns the hex color for a disease name, e.g. {{ tree.disease|disease_color }}."""
    disease_class = get_disease_lookup().get(disease_name)
    return disease_class.color_hex if disease_class else "#6c757d"
