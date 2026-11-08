import io
from PIL import Image, ImageOps
from django.core.files.base import ContentFile

# Images are stored at up to 1080px on the longest edge for record-keeping,
# display, and potential future model retraining. This is deliberately
# separate from the CNN's own input size (e.g. 224x224) — that resize/
# normalization happens right before inference, not at storage time.
MAX_DIMENSION = 1080
WEBP_QUALITY = 85

# The only formats a scan photo may be. The browser compresses every photo to
# WebP; JPEG and PNG cover photos queued by older versions. Pillow can open
# many more formats (EPS, GD, PCX, ...), and every extra decoder is more
# attack surface for a file a stranger can upload, so Image.open() is told
# exactly which ones to try.
ALLOWED_FORMATS = ("JPEG", "PNG", "WEBP")


def is_valid_image(data):
    """True when `data` (bytes) is a complete JPEG, PNG or WebP image.
    Used before a photo is sent to the AI model or stored, so a file that is
    not really an image can't be pushed through either of them."""
    try:
        with Image.open(io.BytesIO(data), formats=ALLOWED_FORMATS) as image:
            image.verify()
        return True
    except Exception:
        # Image.open raises UnidentifiedImageError / OSError / SyntaxError /
        # DecompressionBombError depending on what is wrong with the file.
        return False


def resize_for_storage(django_file, filename):
    """
    Takes an uploaded file (from request.FILES), downscales it so its
    longest edge is at most MAX_DIMENSION (upscaling is never applied —
    a smaller source image is left as-is), corrects EXIF rotation, and
    returns a Django ContentFile ready to assign to an ImageField.
    Converts everything to WebP (per Chapter 3's stated preprocessing
    pipeline) for consistent, predictable, and compact storage size.

    Raises PIL.UnidentifiedImageError (an OSError) when the file is not a
    JPEG, PNG or WebP image; callers turn that into a normal error message.
    """
    image = Image.open(django_file, formats=ALLOWED_FORMATS)
    image = ImageOps.exif_transpose(image)  # respect phone camera orientation
    if image.mode not in ("RGB", "L"):
        image = image.convert("RGB")

    width, height = image.size
    longest_edge = max(width, height)
    if longest_edge > MAX_DIMENSION:
        scale = MAX_DIMENSION / longest_edge
        image = image.resize((round(width * scale), round(height * scale)), Image.LANCZOS)

    buffer = io.BytesIO()
    image.save(buffer, format="WEBP", quality=WEBP_QUALITY)
    buffer.seek(0)

    base_name = filename.rsplit(".", 1)[0] if "." in filename else filename
    return ContentFile(buffer.read(), name=f"{base_name}.webp")
