/* Handles the two-step capture flow (root image, then trunk image — see
   comment 4), resizes each photo client-side before upload, sends both to
   the real AI model for analysis, and uploads both resized images
   directly to cloud storage via a presigned URL (falling back to
   attaching them to the save form's file inputs for a normal multipart
   submission if direct upload isn't available).

   This page is ONLINE-ONLY. A live GPS fix for Take Photo and the AI
   analysis both need a connection, so there is no offline queue here --
   photos prepared without signal go through Bulk Upload instead (see
   offline_queue.js). */

let rootImageFile = null;   // resized File, ready to attach to the save form
let trunkImageFile = null;
let rootGPS = null;   // { lat, lng, source: 'exif' | 'device' } -- resolved per image
let trunkGPS = null;

// Where the browser's geolocation permission stands: "granted" | "prompt" |
// "denied" | "unknown" (browser can't report it, e.g. older Safari).
// Kept current by checkLocationAvailability() and its live onchange hook.
// Take Photo only opens the camera once this is "granted" -- see
// guardTakePhoto() for why the permission is asked for BEFORE the shot.
let locationPermission = "unknown";

// Direct-to-storage upload state. Uploads kick off in the background as
// soon as the analysis result is shown, so they're usually
// already finished by the time the farmer reviews the result and hits
// Save. directUploadPromise resolves once both are done (or resolves
// anyway on failure/unavailability, leaving the original file-input
// attachment from showResult() as the fallback).
let directUploadPromise = null;

// Reads the device's position and resolves with the best fix it can get in a
// short window -- not just the first one the browser hands back.
//
// The first reading from a phone is often the coarsest (cell/Wi-Fi based,
// tens or hundreds of metres off); the GPS chip tightens it over the next few
// seconds, especially under rubber tree canopy. So this watches the position
// and keeps the most accurate fix seen. It stops as soon as one is within
// GPS_TARGET_ACCURACY_M and, when the window ends, accepts the best one only
// if it is within GPS_MAX_ACCURACY_M (both in gps_exif.js) -- otherwise it
// reports the fix as too imprecise instead of tagging the tree with a
// position that could be off by a whole row.
//
// maximumAge is 0: a cached position (the browser may still hold one from the
// previous tree) is never used. The one exception is a fix THIS function took
// within the last RECENT_FIX_MAX_AGE_MS -- the root and trunk photos of one
// tree are shot seconds apart, so the trunk reuses the root's fix instead of
// making the farmer wait twice.
//
// Resolves { lat, lng, accuracy, source: "device", capturedAt } on success, or
// { error, code } on failure. The codes are the Geolocation API's (1 blocked,
// 2 no fix, 3 timed out) plus 4 = fix too imprecise: telling them apart
// matters a lot in the field, since the remedy for each is different.
//
// opts.permissionOnly: used by requestLocationPermission() just to raise the
// browser's permission prompt -- resolves on the first fix of any quality.
const GPS_FIX_WINDOW_MS = 20000;
const RECENT_FIX_MAX_AGE_MS = 10000;
let recentDeviceFix = null;   // last good fix from getDeviceGPS(), for the trunk photo to reuse

