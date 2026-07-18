"""
Presigned-upload support for direct browser -> R2 image uploads, kept
separate from views.py the same way imaging.py and ai_inference.py are
their own modules.

Why this exists: the farmer's phone now compresses each scan photo to
WebP itself (see static/js/upload_direct.js) and uploads it straight to
Cloudflare R2 using a short-lived presigned URL generated here, instead
of sending the raw file through Django. That keeps PythonAnywhere's
free-tier CPU-seconds and request bandwidth free for everything else --
important once usage is closer to production scale (many farms/trees)
than a single demo. See views.request_upload_url() (issues the URL) and
the root_image_key/trunk_image_key branch in views.save_detection()
(reads the result back).

Falls back cleanly: if cloud storage isn't configured yet
(CLOUD_STORAGE_ENABLED is False -- see project/storage_config.py),
generate_upload_url() raises DirectUploadUnavailable and the frontend
falls back to the original multipart file upload through
save_detection(), so the app never breaks because R2 credentials
aren't set.
"""

import datetime
import uuid

import boto3
from botocore.client import Config

from project.storage_config import (
    STORAGE_ENDPOINT_URL, STORAGE_ACCESS_KEY, STORAGE_SECRET_KEY,
    STORAGE_BUCKET_NAME, STORAGE_REGION, CLOUD_STORAGE_ENABLED,
)

# How long a presigned upload URL stays valid. Generous enough to cover a
# slow mobile-data upload of a compressed (~60-100KB) photo without the
# farmer needing to re-request one mid-scan.
UPLOAD_URL_EXPIRES_SECONDS = 600


class DirectUploadUnavailable(Exception):
    """Raised when cloud storage isn't configured. Callers (views.py)
    should catch this and tell the client to fall back to the normal
    multipart upload path instead."""


def _client():
    return boto3.client(
        "s3",
        endpoint_url=STORAGE_ENDPOINT_URL,
        aws_access_key_id=STORAGE_ACCESS_KEY,
        aws_secret_access_key=STORAGE_SECRET_KEY,
        region_name=STORAGE_REGION,
        config=Config(signature_version="s3v4"),
    )


def build_key(kind):
    """kind is 'roots' or 'trunks'. Mirrors RubberTree/ScanHistory's
    existing upload_to=scans/roots/%Y/%m/ and scans/trunks/%Y/%m/
    paths, so directly-uploaded files land in the same bucket layout as
    ones that went through Django's own (still-available) resize path."""
    if kind not in ("roots", "trunks"):
        raise ValueError(f"kind must be 'roots' or 'trunks', got {kind!r}")
    today = datetime.date.today()
    return f"scans/{kind}/{today:%Y}/{today:%m}/{uuid.uuid4().hex}.webp"


def generate_upload_url(kind):
    """Returns {key, upload_url, expires_in} for a single image. The
    frontend PUTs its compressed WebP blob to upload_url with header
    Content-Type: image/webp, then reports `key` back to
    save_detection() once both the root and trunk uploads finish."""
    if not CLOUD_STORAGE_ENABLED:
        raise DirectUploadUnavailable(
            "Cloud storage isn't configured -- set the STORAGE_* environment "
            "variables described in project/storage_config.py to enable "
            "direct uploads."
        )
    key = build_key(kind)
    upload_url = _client().generate_presigned_url(
        "put_object",
        Params={"Bucket": STORAGE_BUCKET_NAME, "Key": key, "ContentType": "image/webp"},
        ExpiresIn=UPLOAD_URL_EXPIRES_SECONDS,
    )
    return {"key": key, "upload_url": upload_url, "expires_in": UPLOAD_URL_EXPIRES_SECONDS}


def fetch_uploaded_bytes(key):
    """Reads back an already-uploaded object's bytes -- used by
    save_detection() to hand the image to ai_inference.classify_images()
    without re-uploading it. Cheap: R2 has no egress fees, and these are
    already-compressed ~60-100KB WebP files, not the CPU-heavy resize
    Django used to do itself."""
    if not CLOUD_STORAGE_ENABLED:
        raise DirectUploadUnavailable("Cloud storage isn't configured.")
    response = _client().get_object(Bucket=STORAGE_BUCKET_NAME, Key=key)
    return response["Body"].read()
