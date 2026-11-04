/* Doc Scanner – main app logic (screens, camera, crop, filter, export). */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const state = {
    pages: [],            // saved pages, in order (records from IndexedDB)
    queue: [],            // captured images waiting to be cropped: {blob} or {canvas}
    current: null,        // the page being edited (see openCrop)
    returnTo: 'camera',   // where to go after the queue is empty
    replaceId: null,      // when retaking an existing page
    filter: localStorage.getItem('lastFilter') || 'original',
    stream: null,
    pdfBlob: null,
    pdfName: '',
    thumbUrls: [],
  };

  /* ---------------- small UI helpers ---------------- */
  const screens = ['home', 'camera', 'crop', 'filter', 'export'];
  function show(name) {
    screens.forEach((s) => $('screen-' + s).classList.toggle('active', s === name));
    if (name !== 'camera') stopLiveLoop();
    if (name === 'home' || name === 'export') stopCamera();
    if (name === 'camera') startCamera();
    if (name === 'crop') requestAnimationFrame(layoutCrop);
  }
  function activeScreen() {
    return screens.find((s) => $('screen-' + s).classList.contains('active'));
  }

  let toastTimer = null;
  function toast(msg, ms = 2600, onTap = null) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    t.classList.toggle('action', !!onTap);
    t.onclick = onTap ? () => { t.hidden = true; onTap(); } : null;
    clearTimeout(toastTimer);
    if (ms > 0) toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }
  function busy(msg) {
    $('busy-text').textContent = msg || '';
    $('busy').hidden = !msg;
  }
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /* ---------------- HOME ---------------- */
  function renderHome() {
    const grid = $('pages-grid');
    state.thumbUrls.forEach((u) => URL.revokeObjectURL(u));
    state.thumbUrls = [];
    grid.innerHTML = '';
    const n = state.pages.length;
    $('empty-state').hidden = n > 0;
    $('reorder-hint').hidden = n < 2;
    $('btn-clear').hidden = n === 0;
    $('btn-export').disabled = n === 0;
    state.pages.forEach((p, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'thumb';
      b.dataset.id = p.id;
      const img = document.createElement('img');
      const url = URL.createObjectURL(p.thumb);
      state.thumbUrls.push(url);
      img.src = url;
      img.alt = 'Page ' + (i + 1);
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = i + 1;
      b.append(img, num);
      grid.appendChild(b);
    });
  }

  /* Tap = edit page. Hold + drag = reorder. */
  (function setupGridGestures() {
    const grid = $('pages-grid');
    let pressTimer = null, dragging = null, ghost = null, startX = 0, startY = 0, moved = false;

    function cancelPress() { clearTimeout(pressTimer); pressTimer = null; }
    function thumbAt(x, y) {
      const el = document.elementFromPoint(x, y);
      return el && el.closest ? el.closest('.thumb') : null;
    }
    function endDrag(commit) {
      if (!dragging) return;
      dragging.classList.remove('dragging');
      grid.querySelectorAll('.drop-target').forEach((e) => e.classList.remove('drop-target'));
      if (ghost) ghost.remove();
      ghost = null;
      dragging = null;
      if (commit) persistOrder();
    }
    function preventScroll(e) { if (dragging) e.preventDefault(); }
    document.addEventListener('touchmove', preventScroll, { passive: false });

    grid.addEventListener('contextmenu', (e) => e.preventDefault());

    grid.addEventListener('pointerdown', (e) => {
      const t = e.target.closest('.thumb');
      if (!t || e.button > 0) return;
      startX = e.clientX; startY = e.clientY; moved = false;
      cancelPress();
      pressTimer = setTimeout(() => {
        pressTimer = null;
        dragging = t;
        t.classList.add('dragging');
        const r = t.getBoundingClientRect();
        ghost = document.createElement('div');
        ghost.className = 'drag-ghost';
        ghost.style.width = r.width + 'px';
        ghost.style.height = r.height + 'px';
        ghost.style.left = r.left + 'px';
        ghost.style.top = r.top + 'px';
        ghost.appendChild(t.querySelector('img').cloneNode());
        document.body.appendChild(ghost);
        navigator.vibrate && navigator.vibrate(15);
      }, 280);
    });

    grid.addEventListener('pointermove', (e) => {
      if (pressTimer && Math.hypot(e.clientX - startX, e.clientY - startY) > 8) { cancelPress(); moved = true; }
      if (!dragging) return;
      const r = dragging.getBoundingClientRect();
      ghost.style.left = (e.clientX - r.width / 2) + 'px';
      ghost.style.top = (e.clientY - r.height / 2) + 'px';
      const over = thumbAt(e.clientX, e.clientY);
      if (over && over !== dragging) {
        const items = [...grid.children];
        const from = items.indexOf(dragging), to = items.indexOf(over);
        if (from < to) over.after(dragging); else over.before(dragging);
        renumber();
      }
    });

    const finish = (e) => {
      const wasDragging = !!dragging;
      const wasPress = !!pressTimer;
      cancelPress();
      if (wasDragging) { endDrag(true); return; }
      if (wasPress && !moved && e.type === 'pointerup') {
        const t = e.target.closest('.thumb');
        if (t) editPage(t.dataset.id);
      }
    };
    grid.addEventListener('pointerup', finish);
    grid.addEventListener('pointercancel', () => { cancelPress(); endDrag(true); });

    function renumber() {
      [...grid.children].forEach((el, i) => { el.querySelector('.num').textContent = i + 1; });
    }
    async function persistOrder() {
      const ids = [...grid.children].map((el) => el.dataset.id);
      const byId = Object.fromEntries(state.pages.map((p) => [p.id, p]));
      state.pages = ids.map((id) => byId[id]).filter(Boolean);
      state.pages.forEach((p, i) => { p.order = i; });
      renumber();
      await DB.putMany(state.pages);
    }
  })();

  $('btn-scan').onclick = () => { state.returnTo = 'camera'; state.replaceId = null; show('camera'); };
  $('btn-import').onclick = () => $('file-import').click();
  $('btn-export').onclick = openExport;
  $('btn-clear').onclick = async () => {
    if (!confirm('Delete all ' + state.pages.length + ' pages?')) return;
    await DB.clear();
    state.pages = [];
    renderHome();
  };

  $('file-import').addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    state.returnTo = 'home';
    state.replaceId = null;
    files.forEach((f) => state.queue.push({ blob: f }));
    processQueue();
  });

  /* ---------------- CAMERA ---------------- */
  const video = $('video');
  const overlay = $('live-overlay');
  let liveRaf = 0, lastDetect = 0, smooth = null, detectCanvas = null;

  async function startCamera() {
    $('cam-count').textContent = state.pages.length;
    $('cam-error').hidden = true;
    if (state.stream && state.stream.active) { video.play().catch(() => {}); startLiveLoop(); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      cameraFailed('This browser does not allow live camera access here.');
      return;
    }
    setCamStatus('Starting camera…');
    const constraints = [
      { video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1920 } }, audio: false },
      { video: { facingMode: 'environment' }, audio: false },
      { video: true, audio: false },
    ];
    let stream = null, err = null;
    for (const c of constraints) {
      try { stream = await navigator.mediaDevices.getUserMedia(c); break; } catch (e) { err = e; }
    }
    if (!stream) { cameraFailed(err && err.name === 'NotAllowedError' ? 'Camera permission was denied.' : 'The live camera could not be started.'); return; }
    if (activeScreen() !== 'camera') { stream.getTracks().forEach((t) => t.stop()); return; }
    state.stream = stream;
    video.srcObject = stream;
    try { await video.play(); } catch (e) { /* autoplay attr handles it */ }
    updateCamStatus();
    startLiveLoop();
  }

  function cameraFailed(msg) {
    $('cam-error-text').textContent = msg;
    $('cam-error').hidden = false;
    setCamStatus('');
    $('btn-shutter').disabled = true;
  }

  function stopCamera() {
    stopLiveLoop();
    if (state.stream) {
      state.stream.getTracks().forEach((t) => t.stop());
      state.stream = null;
    }
    video.srcObject = null;
  }

  function setCamStatus(text, ok = false) {
    const el = $('cam-status');
    el.textContent = text;
    el.hidden = !text;
    el.classList.toggle('ok', ok);
  }
  function updateCamStatus() {
    if (!Scanner.ready) setCamStatus('Loading edge detection…');
    else setCamStatus('');
    $('btn-shutter').disabled = false;
  }

  function startLiveLoop() {
    stopLiveLoop();
    smooth = null;
    const loop = (ts) => {
      liveRaf = requestAnimationFrame(loop);
      if (ts - lastDetect < 140 || !Scanner.ready || !video.videoWidth) return;
      lastDetect = ts;
      liveDetect();
    };
    liveRaf = requestAnimationFrame(loop);
  }
  function stopLiveLoop() {
    if (liveRaf) cancelAnimationFrame(liveRaf);
    liveRaf = 0;
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
  }

  function liveDetect() {
    const vw = video.videoWidth, vh = video.videoHeight;
    const k = Math.max(vw, vh) / 420;
    if (!detectCanvas) detectCanvas = Imaging.createCanvas(1, 1);
    const sw = Math.round(vw / k), sh = Math.round(vh / k);
    if (detectCanvas.width !== sw || detectCanvas.height !== sh) { detectCanvas.width = sw; detectCanvas.height = sh; }
    detectCanvas.getContext('2d').drawImage(video, 0, 0, sw, sh);
    const corners = Scanner.detect(detectCanvas);

    const cw = overlay.clientWidth, ch = overlay.clientHeight;
    if (overlay.width !== cw || overlay.height !== ch) { overlay.width = cw; overlay.height = ch; }
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, cw, ch);
    if (!corners) { smooth = null; return; }

    // Map video pixels -> screen (object-fit: cover)
    const s = Math.max(cw / vw, ch / vh);
    const dx = (cw - vw * s) / 2, dy = (ch - vh * s) / 2;
    const pts = ['tl', 'tr', 'br', 'bl'].map((key) => ({
      x: corners[key].x * k * s + dx, y: corners[key].y * k * s + dy,
    }));
    if (smooth) pts.forEach((p, i) => { p.x = smooth[i].x * 0.5 + p.x * 0.5; p.y = smooth[i].y * 0.5 + p.y * 0.5; });
    smooth = pts;

    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = 'rgba(55,198,106,0.18)';
    ctx.strokeStyle = '#37c66a';
    ctx.lineWidth = 3;
    ctx.fill();
    ctx.stroke();
  }

  $('btn-shutter').onclick = () => {
    if (!video.videoWidth) { toast('Camera not ready yet'); return; }
    const canvas = Imaging.videoToCanvas(video);
    const ctx = overlay.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, overlay.width, overlay.height);
    setTimeout(() => ctx.clearRect(0, 0, overlay.width, overlay.height), 80);
    state.queue.push({ canvas });
    processQueue();
  };
  $('btn-native').onclick = () => $('file-native').click();
  $('file-native').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    state.queue.push({ blob: f });
    processQueue();
  });
  $('btn-cam-close').onclick = () => { state.replaceId = null; show('home'); renderHome(); };
  $('btn-cam-done').onclick = () => { state.replaceId = null; show('home'); renderHome(); };

  /* ---------------- QUEUE ---------------- */
  async function processQueue() {
    if (state.current) return;
    const item = state.queue.shift();
    if (!item) {
      if (state.returnTo === 'camera' && !state.replaceId) show('camera');
      else { state.replaceId = null; show('home'); renderHome(); }
      return;
    }
    let canvas = item.canvas;
    if (!canvas) {
      busy('Reading photo…');
      try { canvas = await Imaging.blobToCanvas(item.blob); }
      catch (e) { busy(''); toast('Could not read that image'); return processQueue(); }
      busy('');
    }
    await openCrop(canvas, { replaceId: state.replaceId, filter: state.filter });
  }

  /* ---------------- CROP ---------------- */
  const cropCanvas = $('crop-canvas');
  const cropSvg = $('crop-svg');
  const cropPoly = $('crop-poly');
  const handlesG = $('crop-handles');
  const loupe = $('loupe');
  const CORNER_KEYS = ['tl', 'tr', 'br', 'bl'];
  let cropRect = { x: 0, y: 0, w: 1, h: 1, scale: 1 };

  /* Open the crop screen for a source canvas.
     opts: { pageId, replaceId, corners, filter, original } */
  async function openCrop(canvas, opts) {
    state.current = {
      source: canvas,
      pageId: opts.pageId || null,
      replaceId: opts.replaceId || null,
      filter: opts.filter || state.filter,
      original: opts.original || null,
      corners: opts.corners || null,
      warped: null,
    };
    const editing = !!(state.current.pageId || state.current.replaceId);
    const id = state.current.pageId || state.current.replaceId;
    const idx = state.pages.findIndex((p) => p.id === id);
    $('crop-title').textContent = editing && idx >= 0 ? `Page ${idx + 1} of ${state.pages.length}` : 'Adjust corners';
    $('btn-crop-delete').hidden = !state.current.pageId;
    $('btn-crop-earlier').hidden = !state.current.pageId;
    $('btn-crop-later').hidden = !state.current.pageId;

    drawCropSource();
    show('crop');
    if (!state.current.corners) await autoDetect();
    layoutCrop();
  }

  function drawCropSource() {
    const src = state.current.source;
    cropCanvas.width = src.width;
    cropCanvas.height = src.height;
    cropCanvas.getContext('2d').drawImage(src, 0, 0);
  }

  async function autoDetect() {
    const cur = state.current;
    if (!Scanner.ready) {
      busy('Loading scanner engine…');
      try { await Scanner.load(); } catch (e) { toast('Edge detection is unavailable, adjust the corners by hand'); }
      busy('');
      if (state.current !== cur) return;
    }
    const found = Scanner.ready ? Scanner.detect(cur.source) : null;
    cur.corners = found || Scanner.fullCorners(cur.source.width, cur.source.height);
    if (!found && Scanner.ready) toast('No page edges found, drag the corners to fit');
    layoutCrop();
  }

  function layoutCrop() {
    if (!state.current || activeScreen() !== 'crop') return;
    const stage = $('crop-stage').getBoundingClientRect();
    const r = cropCanvas.getBoundingClientRect();
    cropRect = { x: r.left - stage.left, y: r.top - stage.top, w: r.width, h: r.height, scale: r.width / cropCanvas.width };
    cropSvg.setAttribute('viewBox', `0 0 ${stage.width} ${stage.height}`);
    if (!handlesG.children.length) {
      CORNER_KEYS.forEach((key) => {
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.dataset.corner = key;
        const big = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        big.setAttribute('r', '24');
        big.setAttribute('class', 'handle');
        const core = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        core.setAttribute('r', '5');
        core.setAttribute('class', 'handle-core');
        g.append(big, core);
        handlesG.appendChild(g);
      });
    }
    drawCropOverlay();
  }

  function toScreen(p) { return { x: cropRect.x + p.x * cropRect.scale, y: cropRect.y + p.y * cropRect.scale }; }
  function toImage(p) {
    const src = state.current.source;
    return {
      x: Math.min(src.width, Math.max(0, (p.x - cropRect.x) / cropRect.scale)),
      y: Math.min(src.height, Math.max(0, (p.y - cropRect.y) / cropRect.scale)),
    };
  }

  function drawCropOverlay() {
    if (!state.current || !state.current.corners) return;
    const c = state.current.corners;
    const pts = CORNER_KEYS.map((k) => toScreen(c[k]));
    cropPoly.setAttribute('points', pts.map((p) => `${p.x},${p.y}`).join(' '));
    [...handlesG.children].forEach((g, i) => g.setAttribute('transform', `translate(${pts[i].x} ${pts[i].y})`));
  }

  (function setupCropDrag() {
    let activeKey = null, pointerId = null;

    function nearestCorner(pt) {
      let best = null, bestD = 44;
      CORNER_KEYS.forEach((k) => {
        const d = Math.hypot(pt.x - toScreen(state.current.corners[k]).x, pt.y - toScreen(state.current.corners[k]).y);
        if (d < bestD) { bestD = d; best = k; }
      });
      return best;
    }
    function localPoint(e) {
      const r = cropSvg.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    function drawLoupe(imgPt, screenPt) {
      const src = state.current.source;
      const zoom = 2.5;
      const size = loupe.width;
      const region = size / (cropRect.scale * zoom);
      const ctx = loupe.getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, size, size);
      ctx.drawImage(src, imgPt.x - region / 2, imgPt.y - region / 2, region, region, 0, 0, size, size);
      ctx.strokeStyle = '#2f7bff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(size / 2, 0); ctx.lineTo(size / 2, size);
      ctx.moveTo(0, size / 2); ctx.lineTo(size, size / 2);
      ctx.stroke();
      const stageW = $('crop-stage').clientWidth;
      loupe.style.left = screenPt.x < stageW / 2 ? (stageW - 150) + 'px' : '10px';
      loupe.style.top = '10px';
      loupe.hidden = false;
    }

    cropSvg.addEventListener('pointerdown', (e) => {
      if (!state.current || !state.current.corners) return;
      const pt = localPoint(e);
      const key = nearestCorner(pt);
      if (!key) return;
      activeKey = key;
      pointerId = e.pointerId;
      cropSvg.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    cropSvg.addEventListener('pointermove', (e) => {
      if (!activeKey || e.pointerId !== pointerId) return;
      const pt = localPoint(e);
      const ip = toImage(pt);
      state.current.corners[activeKey] = ip;
      drawCropOverlay();
      drawLoupe(ip, pt);
    });
    const end = (e) => {
      if (e.pointerId !== pointerId) return;
      activeKey = null; pointerId = null;
      loupe.hidden = true;
    };
    cropSvg.addEventListener('pointerup', end);
    cropSvg.addEventListener('pointercancel', end);
  })();

  $('btn-crop-auto').onclick = () => { state.current.corners = null; autoDetect(); };
  $('btn-crop-full').onclick = () => {
    const s = state.current.source;
    state.current.corners = Scanner.fullCorners(s.width, s.height);
    drawCropOverlay();
  };
  $('btn-crop-rotate').onclick = () => {
    const cur = state.current;
    const old = cur.source;
    const H = old.height;
    cur.source = Imaging.rotate90(old);
    Imaging.release(old);
    cur.original = null;   // the stored original must match the rotated image
    const rot = (p) => ({ x: H - p.y, y: p.x });
    const c = cur.corners;
    cur.corners = { tl: rot(c.bl), tr: rot(c.tl), br: rot(c.tr), bl: rot(c.br) };
    drawCropSource();
    requestAnimationFrame(layoutCrop);
  };
  $('btn-crop-back').onclick = () => { discardCurrent(); processQueue(); };
  $('btn-crop-retake').onclick = () => {
    const cur = state.current;
    state.replaceId = cur.pageId || cur.replaceId || null;
    state.returnTo = state.replaceId ? 'home' : state.returnTo;
    discardCurrent();
    state.queue = [];
    show('camera');
  };
  $('btn-crop-delete').onclick = async () => {
    const id = state.current.pageId;
    if (!confirm('Delete this page?')) return;
    await DB.remove(id);
    state.pages = state.pages.filter((p) => p.id !== id);
    state.pages.forEach((p, i) => { p.order = i; });
    await DB.putMany(state.pages);
    discardCurrent();
    show('home');
    renderHome();
  };
  async function movePage(delta) {
    const id = state.current.pageId;
    const i = state.pages.findIndex((p) => p.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= state.pages.length) return;
    [state.pages[i], state.pages[j]] = [state.pages[j], state.pages[i]];
    state.pages.forEach((p, k) => { p.order = k; });
    await DB.putMany(state.pages);
    $('crop-title').textContent = `Page ${j + 1} of ${state.pages.length}`;
    toast(`Moved to position ${j + 1}`, 1200);
  }
  $('btn-crop-earlier').onclick = () => movePage(-1);
  $('btn-crop-later').onclick = () => movePage(1);
  $('btn-crop-next').onclick = openFilter;

  function discardCurrent() {
    const cur = state.current;
    if (!cur) return;
    Imaging.release(cur.source);
    Imaging.release(cur.warped);
    Imaging.release(cropCanvas);
    Imaging.release(filterCanvas);
    state.current = null;
  }

  window.addEventListener('resize', () => requestAnimationFrame(layoutCrop));

  /* ---------------- FILTER / PREVIEW ---------------- */
  const filterCanvas = $('filter-canvas');

  async function openFilter() {
    const cur = state.current;
    busy('Flattening page…');
    await nextFrame();
    try {
      if (!Scanner.ready) await Scanner.load();
      Imaging.release(cur.warped);
      cur.warped = Scanner.warp(cur.source, cur.corners);
    } catch (e) {
      busy('');
      toast('Could not process the page: ' + e.message);
      return;
    }
    $('btn-filter-save').textContent = cur.pageId ? 'Save page' : 'Add page';
    show('filter');
    await renderFilter();
    busy('');
  }

  async function renderFilter() {
    const cur = state.current;
    const w = cur.warped;
    document.querySelectorAll('#filter-chips .chip').forEach((c) => c.classList.toggle('selected', c.dataset.filter === cur.filter));
    filterCanvas.width = w.width;
    filterCanvas.height = w.height;
    filterCanvas.getContext('2d').drawImage(w, 0, 0);
    await nextFrame();
    Scanner.applyFilter(filterCanvas, cur.filter);
  }

  $('filter-chips').addEventListener('click', async (e) => {
    const chip = e.target.closest('.chip');
    if (!chip || !state.current) return;
    state.current.filter = chip.dataset.filter;
    state.filter = chip.dataset.filter;
    localStorage.setItem('lastFilter', state.filter);
    busy('Applying filter…');
    await nextFrame();
    await renderFilter();
    busy('');
  });

  $('btn-filter-back').onclick = () => { show('crop'); };

  $('btn-filter-save').onclick = async () => {
    const cur = state.current;
    busy('Saving page…');
    await nextFrame();
    try {
      const processed = await Imaging.toBlob(filterCanvas, 'image/jpeg', 0.82);
      const thumbCanvas = Imaging.copyCanvas(filterCanvas, 320);
      const thumb = await Imaging.toBlob(thumbCanvas, 'image/jpeg', 0.7);
      Imaging.release(thumbCanvas);
      const original = cur.original || await Imaging.toBlob(cur.source, 'image/jpeg', 0.85);

      const existingId = cur.pageId || cur.replaceId;
      const idx = state.pages.findIndex((p) => p.id === existingId);
      const page = {
        id: idx >= 0 ? existingId : uid(),
        order: idx >= 0 ? state.pages[idx].order : state.pages.length,
        createdAt: idx >= 0 ? state.pages[idx].createdAt : Date.now(),
        width: cur.source.width, height: cur.source.height,
        original, corners: cur.corners, filter: cur.filter,
        processed, thumb, pw: filterCanvas.width, ph: filterCanvas.height,
      };
      await DB.put(page);
      if (idx >= 0) state.pages[idx] = page; else state.pages.push(page);
      $('cam-count').textContent = state.pages.length;
    } catch (e) {
      busy('');
      toast('Could not save the page: ' + e.message);
      return;
    }
    busy('');
    const wasEdit = !!(cur.pageId || cur.replaceId);
    state.replaceId = null;
    discardCurrent();
    if (wasEdit) { show('home'); renderHome(); }
    else processQueue();
  };

  async function editPage(id) {
    const page = state.pages.find((p) => p.id === id);
    if (!page) return;
    busy('Opening page…');
    try {
      const canvas = await Imaging.blobToCanvas(page.original);
      state.returnTo = 'home';
      state.replaceId = null;
      await openCrop(canvas, { pageId: id, corners: JSON.parse(JSON.stringify(page.corners)), filter: page.filter, original: page.original });
    } catch (e) {
      toast('Could not open the page');
    }
    busy('');
  }

  /* ---------------- EXPORT ---------------- */
  function openExport() {
    if (!state.pages.length) return;
    state.pdfBlob = null;
    $('export-form').hidden = false;
    $('export-progress').hidden = true;
    $('export-result').hidden = true;
    $('export-actions').hidden = false;
    $('result-actions').hidden = true;
    $('export-summary').textContent = `${state.pages.length} page${state.pages.length === 1 ? '' : 's'}, A4`;
    updateFilenamePreview();
    show('export');
    setTimeout(() => $('doc-title').focus(), 50);
  }
  function updateFilenamePreview() {
    $('filename-preview').textContent = PDFBuilder.filename($('doc-title').value);
  }
  $('doc-title').addEventListener('input', updateFilenamePreview);
  $('doc-title').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('btn-create-pdf').click(); } });
  $('btn-export-back').onclick = () => { show('home'); renderHome(); };

  $('btn-create-pdf').onclick = async () => {
    $('doc-title').blur();
    $('export-form').hidden = true;
    $('export-progress').hidden = false;
    $('export-actions').hidden = true;
    try {
      state.pdfName = PDFBuilder.filename($('doc-title').value);
      state.pdfBlob = await PDFBuilder.build(state.pages, (i, n) => {
        $('export-progress-text').textContent = `Building PDF… page ${i} of ${n}`;
      });
    } catch (e) {
      toast('Could not create the PDF: ' + e.message, 4000);
      openExport();
      return;
    }
    $('export-progress').hidden = true;
    $('export-result').hidden = false;
    $('result-actions').hidden = false;
    $('result-name').textContent = state.pdfName;
    $('result-size').textContent = formatSize(state.pdfBlob.size) + ' · ' + state.pages.length + ' page' + (state.pages.length === 1 ? '' : 's');
  };

  function formatSize(bytes) {
    return bytes > 1024 * 1024 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.round(bytes / 1024) + ' KB';
  }

  $('btn-share').onclick = async () => {
    if (!state.pdfBlob) return;
    const file = new File([state.pdfBlob], state.pdfName, { type: 'application/pdf' });
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: state.pdfName });
        toast('Done');
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;   // user closed the share sheet
      }
    }
    downloadBlob(state.pdfBlob, state.pdfName);
  };

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast('Downloading ' + name, 3000);
  }

  $('btn-new-doc').onclick = async () => {
    if (!confirm('Start a new document? The current pages will be deleted from this phone.')) return;
    await DB.clear();
    state.pages = [];
    state.pdfBlob = null;
    show('home');
    renderHome();
  };

  /* ---------------- lifecycle ---------------- */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stopLiveLoop(); if (state.stream) stopCamera(); }
    else if (activeScreen() === 'camera') startCamera();
  });
  window.addEventListener('pagehide', stopCamera);

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('./sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) toast('Update installed – tap to reload', 0, () => location.reload());
    });
  }

  async function init() {
    registerSW();
    try { state.pages = await DB.getAll(); } catch (e) { state.pages = []; }
    renderHome();
    Scanner.load().then(() => { if (activeScreen() === 'camera') updateCamStatus(); })
      .catch(() => toast('Could not load the scanner engine. Check your connection and reload.', 5000));
    if (state.pages.length) show('home');
    else { state.returnTo = 'camera'; show('camera'); }
  }

  init();
})();