function getDeviceGPS(opts) {
  const permissionOnly = !!(opts && opts.permissionOnly);
  console.log("[GPS DEBUG] getDeviceGPS() called. navigator.geolocation present:", !!navigator.geolocation, "permissionOnly:", permissionOnly);
  // Fire-and-forget permission read, purely for diagnostics -- doesn't
  // block or change the actual geolocation call below.
  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: "geolocation" })
      .then(status => console.log("[GPS DEBUG] permission state at call time:", status.state))
      .catch(permErr => console.log("[GPS DEBUG] permission query failed:", permErr));
  }
  return new Promise(resolve => {
    if (!navigator.geolocation) { console.log("[GPS DEBUG] no navigator.geolocation -- resolving with error immediately"); resolve({ error: "This browser doesn't support device location." }); return; }

    if (!permissionOnly && recentDeviceFix && Date.now() - recentDeviceFix.fixedAt <= RECENT_FIX_MAX_AGE_MS) {
      console.log("[GPS DEBUG] reusing the fix taken moments ago:", recentDeviceFix);
      resolve({ ...recentDeviceFix, capturedAt: Date.now() });
      return;
    }

    const reasons = {
      1: "Location access is blocked. Check two settings: the site permission (tap the location icon in your address bar) and your browser app's own OS permission (Android: Settings → Apps → Chrome → Permissions → Location) -- granting one without the other still fails.",
      2: "Couldn't get a GPS fix. Try moving to open sky, away from thick canopy or buildings.",
      3: "GPS location timed out. Try again, ideally with a clearer view of the sky.",
    };
    const startedAt = Date.now();
    let best = null;        // most accurate fix seen so far
    let lastError = null;
    let settled = false;
    let watchId = null;
    let timer = null;

    const done = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      console.log("[GPS DEBUG] getDeviceGPS() settled after", Date.now() - startedAt, "ms:", result);
      resolve(result);
    };
    const accept = fix => {
      if (settled) return;   // a reading that arrives after the lookup finished must not touch the cache
      if (!permissionOnly) recentDeviceFix = { ...fix, fixedAt: Date.now() };
      done(fix);
    };

    // Window over: take the best fix if it's good enough, otherwise say why not.
    timer = setTimeout(() => {
      if (best && (best.accuracy === null || best.accuracy <= GPS_MAX_ACCURACY_M)) { accept(best); return; }
      if (best) {
        done({
          error: `The GPS fix is too imprecise right now (about ${Math.round(best.accuracy)} m). Move to open sky, away from thick canopy, wait a few seconds, then try again.`,
          code: 4,
          accuracy: best.accuracy,
        });
        return;
      }
      const code = lastError ? lastError.code : 3;
      done({ error: reasons[code] || "Couldn't get your device's location.", code });
    }, permissionOnly ? 15000 : GPS_FIX_WINDOW_MS);

    watchId = navigator.geolocation.watchPosition(
      pos => {
        if (settled) return;
        const c = pos.coords;
        const fix = {
          lat: c.latitude,
          lng: c.longitude,
          accuracy: Number.isFinite(c.accuracy) ? c.accuracy : null,
          source: "device",
          capturedAt: Date.now(),
        };
        console.log("[GPS DEBUG] position update after", Date.now() - startedAt, "ms:", c.latitude, c.longitude, "accuracy", c.accuracy);
        if (!best || (fix.accuracy !== null && (best.accuracy === null || fix.accuracy < best.accuracy))) best = fix;
        if (permissionOnly || (best.accuracy !== null && best.accuracy <= GPS_TARGET_ACCURACY_M)) accept(best);
      },
      err => {
        console.warn("[GPS DEBUG] geolocation ERROR after", Date.now() - startedAt, "ms -- code:", err.code, "message:", err.message);
        lastError = err;
        // Blocked permission won't fix itself in the next few seconds; the
        // other errors can be transient while the GPS chip is still starting.
        if (err.code === 1) done({ error: reasons[1], code: 1 });
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: GPS_FIX_WINDOW_MS }
    );
  });
}

// Every photo has to carry a location one way or another, but which
// fallback is trustworthy depends on HOW the photo got here:
//
// - Take Photo (source "camera"): the shot and the upload happen in the
//   same moment, standing at the same tree. A live device GPS reading at
//   that moment is a genuinely accurate stand-in when the photo itself has
//   no EXIF GPS (the normal case for browser camera capture -- browsers
//   strip it there for privacy regardless of Location Services being on).
//
// - Browse or drag-drop (source "file"): this is an EXISTING photo. It
//   could've been taken this morning at the farm and uploaded tonight from
//   home -- the phone's current position has no reliable relationship to
//   where that photo was actually taken. Tagging it with a live reading
//   would silently mislabel the tree instead of honestly saying "unknown."
//   (On Android specifically, EXIF GPS is stripped from nearly every photo
//   handed over through the system Photo Picker anyway -- an OS privacy
//   policy since Android 13, independent of Camera/Location settings -- so
//   this path failing is expected, not a bug to chase.)
//
// Returns { lat, lng, source, accuracy } on success (accuracy in metres, or
// null when unknown), or { error } on failure -- never plain null, so the
// caller always has something to show the user.
async function resolveImageGPS(file, source) {
  console.log("[GPS DEBUG] resolveImageGPS() start -- source:", source, "file:", file && file.name, file && file.type, file && file.size, "bytes");
  const exifGps = await extractGPSFromFile(file);
  console.log("[GPS DEBUG] extractGPSFromFile() returned:", exifGps);
  if (exifGps) {
    // A photo that says how accurate its own fix was is held to the same
    // limit as a live reading. (Most don't say, and are taken as they are.)
    if (exifGps.accuracy === null || exifGps.accuracy <= GPS_MAX_ACCURACY_M) return exifGps;
    console.log("[GPS DEBUG] EXIF GPS present but too imprecise:", exifGps.accuracy, "m");
    if (source !== "camera") {
      return {
        error: `This photo's location is too imprecise (about ${Math.round(exifGps.accuracy)} m). Use Take Photo at the tree instead so we can read a fresh, accurate location.`,
      };
    }
    // Camera capture: fall through to a live device reading below.
  }
  if (source !== "camera") {
    console.log("[GPS DEBUG] no EXIF and source isn't camera -- rejecting without touching device GPS");
    return {
      error: "This photo has no location data attached (normal for gallery/browsed photos, especially on Android). Use Take Photo instead so we can read your current location.",
    };
  }
  console.log("[GPS DEBUG] no EXIF, source is camera -- falling back to getDeviceGPS()");
  const deviceGps = await getDeviceGPS();
  console.log("[GPS DEBUG] getDeviceGPS() settled with:", deviceGps);
  return deviceGps;
}

