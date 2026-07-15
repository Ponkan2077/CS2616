import io
from PIL import Image, ImageOps
from django.core.files.base import ContentFile

# Images are stored at up to 1080px on the longest edge for record-keeping,
# display, and potential future model retraining. This is deliberately
# separate from the CNN's own input size (e.g. 224x224) — that resize/
# normalization happens right before inference, not at storage time.
MAX_DIMENSION = 1080
WEBP_QUALITY = 85


def resize_for_storage(django_file, filename):
    """
    Takes an uploaded file (from request.FILES), downscales it so its
    longest edge is at most MAX_DIMENSION (upscaling is never applied —
    a smaller source image is left as-is), corrects EXIF rotation, and
    returns a Django ContentFile ready to assign to an ImageField.
    Converts everything to WebP (per Chapter 3's stated preprocessing
    pipeline) for consistent, predictable, and compact storage size.
    """
    image = Image.open(django_file)
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
