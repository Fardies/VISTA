'use strict';
// VISTA Face Scanner tab (operator dashboard). Loaded after guard.js and face.js.
// Check-in:  pending registration -> scan -> guard confirms -> faceEnrollCheckIn
// Check-out: scan -> faceMatchCheckOut (server finds the visitor) -> guard confirms
//            -> faceConfirmCheckOut (template deleted)
// The guard always confirms before attendance changes. Manual check-in/out stays
// available for visitors who decline scanning or when recognition fails.

/**
 * FACE_MODE
 *  'local' = Face matching on the guard's phone (Spark plan). Face templates are saved in
 *            Firestore "faceTemplatesShared" (operator-only, deleted at check-out), so any
 *            guard phone can check out a visitor that another phone checked in (face-local.js).
 *  'cloud' = Cloud Functions backend (functions/, needs Blaze). Templates are
 *            encrypted and matched on the server.
 */
const FACE_MODE = 'local';
const FACE_REGION = 'asia-southeast1'; // must match functions/index.js (cloud mode)
let faceFns = null;
function callFace(name, data) {
  if (!faceFns) faceFns = firebase.app().functions(FACE_REGION);
  return faceFns.httpsCallable(name, { timeout: 30000 })(data).then((r) => r.data);
}
const isLocalMode = FACE_MODE === 'local';

/** Visitor fields shown on the check-out screen. */
function publicVisit(v) {
  const inAt = toDate(v.inAt);
  return { id: v.id, name: v.name, purpose: v.purpose, car: v.car, inAt: inAt ? inAt.toISOString() : null };
}

/** The two backends do the same 4 jobs; the screens below do not care which one runs. */
const faceBackend = isLocalMode ? {
  async enroll(v, scan, photo) {
    const inside = new Set(visits.filter((x) => state(x) === 'in').map((x) => x.id));
    // A face that looks like someone still inside: the guard decides (same person or e.g. a twin)
    const near = FaceLocal.similar(scan, inside);
    const other = near && visits.find((x) => x.id === near.id);
    if (other) {
      FaceLocal.log({ event: 'check-in similar face', visitor: v.name, result: other.name, best: near.score, ...scan.quality });
      const e = new Error(`This face looks like ${other.name}, who is inside.`);
      e.code = 'similar-face';
      e.other = other;
      e.score = near.score;
      throw e;
    }
    // One batch = the face template, the photo and the check-in are saved together (all or
    // nothing), so a visitor is never marked inside without them, or the other way round.
    const batch = vistaDb.batch();
    FaceLocal.queueSave(batch, v.id, scan.embedding, scan.samples || scan.embeddings || []);
    batch.update(visitRef(v), { status: 'in', inAt: serverTime(), checkInMethod: 'face-local' });
    VistaPhoto.queueSave(batch, v.id, photo);
    await batch.commit();
    FaceLocal.log({ event: 'check-in', visitor: v.name, result: 'saved', ...scan.quality });
  },
  async match(scan) {
    if (!FaceLocal.isReady()) throw new Error(FaceLocal.problem());
    const inside = visits.filter((x) => state(x) === 'in');
    const r = FaceLocal.match(scan, new Set(inside.map((x) => x.id)));
    const v = r.visitId ? inside.find((x) => x.id === r.visitId) : null;
    FaceLocal.log({ event: 'check-out scan', visitor: v ? v.name : '', result: r.status, best: r.best, second: r.second, ...scan.quality });
    if (r.status === 'ambiguous') {
      const scores = {};
      for (const x of FaceLocal.rank(scan, new Set(inside.map((y) => y.id)))) scores[x.id] = x.score;
      const candidates = (r.candidates || []).map((id) => inside.find((x) => x.id === id)).filter(Boolean).map((x) => ({ ...publicVisit(x), score: scores[x.id] }));
      return candidates.length ? { status: 'ambiguous', best: r.best, second: r.second, candidates } : { status: 'unknown', best: r.best };
    }
    const found = r.status === 'match' || r.status === 'possible';
    if (!found || !v) return { status: found ? 'unknown' : r.status, best: r.best };
    return { status: r.status, score: r.best, second: r.second, visit: publicVisit(v) };
  },
  async confirmOut(m) {
    // Check-out, deleting the face template and deleting the photo are one batch (all or nothing).
    const batch = vistaDb.batch();
    batch.update(visitRef({ id: m.visit.id }), { status: 'out', outAt: serverTime(), checkOutMethod: 'face-local' });
    FaceLocal.queueDelete(batch, m.visit.id);
    VistaPhoto.queueDelete(batch, m.visit.id);
    await batch.commit();
    FaceLocal.forgetLocal(m.visit.id);
    FaceLocal.log({ event: 'check-out confirmed', visitor: m.visit.name, result: 'correct person', best: m.score, second: m.second });
  },
  rejected(m) { FaceLocal.log({ event: 'not this person', visitor: m.visit.name, result: 'wrong person', best: m.score, second: m.second }); },
  // Manual check-out or cancel: the visit is already saved, so delete the template now.
  // If that fails the visitor is still checked out; the clean-up below removes it later.
  release(v) {
    FaceLocal.remove(v.id).catch((err) => {
      console.warn('Face template delete failed; clean-up will retry.', err.message);
      setError('dashboard-error', 'Checked out, but this visitor\'s face data could not be deleted yet. It will be removed automatically.');
    });
  },
} : {
  async enroll(v, scan, photo) {
    await callFace('faceEnrollCheckIn', { visitId: v.id, embedding: scan.embedding, quality: scan.quality });
    await VistaPhoto.save(v.id, photo); // the visit is now "in", so the photo rule allows it
  },
  match: (scan) => callFace('faceMatchCheckOut', { embedding: scan.embedding, quality: scan.quality }),
  async confirmOut(m) {
    await callFace('faceConfirmCheckOut', { visitId: m.visit.id, token: m.token });
    VistaPhoto.remove(m.visit.id).catch(() => {}); // clean-up removes it later if this fails
  },
  rejected() {},
  release(v) {
    if (!v.faceEnrolled) return;
    callFace('faceRelease', { visitId: v.id }).catch((err) => console.warn('Face template release failed; hourly clean-up will remove it.', err.message));
  },
};

