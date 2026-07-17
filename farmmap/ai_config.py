"""
AI model hosting configuration, kept separate from ai_inference.py so
switching model hosts -- or tuning timeouts/retries -- is a change to this
file only, not to the request-handling logic in ai_inference.py. Mirrors
how project/storage_config.py is kept separate from settings.py.

Required environment variable to enable real inference (set on
PythonAnywhere's Web tab -> Environment variables, or in a local .env):
    AI_MODEL_ENDPOINT_URL   e.g. https://<user>-<space>.hf.space/predict

Optional:
    AI_MODEL_TIMEOUT_SECONDS   defaults to 15
    AI_MODEL_API_KEY           only needed if your endpoint requires auth
                                (sent as a Bearer token); leave unset for
                                a public Space/endpoint

Until AI_MODEL_ENDPOINT_URL is set, save_detection() keeps using the
client-side JS simulator (static/js/disease_detection.js) -- the app
never breaks because a model isn't deployed yet.

---------------------------------------------------------------------
Recommended AI hosting (checked July 2026)
---------------------------------------------------------------------
Hugging Face Spaces, CPU Basic tier, is still the best free option for a
thesis-scale deployment: MobileNetV3 / EfficientNet-B0 / ResNet-50 sized
models classify a single image in well under a second on CPU, so GPU
isn't needed to serve individual scan requests. Package the trained model
behind a small FastAPI or Gradio app in a public Space, and its URL goes
in AI_MODEL_ENDPOINT_URL above. hf.space is on PythonAnywhere's
free-account outbound allowlist (pythonanywhere.com/whitelist/), so this
works unmodified on a free PythonAnywhere account.

One change since this was first set up: as of June 1, 2026, Hugging Face
capped free CPU-Basic usage at 2,000 CPU-hours/month (previously
uncapped), and that free allowance now requires the Space to be public.
2,000 hours/month is still far more than a single low-traffic demo
endpoint needs (roughly 66 hours/day), so this doesn't change the
recommendation -- just keep the Space public rather than private.

If you outgrow the free CPU tier or need GPU for a heavier model, two
pay-as-you-go options worth comparing when the time comes: Hugging Face
Inference Endpoints (scale-to-zero, billed per minute, so a bursty demo
stays cheap) and Modal (serverless GPU functions, no idle charges).
Neither is needed for the current MobileNetV3/ResNet-50/EfficientNet-B0
model sizes on CPU.
"""

import os

AI_MODEL_ENDPOINT_URL = os.environ.get("AI_MODEL_ENDPOINT_URL", "")
AI_MODEL_TIMEOUT_SECONDS = float(os.environ.get("AI_MODEL_TIMEOUT_SECONDS", "15"))
AI_MODEL_API_KEY = os.environ.get("AI_MODEL_API_KEY", "")

AI_MODEL_ENABLED = bool(AI_MODEL_ENDPOINT_URL)


def get_request_headers():
    """Returns the headers to send with the inference request -- just an
    Authorization header if AI_MODEL_API_KEY is set, otherwise none."""
    if AI_MODEL_API_KEY:
        return {"Authorization": f"Bearer {AI_MODEL_API_KEY}"}
    return {}
