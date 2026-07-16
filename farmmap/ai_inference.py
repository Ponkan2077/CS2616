"""
AI model inference, kept separate from views.py so swapping model hosts
(or eventually running a real local model) never touches request-handling
code -- only this module changes.

Currently, actual classification happens client-side as a JS simulation
(see static/js/disease_detection.js) since no trained model is wired in
yet. This module is the seam for when that changes: once you deploy your
trained model behind an HTTP endpoint, set AI_MODEL_ENDPOINT_URL and
classify_images() below will call it for real, with the simulated
fallback removed automatically.

Recommended free hosting for testing your pipeline (as of mid-2026):
Hugging Face Spaces, CPU Basic tier -- genuinely free with no daily time
limit (unlike ZeroGPU's 3.5-minutes/day free quota), and MobileNetV3 /
EfficientNet-B0 / ResNet-50 sized models run inference in well under a
second on CPU, so GPU isn't actually needed for serving single-image
classification requests. Package your trained model behind a small
FastAPI or Gradio app in a Space, and its URL
(https://<user>-<space>.hf.space/predict) is what goes in
AI_MODEL_ENDPOINT_URL below -- hf.space is on PythonAnywhere's free-account
outbound allowlist (pythonanywhere.com/whitelist/), so this works
unmodified on a free PythonAnywhere account.

If you specifically need GPU to validate inference speed/behavior before
going live, Hugging Face's ZeroGPU (free, H200-backed, 3.5 min/day quota,
Gradio SDK only) is also usable from PythonAnywhere for that kind of
occasional testing -- just not for serving continuous production traffic
on the free quota.
"""

import os
import requests

AI_MODEL_ENDPOINT_URL = os.environ.get("AI_MODEL_ENDPOINT_URL", "")
AI_MODEL_TIMEOUT_SECONDS = float(os.environ.get("AI_MODEL_TIMEOUT_SECONDS", "15"))
AI_MODEL_ENABLED = bool(AI_MODEL_ENDPOINT_URL)


class InferenceError(Exception):
    """Raised when a configured model endpoint is unreachable or returns
    an unexpected response. Callers should catch this and decide whether
    to surface an error to the user or fall back to another path."""


def classify_images(root_image_bytes, trunk_image_bytes):
    """
    Sends the root and trunk photos to the configured model endpoint and
    returns a dict: {"disease": str, "confidence": float,
    "root_condition": str}.

    Raises InferenceError if AI_MODEL_ENDPOINT_URL isn't set, the request
    fails, or the response is malformed -- callers decide what to do next
    (e.g. views.py can catch this and tell the client to fall back to the
    JS simulator during development).
    """
    if not AI_MODEL_ENABLED:
        raise InferenceError(
            "No AI_MODEL_ENDPOINT_URL configured. Set it once your trained "
            "model is deployed (e.g. to a Hugging Face Space) to enable "
            "real inference; until then, the client-side simulator is used."
        )

    try:
        response = requests.post(
            AI_MODEL_ENDPOINT_URL,
            files={
                "root_image": ("root.webp", root_image_bytes, "image/webp"),
                "trunk_image": ("trunk.webp", trunk_image_bytes, "image/webp"),
            },
            timeout=AI_MODEL_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        data = response.json()
    except requests.RequestException as exc:
        raise InferenceError(f"Model endpoint request failed: {exc}") from exc
    except ValueError as exc:
        raise InferenceError(f"Model endpoint returned non-JSON response: {exc}") from exc

    required_keys = {"disease", "confidence"}
    if not required_keys.issubset(data):
        raise InferenceError(f"Model response missing required keys {required_keys}: got {data!r}")

    return {
        "disease": data["disease"],
        "confidence": float(data["confidence"]),
        "root_condition": data.get("root_condition", ""),
    }