/** Can this visitor (inside) be checked out by face on this phone? */
function faceCanCheckOut(v) {
  // While shared face data is still loading, do not list everyone as "manual only"
  return isLocalMode ? (FaceLocal.has(v.id) || FaceLocal.loading()) : Boolean(v.faceEnrolled);
}

/** Visitors inside who can check out by face (for the Face Scanner tab). */
function faceInsideCount() {
  return visits.filter((v) => state(v) === 'in' && faceCanCheckOut(v)).length;
}

const faceUI = {
  mode: null,        // 'checkin' | 'checkout'
  visit: null,       // check-in target, or matched visitor at check-out
  scan: null,        // { embedding, samples, quality } — kept only until confirm/close
  photo: '',         // visitor photo taken at face check-in (saved with the check-in)
  match: null,       // { visit, score, token }
  abort: null,       // AbortController of the running scan
  scanId: 0,         // increases on every start/stop, so late results of an old scan are ignored
  facing: 'environment',
};
const fEl = (id) => document.getElementById(id);

/** True when the face backend cannot be reached (not deployed, no internet). */
function faceOffline(err) {
  const code = String(err?.code || '').replace('functions/', '');
  return code === 'unavailable' || code === 'deadline-exceeded'
    || (code === 'not-found' && /function/i.test(err.message || ''))
    || (code === 'internal' && (!err.message || err.message === 'internal'));
}

function faceErrorText(err) {
  const code = String(err?.code || '').replace('functions/', '');
  if (err instanceof VistaFace.FaceError) return err.message;
  if (faceOffline(err)) return 'Face service offline. Use manual instead.';
  if (code === 'already-exists') return err.message;
  if (code === 'permission-denied' && isLocalMode) return 'Permission denied. Publish the new firestore.rules first.';
  if (code === 'unauthenticated' || code === 'permission-denied') return 'Please sign in again.';
  return err?.message || 'Something went wrong. Use manual instead.';
}

