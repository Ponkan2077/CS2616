from django.conf import settings


def static_version(request):
    """Makes STATIC_VERSION available in every template as {{ STATIC_VERSION }},
    for cache-busting static JS/CSS: {% static 'js/x.js' %}?v={{ STATIC_VERSION }}
    See the STATIC_VERSION comment in project/settings.py for why this exists."""
    return {"STATIC_VERSION": settings.STATIC_VERSION}
