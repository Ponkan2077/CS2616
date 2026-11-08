"""Tiny real images for tests. The server now refuses a "photo" that is not a
JPEG, PNG or WebP image, so tests can no longer pass made-up bytes."""
import io

from PIL import Image


def image_bytes(color=(20, 120, 20), fmt="WEBP"):
    buffer = io.BytesIO()
    Image.new("RGB", (16, 16), color).save(buffer, format=fmt)
    return buffer.getvalue()


ROOT_PHOTO = image_bytes((120, 80, 30))
TRUNK_PHOTO = image_bytes((70, 60, 50))
OTHER_TRUNK_PHOTO = image_bytes((200, 10, 10))