// ---------- Modal ----------
function faceSetError(msg) { fEl('face-error').textContent = msg || ''; fEl('face-error').hidden = !msg; }
function faceStatus(text, progress) {
  fEl('face-status').textContent = text;
  if (typeof progress === 'number') fEl('face-progress').style.width = `${Math.round(progress * 100)}%`;
}

function faceButton(label, cls, onClick, disabled = false) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `btn ${cls}`;
  b.textContent = label;
  b.disabled = disabled;
  b.addEventListener('click', onClick);
  return b;
}
function faceActions(...buttons) { fEl('face-actions').replaceChildren(...buttons.filter(Boolean)); }

function detailsList(v, extra = []) {
  const box = document.createElement('div');
  box.className = 'details-card face-details';
  const rows = [['Name', v.name], ['Purpose', v.purpose || '-'], ['Car Plate', v.car || '-'], ...extra];
  for (const [k, val] of rows) {
    const d = document.createElement('div');
    const s = document.createElement('span'); s.textContent = k;
    const b = document.createElement('strong'); b.textContent = val;
    d.append(s, b);
    box.append(d);
  }
  return box;
}

function openFaceModal(mode, v = null) {
  if (!authorized) return;
  Object.assign(faceUI, { mode, visit: v, scan: null, match: null, photo: '' });
  fEl('face-title').textContent = mode === 'checkin' ? 'Face Check-In' : 'Face Check-Out';
  fEl('face-step').textContent = 'Step 1 of 2';
  faceSetError('');
  fEl('face-result').hidden = true;
  fEl('face-camera').hidden = true;
  const who = fEl('face-visitor');
  who.replaceChildren();
  who.hidden = !v;
  if (v) {
    const p = document.createElement('p');
    p.className = 'face-lead';
    p.textContent = 'Check the person matches:';
    who.append(p, detailsList(v, [['Registered', `${fmt.time(v.createdAt)} · ${fmt.date(v.createdAt)}`]]));
  }
  faceActions(
    faceButton('Start Scan', 'primary', startFaceScan),
    mode === 'checkin' ? faceButton('Manual Check In', 'secondary', manualFromModal) : null,
  );
  fEl('face-modal').hidden = false;
  document.body.classList.add('modal-open');
  // Start downloading the models early while the guard reads the screen
  VistaFace.load().catch(() => {});
}

/** Stops any running scan at once: the camera turns off immediately, the old scan's result is ignored. */
function stopScan() {
  faceUI.scanId++;
  if (faceUI.abort) faceUI.abort.abort();
  faceUI.abort = null;
  VistaFace.stopCamera(fEl('face-video'));
  fEl('face-camera').hidden = true;
}

function closeFaceModal() {
  stopScan();
  Object.assign(faceUI, { mode: null, visit: null, scan: null, match: null, photo: '' });
  fEl('face-modal').hidden = true;
  document.body.classList.remove('modal-open');
}

function retryActions() {
  faceActions(
    faceButton('Try Again', 'primary', startFaceScan),
    faceUI.mode === 'checkin' ? faceButton('Manual Check In', 'secondary', manualFromModal) : faceButton('Manual Check-Out', 'secondary', goManualCheckOut),
  );
}

function cancelScan() {
  stopScan();
  fEl('face-visitor').hidden = !faceUI.visit || faceUI.mode !== 'checkin';
  faceStatus('', 0);
  retryActions();
}

// ---------- Scan ----------
// ---------- Quick beep when a face is captured ----------
// Short, soft tone made in code (no audio file). Android also vibrates; iPhone
// Safari has no vibration for websites, so it only beeps. Phones on silent stay quiet.
let beepCtx = null;
function primeBeep() {
  // Must run during a button tap, or iPhone blocks the sound
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!beepCtx) beepCtx = new Ctx();
    if (beepCtx.state === 'suspended') beepCtx.resume();
  } catch { /* no sound available */ }
}
function scanBeep() {
  try { if (navigator.vibrate) navigator.vibrate(80); } catch { /* ignore */ }
  try {
    if (!beepCtx) return;
    const t = beepCtx.currentTime;
    const osc = beepCtx.createOscillator();
    const gain = beepCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.18, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    osc.connect(gain).connect(beepCtx.destination);
    osc.start(t);
    osc.stop(t + 0.15);
  } catch { /* ignore */ }
}