// Shows/hides a Bootstrap flex element. The banners use "d-flex" for their
// layout, and Bootstrap's display utilities are `display: ... !important`
// -- so a plain style.display = "none" can NEVER hide them (that's why the
// location banner used to sit on the page permanently, empty). Toggling
// the class, backed by an !important inline override, is what works.
function setFlexShown(el, shown) {
  el.classList.toggle("d-flex", shown);
  if (shown) el.style.removeProperty("display");
  else el.style.setProperty("display", "none", "important");
}

// Hides the banner. Called after page-load check, a successful device
// location fix, or a live permission change -- whichever happens first.
function hideLocationBanner() {
  const banner = document.getElementById("location-banner");
  if (banner) setFlexShown(banner, false);
}

// kind "prompt": permission hasn't been decided (or a fix just failed) --
// amber, with an Enable/Try again button. kind "denied": blocked -- red,
// no button (the browser won't re-prompt; only the site settings can fix it).
function showLocationBanner(reason, kind, buttonLabel) {
  const banner = document.getElementById("location-banner");
  const bannerText = document.getElementById("location-banner-text");
  const enableBtn = document.getElementById("location-enable-btn");
  if (!banner || !bannerText) return;
  const isPrompt = kind === "prompt";
  bannerText.textContent = isPrompt
    ? (reason || "Location is needed to tag each photo with the tree's position.")
    : `${reason || "Couldn't get your device's location."} Needed for Take Photo. On Android: browser menu → Settings → Sites and downloads → Site permissions → Location, and keep Precise location on for your browser.`;
  banner.classList.toggle("alert-danger", !isPrompt);
  banner.classList.toggle("alert-warning", isPrompt);
  if (enableBtn) {
    enableBtn.textContent = buttonLabel || "Enable location";
    enableBtn.style.display = isPrompt ? "" : "none";
  }
  setFlexShown(banner, true);
}

// Asks for location permission on purpose, from a tap (the banner's button
// or the first Take Photo tap), rather than leaving it to surface as a
// surprise prompt AFTER the photo is taken -- by which point the camera app
// has switched this page out and (on Android) the prompt/result can get
// lost. Resolves true once a real fix came back.
async function requestLocationPermission() {
  const enableBtn = document.getElementById("location-enable-btn");
  if (enableBtn) { enableBtn.disabled = true; enableBtn.textContent = "Waiting for location…"; }
  // This call is what raises the browser's prompt. Any fix at all proves the
  // permission works, so it doesn't wait around for an accurate one.
  const result = await getDeviceGPS({ permissionOnly: true });
  if (enableBtn) enableBtn.disabled = false;

  if (result && !result.error) {
    locationPermission = "granted";
    hideLocationBanner();
    return true;
  }
  // Re-read the real permission state to pick the right message: blocked
  // needs the browser settings, but a granted permission that just couldn't
  // get a fix (indoors, thick canopy) only needs another try.
  await checkLocationAvailability();
  if (locationPermission !== "denied") {
    // Error code 1 while the permission is STILL undecided means the prompt
    // was dismissed without choosing -- not that location is blocked, so
    // don't send them to the browser settings for that.
    const dismissed = result && result.code === 1 && locationPermission === "prompt";
    showLocationBanner(
      dismissed ? "Location wasn't allowed yet. Tap Try again and choose Allow when your browser asks."
                : ((result && result.error) || "Couldn't get your location."),
      "prompt", "Try again");
  }
  return false;
}

// Starts the GPS hardware warming up the moment Take Photo is tapped, so the
// chip already has satellites locked when the camera returns and the fix
// that getDeviceGPS() then asks for comes back quickly. The readings here are
// thrown away on purpose: the farmer may walk or spend a while in the camera
// app, so only a fix taken after the photo counts as the tree's position.
let lastGpsWarmUp = 0;
function warmUpGps() {
  if (!navigator.geolocation || Date.now() - lastGpsWarmUp < 10000) return;
  lastGpsWarmUp = Date.now();
  const watchId = navigator.geolocation.watchPosition(() => {}, () => {}, { enableHighAccuracy: true, maximumAge: 0 });
  setTimeout(() => navigator.geolocation.clearWatch(watchId), 8000);
}

function setCaptureStatus(kind, message, cssClass) {
  const statusEl = document.getElementById(`${kind}-gps-status`);
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.className = `${cssClass || "text-muted"} text-sm-rg mt-1`;
}

