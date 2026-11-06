import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

SECRET_KEY = 'django-insecure-rubberguard-thesis-prototype-2025-change-in-production'

DEBUG = True

ALLOWED_HOSTS = ['*']  # PythonAnywhere: add your .pythonanywhere.com domain here

# Required so Django trusts POST requests coming from the PythonAnywhere
# domain (Django 4+ requires the scheme to be included explicitly).
CSRF_TRUSTED_ORIGINS = [
    'https://*.pythonanywhere.com',
    'https://reyursus.pythonanywhere.com',
]

# On a CSRF mismatch (commonly a dropped mobile connection during /login/),
# redirect to a fresh login form instead of showing Django's raw 403 page.
CSRF_FAILURE_VIEW = 'farmmap.views.csrf_failure'

INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.staticfiles',
    'django.contrib.sessions',
    'django.contrib.messages',
    'farmmap',
]

MIDDLEWARE = [
    # First, so every HTML/JSON response (the farm map embeds a few thousand
    # markers in its page) is compressed for browsers that accept gzip.
    'django.middleware.gzip.GZipMiddleware',
    'django.middleware.security.SecurityMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'farmmap.middleware.NoCacheForAuthenticatedUsersMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

ROOT_URLCONF = 'project.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [BASE_DIR / 'templates'],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.debug',
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
                'farmmap.context_processors.static_version',
            ],
        },
    },
]

WSGI_APPLICATION = 'project.wsgi.application'

# SQLite database — stores users, farms, trees, scan history
DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.sqlite3',
        'NAME': BASE_DIR / 'db.sqlite3',
        # SQLite allows one writer at a time. Several farmers syncing bulk
        # uploads at once would otherwise fail after Django's default 5 s
        # wait with "database is locked"; 20 s lets the queue drain instead.
        'OPTIONS': {'timeout': 20},
    }
}

# Checked on sign-up and password change (not on existing passwords): at
# least 8 characters, not a common password, not all digits, not too close
# to the username. Without this list Django accepts any password, "1234"
# included.
AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator'},
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
]

# Sessions stored in the database (requires migrate)
SESSION_ENGINE = 'django.contrib.sessions.backends.db'

# Where Django redirects after login/logout
LOGIN_URL = 'login'
LOGIN_REDIRECT_URL = 'dashboard'
LOGOUT_REDIRECT_URL = 'login'

LANGUAGE_CODE = 'en-us'
TIME_ZONE = 'Asia/Manila'
USE_I18N = True
USE_TZ = True

STATIC_URL = '/static/'
STATICFILES_DIRS = [BASE_DIR / 'static']
STATIC_ROOT = BASE_DIR / 'staticfiles'  # for PythonAnywhere collectstatic

# Cache-busting suffix appended to every static JS/CSS <script>/<link> tag
# as ?v=<STATIC_VERSION> (see farmmap/context_processors.py). Computed once
# when this process starts, so it changes on its own every time the app is
# reloaded on PythonAnywhere -- no manual version bump needed, and no more
# "I updated the file but the browser is still running the old one."
import time as _time
STATIC_VERSION = str(int(_time.time()))

# Local storage by default; switches to cloud storage automatically if
# configured. See project/storage_config.py for provider setup and
# recommendations -- kept in its own module so switching cloud storage
# providers never requires touching this settings file.
MEDIA_URL = '/media/'
MEDIA_ROOT = BASE_DIR / 'media'

from .storage_config import get_storages_setting, CLOUD_STORAGE_ENABLED

if CLOUD_STORAGE_ENABLED:
    STORAGES = {
        'default': get_storages_setting(),
        'staticfiles': {'BACKEND': 'django.contrib.staticfiles.storage.StaticFilesStorage'},
    }

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

# --- GPS quality rules (used by save_detection in farmmap/views.py) ---------
# Worst horizontal accuracy, in metres, a scan's GPS fix may report and still
# be saved. Keep in step with GPS_MAX_ACCURACY_M in static/js/gps_exif.js,
# which applies the same limit on the phone before a photo is accepted.
GPS_MAX_ACCURACY_M = 50
# A new location this far from the average of the farm's existing trees is
# treated as a bad fix (cell-tower or stale position) rather than a real tree.
# Only checked once the farm has FARM_DISTANCE_CHECK_MIN_TREES trees.
FARM_MAX_DISTANCE_KM = 5
FARM_DISTANCE_CHECK_MIN_TREES = 10

# How long (seconds) the signed result from /detection/analyze/ stays valid
# for /detection/save/, so the model isn't run a second time at save.
ANALYSIS_TOKEN_MAX_AGE_S = 2 * 60 * 60
