/* Edge detection, perspective correction and filters.
   Uses jscanify on top of OpenCV.js. OpenCV (9 MB) is loaded lazily so the
   UI appears immediately; the service worker caches it after the first load. */
const Scanner = (() => {
  let loadPromise = null;
  let ready = false;
  let scanner = null;
  const DETECT_SIDE = 600; // detection runs on a small copy for speed

  function load(onStatus) {
    if (loadPromise) return loadPromise;
    loadPromise = new Promise((resolve, reject) => {
      onStatus && onStatus('Loading scanner engine…');
      const s = document.createElement('script');
      s.src = './lib/opencv.js';
      s.async = true;
      s.onload = async () => {
        try {
          const mod = window.cv;
          if (mod && !mod.Mat) {
            // The Emscripten build exposes a legacy `then` that resolves to itself;
            // `await mod` would loop forever, so call it once by hand.
            await new Promise((resolve) => {
              if (typeof mod.then === 'function') mod.then(() => resolve());
              else mod.onRuntimeInitialized = resolve;
            });
          }
          window.cv = mod;
          scanner = new jscanify();
          ready = true;
          onStatus && onStatus('');
          resolve();
        } catch (e) { reject(e); }
      };
      s.onerror = () => reject(new Error('Could not load OpenCV'));
      document.head.appendChild(s);
    });
    return loadPromise;
  }

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  function fullCorners(w, h) {
    return { tl: { x: 0, y: 0 }, tr: { x: w, y: 0 }, br: { x: w, y: h }, bl: { x: 0, y: h } };
  }

  function polygonArea(c) {
    const p = [c.tl, c.tr, c.br, c.bl];
    let a = 0;
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      a += p[i].x * p[j].y - p[j].x * p[i].y;
    }
    return Math.abs(a) / 2;
  }

  /* Detect the page corners in a canvas. Returns {tl,tr,br,bl} in canvas
     pixel coordinates, or null when nothing plausible was found. */
  function detect(canvas) {
    if (!ready) return null;
    const scale = Math.max(canvas.width, canvas.height) > DETECT_SIDE
      ? DETECT_SIDE / Math.max(canvas.width, canvas.height) : 1;
    const small = scale < 1 ? Imaging.copyCanvas(canvas, DETECT_SIDE) : canvas;
    let img = null, contour = null;
    try {
      img = cv.imread(small);
      contour = scanner.findPaperContour(img);
      if (!contour) return null;
      const p = scanner.getCornerPoints(contour);
      if (!p.topLeftCorner || !p.topRightCorner || !p.bottomRightCorner || !p.bottomLeftCorner) return null;
      const inv = 1 / scale;
      const corners = {
        tl: { x: p.topLeftCorner.x * inv, y: p.topLeftCorner.y * inv },
        tr: { x: p.topRightCorner.x * inv, y: p.topRightCorner.y * inv },
        br: { x: p.bottomRightCorner.x * inv, y: p.bottomRightCorner.y * inv },
        bl: { x: p.bottomLeftCorner.x * inv, y: p.bottomLeftCorner.y * inv },
      };
      // Reject tiny or degenerate quads: a page should fill a good part of the frame.
      const area = polygonArea(corners);
      if (area < 0.12 * canvas.width * canvas.height) return null;
      const minSide = Math.min(dist(corners.tl, corners.tr), dist(corners.tr, corners.br),
        dist(corners.br, corners.bl), dist(corners.bl, corners.tl));
      if (minSide < 0.15 * Math.min(canvas.width, canvas.height)) return null;
      return corners;
    } catch (e) {
      return null;
    } finally {
      if (contour) contour.delete();
      if (img) img.delete();
      if (small !== canvas) Imaging.release(small);
    }
  }

  /* Crop + flatten the quad into a straight rectangle. */
  function warp(canvas, corners, maxSide = Imaging.MAX_SIDE) {
    const wTop = dist(corners.tl, corners.tr), wBot = dist(corners.bl, corners.br);
    const hL = dist(corners.tl, corners.bl), hR = dist(corners.tr, corners.br);
    let w = Math.max(wTop, wBot), h = Math.max(hL, hR);
    const s = Math.min(1, maxSide / Math.max(w, h));
    w = Math.max(16, Math.round(w * s));
    h = Math.max(16, Math.round(h * s));
    return scanner.extractPaper(canvas, w, h, {
      topLeftCorner: corners.tl,
      topRightCorner: corners.tr,
      bottomLeftCorner: corners.bl,
      bottomRightCorner: corners.br,
    });
  }

  /* Apply a filter in place: 'original' | 'grey' | 'bw'. */
  function applyFilter(canvas, filter) {
    if (filter === 'original' || !ready) return canvas;
    const src = cv.imread(canvas);
    const gray = new cv.Mat();
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      if (filter === 'grey') {
        // Mild contrast stretch so the paper looks white and the text dark.
        cv.normalize(gray, gray, 0, 255, cv.NORM_MINMAX);
        cv.imshow(canvas, gray);
      } else if (filter === 'bw') {
        const blurred = new cv.Mat();
        const out = new cv.Mat();
        try {
          cv.GaussianBlur(gray, blurred, new cv.Size(3, 3), 0);
          let block = Math.round(Math.max(canvas.width, canvas.height) / 40);
          block = Math.min(75, Math.max(15, block)) | 1;       // odd, 15..75
          cv.adaptiveThreshold(blurred, out, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, block, 12);
          cv.medianBlur(out, out, 3);                          // remove speckles
          cv.imshow(canvas, out);
        } finally { blurred.delete(); out.delete(); }
      }
    } finally {
      src.delete(); gray.delete();
    }
    return canvas;
  }

  return {
    load,
    get ready() { return ready; },
    detect, warp, applyFilter, fullCorners,
  };
})();