async function startFaceScan() {
  primeBeep();
  stopScan();
  const id = faceUI.scanId;
  const ctrl = new AbortController();
  faceUI.abort = ctrl;
  const current = () => id === faceUI.scanId;
  faceSetError('');
  faceUI.scan = null;
  faceUI.match = null;
  faceUI.photo = '';
  fEl('face-result').hidden = true;
  fEl('face-visitor').hidden = true; // keep the camera on screen while scanning
  fEl('face-camera').hidden = false;
  fEl('face-step').textContent = 'Step 1 of 2';
  faceActions(faceButton('Cancel', 'secondary', cancelScan));
  faceStatus('Starting camera…', 0);
  const video = fEl('face-video');
  try {
        // Load the face models and open the camera at the same time (faster than one after the other)
    const started = await Promise.allSettled([
      VistaFace.load((t) => current() && faceStatus(t, 0)),
      VistaFace.openCamera(video, faceUI.facing, ctrl.signal),
    ]);
    const failed = started.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
    if (!current()) return;
    const scan = await VistaFace.capture(video, { onStatus: (t, p) => current() && faceStatus(t, p), signal: ctrl.signal });
    if (!current()) return;
    scanBeep(); // face captured: tells the guard to look at the screen
    // Check-in: take the visitor photo from the same camera frame, centred on the face
    faceUI.photo = faceUI.mode === 'checkin' ? VistaPhoto.fromVideo(video, scan.box) : '';
    VistaFace.stopCamera(video);
    faceUI.abort = null;
    faceUI.scan = scan;
    fEl('face-camera').hidden = true;
    if (faceUI.mode === 'checkin') showCheckInReview();
    else await findCheckOutMatch();
  } catch (err) {
    if (!current()) return; // a newer scan or Cancel already handled the camera
    faceUI.abort = null;
    VistaFace.stopCamera(video);
    fEl('face-camera').hidden = true;
    fEl('face-visitor').hidden = !faceUI.visit || faceUI.mode !== 'checkin';
    if (err.code !== 'cancelled') faceSetError(faceErrorText(err));
    retryActions();
  }
}

function qualityLine(q) {
  const p = document.createElement('p');
  p.className = 'face-quality';
  p.textContent = `Scan quality: ${q.consistency >= 0.8 ? 'Good' : 'OK'}`;
  return p;
}

// ---------- Check-in ----------
function showCheckInReview() {
  const { scan, visit } = faceUI;
  fEl('face-visitor').hidden = false;
  fEl('face-step').textContent = 'Step 2 of 2';
  const box = fEl('face-result');
  box.replaceChildren();
  const ok = document.createElement('p');
  ok.className = 'face-ok';
  ok.textContent = '✓ Face captured';
  box.append(ok);
  if (faceUI.photo) {
    const pic = document.createElement('img');
    pic.className = 'face-photo';
    pic.src = faceUI.photo;
    pic.alt = 'Photo that will be saved';
    const cap = document.createElement('p');
    cap.className = 'face-quality face-center';
    cap.textContent = 'This photo will be saved for guards.';
    box.append(pic, cap);
  }
  box.append(qualityLine(scan.quality));
  const confirmBtn = faceButton('Confirm Check-In', 'primary', confirmFaceCheckIn, !faceUI.photo);
  if (!faceUI.photo) faceSetError('Photo could not be taken. Press Scan Again.');
  box.hidden = false;
  faceActions(confirmBtn, faceButton('Scan Again', 'secondary', startFaceScan), faceButton('Manual Check In', 'secondary', manualFromModal));
}

