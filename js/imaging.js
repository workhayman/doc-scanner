/* Canvas / image helpers. Photos are kept at the camera's full resolution
   (up to 12 MP, 4032 px) and flattened pages at up to A4 / 300 dpi
   (3508 px), which is about the most Safari on iPhone handles comfortably. */
const Imaging = (() => {
  const MAX_SIDE = 4032;
  const PAGE_SIDE = 3508;

  function createCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  /* Free the memory a canvas holds (important on iOS). */
  function release(canvas) {
    if (!canvas) return;
    canvas.width = 0;
    canvas.height = 0;
  }

  function fitScale(w, h, maxSide) {
    const m = Math.max(w, h);
    return m > maxSide ? maxSide / m : 1;
  }

  function drawScaled(source, sw, sh, maxSide) {
    const s = fitScale(sw, sh, maxSide);
    const c = createCanvas(sw * s, sh * s);
    const ctx = c.getContext('2d');
    ctx.drawImage(source, 0, 0, c.width, c.height);
    return c;
  }

  function loadImageElement(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read image')); };
      img.src = url;
    });
  }

  /* Decode a photo (File/Blob) into a canvas no larger than maxSide,
     honouring the EXIF rotation stored by the phone camera. */
  async function blobToCanvas(blob, maxSide = MAX_SIDE) {
    if (typeof createImageBitmap === 'function') {
      try {
        const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
        const c = drawScaled(bmp, bmp.width, bmp.height, maxSide);
        bmp.close && bmp.close();
        return c;
      } catch (e) {
        /* fall through to <img> decoding */
      }
    }
    const img = await loadImageElement(blob);
    const c = drawScaled(img, img.naturalWidth, img.naturalHeight, maxSide);
    img.src = '';
    return c;
  }

  function videoToCanvas(video, maxSide = MAX_SIDE) {
    return drawScaled(video, video.videoWidth, video.videoHeight, maxSide);
  }

  function copyCanvas(src, maxSide) {
    return drawScaled(src, src.width, src.height, maxSide || Math.max(src.width, src.height));
  }

  function rotate90(src) {
    const c = createCanvas(src.height, src.width);
    const ctx = c.getContext('2d');
    ctx.translate(c.width, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(src, 0, 0);
    return c;
  }

  function toBlob(canvas, type = 'image/jpeg', quality = 0.85) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), type, quality);
    });
  }

  function toDataURL(canvas, quality = 0.6) {
    return canvas.toDataURL('image/jpeg', quality);
  }

  return { MAX_SIDE, PAGE_SIDE, createCanvas, release, blobToCanvas, videoToCanvas, copyCanvas, rotate90, toBlob, toDataURL };
})();
