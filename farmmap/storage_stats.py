"""
Storage usage analytics for the admin dashboard. Kept separate from
views.py, alongside storage_config.py (the provider config itself), so
the two concerns -- "which provider is active" and "how much are we
using" -- stay in their own files.
"""

from project.storage_config import CLOUD_STORAGE_ENABLED, STORAGE_ENDPOINT_URL, STORAGE_BUCKET_NAME

# Summing exact byte sizes across every stored image would mean one
# stat/HEAD call per file -- fine for local disk, potentially slow and
# rate-limit-prone against a cloud provider's API once there are
# thousands of images. Sampling the most recent N keeps the dashboard
# fast regardless of provider, at the cost of being an estimate rather
# than an exact total.
SAMPLE_SIZE = 200


def get_storage_summary():
    from .models import RubberTree

    total_trees_with_images = RubberTree.objects.filter(
        root_image__isnull=False
    ).exclude(root_image="").count()

    recent = list(
        RubberTree.objects.exclude(root_image="").exclude(trunk_image="")
        .order_by("-id")[:SAMPLE_SIZE]
    )
    sampled_bytes = 0
    sampled_files = 0
    for tree in recent:
        for field in (tree.root_image, tree.trunk_image):
            try:
                sampled_bytes += field.size
                sampled_files += 1
            except (ValueError, OSError):
                continue  # file missing/unreachable -- skip rather than fail the whole page

    avg_bytes_per_file = (sampled_bytes / sampled_files) if sampled_files else 0
    total_image_count = RubberTree.objects.exclude(root_image="").count() + \
        RubberTree.objects.exclude(trunk_image="").count()
    estimated_total_bytes = avg_bytes_per_file * total_image_count

    if CLOUD_STORAGE_ENABLED:
        backend_label = f"Cloud ({STORAGE_ENDPOINT_URL.split('//')[-1].split('/')[0]})"
        bucket_label = STORAGE_BUCKET_NAME
    else:
        backend_label = "Local disk"
        bucket_label = "—"

    return {
        "backend_label": backend_label,
        "bucket_label": bucket_label,
        "total_trees_with_images": total_trees_with_images,
        "total_image_count": total_image_count,
        "sample_size": sampled_files,
        "estimated_total_mb": round(estimated_total_bytes / (1024 * 1024), 1),
        "is_estimate": total_image_count > sampled_files,
    }