async function confirmFaceCheckIn(e) {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  faceSetError('');
  try {
    await faceBackend.enroll(faceUI.visit, faceUI.scan, faceUI.photo);
    faceUI.scan = null;
    faceUI.photo = '';
    faceDone(`✓ ${faceUI.visit.name} checked in`);
  } catch (err) {
    if (err.code === 'similar-face') { showSimilarFace(err.other, err.score); return; }
    faceSetError(faceErrorText(err));
    if (faceOffline(err)) {
      // Backend not available: make manual check-in the obvious next step
      faceActions(faceButton('Manual Check In', 'primary', manualFromModal), faceButton('Scan Again', 'secondary', startFaceScan));
      return;
    }
    btn.disabled = false;
    btn.textContent = 'Confirm Check-In';
  }
}

/**
 * The new face looks like someone already inside. The guard checks IC and chooses:
 *  - Same person: Close. Nothing is checked in (the registration stays pending).
 *  - Scan Again: try the scan again (e.g. a bad angle or light).
 *  - Check In Manually: a different person (e.g. a twin). The guard must confirm, and NO face
 *    is saved, so the two visitors can never be mixed up at check-out.
 */
function showSimilarFace(other, score) {
  const v = faceUI.visit;
  faceUI.scan = null;
  faceUI.photo = '';
  fEl('face-step').textContent = 'Check';
  fEl('face-visitor').hidden = true; // the visitor's name is in the message below: keeps the screen short
  const box = fEl('face-result');
  box.replaceChildren();
  const warn = document.createElement('p');
  warn.className = 'face-miss face-center';
  warn.textContent = `${v.name} looks like ${other.name}, who is already inside.`;
  const choices = document.createElement('div');
  choices.className = 'face-choices';
  choices.append(choiceCard(other, score != null ? `Inside now · ${pctText(score)} similar` : 'Inside now', true));
  const ask = document.createElement('p');
  ask.className = 'face-lead face-center';
  ask.textContent = 'Same person? Press Close.';
  box.append(warn, choices, ask);
  box.hidden = false;
  faceActions(
    faceButton('Scan Again', 'primary', startFaceScan),
    faceButton('Check In Manually', 'secondary', async () => {
      if (!confirm(`Check in ${v.name} manually?\n\nNo face data will be saved, so check-out will also be manual. Next, take the visitor's photo.`)) return;
      closeFaceModal();
      try {
        // manual: no face template for this visitor, but a photo is still required
        if (await manualCheckIn(v)) FaceLocal.log({ event: 'similar face: manual check-in', visitor: v.name, result: other.name });
      } catch (err) { alert(`Could not check in: ${err.message}`); }
    }),
    faceButton('Close', 'secondary', () => {
      FaceLocal.log({ event: 'similar face: same person, not checked in', visitor: v.name, result: other.name });
      closeFaceModal();
    }),
  );
}

/** 0.734 -> '73%' */
function pctText(score) { return `${Math.round(score * 100)}%`; }

/** One visitor shown as a centred card. selectable=false for a plain display card. */
function choiceCard(v, note = '', display = false) {
  const card = document.createElement(display ? 'div' : 'button');
  if (!display) { card.type = 'button'; card.setAttribute('aria-pressed', 'false'); }
  card.className = display ? 'face-choice face-choice-static' : 'face-choice';
  const name = document.createElement('strong');
  name.textContent = v.name;
  const inAt = v.inAt ? (v.inAt instanceof Date ? v.inAt : toDate(v.inAt) || new Date(v.inAt)) : null;
  const meta = document.createElement('span');
  meta.textContent = [v.purpose, inAt ? `In ${fmt.time(inAt)}` : '', note].filter(Boolean).join(' · ');
  // Photo helps the guard pick the right person (inside a button: picture only, no zoom)
  const img = VistaPhoto.get(v.id);
  if (img) {
    const pic = document.createElement('img');
    pic.className = 'face-choice-photo';
    pic.src = img;
    pic.alt = '';
    card.append(pic);
  }
  card.append(name, meta);
  return card;
}

