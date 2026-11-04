/* Page detection, perspective correction and filters, on top of OpenCV.js.
   OpenCV (9 MB) is loaded lazily so the UI appears immediately; the service
   worker caches it after the first load.

   Detection works in two stages:
   1. Find candidate four-sided shapes in a small copy of the image, using
      several edge/threshold maps (so a white page on a light desk, a page on
      wood grain and a page in a shadow all get a fair chance), and keep the
      candidate whose sides best follow real edges.
   2. Refine every side on the full-resolution image: sample the edge at many
      points, fit a straight line through them and intersect neighbouring
      lines. That puts the corners within a pixel or two of the paper edge. */
const Scanner = (() => {
  let loadPromise = null;
  let ready = false;
  const DETECT_SIDE = 900;      // still photos
  const LIVE_SIDE = 420;        // live camera preview

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

  /* ---------- small geometry helpers ---------- */
  const KEYS = ['tl', 'tr', 'br', 'bl'];
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function odd(n) { n = Math.max(1, Math.round(n)); return n % 2 ? n : n + 1; }

  function fullCorners(w, h) {
    return { tl: { x: 0, y: 0 }, tr: { x: w, y: 0 }, br: { x: w, y: h }, bl: { x: 0, y: h } };
  }

  function polygonArea(p) {
    let a = 0;
    for (let i = 0; i < p.length; i++) {
      const j = (i + 1) % p.length;
      a += p[i].x * p[j].y - p[j].x * p[i].y;
    }
    return Math.abs(a) / 2;
  }

  /* Put 4 points in tl, tr, br, bl order. */
  function orderPoints(pts) {
    const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
    const cy = pts.reduce((s, p) => s + p.y, 0) / 4;
    const sorted = pts.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
    // sorted clockwise (screen coords) starting near -180°; rotate so the
    // point with the smallest x+y comes first.
    let start = 0;
    for (let i = 1; i < 4; i++) if (sorted[i].x + sorted[i].y < sorted[start].x + sorted[start].y) start = i;
    const o = [0, 1, 2, 3].map((i) => sorted[(start + i) % 4]);
    return { tl: o[0], tr: o[1], br: o[2], bl: o[3] };
  }

  function scaleCorners(c, k) {
    const out = {};
    KEYS.forEach((key) => { out[key] = { x: c[key].x * k, y: c[key].y * k }; });
    return out;
  }

  /* Largest |cos| of the four interior angles: 0 for a perfect rectangle. */
  function maxCos(p) {
    let m = 0;
    for (let i = 0; i < 4; i++) {
      const a = p[(i + 3) % 4], b = p[i], c = p[(i + 1) % 4];
      const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
      const cos = Math.abs((v1x * v2x + v1y * v2y) / (Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) + 1e-9));
      m = Math.max(m, cos);
    }
    return m;
  }

  /* ---------- stage 1: candidate quads ---------- */

  function quadsFromBinary(bin, W, H, out) {
    const contours = new cv.MatVector();
    const hier = new cv.Mat();
    try {
      cv.findContours(bin, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      const minArea = 0.08 * W * H;
      for (let i = 0; i < contours.size(); i++) {
        const c = contours.get(i);
        const hull = new cv.Mat();
        const approx = new cv.Mat();
        try {
          cv.convexHull(c, hull, false, true);
          if (cv.contourArea(hull) < minArea) continue;
          const peri = cv.arcLength(hull, true);
          for (const eps of [0.01, 0.02, 0.035, 0.05, 0.08]) {
            cv.approxPolyDP(hull, approx, eps * peri, true);
            if (approx.rows === 4) {
              const d = approx.data32S;
              out.push([0, 1, 2, 3].map((k) => ({ x: d[2 * k], y: d[2 * k + 1] })));
              break;
            }
            if (approx.rows < 4) break;
          }
        } finally { c.delete(); hull.delete(); approx.delete(); }
      }
    } finally { contours.delete(); hier.delete(); }
  }

  /* How much of each side lies on an edge pixel (0..1). Sides that run along
     the picture border count as half-supported, so a page that is cut off by
     the frame can still win. */
  function sideSupport(edges, W, H, a, b) {
    const m = 3;
    const onBorder = (Math.abs(a.x) < m && Math.abs(b.x) < m) || (Math.abs(a.y) < m && Math.abs(b.y) < m)
      || (Math.abs(a.x - (W - 1)) < m && Math.abs(b.x - (W - 1)) < m) || (Math.abs(a.y - (H - 1)) < m && Math.abs(b.y - (H - 1)) < m);
    if (onBorder) return { s: 0.5, border: true };
    const n = Math.max(12, Math.round(dist(a, b) / 3));
    const data = edges.data;
    let hit = 0, total = 0;
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const x = Math.round(a.x + (b.x - a.x) * t), y = Math.round(a.y + (b.y - a.y) * t);
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      total++;
      if (data[y * W + x]) hit++;
    }
    return { s: total ? hit / total : 0, border: false };
  }

  function scoreQuad(pts, edges, W, H) {
    const area = polygonArea(pts) / (W * H);
    if (area < 0.08 || area > 0.995) return -1;
    const mc = maxCos(pts);
    if (mc > 0.6) return -1;                      // angles must be 53°..127°
    let sum = 0, min = 1, borders = 0;
    for (let i = 0; i < 4; i++) {
      const r = sideSupport(edges, W, H, pts[i], pts[(i + 1) % 4]);
      sum += r.s; min = Math.min(min, r.s); if (r.border) borders++;
    }
    if (borders > 2 || min < 0.25) return -1;
    const support = sum / 4;
    return Math.sqrt(area) * support * support * (1 - 0.5 * mc) * (0.6 + 0.4 * min);
  }

  /* Detect the page in a small canvas. Returns ordered corners in that
     canvas's pixels and a confidence score, or null. */
  function findQuad(small, fast) {
    const W = small.width, H = small.height;
    const mats = [];
    const mk = () => { const m = new cv.Mat(); mats.push(m); return m; };
    try {
      const rgba = cv.imread(small); mats.push(rgba);
      const gray = mk();
      cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
      const blur = mk();
      cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
      // Closing wipes out dark text and lines printed on the page, so the
      // page becomes one flat bright area and only its outline has edges.
      const k = odd(Math.max(W, H) / 90);
      const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(k, k)); mats.push(kernel);
      const closed = mk();
      cv.morphologyEx(blur, closed, cv.MORPH_CLOSE, kernel);
      const k3 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)); mats.push(k3);

      const maps = [];
      const canny = (src, lo, hi) => {
        const e = mk();
        cv.Canny(src, e, lo, hi);
        cv.dilate(e, e, k3);
        maps.push(e);
        return e;
      };
      const eLow = canny(closed, 15, 45);
      canny(closed, 40, 120);
      if (!fast) canny(closed, 80, 200);
      const otsu = mk();
      cv.threshold(closed, otsu, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      cv.morphologyEx(otsu, otsu, cv.MORPH_OPEN, kernel);
      maps.push(otsu);
      if (!fast) {
        // Saturation separates white paper from a beige/wooden/coloured desk
        // even when the brightness is almost the same.
        const rgb = mk(); cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
        const hsv = mk(); cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
        const ch = new cv.MatVector();
        cv.split(hsv, ch);
        const sat = mk(); ch.get(1).copyTo(sat);
        for (let i = 0; i < ch.size(); i++) ch.get(i).delete();
        ch.delete();
        cv.GaussianBlur(sat, sat, new cv.Size(5, 5), 0);
        cv.morphologyEx(sat, sat, cv.MORPH_OPEN, kernel);
        canny(sat, 15, 45);
        const sotsu = mk();
        cv.threshold(sat, sotsu, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
        maps.push(sotsu);
      }

      // Edge map used to judge candidates: union of the gentle Canny maps.
      const support = mk();
      eLow.copyTo(support);
      cv.dilate(support, support, k3);

      const quads = [];
      maps.forEach((m) => { const c = mk(); m.copyTo(c); quadsFromBinary(c, W, H, quads); });

      let best = null, bestScore = 0;
      for (const q of quads) {
        const s = scoreQuad(q, support, W, H);
        if (s > bestScore) { bestScore = s; best = q; }
      }
      if (!best || bestScore < 0.12) return null;
      return { corners: orderPoints(best), score: bestScore };
    } finally {
      mats.forEach((m) => m.delete());
    }
  }

  /* ---------- stage 2: sub-pixel refinement on the full image ---------- */

  function lumaSampler(canvas) {
    const W = canvas.width, H = canvas.height;
    const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
    const L = new Uint8Array(W * H);
    for (let i = 0, j = 0; i < L.length; i++, j += 4) L[i] = (77 * d[j] + 150 * d[j + 1] + 29 * d[j + 2]) >> 8;
    return {
      W, H,
      at(x, y) {
        if (x < 0 || y < 0 || x > W - 2 || y > H - 2) return NaN;
        const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * W + x0;
        return (L[i] * (1 - fx) + L[i + 1] * fx) * (1 - fy) + (L[i + W] * (1 - fx) + L[i + W + 1] * fx) * fy;
      },
    };
  }

  /* Fit a line through points (total least squares). Returns {px,py,dx,dy}. */
  function fitLine(pts) {
    let mx = 0, my = 0;
    pts.forEach((p) => { mx += p.x; my += p.y; });
    mx /= pts.length; my /= pts.length;
    let sxx = 0, sxy = 0, syy = 0;
    pts.forEach((p) => { const dx = p.x - mx, dy = p.y - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; });
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return { px: mx, py: my, dx: Math.cos(ang), dy: Math.sin(ang) };
  }
  function lineDist(l, p) { return Math.abs((p.x - l.px) * l.dy - (p.y - l.py) * l.dx); }
  function intersect(a, b) {
    const den = a.dx * b.dy - a.dy * b.dx;
    if (Math.abs(den) < 1e-6) return null;
    const t = ((b.px - a.px) * b.dy - (b.py - a.py) * b.dx) / den;
    return { x: a.px + a.dx * t, y: a.py + a.dy * t };
  }

  /* Find the paper edge along side a->b; returns a fitted line or null. */
  function refineSide(S, a, b, center, radius) {
    const len = dist(a, b);
    const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
    let nx = -uy, ny = ux;                                  // normal…
    if ((center.x - a.x) * nx + (center.y - a.y) * ny < 0) { nx = -nx; ny = -ny; } // …pointing into the page
    const n = Math.min(80, Math.max(10, Math.round(len / 10)));
    const found = { 1: [], '-1': [] };
    const strength = { 1: 0, '-1': 0 };
    for (let i = 0; i < n; i++) {
      const t = 0.08 + 0.84 * (i / (n - 1));
      const bx = a.x + (b.x - a.x) * t, by = a.y + (b.y - a.y) * t;
      const prof = [];
      for (let j = -radius - 1; j <= radius + 1; j++) prof.push(S.at(bx + nx * j, by + ny * j));
      if (prof.some(Number.isNaN)) continue;
      for (const sign of [1, -1]) {
        let bestJ = -1, bestD = 0;
        for (let j = 1; j < prof.length - 1; j++) {
          const dval = sign * (prof[j + 1] - prof[j - 1]);
          if (dval > bestD) { bestD = dval; bestJ = j; }
        }
        if (bestJ < 1 || bestD < 6) continue;
        // parabolic peak for sub-pixel position
        const dm = sign * (prof[bestJ] - prof[Math.max(0, bestJ - 2)]);
        const dp = sign * (prof[Math.min(prof.length - 1, bestJ + 2)] - prof[bestJ]);
        const den = dm - 2 * bestD + dp;
        const off = den !== 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (dm - dp) / den)) : 0;
        const j = bestJ + off - radius - 1;
        found[sign].push({ x: bx + nx * j, y: by + ny * j });
        strength[sign] += bestD;
      }
    }
    // Paper is usually brighter than the desk (sign 1 = brighter inside),
    // but pick whichever polarity the edge really has.
    const pts = strength[1] >= strength[-1] ? found[1] : found[-1];
    if (pts.length < 8) return null;
    let line = fitLine(pts);
    for (let pass = 0; pass < 2; pass++) {
      const res = pts.map((p) => lineDist(line, p)).sort((x, y) => x - y);
      const lim = Math.max(1.2, 2.5 * res[res.length >> 1]);
      const inl = pts.filter((p) => lineDist(line, p) <= lim);
      if (inl.length < 8) return null;
      line = fitLine(inl);
    }
    // Nudge the line ~1px into the page so no sliver of desk shows in the scan.
    line.px += nx * 1.0; line.py += ny * 1.0;
    return line;
  }

  /* Refine rough corners (in canvas pixels) against the full image. */
  function refine(canvas, corners, roughScale) {
    const S = lumaSampler(canvas);
    const p = KEYS.map((k) => corners[k]);
    const center = { x: p.reduce((s, q) => s + q.x, 0) / 4, y: p.reduce((s, q) => s + q.y, 0) / 4 };
    const radius = Math.round(Math.max(6, Math.min(40, 3.5 * roughScale)));
    const W = canvas.width, H = canvas.height, m = 3 * roughScale;
    const lines = [];
    for (let i = 0; i < 4; i++) {
      const a = p[i], b = p[(i + 1) % 4];
      const border = (a.x < m && b.x < m) || (a.y < m && b.y < m) || (a.x > W - m && b.x > W - m) || (a.y > H - m && b.y > H - m);
      const l = border ? null : refineSide(S, a, b, center, radius);
      if (l) {
        // reject a line that wandered off (e.g. latched onto a text line)
        if (lineDist(l, a) > radius * 1.6 || lineDist(l, b) > radius * 1.6) lines.push(null);
        else lines.push(l);
      } else lines.push(null);
    }
    const out = {};
    for (let i = 0; i < 4; i++) {
      // corner i joins side (i-1) and side i
      const la = lines[(i + 3) % 4] || { px: p[(i + 3) % 4].x, py: p[(i + 3) % 4].y, dx: p[i].x - p[(i + 3) % 4].x, dy: p[i].y - p[(i + 3) % 4].y };
      const lb = lines[i] || { px: p[i].x, py: p[i].y, dx: p[(i + 1) % 4].x - p[i].x, dy: p[(i + 1) % 4].y - p[i].y };
      let q = (lines[(i + 3) % 4] || lines[i]) ? intersect(la, lb) : null;
      if (!q || dist(q, p[i]) > radius * 2.5) q = p[i];
      out[KEYS[i]] = { x: Math.max(0, Math.min(W, q.x)), y: Math.max(0, Math.min(H, q.y)) };
    }
    return out;
  }

  /* Detect the page corners in a canvas. Returns {tl,tr,br,bl} in canvas
     pixel coordinates, or null when nothing plausible was found.
     opts.fast: live preview mode (smaller image, fewer maps, no refinement). */
  function detect(canvas, opts = {}) {
    if (!ready) return null;
    const side = opts.fast ? LIVE_SIDE : DETECT_SIDE;
    const big = Math.max(canvas.width, canvas.height);
    const small = big > side ? Imaging.copyCanvas(canvas, side) : canvas;
    const k = canvas.width / small.width;
    try {
      const r = findQuad(small, !!opts.fast);
      if (!r) return null;
      let corners = scaleCorners(r.corners, k);
      if (!opts.fast) {
        try { corners = refine(canvas, corners, k); } catch (e) { /* keep rough corners */ }
      }
      return corners;
    } catch (e) {
      return null;
    } finally {
      if (small !== canvas) Imaging.release(small);
    }
  }

  /* Crop + flatten the quad into a straight rectangle (bicubic, so text stays crisp). */
  function warp(canvas, corners, maxSide = Imaging.PAGE_SIDE) {
    const wTop = dist(corners.tl, corners.tr), wBot = dist(corners.bl, corners.br);
    const hL = dist(corners.tl, corners.bl), hR = dist(corners.tr, corners.br);
    let w = Math.max(wTop, wBot), h = Math.max(hL, hR);
    const s = Math.min(1, maxSide / Math.max(w, h));
    w = Math.max(16, Math.round(w * s));
    h = Math.max(16, Math.round(h * s));
    const src = cv.imread(canvas);
    const dst = new cv.Mat();
    const from = cv.matFromArray(4, 1, cv.CV_32FC2, KEYS.flatMap((key) => [corners[key].x, corners[key].y]));
    const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h]);
    const M = cv.getPerspectiveTransform(from, to);
    try {
      cv.warpPerspective(src, dst, M, new cv.Size(w, h), cv.INTER_CUBIC, cv.BORDER_REPLICATE, new cv.Scalar());
      const out = Imaging.createCanvas(w, h);
      cv.imshow(out, dst);
      return out;
    } finally {
      src.delete(); dst.delete(); from.delete(); to.delete(); M.delete();
    }
  }

  /* ---------- filters ---------- */

  /* Estimate the colour of the bare paper everywhere on the page (the
     "lighting map"), as an image the same size and type as src.
     The page is split into small cells; in each cell the brightest pixels
     are paper. Cells that are much darker than their neighbourhood are
     printed areas (photos, filled boxes) rather than shadow, so they are
     ignored and filled in from the surrounding paper. */
  function lightingMap(src) {
    const nc = src.channels();
    const W = src.cols, H = src.rows;
    const f = Math.min(1, 320 / Math.max(W, H));
    const small = new cv.Mat();
    cv.resize(src, small, new cv.Size(Math.max(1, Math.round(W * f)), Math.max(1, Math.round(H * f))), 0, 0, cv.INTER_AREA);
    const w = small.cols, h = small.rows, d = small.data;
    small.delete();
    const cell = Math.max(4, Math.round(Math.max(w, h) / 28));
    const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell), n = gw * gh;
    const lum = new Float32Array(n), col = new Float32Array(n * nc);
    const vals = [];
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        vals.length = 0;
        const x1 = Math.min(w, (gx + 1) * cell), y1 = Math.min(h, (gy + 1) * cell);
        for (let y = gy * cell; y < y1; y++) {
          for (let x = gx * cell; x < x1; x++) {
            const i = (y * w + x) * nc;
            vals.push(nc === 1 ? d[i] : 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
          }
        }
        const sorted = vals.slice().sort((p, q) => p - q);
        const p90 = sorted[Math.floor(sorted.length * 0.9)];
        const c = gy * gw + gx;
        lum[c] = p90;
        // average colour of the paper pixels (those near the 90th percentile)
        const acc = new Float32Array(nc); let cnt = 0, k = 0;
        for (let y = gy * cell; y < y1; y++) {
          for (let x = gx * cell; x < x1; x++, k++) {
            if (vals[k] < p90 * 0.97) continue;
            const i = (y * w + x) * nc;
            for (let ch = 0; ch < nc; ch++) acc[ch] += d[i + ch];
            cnt++;
          }
        }
        for (let ch = 0; ch < nc; ch++) col[c * nc + ch] = cnt ? acc[ch] / cnt : p90;
      }
    }
    // paper cells: not much darker than the brightest cell close by
    const paper = new Uint8Array(n);
    let any = false;
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        let mx = 0;
        for (let yy = Math.max(0, gy - 2); yy <= Math.min(gh - 1, gy + 2); yy++)
          for (let xx = Math.max(0, gx - 2); xx <= Math.min(gw - 1, gx + 2); xx++) mx = Math.max(mx, lum[yy * gw + xx]);
        const c = gy * gw + gx;
        paper[c] = lum[c] >= 0.62 * mx && lum[c] > 40 ? 1 : 0;
        if (paper[c]) any = true;
      }
    }
    if (!any) paper.fill(1);
    // fill the other cells from their paper neighbours, ring by ring
    let todo = paper.reduce((s, v) => s + (v ? 0 : 1), 0), guard = 0;
    while (todo > 0 && guard++ < gw + gh) {
      const next = paper.slice();
      for (let gy = 0; gy < gh; gy++) {
        for (let gx = 0; gx < gw; gx++) {
          const c = gy * gw + gx;
          if (paper[c]) continue;
          const acc = new Float32Array(nc); let cnt = 0;
          for (let yy = Math.max(0, gy - 1); yy <= Math.min(gh - 1, gy + 1); yy++)
            for (let xx = Math.max(0, gx - 1); xx <= Math.min(gw - 1, gx + 1); xx++) {
              const q = yy * gw + xx;
              if (!paper[q]) continue;
              for (let ch = 0; ch < nc; ch++) acc[ch] += col[q * nc + ch];
              cnt++;
            }
          if (cnt) { for (let ch = 0; ch < nc; ch++) col[c * nc + ch] = acc[ch] / cnt; next[c] = 1; todo--; }
        }
      }
      paper.set(next);
    }
    // smooth the grid a little, then stretch it to full size
    const grid = new cv.Mat(gh, gw, nc === 1 ? cv.CV_8UC1 : cv.CV_8UC3);
    for (let i = 0; i < n * nc; i++) grid.data[i] = Math.max(1, Math.min(255, Math.round(col[i])));
    cv.blur(grid, grid, new cv.Size(3, 3), new cv.Point(-1, -1), cv.BORDER_REPLICATE);
    // soften at quarter size (cheap), then stretch to full size
    const mid = new cv.Mat(), bg = new cv.Mat();
    const mw = Math.max(1, Math.round(W / 4)), mh = Math.max(1, Math.round(H / 4));
    cv.resize(grid, mid, new cv.Size(mw, mh), 0, 0, cv.INTER_LINEAR);
    grid.delete();
    cv.GaussianBlur(mid, mid, new cv.Size(0, 0), Math.max(mw, mh) / 120);
    cv.resize(mid, bg, new cv.Size(W, H), 0, 0, cv.INTER_LINEAR);
    mid.delete();
    return bg;
  }

  /* Divide the image by its lighting map. This removes shadows and uneven
     light and makes the paper evenly white. */
  function flattenLighting(src, dst) {
    const bg = lightingMap(src);
    try { cv.divide(src, bg, dst, 255); } finally { bg.delete(); }
  }

  /* Make low-resolution pages bigger before the contrast curve, so letter
     edges come out smooth instead of jagged. Returns the scale used. */
  const TEXT_SIDE = 2600;   // long side a page should have for crisp 10pt text
  function upscaleForText(mat) {
    const long = Math.max(mat.cols, mat.rows);
    if (long >= TEXT_SIDE * 0.92) return 1;
    const k = Math.min(2, TEXT_SIDE / long);
    cv.resize(mat, mat, new cv.Size(Math.round(mat.cols * k), Math.round(mat.rows * k)), 0, 0, cv.INTER_CUBIC);
    return k;
  }

  /* Unsharp mask tuned to the width of a text stroke. */
  function sharpen(mat, amount) {
    const blur = new cv.Mat();
    try {
      const sigma = Math.max(1, Math.max(mat.cols, mat.rows) / 2200);
      cv.GaussianBlur(mat, blur, new cv.Size(0, 0), sigma);
      cv.addWeighted(mat, 1 + amount, blur, -amount, 0, mat);
    } finally { blur.delete(); }
  }

  /* Tone curve for text on a lighting-corrected page (paper ≈ 255):
     everything brighter than `white` becomes pure paper white, and the
     curve bends (gamma) so grey, slightly blurred strokes turn near-black. */
  function textCurve(mat, black, white, gamma) {
    const lut = new Uint8Array(256);
    for (let v = 0; v < 256; v++) {
      const t = Math.max(0, Math.min(1, (v - black) / (white - black)));
      lut[v] = Math.round(255 * Math.pow(t, gamma));
    }
    const d = mat.data;
    for (let i = 0; i < d.length; i++) d[i] = lut[d[i]];
  }

  /* Typical brightness of the ink cores. Most non-paper pixels are the soft
     edges of letters, so take a low percentile of them, not the median. */
  function darkLevel(gray) {
    const hist = new Uint32Array(256), d = gray.data;
    for (let i = 0; i < d.length; i += 3) hist[d[i]]++;
    let n = 0;
    for (let v = 0; v < 230; v++) n += hist[v];
    if (n < 50) return 60;
    let acc = 0;
    for (let v = 0; v < 230; v++) { acc += hist[v]; if (acc >= n * 0.15) return v; }
    return 60;
  }

  /* Apply a filter. 'original' | 'enhance' | 'grey' | 'bw'.
     Returns the canvas holding the result: the same canvas, or a new,
     larger one when a small page was upscaled for sharper text. */
  function applyFilter(canvas, filter) {
    if (filter === 'original' || !ready) return canvas;
    const src = cv.imread(canvas);
    const work = new cv.Mat();
    let out = canvas;
    const show = (mat) => {
      if (mat.cols !== canvas.width || mat.rows !== canvas.height) out = Imaging.createCanvas(mat.cols, mat.rows);
      cv.imshow(out, mat);
    };
    try {
      if (filter === 'enhance') {
        // Colour scan: even white paper, black crisp text, colours kept.
        cv.cvtColor(src, work, cv.COLOR_RGBA2RGB);
        src.delete();
        flattenLighting(work, work);
        upscaleForText(work);
        sharpen(work, 1.1);
        textCurve(work, 45, 220, 1.7);
        show(work);
      } else if (filter === 'grey') {
        cv.cvtColor(src, work, cv.COLOR_RGBA2GRAY);
        src.delete();
        flattenLighting(work, work);
        upscaleForText(work);
        sharpen(work, 1.1);
        textCurve(work, 40, 222, 1.75);
        show(work);
      } else if (filter === 'bw') {
        const bin = new cv.Mat();
        try {
          cv.cvtColor(src, work, cv.COLOR_RGBA2GRAY);
          src.delete();
          flattenLighting(work, work);
          upscaleForText(work);
          sharpen(work, 0.6);
          // The lighting is already even (paper = 255), so one threshold for
          // the whole page works: halfway between the ink and the paper.
          // Cutting at the middle of the soft letter edge keeps strokes at
          // their true weight instead of making them bold.
          const ink = darkLevel(work);
          const t = Math.max(100, Math.min(200, Math.round((ink + 255) / 2) - 8));
          cv.threshold(work, bin, t, 255, cv.THRESH_BINARY);
          cv.medianBlur(bin, bin, 3);                          // remove speckles
          show(bin);
        } finally { bin.delete(); }
      }
    } finally {
      if (!src.isDeleted()) src.delete();
      work.delete();
    }
    return out;
  }

  /* Sharpness of an image (variance of the Laplacian): higher = sharper.
     Used to pick the best frame of a burst. */
  function sharpness(canvas) {
    if (!ready) return 0;
    const src = cv.imread(canvas), gray = new cv.Mat(), lap = new cv.Mat();
    const mean = new cv.Mat(), std = new cv.Mat();
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.Laplacian(gray, lap, cv.CV_16S, 3);
      cv.meanStdDev(lap, mean, std);
      return std.data64F[0] * std.data64F[0];
    } finally { [src, gray, lap, mean, std].forEach((m) => m.delete()); }
  }

  return {
    load,
    get ready() { return ready; },
    detect, refine, warp, applyFilter, sharpness, fullCorners, polygonArea,
  };
})();
