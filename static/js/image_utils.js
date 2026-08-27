// Images are stored at up to this size on the longest edge -- separate
// from whatever input size a future trained CNN normalizes to (e.g.
// 224x224), which would happen right before inference, not at capture time.
const STORAGE_MAX_DIMENSION = 1080;
const STORAGE_WEBP_QUALITY = 0.85;

function resizeImageFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      let { width, height } = img;
      const longestEdge = Math.max(width, height);
      if (longestEdge > STORAGE_MAX_DIMENSION) {
        const scale = STORAGE_MAX_DIMENSION / longestEdge;
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);

      const finish = (blob, mimeType, ext) => {
        if (!blob) { reject(new Error("Couldn't process this image. Try a different photo.")); return; }
        const resizedName = file.name.replace(/\.[^.]+$/, "") + ext;
        resolve(new File([blob], resizedName, { type: mimeType }));
      };

      // WebP first for smaller uploads. If this browser/WebView can't
      // encode it, toBlob calls back with null rather than throwing --
      // fall back to JPEG instead of failing the whole capture over it.
      canvas.toBlob(blob => {
        if (blob) { finish(blob, "image/webp", ".webp"); return; }
        canvas.toBlob(jpegBlob => finish(jpegBlob, "image/jpeg", ".jpg"), "image/jpeg", STORAGE_WEBP_QUALITY);
      }, "image/webp", STORAGE_WEBP_QUALITY);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Couldn't read this image -- it may be corrupted or in a format this browser can't decode (e.g. HEIC)."));
    };
    img.src = objectUrl;
  });
}