async function manualFromModal() {
  const v = faceUI.visit;
  if (!v || !confirm(`Check in ${v.name} manually?\nNext, take the visitor's photo.`)) return;
  closeFaceModal(); // the Take Photo screen opens next
  try {
    await manualCheckIn(v);
  } catch (err) { alert(`Could not check in: ${err.message}`); }
}

// ---------- Check-out ----------
async function findCheckOutMatch() {
  fEl('face-step').textContent = 'Step 2 of 2';
  faceStatus('Searching…');
  const box = fEl('face-result');
  box.replaceChildren();
  const wait = document.createElement('p');
  wait.className = 'face-lead';
  wait.textContent = 'Searching…';
  box.append(wait);
  box.hidden = false;
  faceActions();
  let res;
  try {
    res = await faceBackend.match(faceUI.scan);
  } catch (err) {
    box.hidden = true;
    faceSetError(faceErrorText(err));
    faceActions(
      faceOffline(err) ? faceButton('Manual Check-Out', 'primary', goManualCheckOut) : faceButton('Try Again', 'primary', startFaceScan),
      faceOffline(err) ? faceButton('Scan Again', 'secondary', startFaceScan) : faceButton('Manual Check-Out', 'secondary', goManualCheckOut),
    );
    return;
  }
  faceUI.scan.embedding = null; // no longer needed in the browser
  faceUI.scan.samples = null;
  box.replaceChildren();

  if (res.status === 'ambiguous' && res.candidates && res.candidates.length) {
    showCandidates(res);
    return;
  }

  if (res.status !== 'match' && res.status !== 'possible') {
    const p = document.createElement('p');
    p.className = 'face-miss';
    p.textContent = {
      none: 'No one is checked in by face.',
      ambiguous: 'Looks like more than one visitor.',
      unknown: 'No match found.',
    }[res.status] || 'No match found.';
    const tip = document.createElement('p');
    tip.className = 'face-lead';
    tip.textContent = 'Ask their name and check out manually.';
    box.append(p, tip);
    faceActions(faceButton('Scan Again', 'primary', startFaceScan), faceButton('Manual Check-Out', 'secondary', goManualCheckOut));
    return;
  }

  faceUI.match = res;
  const v = res.visit;
  const lead = document.createElement('p');
  lead.className = 'face-lead';
  lead.textContent = 'Is this the person?';
  const inAt = v.inAt ? new Date(v.inAt) : null;
  box.append(lead);
  const pic = VistaPhoto.thumb(v, { size: 'xl', showEmpty: false });
  if (pic) box.append(pic);
  box.append(detailsList(v, [
    ['Checked In', inAt ? fmt.time(inAt) : '-'],
    ['Inside For', inAt ? fmt.duration(Date.now() - inAt.getTime()) : '-'],
  ]));
  // Similarity score (also saved in the on-phone log for accuracy checks)
  if (res.score != null) {
    const sc = document.createElement('p');
    sc.className = 'face-quality face-center';
    sc.textContent = `Similarity ${pctText(res.score)}${res.status === 'possible' ? ' · lower score, check carefully' : ''}`;
    box.append(sc);
  }
  const confirmBtn = faceButton('Confirm Check-Out', 'primary', confirmFaceCheckOut);
  faceActions(confirmBtn, faceButton('Not This Person', 'secondary', notThisPerson));
}

/** Several visitors inside look alike: list them (most similar first); the guard picks one. */
function showCandidates(res) {
  const box = fEl('face-result');
  box.replaceChildren();
  const warn = document.createElement('p');
  warn.className = 'face-miss face-center';
  warn.textContent = 'Looks like more than one visitor.';
  const tip = document.createElement('p');
  tip.className = 'face-lead face-center';
  tip.textContent = 'Check their IC and choose the right person:';
  const list = document.createElement('div');
  list.className = 'face-choices';
  list.setAttribute('role', 'group');
  list.setAttribute('aria-label', 'Possible visitors');
  const confirmBtn = faceButton('Confirm Check-Out', 'primary', confirmFaceCheckOut, true);
  for (const v of res.candidates) {
    const card = choiceCard(v, v.score != null ? `${pctText(v.score)} similar` : '');
    card.addEventListener('click', () => {
      list.querySelectorAll('.face-choice').forEach((c) => c.setAttribute('aria-pressed', 'false'));
      card.setAttribute('aria-pressed', 'true');
      faceUI.match = { status: 'chosen', visit: v, score: res.best, second: res.second };
      confirmBtn.disabled = false;
    });
    list.append(card);
  }
  box.append(warn, tip, list);
  faceActions(confirmBtn, faceButton('None of These', 'secondary', goManualCheckOut));
}

