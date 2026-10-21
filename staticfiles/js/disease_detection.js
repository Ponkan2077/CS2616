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

// One-shot read of the device's current position, promisified. Used as a
// fallback when a photo has no EXIF GPS of its own (see resolveImageGPS
// below), and to trigger the browser's permission prompt up front (see
// requestLocationPermission below).
//
// Returns { lat, lng, source: "device" } on success, or null with a
// human-readable reason on failure -- distinguishing "you denied the
// permission prompt" from "GPS hardware couldn't get a fix in time" matters
// a lot in the field (e.g. under rubber tree canopy), since the fix for
// each is completely different.
function getDeviceGPS() {
  console.log("[GPS DEBUG] getDeviceGPS() called. navigator.geolocation present:", !!navigator.geolocation);
  // Fire-and-forget permission read, purely for diagnostics -- doesn't
  // block or change the actual getCurrentPosition() call below.
  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: "geolocation" })
      .then(status => console.log("[GPS DEBUG] permission state at call time:", status.state))
      .catch(permErr => console.log("[GPS DEBUG] permission query failed:", permErr));
  }
  return new Promise(resolve => {
    if (!navigator.geolocation) { console.log("[GPS DEBUG] no navigator.geolocation -- resolving with error immediately"); resolve({ error: "This browser doesn't support device location." }); return; }
    const startedAt = Date.now();
    console.log("[GPS DEBUG] calling getCurrentPosition at", new Date(startedAt).toISOString());
    navigator.geolocation.getCurrentPosition(
      pos => {
        console.log("[GPS DEBUG] getCurrentPosition SUCCESS after", Date.now() - startedAt, "ms", pos.coords);
        resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, source: "device", capturedAt: Date.now() });
      },
      err => {
        console.warn("[GPS DEBUG] getCurrentPosition ERROR after", Date.now() - startedAt, "ms -- code:", err.code, "message:", err.message);
        const reasons = {
          1: "Location access is blocked. Check two settings: the site permission (tap the location icon in your address bar) and your browser app's own OS permission (Android: Settings → Apps → Chrome → Permissions → Location) -- granting one without the other still fails.",
          2: "Couldn't get a GPS fix. Try moving to open sky, away from thick canopy or buildings.",
          3: "GPS location timed out. Try again, ideally with a clearer view of the sky.",
        };
        resolve({ error: reasons[err.code] || "Couldn't get your device's location.", code: err.code });
      },
      // 15s (not the default 3 typical minimum) since a fix can genuinely
      // take longer under rubber tree canopy; maximumAge lets the trunk
      // photo reuse a fix from moments ago (root photo) instead of
      // re-polling GPS hardware and making the farmer wait twice.
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
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
// Returns { lat, lng, source } on success, or { error } on failure --
// never plain null, so the caller always has something to show the user.
async function resolveImageGPS(file, source) {
  console.log("[GPS DEBUG] resolveImageGPS() start -- source:", source, "file:", file && file.name, file && file.type, file && file.size, "bytes");
  const exifGps = await extractGPSFromFile(file);
  console.log("[GPS DEBUG] extractGPSFromFile() returned:", exifGps);
  if (exifGps) return exifGps;
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
  const result = await getDeviceGPS(); // this call is what raises the browser's prompt
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

// Starts the GPS hardware warming up the moment Take Photo is tapped, so
// the fix is usually already there when the camera returns instead of the
// farmer waiting on it afterwards. The result is discarded here -- the
// browser caches it, and getDeviceGPS()'s maximumAge reuses it.
let lastGpsWarmUp = 0;
function warmUpGps() {
  if (!navigator.geolocation || Date.now() - lastGpsWarmUp < 10000) return;
  lastGpsWarmUp = Date.now();
  navigator.geolocation.getCurrentPosition(() => {}, () => {}, { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 });
}

function setCaptureStatus(kind, message, cssClass) {
  const statusEl = document.getElementById(`${kind}-gps-status`);
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.className = `${cssClass || "text-muted"} mt-1`;
  statusEl.style.fontSize = "11px";
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
        setCaptureStatus(kind, "Location is on. Tap Take Photo again.", "text-healthy");
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

// Advances the workflow strip, marking prior steps done and the given step active.
function setWorkflowStep(index) {
  for (let i = 0; i <= 4; i++) {
    const el = document.getElementById(`step-${i}`);
    if (!el) continue;
    el.classList.remove("active", "done");
    if (i < index) el.classList.add("done");
    if (i === index) el.classList.add("active");
  }
}

// Resizes an image file so its longest edge is at most STORAGE_MAX_DIMENSION,
// respecting camera EXIF orientation via the browser's own decode, and
// returns a Promise<File> (WebP). Smaller source images are left as-is.
// Reads the CSRF token straight out of the save form's own hidden input,
// so the direct-upload requests below stay authenticated the same way
// the eventual form submission is, without depending on cookie settings.

// Asks Django for a short-lived presigned URL to PUT one image straight
// to cloud storage. kind is 'roots' or 'trunks'.
async function requestUploadUrl(kind) {
  const res = await fetch("/detection/upload-url/", {
    method: "POST",
    headers: {
      "X-CSRFToken": getCsrfToken(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ kind }),
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
async function uploadDirectly(file, kind) {
  const { key, upload_url } = await requestUploadUrl(kind);
  const putRes = await fetch(upload_url, {
    method: "PUT",
    headers: { "Content-Type": "image/webp" },
    body: file,
  });
  if (!putRes.ok) throw new Error("Direct upload to storage failed");
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


// Resolves GPS from the original file (has to happen before resize, since
// redrawing onto a canvas strips all EXIF including GPS), resizes it, and
// only then accepts the capture -- rejecting outright if neither the
// photo's own EXIF nor a live device position could provide a location.
function handleCapture(file, { previewImgId, dropZoneId, kind, source }) {
  const dropZone = document.getElementById(dropZoneId);
  const previewImg = document.getElementById(previewImgId);
  const statusEl = document.getElementById(`${kind}-gps-status`);
  if (statusEl) { statusEl.textContent = "Checking location…"; statusEl.className = "text-muted mt-1"; statusEl.style.fontSize = "11px"; }
  console.log("[GPS DEBUG] handleCapture() start --", { kind, source, fileName: file && file.name, fileType: file && file.type, fileSize: file && file.size });

  Promise.all([resolveImageGPS(file, source), resizeImageFile(file)]).then(([gps, resizedFile]) => {
    console.log("[GPS DEBUG] Promise.all RESOLVED --", { gps, resizedFile: resizedFile && resizedFile.name });
    if (!gps || gps.error) {
      if (statusEl) {
        statusEl.textContent = (gps && gps.error) || "No location data found in this photo, and couldn't get your device's GPS either.";
        statusEl.className = "text-danger mt-1";
        statusEl.style.fontSize = "11px";
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
      statusEl.textContent = `📍 Location from ${gps.source === "exif" ? "photo" : "device"}`;
      statusEl.className = "text-healthy mt-1";
      statusEl.style.fontSize = "11px";
    }

    // The tree gets one location -- prefer the root photo's, since
    // root and trunk are shot moments apart at the same tree and root is
    // captured first. Refreshed every time either GPS resolves, so
    // whichever was captured most recently is reflected immediately.
    const chosenGps = rootGPS || trunkGPS;
    document.getElementById("save-lat").value = chosenGps.lat;
    document.getElementById("save-lng").value = chosenGps.lng;
    if (chosenGps.capturedAt) document.getElementById("save-captured-at").value = new Date(chosenGps.capturedAt).toISOString();

    previewImg.src = URL.createObjectURL(resizedFile);
    previewImg.style.display = "block";
    dropZone.classList.add("has-image");

    if (kind === "root") {
      // Root image captured first -- unlock the trunk capture step.
      document.getElementById("trunk-zone-wrapper").classList.remove("step-locked");
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
      statusEl.className = "text-danger mt-1";
      statusEl.style.fontSize = "11px";
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
    const data = await res.json().catch(() => { throw new Error(`Analysis failed (${res.status}). Please try again.`); });
    if (!res.ok) throw new Error(data.error || `Analysis failed (${res.status})`);
    showResult(data.disease, data.confidence, data.root_condition, data.action);
    setWorkflowStep(3);
  } catch (err) {
    errorBox.textContent = err.message || "Analysis failed. Please try again.";
    errorBox.style.display = "";
    setWorkflowStep(1);
  } finally {
    analyzeBtn.disabled = false;
    analyzeBtn.innerHTML = '<i class="bi bi-cpu"></i> Analyze Images';
  }
}

// Populates and reveals the result panel, hides the class reference card,
// and fills the hidden save-form fields (including the two image files).
function showResult(disease, confidence, rootCondition, action) {
  document.getElementById("result-disease").textContent = disease;
  document.getElementById("result-conf").textContent = `${confidence}%`;
  document.getElementById("result-fill").style.width = `${confidence}%`;
  document.getElementById("result-action").textContent = action || "No recommendation on file for this result.";

  const rootBadge = document.getElementById("result-root-condition");
  rootBadge.textContent = rootCondition || "Not reported by model";
  rootBadge.className = rootCondition === "Exposed Roots Detected"
    ? "fw-bold mt-1 text-pink" : "fw-bold mt-1 text-healthy";

  const badge = document.getElementById("threshold-badge-result");
  if (confidence >= 80) {
    badge.innerHTML = '<span class="threshold-badge threshold-confirmed"><i class="bi bi-check-circle-fill"></i> Confirmed Detection</span>';
  } else if (confidence >= 50) {
    badge.innerHTML = '<span class="threshold-badge threshold-review"><i class="bi bi-exclamation-circle-fill"></i> Manual Review Suggested</span>';
  } else {
    badge.innerHTML = '<span class="threshold-badge" style="background:rgba(248,113,113,.15);color:#f87171;border:1px solid rgba(248,113,113,.35);"><i class="bi bi-question-circle-fill"></i> Uncertain — Not a Reliable Classification</span>';
  }

  document.getElementById("save-disease").value = disease;
  document.getElementById("save-confidence").value = confidence;
  document.getElementById("save-root-condition").value = rootCondition;

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

// Keeps Step 1 locked (see .step-locked in style.css) until a farm is
// picked -- a scan captured with no farm attached has nowhere to save
// to. Server-rendered initial state (see disease_detection.html) already
// covers the common case of a farm already selected app-wide; this just
// keeps it in sync as the person changes the dropdown.
function wireFarmGate() {
  const farmSelect = document.getElementById("save-farm-pk");
  const rootWrapper = document.getElementById("root-zone-wrapper");
  if (!farmSelect || !rootWrapper) return;
  const update = () => rootWrapper.classList.toggle("step-locked", !farmSelect.value);
  farmSelect.addEventListener("change", update);
  update();
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

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const originalHtml = btn.innerHTML;
    btn.innerHTML = '<i class="bi bi-hourglass-split"></i> Saving...';
    if (directUploadPromise) {
      await directUploadPromise;
    }
    form.submit();
  });
}

// Shows the farmer what their typed tree code will actually be saved as
// (farm ID prefix + their code), matching the server-side prefixing in
// save_detection() -- so there's no surprise about why "T1" shows up in
// the inventory as "FARM-001-T1". Mirrors the server logic only for
// display; the server remains the source of truth for the real prefixing
// and uniqueness check.
function wireTreeIdPreview() {
  const farmSelect = document.getElementById("save-farm-pk");
  const treeIdInput = document.getElementById("save-tree-id");
  const previewEl = document.getElementById("tree-id-preview");
  if (!farmSelect || !treeIdInput || !previewEl) return;

  function update() {
    const farmId = farmSelect.selectedOptions[0]?.dataset.farmId || "";
    const code = treeIdInput.value.trim();
    if (!farmId || !code) {
      previewEl.textContent = "";
      return;
    }
    const finalId = code.startsWith(`${farmId}-`) ? code : `${farmId}-${code}`;
    previewEl.textContent = ` — will be saved as "${finalId}"`;
  }

  farmSelect.addEventListener("change", update);
  treeIdInput.addEventListener("input", update);
}
