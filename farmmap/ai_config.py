"""
AI model hosting configuration, kept separate from ai_inference.py so
switching model hosts -- or tuning timeouts/retries -- is a change to this
file only, not to the request-handling logic in ai_inference.py. Mirrors
how project/storage_config.py is kept separate from settings.py.

Required environment variable to enable real inference (set on
PythonAnywhere's Web tab -> Environment variables, or in a local .env):
    AI_MODEL_ENDPOINT_URL   e.g. https://REGION-PROJECT_ID.cloudfunctions.net/predict

Optional:
    AI_MODEL_TIMEOUT_SECONDS   defaults to 60 (see cold-start note below)
    AI_MODEL_API_KEY           only needed if your endpoint requires auth
                                (sent as a Bearer token); leave unset for
                                a public endpoint

Until AI_MODEL_ENDPOINT_URL is set, the Analyze Images button on the
detection page is disabled instead of faking a result (see
templates/disease_detection.html and admin_dashboard.html).

---------------------------------------------------------------------
Recommended AI hosting (checked July 2026)
---------------------------------------------------------------------
As of this month, Hugging Face requires a paid plan to create a Docker
or Gradio-on-CPU Space -- free accounts can only create Gradio Spaces on
ZeroGPU hardware (max 2, account 30+ days old, verified email) or static
Spaces, and Render's free tier isn't on PythonAnywhere's outbound
allowlist by default (would need a manual per-URL approval request that
isn't guaranteed for a private endpoint). That replaces both of those
earlier recommendations here.

Currently deployed on Google Cloud, specifically as a "Cloud Run
function" (2nd gen, deployed with `gcloud functions deploy`, NOT `gcloud
run deploy`) -- see the gcp_deploy/ folder alongside this file's sibling
module for the ready-to-deploy app matching the /predict contract
classify_images() below expects. The reason for that specific deploy
path: it gives a *.cloudfunctions.net URL by default, which -- unlike
plain Cloud Run's *.run.app -- IS already on PythonAnywhere's free
outbound allowlist. Same underlying infrastructure and free tier as
Cloud Run either way (2 million requests / 360,000 GB-seconds / 180,000
vCPU-seconds per month, far more than this project needs), just reached
through a URL PythonAnywhere already trusts.

Setting up Google Cloud billing may involve a one-time refundable
deposit depending on your country/card (not an ongoing cost) -- see
gcp_deploy/README.md for details. Since real billing is attached here
(unlike the free-Space options above), gcp_deploy/main.py supports an
optional PREDICT_API_KEY / AI_MODEL_API_KEY shared secret so the
endpoint isn't left open to random use -- worth setting.

Cold starts: much faster than Render's free tier was, but a TensorFlow
container loading a model from a cold instance can still take several
seconds, which is why AI_MODEL_TIMEOUT_SECONDS defaults to 60 below.
"""

import os

AI_MODEL_ENDPOINT_URL = os.environ.get("AI_MODEL_ENDPOINT_URL", "")
AI_MODEL_TIMEOUT_SECONDS = float(os.environ.get("AI_MODEL_TIMEOUT_SECONDS", "60"))
AI_MODEL_API_KEY = os.environ.get("AI_MODEL_API_KEY", "")

AI_MODEL_ENABLED = bool(AI_MODEL_ENDPOINT_URL)


def get_request_headers():
    """Returns the headers to send with the inference request -- just an
    Authorization header if AI_MODEL_API_KEY is set, otherwise none."""
    if AI_MODEL_API_KEY:
        return {"Authorization": f"Bearer {AI_MODEL_API_KEY}"}
    return {}
