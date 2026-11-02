"""
Presigned-upload support for direct browser -> R2 image uploads, kept
separate from views.py the same way imaging.py and ai_inference.py are
their own modules.

Why this exists: the farmer's phone now compresses each scan photo to
WebP itself (see static/js/disease_detection.js, startDirectUploads) and
uploads it straight to Cloudflare R2 using a short-lived presigned URL
generated here, instead of sending the raw file through Django. That keeps
PythonAnywhere's free-tier CPU-seconds and request bandwidth free for
everything else -- important once usage is closer to production scale
(many farms/trees) than a single demo. See views.request_upload_url()
(issues the URL) and the root_image_key/trunk_image_key branch in
views.save_detection() (reads the result back).

Falls back cleanly: if cloud storage isn't configured yet
(CLOUD_STORAGE_ENABLED is False -- see project/storage_config.py),
generate_upload_url() raises DirectUploadUnavailable and the frontend
falls back to the original multipart file upload through
save_detection(), so the app never breaks because R2 credentials
aren't set.

Safety rules enforced here (the client is never trusted):
  * Only keys this module generated (scans/<roots|trunks>/YYYY/MM/<32 hex>.webp)
    are accepted back -- is_valid_key().
  * The size of an upload is limited: the URL request can declare the size
    and the presigned PUT then only accepts exactly that many bytes, and
    fetch_uploaded_bytes() refuses anything over MAX_UPLOAD_BYTES.
"""

import datetime
import os
import re
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

# The browser compresses every photo to WebP before uploading (~60-100KB),
# so anything near this size is not a normal scan photo.
MAX_UPLOAD_BYTES = 5 * 1024 * 1024

# Set DIRECT_UPLOAD_SIGN_SIZE=0 in the environment to stop signing the
# declared Content-Length into the presigned URL (only needed if a storage
# provider rejects it; the size is still checked again when the key is
# read back in fetch_uploaded_bytes()).
SIGN_UPLOAD_SIZE = os.environ.get("DIRECT_UPLOAD_SIGN_SIZE", "1") != "0"

_KEY_RE = re.compile(r"scans/(roots|trunks)/\d{4}/\d{2}/[0-9a-f]{32}\.webp")


class DirectUploadUnavailable(Exception):
    """Raised when cloud storage isn't configured. Callers (views.py)
    should catch this and tell the client to fall back to the normal
    multipart upload path instead."""


class InvalidUploadKey(ValueError):
    """The key isn't one this module could have generated."""


class UploadTooLarge(ValueError):
    """The declared or actual size is above MAX_UPLOAD_BYTES."""


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


def is_valid_key(key, kind=None):
    """True only for keys shaped exactly like build_key() output. Used to
    reject client-supplied keys that point at anything else in the bucket."""
    if not isinstance(key, str):
        return False
    match = _KEY_RE.fullmatch(key)
    if not match:
        return False
    return kind is None or match.group(1) == kind


def generate_upload_url(kind, size=None):
    """Returns {key, upload_url, expires_in} for a single image. The
    frontend PUTs its compressed WebP blob to upload_url with header
    Content-Type: image/webp, then reports `key` back to
    save_detection() once both the root and trunk uploads finish.

    `size` is the byte length the client is about to upload. When given
    (and SIGN_UPLOAD_SIZE is on) it is signed into the URL, so the storage
    provider rejects a PUT of any other length. Raises UploadTooLarge when
    it is zero, negative or above MAX_UPLOAD_BYTES."""
    if not CLOUD_STORAGE_ENABLED:
        raise DirectUploadUnavailable(
            "Cloud storage isn't configured -- set the STORAGE_* environment "
            "variables described in project/storage_config.py to enable "
            "direct uploads."
        )
    params = {"Bucket": STORAGE_BUCKET_NAME, "ContentType": "image/webp"}
    if size is not None:
        if not isinstance(size, int) or size <= 0 or size > MAX_UPLOAD_BYTES:
            raise UploadTooLarge(
                f"Photo is too large to upload (limit {MAX_UPLOAD_BYTES // (1024 * 1024)} MB)."
            )
        if SIGN_UPLOAD_SIZE:
            params["ContentLength"] = size
    key = build_key(kind)
    params["Key"] = key
    upload_url = _client().generate_presigned_url(
        "put_object",
        Params=params,
        ExpiresIn=UPLOAD_URL_EXPIRES_SECONDS,
    )
    return {"key": key, "upload_url": upload_url, "expires_in": UPLOAD_URL_EXPIRES_SECONDS}


def fetch_uploaded_bytes(key):
    """Reads back an already-uploaded object's bytes -- used by
    save_detection() to hand the image to ai_inference.classify_images()
    without re-uploading it. Cheap: R2 has no egress fees, and these are
    already-compressed ~60-100KB WebP files, not the CPU-heavy resize
    Django used to do itself.

    Raises InvalidUploadKey for a key that isn't one of ours and
    UploadTooLarge for an oversized object (checked before downloading and
    again while reading)."""
    if not CLOUD_STORAGE_ENABLED:
        raise DirectUploadUnavailable("Cloud storage isn't configured.")
    if not is_valid_key(key):
        raise InvalidUploadKey("That isn't a valid upload reference.")
    client = _client()
    head = client.head_object(Bucket=STORAGE_BUCKET_NAME, Key=key)
    if head.get("ContentLength", 0) > MAX_UPLOAD_BYTES:
        raise UploadTooLarge("The uploaded photo is too large.")
    response = client.get_object(Bucket=STORAGE_BUCKET_NAME, Key=key)
    data = response["Body"].read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise UploadTooLarge("The uploaded photo is too large.")
    return data
