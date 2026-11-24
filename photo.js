'use strict';
// VISTA VISITOR PHOTOS (Spark plan, free)
// A small photo of every visitor is taken at check-in so guards can recognise and find
// who is still inside.
//  - Saved in Firestore collection "visitorPhotos" (same id as the visit). Only the signed-in
//    operator account can read or write it (see firestore.rules). Visitors cannot.
//  - About 25-40 KB each (300 x 375 JPEG), stored as text, so no Cloud Storage / Blaze needed.
//  - Deleted at check-out (face or manual). If a visitor is never checked out, the photo is
//    deleted after 7 days anyway (RETENTION_DAYS). The visit record itself is kept.
//  - The guard app does the clean-up while it is open (Spark has no timers on the server).
// Loaded BEFORE guard.js (guard.html).

const VistaPhoto = (() => {
  const COL = 'visitorPhotos';
  const RETENTION_DAYS = 7;             // keep in step with firestore.rules (visitorPhotos)
  const RETENTION_MS = RETENTION_DAYS * 24 * 3600e3;
  const OUT_W = 300, OUT_H = 375;       // portrait 4:5
  const QUALITY = 0.72;                 // JPEG quality: small file, still clear

  // ---------- Live photos from Firestore (operator only) ----------
  let db = null, unsub = null, photos = {}, ready = false, error = '';
  let onChange = () => {};

  const col = () => db.collection(COL);
  const expiresMs = (p) => (p && p.expiresAt && typeof p.expiresAt.toMillis === 'function' ? p.expiresAt.toMillis() : 0);

  /** Starts listening to visitor photos. Call after the operator signs in. */
  function connect(database, changed = () => {}) {
    disconnect();
    db = database;
    onChange = changed;
    unsub = col().onSnapshot((snap) => {
      const next = {};
      snap.forEach((doc) => { next[doc.id] = doc.data(); });
      photos = next;
      ready = true;
      error = '';
      onChange();
    }, (err) => {
      photos = {};
      ready = false;
      error = err && err.code === 'permission-denied'
        ? 'Visitor photos are blocked. Publish the new firestore.rules, then refresh.'
        : 'Visitor photos are not available. Check the internet connection.';
      onChange();
    });
  }
  /** Stops listening and forgets every photo held in memory (sign-out). */
  function disconnect() {
    if (unsub) { unsub(); unsub = null; }
    db = null; photos = {}; ready = false; error = '';
  }

  /** The photo (data:image/jpeg;base64,...) of a visit, or '' if there is none. */
  function get(visitId) {
    const p = photos[visitId];
    return p && typeof p.img === 'string' && expiresMs(p) > Date.now() ? p.img : '';
  }
  const has = (visitId) => Boolean(get(visitId));
  const isReady = () => ready;
  const problem = () => error;

  /** Adds "save this visitor's photo" to a Firestore batch (commit it together with the check-in). */
  function queueSave(batch, visitId, img) {
    if (!db) throw new Error('Please sign in again.');
    if (!validImg(img)) throw new Error('The photo is missing. Please take the photo again.');
    batch.set(col().doc(visitId), {
      img,
      takenAt: firebase.firestore.FieldValue.serverTimestamp(),
      expiresAt: firebase.firestore.Timestamp.fromMillis(Date.now() + RETENTION_MS),
    });
  }
  /** Saves a photo on its own (used by the Cloud Functions face mode). */
  async function save(visitId, img) {
    const batch = db.batch();
    queueSave(batch, visitId, img);
    await batch.commit();
  }
  /** Adds "delete this visitor's photo" to a Firestore batch (commit it together with the check-out). */
  function queueDelete(batch, visitId) {
    if (db) batch.delete(col().doc(visitId));
  }
  /** Deletes a visitor's photo now. */
  async function remove(visitId) {
    if (db) await col().doc(visitId).delete();
    delete photos[visitId];
  }
  /** Deletes expired photos (7 days) and photos of visits that are finished (isFinished(id) true). */
  let purging = false;
  async function purge(isFinished) {
    if (!db || !ready || purging) return 0;
    purging = true;
    try {
      const now = Date.now();
      const ids = Object.keys(photos).filter((id) => expiresMs(photos[id]) <= now || isFinished(id));
      let n = 0;
      for (const id of ids) { try { await remove(id); n++; } catch { /* try again next time */ } }
      return n;
    } finally { purging = false; }
  }

  function validImg(img) {
    return typeof img === 'string' && img.startsWith('data:image/jpeg;base64,') && img.length > 1000 && img.length < 300000;
  }

  // ---------- Making the photo (video frame or picture file -> small JPEG) ----------
  const canvas = document.createElement('canvas');
  canvas.width = OUT_W; canvas.height = OUT_H;
  const ctx = canvas.getContext('2d');

  /**
   * Cuts a portrait photo out of a video or image and returns a small JPEG (data URL), or ''.
   * box (optional): the face box from the face scan, [x, y, w, h] as 0..1 of the frame.
   * With a box, the photo is centred on the face (head and shoulders). Without, the centre.
   */
  function fromSource(src, srcW, srcH, box = null) {
    if (!src || !srcW || !srcH) return '';
    const ratio = OUT_W / OUT_H;
    let cw, ch, cx, cy;
    if (Array.isArray(box) && box.length === 4 && box[2] > 0) {
      cw = box[2] * srcW * 2.0;                  // face box plus space around it
      ch = cw / ratio;
      cx = (box[0] + box[2] / 2) * srcW;
      cy = (box[1] + box[3] / 2) * srcH + ch * 0.08; // a little lower: include the shoulders
    } else {
      cw = srcW; ch = cw / ratio;
      if (ch > srcH) { ch = srcH; cw = ch * ratio; }
      cx = srcW / 2; cy = srcH / 2;
    }
    // Keep the crop inside the frame (shrink it if needed, keep 4:5)
    if (cw > srcW) { cw = srcW; ch = cw / ratio; }
    if (ch > srcH) { ch = srcH; cw = ch * ratio; }
    const x = Math.min(Math.max(cx - cw / 2, 0), srcW - cw);
    const y = Math.min(Math.max(cy - ch / 2, 0), srcH - ch);
    try {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, OUT_W, OUT_H);
      ctx.drawImage(src, x, y, cw, ch, 0, 0, OUT_W, OUT_H);
      const img = canvas.toDataURL('image/jpeg', QUALITY);
      return validImg(img) ? img : '';
    } catch { return ''; }
  }

  /** Photo from a playing <video> (camera). */
  function fromVideo(video, box = null) {
    return video && video.videoWidth ? fromSource(video, video.videoWidth, video.videoHeight, box) : '';
  }

  /** Photo from a picture file (phone camera app or gallery). */
  function fromFile(file) {
    return new Promise((resolve) => {
      if (!file || !/^image\//.test(file.type || 'image/')) { resolve(''); return; }
      const url = URL.createObjectURL(file);
      const im = new Image();
      im.onload = () => { const out = fromSource(im, im.naturalWidth, im.naturalHeight); URL.revokeObjectURL(url); resolve(out); };
      im.onerror = () => { URL.revokeObjectURL(url); resolve(''); };
      im.src = url;
    });
  }

  // ---------- Take Photo screen (manual check-in and walk-in) ----------
  const el = (id) => document.getElementById(id);
  const ui = { resolve: null, stream: null, img: '', stage: 'closed', facing: 'environment', busy: false };

  function stopCamera() {
    if (ui.stream) ui.stream.getTracks().forEach((t) => t.stop());
    ui.stream = null;
    const v = el('photo-video');
    if (v) v.srcObject = null;
  }

  function setError(msg) { el('photo-error').textContent = msg || ''; el('photo-error').hidden = !msg; }

  function button(label, cls, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn ${cls}`;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }
  function actions(...buttons) { el('photo-actions').replaceChildren(...buttons.filter(Boolean)); }

  function cameraError(err) {
    const name = err && err.name;
    if (!window.isSecureContext) return 'Camera needs an https:// link (or localhost).';
    if (name === 'NotAllowedError' || name === 'SecurityError') return 'Camera blocked. Allow the camera in browser settings, or use Phone Camera.';
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera found. Use Phone Camera instead.';
    if (name === 'NotReadableError' || name === 'AbortError') return 'Camera busy. Close other camera apps and try again.';
    return 'Camera could not open. Use Phone Camera instead.';
  }

  /** Step 1: live camera. */
  async function showLive() {
    ui.stage = 'live';
    ui.img = '';
    setError('');
    el('photo-preview').hidden = true;
    el('photo-camera').hidden = false;
    el('photo-step').textContent = 'Step 1 of 2';
    const takeBtn = button('Take Photo', 'primary', takeFromCamera);
    takeBtn.disabled = true;
    actions(takeBtn, button('Use Phone Camera', 'secondary', () => el('photo-file').click()));
    stopCamera();
    if (!navigator.mediaDevices?.getUserMedia) {
      el('photo-camera').hidden = true;
      setError('This browser cannot open the camera here. Use Phone Camera instead.');
      return;
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: ui.facing }, width: { ideal: 960 }, height: { ideal: 720 } },
      });
      if (ui.stage !== 'live') { s.getTracks().forEach((t) => t.stop()); return; } // closed while asking
      ui.stream = s;
      const v = el('photo-video');
      v.setAttribute('playsinline', '');
      v.muted = true;
      v.srcObject = s;
      await v.play().catch(() => {});
      if (!v.videoWidth) await new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true }));
      takeBtn.disabled = false;
    } catch (err) {
      el('photo-camera').hidden = true;
      setError(cameraError(err));
    }
  }

  /** Step 2: check the photo, then use it or retake. */
  function showPreview(img) {
    ui.stage = 'preview';
    ui.img = img;
    stopCamera();
    setError('');
    el('photo-camera').hidden = true;
    el('photo-preview-img').src = img;
    el('photo-preview').hidden = false;
    el('photo-step').textContent = 'Step 2 of 2';
    actions(button('Use This Photo', 'primary', () => finish(ui.img)), button('Retake', 'secondary', showLive));
  }

  function takeFromCamera() {
    const img = fromVideo(el('photo-video'));
    if (!img) { setError('Could not take the photo. Try again.'); return; }
    showPreview(img);
  }

  function finish(result) {
    stopCamera();
    ui.stage = 'closed';
    el('photo-modal').hidden = true;
    document.body.classList.remove('modal-open');
    const done = ui.resolve;
    ui.resolve = null;
    ui.img = '';
    if (done) done(result || null);
  }

  /**
   * Opens the Take Photo screen for a visitor.
   * Resolves the photo (data URL), or null if the guard pressed Cancel.
   */
  function take(name, title = 'Visitor Photo') {
    if (ui.resolve) finish(null); // only one at a time
    el('photo-title').textContent = title;
    el('photo-name').textContent = name ? `Visitor: ${name}` : '';
    el('photo-modal').hidden = false;
    document.body.classList.add('modal-open');
    return new Promise((resolve) => {
      ui.resolve = resolve;
      showLive();
    });
  }

  /** Closes the Take Photo screen (for example on sign-out). */
  function close() { if (ui.stage !== 'closed') finish(null); }

  // ---------- Photo viewer (tap a photo to see it bigger) ----------
  function view(v) {
    const img = v && get(v.id);
    if (!img) return;
    el('photo-view-img').src = img;
    el('photo-view-img').alt = `Photo of ${v.name}`;
    el('photo-view-name').textContent = v.name;
    const inAt = toDate(v.inAt);
    el('photo-view-meta').textContent = [v.purpose, v.car, inAt ? `In ${fmt.time(inAt)} · ${fmt.date(inAt)}` : ''].filter(Boolean).join(' · ');
    el('photo-view').hidden = false;
    document.body.classList.add('modal-open');
  }
  function closeView() {
    el('photo-view').hidden = true;
    el('photo-view-img').removeAttribute('src');
    // Keep scrolling locked if another sheet is still open underneath
    if ([...document.querySelectorAll('.modal-backdrop')].every((m) => m.hidden)) document.body.classList.remove('modal-open');
  }

  /**
   * Small photo for cards and lists. Tap = see it bigger.
   * Returns a placeholder ("No photo") when the visitor has none, or null if showEmpty is false.
   */
  function thumb(v, { size = 'md', showEmpty = true } = {}) {
    const img = v && get(v.id);
    if (!img) {
      if (!showEmpty) return null;
      const s = document.createElement('span');
      s.className = `photo-thumb photo-${size} empty`;
      s.textContent = 'No photo';
      return s;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `photo-thumb photo-${size}`;
    b.setAttribute('aria-label', `See the photo of ${v.name}`);
    const i = document.createElement('img');
    i.src = img;
    i.alt = '';
    i.loading = 'lazy';
    b.append(i);
    b.addEventListener('click', (e) => { e.stopPropagation(); view(v); });
    return b;
  }

  // ---------- Wiring ----------
  el('photo-cancel').addEventListener('click', () => finish(null));
  el('photo-flip').addEventListener('click', () => {
    ui.facing = ui.facing === 'environment' ? 'user' : 'environment';
    if (ui.stage === 'live') showLive();
  });
  el('photo-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // the same file can be chosen again
    if (!file || ui.stage === 'closed') return;
    const img = await fromFile(file);
    if (!img) { setError('That picture could not be used. Try again.'); return; }
    showPreview(img);
  });
  el('photo-view-close').addEventListener('click', closeView);
  el('photo-view').addEventListener('click', (e) => { if (e.target === el('photo-view')) closeView(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!el('photo-view').hidden) closeView();
    else if (ui.stage !== 'closed') finish(null);
  });
  // Phones stop the camera when the browser goes to the background; start it again on return.
  document.addEventListener('visibilitychange', () => {
    if (ui.stage !== 'live') return;
    if (document.visibilityState === 'hidden') stopCamera();
    else showLive();
  });

  return { RETENTION_DAYS, connect, disconnect, get, has, isReady, problem, queueSave, save, queueDelete, remove, purge, fromVideo, fromFile, take, close, view, thumb };
})();