// Runs on every Take Photo tap, BEFORE the camera opens. Blocks the tap
// (preventDefault must happen synchronously, hence the state variables
// instead of awaiting anything here) when:
//  - the page is offline: Take Photo is online-only now -- a GPS fix and the
//    AI analysis both need a connection. Bulk Upload is the offline route.
//  - location isn't granted yet: asks for it now, then re-opens the camera
//    (or asks for one more tap if the browser's tap-allowance has lapsed
//    while the permission dialog was open).
function guardTakePhoto(e, kind) {
  if (window.rgOnline === false) {
    e.preventDefault();
    setCaptureStatus(kind, "You're offline. Take Photo needs a connection (GPS + analysis). Use Bulk Upload to prepare photos without signal.", "text-danger");
    // The offline flag can be stale (or a slow connection can fail the 4s
    // probe); re-check so a false "offline" clears on its own.
    if (typeof updateConnectivityBanner === "function") updateConnectivityBanner();
    return;
  }
  if (locationPermission !== "granted") {
    e.preventDefault();
    const input = e.currentTarget;
    setCaptureStatus(kind, "Allow location access when your browser asks…", "text-muted");
    requestLocationPermission().then(ok => {
      if (!ok) {
        setCaptureStatus(kind, "Location isn't available yet. See the message at the top of the page.", "text-danger");
        return;
      }
      if (navigator.userActivation && navigator.userActivation.isActive) {
        setCaptureStatus(kind, "", "text-muted");
        input.click();
      } else {
        setCaptureStatus(kind, "Location is on. Tap Take Photo again.", "text-main");
      }
    });
    return;
  }
  warmUpGps();
}

// Dims Take Photo while offline (it's blocked in guardTakePhoto either way).
document.addEventListener("rg:connectivity", e => {
  ["root-camera-input", "trunk-camera-input"].forEach(id => {
    const label = document.getElementById(id)?.closest("label");
    if (label) label.style.opacity = e.detail.online ? "" : ".5";
  });
});

// Checked on page load so a blocked permission shows up immediately, not
// only after Take Photo fails. Also listens for the permission changing
// live (e.g. the user answers the prompt after this first check already
// ran), so the banner doesn't get stuck once access is actually granted.
// The banner is about PERMISSION, not about whether a fix has come back
// yet -- those are different things. A live getCurrentPosition() call can
// take 15s or time out under canopy even with permission fully granted,
// which isn't an error worth a persistent red banner (handleCapture's
// per-photo status already reports that separately). Checking permission
// state directly is near-instant and doesn't depend on GPS hardware at
// all, so the banner reflects reality immediately instead of only after
// a slow poll happens to fail.
function checkLocationAvailability() {
  if (!navigator.geolocation) {
    locationPermission = "unsupported";
    showLocationBanner("This browser doesn't support device location.", "denied");
    return Promise.resolve();
  }
  if (window.isSecureContext === false) {
    locationPermission = "unsupported";
    showLocationBanner("Location only works on a secure (https) page.", "denied");
    return Promise.resolve();
  }
  if (!navigator.permissions || !navigator.permissions.query) {
    // Can't read permission state on this browser (e.g. older Safari) --
    // stay quiet rather than guess. The first Take Photo tap asks for
    // location anyway (see guardTakePhoto), so it's still requested up front.
    locationPermission = "unknown";
    hideLocationBanner();
    return Promise.resolve();
  }
  return navigator.permissions.query({ name: "geolocation" }).then(status => {
    const apply = () => {
      locationPermission = status.state;
      if (status.state === "denied") {
        showLocationBanner("Location permission is blocked for this site.", "denied");
      } else if (status.state === "prompt") {
        // Nothing has asked yet -- say so, with a button, instead of waiting
        // for a prompt to surface after the photo is already taken.
        showLocationBanner("Allow location so each photo can be tagged with the tree's position.", "prompt");
      } else {
        hideLocationBanner();
      }
    };
    apply();
    // Live: answering the prompt (or changing the site setting in another
    // tab) updates the banner and Take Photo immediately.
    status.onchange = apply;
  }).catch(() => {
    locationPermission = "unknown";
    hideLocationBanner();
  });
}

// Only one button on this screen is solid at a time: the one for the current
// step (Take Photo for the root, Take Photo for the trunk, Analyze, Save).
// The others are outlines. Only the classes change; every button keeps
// working whatever its style.
const STEP_CTA_IDS = ["root-camera-input", "trunk-camera-input", "analyze-btn", "save-submit-btn"];

function setPrimaryCta(activeId) {
  STEP_CTA_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    // The camera inputs sit inside a <label class="btn">; the label is the button.
    const btn = el.tagName === "INPUT" ? el.closest("label") : el;
    if (!btn) return;
    btn.classList.toggle("btn-primary", id === activeId);
    btn.classList.toggle("btn-outline-secondary", id !== activeId);
  });
}

// Advances the workflow strip, marking prior steps done and the given step active.
function setWorkflowStep(index) {
  for (let i = 0; i <= 4; i++) {
    const el = document.getElementById(`step-${i}`);
    if (!el) continue;
    el.classList.remove("active", "done");
    if (i < index) el.classList.add("done");
    if (i === index) el.classList.add("active");
  }
  setPrimaryCta(STEP_CTA_IDS[Math.min(index, STEP_CTA_IDS.length - 1)]);
}

