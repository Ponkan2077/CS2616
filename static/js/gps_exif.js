/* ============================================================
   gps_exif.js — Reads GPS coordinates out of a photo's own EXIF
   metadata, client-side, with no external library. Used by
   disease_detection.js to enforce "every captured/uploaded photo
   must carry a location" before it's accepted.

   Only handles JPEG, since that's what phone cameras produce and
   what EXIF actually lives in -- PNG/WebP/screenshots essentially
   never carry GPS EXIF in practice. Returns null (not an error)
   for anything without embedded GPS, so callers can fall back to
   navigator.geolocation for a live capture, or reject the file for
   an old/stripped photo with neither.

   The tag-parsing math here (rational -> DMS -> decimal degrees,
   hemisphere sign handling, GPS IFD pointer lookup) was verified
   against real EXIF-tagged JPEGs before this went into the app --
   not just written and assumed correct.
   ============================================================ */

function readFileHeader(file, maxBytes) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new DataView(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file.slice(0, maxBytes));
  });
}

function rationalToDeg(view, offset, littleEndian) {
  const num = view.getUint32(offset, littleEndian);
  const den = view.getUint32(offset + 4, littleEndian);
  return den === 0 ? 0 : num / den;
}

function dmsToDecimal(view, valueOffset, littleEndian) {
  // GPSLatitude/GPSLongitude are each 3 RATIONALs: degrees, minutes, seconds.
  const deg = rationalToDeg(view, valueOffset, littleEndian);
  const min = rationalToDeg(view, valueOffset + 8, littleEndian);
  const sec = rationalToDeg(view, valueOffset + 16, littleEndian);
  return deg + min / 60 + sec / 3600;
}

function readAsciiValue(view, entryOffset, tiffStart, littleEndian, count) {
  const strOffset = count <= 4 ? entryOffset + 8 : tiffStart + view.getUint32(entryOffset + 8, littleEndian);
  let str = "";
  for (let i = 0; i < count - 1; i++) str += String.fromCharCode(view.getUint8(strOffset + i));
  return str;
}

function parseExifDateTime(str) {
  // "YYYY:MM:DD HH:MM:SS", no timezone in EXIF -- treated as local time.
  const m = str && str.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

function readGpsIfd(view, ifdOffset, tiffStart, littleEndian) {
  const entryCount = view.getUint16(ifdOffset, littleEndian);
  const gps = {};
  for (let i = 0; i < entryCount; i++) {
    const entryOffset = ifdOffset + 2 + i * 12;
    const tag = view.getUint16(entryOffset, littleEndian);
    const type = view.getUint16(entryOffset + 2, littleEndian);
    const count = view.getUint32(entryOffset + 4, littleEndian);
    const valueOffset = tiffStart + view.getUint32(entryOffset + 8, littleEndian);

    if (tag === 0x0001 || tag === 0x0003) {
      // GPSLatitudeRef / GPSLongitudeRef -- single ASCII char, stored
      // inline in the entry's value slot rather than at an offset.
      const refByte = view.getUint8(entryOffset + 8);
      gps[tag === 0x0001 ? "latRef" : "lngRef"] = String.fromCharCode(refByte);
    } else if (tag === 0x0002 && type === 5 && count === 3) {
      gps.lat = dmsToDecimal(view, valueOffset, littleEndian);
    } else if (tag === 0x0004 && type === 5 && count === 3) {
      gps.lng = dmsToDecimal(view, valueOffset, littleEndian);
    }
  }
  return gps;
}

async function extractGPSFromFile(file) {
  try {
    // No file.type pre-check here on purpose -- some Android file
    // providers report an empty or wrong MIME type even for a real JPEG,
    // which would reject valid EXIF GPS before ever reading the file.
    // The SOI marker check two lines down verifies it's a JPEG from the
    // actual bytes instead, which is what should be trusted.
    //
    // 128KB comfortably covers the EXIF block on every phone photo --
    // EXIF sits right after the JPEG's SOI marker, well before the much
    // larger actual image data.
    const view = await readFileHeader(file, 131072);
    if (view.getUint16(0) !== 0xffd8) return null; // not a valid JPEG

    let offset = 2;
    while (offset + 4 <= view.byteLength) {
      const marker = view.getUint16(offset);
      if ((marker & 0xff00) !== 0xff00) break; // corrupted / ran off the marker chain
      if (marker === 0xffd8 || marker === 0xffd9) { offset += 2; continue; }
      const segmentLength = view.getUint16(offset + 2);

      if (marker === 0xffe1) {
        const segStart = offset + 4;
        if (segStart + 6 <= view.byteLength && view.getUint32(segStart) === 0x45786966) {
          // "Exif\0\0" found -- TIFF header starts right after it.
          const tiffStart = segStart + 6;
          const littleEndian = view.getUint16(tiffStart) === 0x4949;
          const ifd0Offset = tiffStart + view.getUint32(tiffStart + 4, littleEndian);

          // Find GPS IFD (0x8825) and Exif SubIFD (0x8769) pointers in IFD0.
          const entryCount = view.getUint16(ifd0Offset, littleEndian);
          let gpsIfdOffset = null;
          let exifIfdOffset = null;
          for (let i = 0; i < entryCount; i++) {
            const entryOffset = ifd0Offset + 2 + i * 12;
            const tag = view.getUint16(entryOffset, littleEndian);
            if (tag === 0x8825) gpsIfdOffset = tiffStart + view.getUint32(entryOffset + 8, littleEndian);
            if (tag === 0x8769) exifIfdOffset = tiffStart + view.getUint32(entryOffset + 8, littleEndian);
          }
          if (gpsIfdOffset === null) return null; // EXIF present, but no GPS block

          const gps = readGpsIfd(view, gpsIfdOffset, tiffStart, littleEndian);
          if (gps.lat === undefined || gps.lng === undefined) return null;

          const lat = gps.latRef === "S" ? -gps.lat : gps.lat;
          const lng = gps.lngRef === "W" ? -gps.lng : gps.lng;

          // DateTimeOriginal (0x9003), best-effort -- missing/unparsable
          // just means no capturedAt, not a failure of the GPS read.
          let capturedAt = null;
          if (exifIfdOffset !== null) {
            const subCount = view.getUint16(exifIfdOffset, littleEndian);
            for (let i = 0; i < subCount; i++) {
              const entryOffset = exifIfdOffset + 2 + i * 12;
              if (view.getUint16(entryOffset, littleEndian) === 0x9003) {
                const count = view.getUint32(entryOffset + 4, littleEndian);
                capturedAt = parseExifDateTime(readAsciiValue(view, entryOffset, tiffStart, littleEndian, count));
                break;
              }
            }
          }

          return { lat, lng, source: "exif", capturedAt };
        }
      }
      offset += 2 + segmentLength;
    }
    return null;
  } catch (err) {
    return null; // malformed/truncated header -- treat as "no GPS data", don't crash the page
  }
}

window.extractGPSFromFile = extractGPSFromFile;