async function confirmFaceCheckOut(e) {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  faceSetError('');
  try {
    const { visit } = faceUI.match;
    await faceBackend.confirmOut(faceUI.match);
    faceDone(`✓ ${visit.name} checked out`);
  } catch (err) {
    faceSetError(faceErrorText(err));
    btn.disabled = false;
    btn.textContent = 'Confirm Check-Out';
  }
}

function notThisPerson() {
  if (faceUI.match) faceBackend.rejected(faceUI.match);
  faceUI.match = null;
  const box = fEl('face-result');
  box.replaceChildren();
  const p = document.createElement('p');
  p.className = 'face-miss';
  p.textContent = 'Not checked out.';
  box.append(p);
  faceActions(faceButton('Scan Again', 'primary', startFaceScan), faceButton('Manual Check-Out', 'secondary', goManualCheckOut));
}

function goManualCheckOut() {
  closeFaceModal();
  $('status').value = 'inside';
  showTab('records');
  render();
}

function faceDone(message) {
  const box = fEl('face-result');
  box.replaceChildren();
  const p = document.createElement('p');
  p.className = 'face-ok';
  p.textContent = message;
  box.append(p);
  box.hidden = false;
  fEl('face-step').textContent = 'Done';
  faceActions(faceButton('Close', 'primary', closeFaceModal));
  setTimeout(() => { if (fEl('face-result').contains(p)) closeFaceModal(); }, 2500);
}

/** After a manual check-out or cancel, delete the visitor's face template right away. */
function releaseFaceTemplate(v) { faceBackend.release(v); }

// ---------- Wiring ----------
fEl('face-close').addEventListener('click', closeFaceModal);
fEl('face-flip').addEventListener('click', async () => {
  faceUI.facing = faceUI.facing === 'environment' ? 'user' : 'environment';
  if (faceUI.abort) startFaceScan(); // restart the running scan with the other camera
});
fEl('scan-checkout').addEventListener('click', () => openFaceModal('checkout'));

if (isLocalMode) fEl('face-note').textContent = 'A photo is saved at check-in. Photo and face data are shared with signed-in guards only and deleted at check-out.';
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !fEl('face-modal').hidden) closeFaceModal(); });
// Phones stop the camera when the browser goes to the background; cancel cleanly.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && faceUI.abort) cancelScan(); });
// Signing out closes the scanner and forgets all face data held in memory.
// Signing in as the operator starts listening to the shared face templates.
vistaAuth.onAuthStateChanged((user) => {
  if (!user || user.isAnonymous) { closeFaceModal(); if (isLocalMode) FaceLocal.disconnect(); return; }
  if (isLocalMode && (user.email || '').toLowerCase() === OPERATOR_EMAIL) {
    FaceLocal.connect(vistaDb, () => { faceCleanup(); render(); });
  }
});

/** Deletes expired templates and templates of visitors already checked out or cancelled
 *  (e.g. a delete that failed earlier). Only acts on proof: the visit must be loaded and finished. */
function faceCleanup() {
  if (!isLocalMode || !authorized) return;
  const done = new Set(visits.filter((x) => ['out', 'cancelled'].includes(state(x))).map((x) => x.id));
  FaceLocal.purge((id) => done.has(id)).catch(() => {});
}
setInterval(faceCleanup, 60000);

window.openFaceCheckIn = (v) => openFaceModal('checkin', v);
window.faceInsideCount = faceInsideCount;
window.faceCanCheckOut = faceCanCheckOut;
window.releaseFaceTemplate = releaseFaceTemplate;