// Resizes an image file so its longest edge is at most STORAGE_MAX_DIMENSION,
// respecting camera EXIF orientation via the browser's own decode, and
// returns a Promise<File> (WebP). Smaller source images are left as-is.
// Reads the CSRF token straight out of the save form's own hidden input,
// so the direct-upload requests below stay authenticated the same way
// the eventual form submission is, without depending on cookie settings.

// Asks Django for a short-lived presigned URL to PUT one image straight
// to cloud storage. kind is 'roots' or 'trunks'.
// size is the byte length about to be uploaded; the server signs it into
// the URL so the storage provider only accepts a PUT of exactly that size.
async function requestUploadUrl(kind, size) {
  const res = await fetch("/detection/upload-url/", {
    method: "POST",
    headers: {
      "X-CSRFToken": getCsrfToken(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ kind, size: String(size) }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Upload URL request failed (${res.status})`);
  }
  return res.json(); // { key, upload_url, expires_in }
}

// Uploads one already-resized WebP file straight to cloud storage and
// returns its object key. Throws if direct upload isn't available or the
// PUT itself fails -- callers fall back to the multipart file inputs.
//
// Keys are remembered per file object, so pressing Analyze again on the same
// photos reuses the object already in storage instead of uploading (and
// leaving behind) another copy every time.
const uploadedKeyByFile = new WeakMap();

async function uploadDirectly(file, kind) {
  if (uploadedKeyByFile.has(file)) return uploadedKeyByFile.get(file);
  const { key, upload_url } = await requestUploadUrl(kind, file.size);
  const putRes = await fetch(upload_url, {
    method: "PUT",
    headers: { "Content-Type": "image/webp" },
    body: file,
  });
  if (!putRes.ok) throw new Error("Direct upload to storage failed");
  uploadedKeyByFile.set(file, key);
  return key;
}

// Kicks off both direct uploads in the background. On success, fills the
// save form's hidden key fields and clears the file inputs (so the
// multipart submission doesn't also send the raw bytes through Django).
// On any failure -- cloud storage not configured, network error, etc --
// leaves the file inputs exactly as showResult() set them, so the
// original multipart upload path still works with no user-visible change.
function startDirectUploads() {
  directUploadPromise = Promise.all([
    uploadDirectly(rootImageFile, "roots"),
    uploadDirectly(trunkImageFile, "trunks"),
  ]).then(([rootKey, trunkKey]) => {
    document.getElementById("save-root-image-key").value = rootKey;
    document.getElementById("save-trunk-image-key").value = trunkKey;
    document.getElementById("save-root-image").value = "";
    document.getElementById("save-trunk-image").value = "";
  }).catch(() => {
    // Fall back silently -- file inputs already hold the resized images.
  });
}


// Picks the better of the root photo's and the trunk photo's location: the one
// with the smaller accuracy figure; a known accuracy beats an unknown one; a
// tie keeps the root. Either may be null (not captured yet).
function betterGps(rootFix, trunkFix) {
  if (!rootFix) return trunkFix;
  if (!trunkFix) return rootFix;
  const r = rootFix.accuracy, t = trunkFix.accuracy;
  if (t != null && (r == null || t < r)) return trunkFix;
  return rootFix;
}

// Resolves GPS from the original file (has to happen before resize, since
// redrawing onto a canvas strips all EXIF including GPS), resizes it, and
// only then accepts the capture -- rejecting outright if neither the
// photo's own EXIF nor a live device position could provide a location.
function handleCapture(file, { previewImgId, dropZoneId, kind, source }) {
  const dropZone = document.getElementById(dropZoneId);
  const previewImg = document.getElementById(previewImgId);
  const statusEl = document.getElementById(`${kind}-gps-status`);
  if (statusEl) { statusEl.textContent = "Checking location…"; statusEl.className = "text-muted text-sm-rg mt-1"; }
  console.log("[GPS DEBUG] handleCapture() start --", { kind, source, fileName: file && file.name, fileType: file && file.type, fileSize: file && file.size });

  Promise.all([resolveImageGPS(file, source), resizeImageFile(file)]).then(([gps, resizedFile]) => {
    console.log("[GPS DEBUG] Promise.all RESOLVED --", { gps, resizedFile: resizedFile && resizedFile.name });
    if (!gps || gps.error) {
      if (statusEl) {
        statusEl.textContent = (gps && gps.error) || "No location data found in this photo, and couldn't get your device's GPS either.";
        statusEl.className = "text-danger text-sm-rg mt-1";
      }
      checkLocationAvailability(); // a blocked permission should also show in the banner, not only in this one status line
      return; // reject: image is not accepted, existing state (if any) is untouched
    }
    if (gps.source === "device") {
      // A real device fix proves location is allowed right now. (An EXIF
      // location says nothing about the permission, so it doesn't count.)
      locationPermission = "granted";
      hideLocationBanner();
    }

    if (kind === "root") {
      rootImageFile = resizedFile;
      rootGPS = gps;
    } else {
      trunkImageFile = resizedFile;
      trunkGPS = gps;
    }
    if (statusEl) {
      const accuracyNote = gps.accuracy != null ? ` (±${Math.round(gps.accuracy)} m)` : "";
      statusEl.textContent = `📍 Location from ${gps.source === "exif" ? "photo" : "device"}${accuracyNote}`;
      statusEl.className = "text-main text-sm-rg mt-1";
    }

    // The tree gets one location. Root and trunk are shot moments apart at
    // the same tree, so whichever fix is more accurate is the better one;
    // on a tie (or when neither says) the root photo's wins, since it was
    // captured first. Refreshed every time either GPS resolves.
    const chosenGps = betterGps(rootGPS, trunkGPS);
    document.getElementById("save-lat").value = chosenGps.lat;
    document.getElementById("save-lng").value = chosenGps.lng;
    document.getElementById("save-gps-accuracy").value = chosenGps.accuracy != null ? chosenGps.accuracy : "";
    if (chosenGps.capturedAt) document.getElementById("save-captured-at").value = new Date(chosenGps.capturedAt).toISOString();

    previewImg.src = URL.createObjectURL(resizedFile);
    previewImg.style.display = "block";
    dropZone.classList.add("has-image");

    if (kind === "root") {
      // Root image captured first -- unlock the trunk capture step.
      setStepLocked(document.getElementById("trunk-zone-wrapper"), false);
      setWorkflowStep(1);
    } else {
      // Stays disabled if no model is configured -- see the banner
      // rendered in disease_detection.html instead of enabling a button
      // that would just error out.
      document.getElementById("analyze-btn").disabled = !window.AI_ENABLED;
      setWorkflowStep(2);
    }
  }).catch(err => {
    console.error("[GPS DEBUG] Promise.all REJECTED --", err);
    if (statusEl) {
      statusEl.textContent = (err && err.message) || "Couldn't process that image. Please try another photo.";
      statusEl.className = "text-danger text-sm-rg mt-1";
    }
  });
}


// Sends the two captured photos to the real AI model (views.analyze_detection)
// and shows its actual result. Root condition comes back from the same
// call -- assessed separately from trunk disease server-side, since
// exposed roots aren't one of the trained trunk disease classes (see the
// dynamic DiseaseClass catalog for what those are).
async function runAnalysis() {
  setWorkflowStep(2);
  const analyzeBtn = document.getElementById("analyze-btn");
  const errorBox = document.getElementById("analyze-error");
  errorBox.style.display = "none";
  analyzeBtn.disabled = true;
  analyzeBtn.innerHTML = '<i class="bi bi-hourglass-split"></i> Analyzing...';

  const formData = new FormData();
  formData.append("root_image", rootImageFile);
  formData.append("trunk_image", trunkImageFile);

  try {
    let res;
    try {
      res = await fetch("/detection/analyze/", {
        method: "POST",
        headers: { "X-CSRFToken": getCsrfToken() },
        body: formData,
        credentials: "same-origin",
      });
    } catch (networkErr) {
      // fetch() throwing (as opposed to resolving with a bad status) means
      // there's no network path right now. Analysis is a live call to the
      // AI model, so there's nothing to fall back to -- say so plainly.
      // Photos can be prepared without signal through Bulk Upload instead.
      throw new Error("Couldn't reach the server. Analysis needs a connection. Check your signal and try again, or use Bulk Upload to queue photos for later.");
    }
    // Session expired (or a stale CSRF token): Django bounces to /login/,
    // which fetch follows and hands back as HTML.
    if (res.redirected && /\/login\//.test(new URL(res.url).pathname)) {
      throw new Error("Your session expired. Log in again, then retake or re-select your photos.");
    }
    const data = await res.json().catch(() => { throw new Error("Analysis didn't work this time. Please try again."); });
    if (!res.ok) throw new Error(data.error || "Analysis didn't work this time. Please try again.");
    showResult(data.disease, data.confidence, data.root_condition, data.action, data.token);
    setWorkflowStep(3);
  } catch (err) {
    errorBox.textContent = err.message || "Analysis didn't work this time. Please try again.";
    errorBox.style.display = "";
    setWorkflowStep(1);
    setPrimaryCta("analyze-btn");   // both photos are still there: retrying the analysis is the next action
  } finally {
    analyzeBtn.disabled = false;
    analyzeBtn.innerHTML = '<i class="bi bi-cpu"></i> Analyze Images';
  }
}

// Populates and reveals the result panel, hides the class reference card,
// and fills the hidden save-form fields (including the two image files).
function showResult(disease, confidence, rootCondition, action, analysisToken) {
  document.getElementById("result-disease").textContent = disease;
  document.getElementById("result-conf").textContent = `${confidence}%`;
  document.getElementById("result-fill").style.width = `${confidence}%`;
  document.getElementById("result-action").textContent = action || "No recommendation on file for this result.";

  // Exposed roots are the one root result that takes colour (the danger pill);
  // anything else is plain text with a small neutral dot.
  const rootBadge = document.getElementById("result-root-condition");
  rootBadge.textContent = "";
  const rootLabel = document.createElement("span");
  if (rootCondition === "Exposed Roots Detected") {
    rootLabel.className = "pill-danger";
    rootLabel.textContent = rootCondition;
  } else {
    rootLabel.className = "disease-plain";
    const dot = document.createElement("span");
    dot.className = "dot-neutral";
    rootLabel.append(dot, document.createTextNode(rootCondition || "Not reported by model"));
  }
  rootBadge.appendChild(rootLabel);

  const badge = document.getElementById("threshold-badge-result");
  if (confidence >= 80) {
    badge.innerHTML = '<span class="threshold-badge threshold-confirmed"><i class="bi bi-check-circle-fill"></i> Confirmed Detection</span>';
  } else if (confidence >= 50) {
    badge.innerHTML = '<span class="threshold-badge threshold-review"><i class="bi bi-exclamation-circle-fill"></i> Manual Review Suggested</span>';
  } else {
    badge.innerHTML = '<span class="threshold-badge threshold-uncertain"><i class="bi bi-question-circle-fill"></i> Uncertain — Not a Reliable Classification</span>';
  }

  document.getElementById("save-disease").value = disease;
  document.getElementById("save-confidence").value = confidence;
  document.getElementById("save-root-condition").value = rootCondition;
  // Signed proof of this exact result for these exact photos; lets the
  // server save it without running the model a second time.
  document.getElementById("save-analysis-token").value = analysisToken || "";

  // Attach the two resized image files to the actual file inputs inside
  // the save form, so the normal multipart form submission uploads them.
  const rootInput = document.getElementById("save-root-image");
  const trunkInput = document.getElementById("save-trunk-image");
  const rootTransfer = new DataTransfer();
  rootTransfer.items.add(rootImageFile);
  rootInput.files = rootTransfer.files;
  const trunkTransfer = new DataTransfer();
  trunkTransfer.items.add(trunkImageFile);
  trunkInput.files = trunkTransfer.files;

  document.getElementById("result-box").style.display = "";
  document.getElementById("class-reference").style.display = "none";

  startDirectUploads();
}

function wireCaptureZone({ dropZoneId, fileInputId, cameraInputId, previewImgId, kind }) {
  const dropZone = document.getElementById(dropZoneId);
  const fileInput = document.getElementById(fileInputId);
  const cameraInput = cameraInputId ? document.getElementById(cameraInputId) : null;

  // Clicking the drop zone itself opens the camera when nothing's been
  // captured yet (the more likely intent while standing at a tree), and
  // re-opens the browse picker once an image is already showing (the more
  // likely intent there is "pick a different one"). Both explicit buttons
  // below remain available regardless, so this is just a helpful default.
  dropZone.addEventListener("click", () => {
    if (dropZone.classList.contains("step-locked")) return;
    if (cameraInput && !dropZone.classList.contains("has-image")) cameraInput.click();
    else fileInput.click();
  });
  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) handleCapture(fileInput.files[0], { previewImgId, dropZoneId, kind, source: "file" });
  });
  if (cameraInput) {
    // Fires for the Take Photo label tap AND for the drop zone's own
    // cameraInput.click() above -- one place that decides whether the
    // camera may open (online, location allowed).
    cameraInput.addEventListener("click", e => guardTakePhoto(e, kind));
    cameraInput.addEventListener("change", () => {
      if (cameraInput.files[0]) handleCapture(cameraInput.files[0], { previewImgId, dropZoneId, kind, source: "camera" });
    });
  }
  dropZone.addEventListener("dragover", e => {
    e.preventDefault();
    if (!dropZone.classList.contains("step-locked")) dropZone.classList.add("dragover");
  });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
  dropZone.addEventListener("drop", e => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    if (dropZone.classList.contains("step-locked")) return;
    // Drag-and-drop is also an existing file, same reasoning as Browse.
    if (e.dataTransfer.files[0]) handleCapture(e.dataTransfer.files[0], { previewImgId, dropZoneId, kind, source: "file" });
  });
}

// A locked step is dimmed by .step-locked (style.css) and, via `inert`,
// also removed from the tab order and the accessibility tree -- otherwise
// keyboard and screen-reader users could still reach its buttons.
function setStepLocked(el, locked) {
  if (!el) return;
  el.classList.toggle("step-locked", locked);
  el.toggleAttribute("inert", locked);
}

// Keeps Step 1 locked (see .step-locked in style.css) until a farm is
// picked -- a scan captured with no farm attached has nowhere to save
// to. Server-rendered initial state (see disease_detection.html) already
// covers the common case of a farm already selected app-wide; this just
// keeps it in sync as the person changes the dropdown.
function wireFarmGate() {
  const farmSelect = document.getElementById("save-farm-pk");
  const rootWrapper = document.getElementById("root-zone-wrapper");
  if (!farmSelect || !rootWrapper) return;
  const update = () => setStepLocked(rootWrapper, !farmSelect.value);
  farmSelect.addEventListener("change", update);
  update();
  // The trunk step starts locked in the markup; mirror that for keyboards.
  const trunkWrapper = document.getElementById("trunk-zone-wrapper");
  if (trunkWrapper && trunkWrapper.classList.contains("step-locked")) setStepLocked(trunkWrapper, true);
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("root-preview-img").style.display = "none";
  document.getElementById("trunk-preview-img").style.display = "none";
  wireFarmGate();
  wireCaptureZone({ dropZoneId: "root-drop-zone", fileInputId: "root-file-input", cameraInputId: "root-camera-input", previewImgId: "root-preview-img", kind: "root" });
  wireCaptureZone({ dropZoneId: "trunk-drop-zone", fileInputId: "trunk-file-input", cameraInputId: "trunk-camera-input", previewImgId: "trunk-preview-img", kind: "trunk" });
  document.getElementById("analyze-btn").addEventListener("click", runAnalysis);
  wireSaveSubmit();
  checkLocationAvailability();
  const locBanner = document.getElementById("location-banner");
  if (locBanner) locBanner.addEventListener("click", checkLocationAvailability);
  // The banner's own button asks for permission (a tap, so the browser
  // is allowed to show its prompt) rather than just re-reading the state.
  const locEnableBtn = document.getElementById("location-enable-btn");
  if (locEnableBtn) locEnableBtn.addEventListener("click", e => { e.stopPropagation(); requestLocationPermission(); });
  wireTreeIdPreview();
});

// Waits for the background direct uploads (if any are in flight) before
// actually submitting the save form, so a fast click right after the
// result appears can't race ahead of the uploads finishing.
function wireSaveSubmit() {
  const btn = document.getElementById("save-submit-btn");
  const form = document.getElementById("save-form");
  if (!btn || !form) return;

  const originalHtml = btn.innerHTML;

  btn.addEventListener("click", async () => {
    // form.submit() skips the browser's own validation, so a Tree ID the
    // server would reject (e.g. containing "/") is caught here first.
    const treeIdInput = document.getElementById("save-tree-id");
    if (treeIdInput && treeIdInput.value.trim() && !TREE_ID_PATTERN.test(treeIdInput.value.trim())) {
      treeIdInput.focus();
      wireTreeIdPreview.refresh && wireTreeIdPreview.refresh();
      return;
    }
    btn.disabled = true;
    btn.innerHTML = '<i class="bi bi-hourglass-split" aria-hidden="true"></i> Saving...';
    if (directUploadPromise) {
      await directUploadPromise;
    }
    form.submit();
  });

  // Coming back to this page with the Back button restores it from the
  // browser's cache with the button still stuck on "Saving...".
  window.addEventListener("pageshow", event => {
    if (event.persisted) {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
  });
}

// Shows the farmer what their typed tree code will actually be saved as
// (farm ID prefix + their code), matching the server-side prefixing in
// save_detection() -- so there's no surprise about why "T1" shows up in
// the inventory as "FARM-001-T1". Mirrors the server logic only for
// display; the server remains the source of truth for the real prefixing
// and uniqueness check.
// Same rule as the server (views._ID_RE): the ID goes into a URL, so no
// slashes, question marks, hashes or percent signs.
const TREE_ID_PATTERN = /^[\p{L}\p{N}_][\p{L}\p{N}_ .\-]*$/u;

function wireTreeIdPreview() {
  const farmSelect = document.getElementById("save-farm-pk");
  const treeIdInput = document.getElementById("save-tree-id");
  const previewEl = document.getElementById("tree-id-preview");
  if (!farmSelect || !treeIdInput || !previewEl) return;

  function update() {
    const farmId = farmSelect.selectedOptions[0]?.dataset.farmId || "";
    const code = treeIdInput.value.trim();
    if (code && !TREE_ID_PATTERN.test(code)) {
      previewEl.textContent = " — use only letters, numbers, spaces, dashes, dots and underscores";
      treeIdInput.setAttribute("aria-invalid", "true");
      return;
    }
    treeIdInput.removeAttribute("aria-invalid");
    if (!farmId || !code) {
      previewEl.textContent = "";
      return;
    }
    const finalId = code.startsWith(`${farmId}-`) ? code : `${farmId}-${code}`;
    previewEl.textContent = ` — will be saved as "${finalId}"`;
  }

  wireTreeIdPreview.refresh = update;
  farmSelect.addEventListener("change", update);
  treeIdInput.addEventListener("input", update);
}
