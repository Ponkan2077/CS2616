"""
Cloud storage configuration, kept separate from settings.py so switching
providers is a config change here, not a settings.py edit.

Uses django-storages' generic S3-compatible backend rather than a
provider-specific SDK (e.g. Cloudinary's), because Cloudflare R2,
Backblaze B2, Supabase Storage, AWS S3, Wasabi, and DigitalOcean Spaces
are all S3-API-compatible. That means changing STORAGE_ENDPOINT_URL and
the three credential env vars below is enough to switch providers --
no code change, no redeploy of different Python packages.

Recommended provider (as of mid-2026): Cloudflare R2 -- free 10GB
storage, zero egress fees, and (per pythonanywhere.com/whitelist/)
r2.cloudflarestorage.com is on PythonAnywhere's free-account outbound
allowlist. Backblaze B2 and Supabase Storage are also whitelisted and
work here unmodified if you'd rather use one of those instead.

Local disk storage is always the fallback if these env vars aren't set,
so the app never breaks because cloud credentials are missing.

Required environment variables to enable cloud storage (set these on
PythonAnywhere's Web tab -> Environment variables, or in a local .env):
    STORAGE_ENDPOINT_URL    e.g. https://<account_id>.r2.cloudflarestorage.com
    STORAGE_ACCESS_KEY
    STORAGE_SECRET_KEY
    STORAGE_BUCKET_NAME
    STORAGE_REGION          optional, defaults to "auto" (R2's default)
    STORAGE_PUBLIC_BASE_URL optional -- a custom/CDN domain to serve files
                            from instead of the raw endpoint URL
"""

import os

STORAGE_ENDPOINT_URL = os.environ.get("STORAGE_ENDPOINT_URL", "")
STORAGE_ACCESS_KEY = os.environ.get("STORAGE_ACCESS_KEY", "")
STORAGE_SECRET_KEY = os.environ.get("STORAGE_SECRET_KEY", "")
STORAGE_BUCKET_NAME = os.environ.get("STORAGE_BUCKET_NAME", "")
STORAGE_REGION = os.environ.get("STORAGE_REGION", "auto")
STORAGE_PUBLIC_BASE_URL = os.environ.get("STORAGE_PUBLIC_BASE_URL", "")

CLOUD_STORAGE_ENABLED = bool(
    STORAGE_ENDPOINT_URL and STORAGE_ACCESS_KEY and STORAGE_SECRET_KEY and STORAGE_BUCKET_NAME
)


def get_storages_setting():
    """Returns the Django STORAGES dict entry for 'default', or None to
    fall back to local disk storage (the caller should not set STORAGES
    at all in that case, letting Django use its own default)."""
    if not CLOUD_STORAGE_ENABLED:
        return None
    return {
        "BACKEND": "storages.backends.s3.S3Storage",
        "OPTIONS": {
            "endpoint_url": STORAGE_ENDPOINT_URL,
            "access_key": STORAGE_ACCESS_KEY,
            "secret_key": STORAGE_SECRET_KEY,
            "bucket_name": STORAGE_BUCKET_NAME,
            "region_name": STORAGE_REGION,
            "custom_domain": STORAGE_PUBLIC_BASE_URL or None,
            "querystring_auth": False,  # public read URLs, no signed-URL expiry
            "file_overwrite": False,
        },
    }
