'use strict';
// VISTA Face Scanner tab (operator dashboard). Loaded after guard.js and face.js.
// Check-in:  pending registration -> scan -> guard confirms -> faceEnrollCheckIn
// Check-out: scan -> faceMatchCheckOut (server finds the visitor) -> guard confirms
//            -> faceConfirmCheckOut (template deleted)
// The guard always confirms before attendance changes. Manual check-in/out stays
// available for visitors who decline scanning or when recognition fails.

/**
 * FACE_MODE
 *  'local' = Local face matching (Spark plan). Templates stay on the guard's
 *            phone only (face-local.js); nothing biometric goes to Firestore.
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

/** The two backends do the same 4 jobs; the screens below do not care which one runs. */
const faceBackend = isLocalMode ? {
  async enroll(v, scan) {
    const inside = new Set(visits.filter((x) => state(x) === 'in').map((x) => x.id));
    const dup = FaceLocal.match(scan.embedding, inside);
    if (dup.status === 'match' || dup.status === 'ambiguous') {
      const other = visits.find((x) => x.id === dup.visitId);
      FaceLocal.log({ event: 'check-in blocked', visitor: v.name, result: dup.status, best: dup.best, second: dup.second, ...scan.quality });
      const e = new Error(other ? `This face matches ${other.name}, who is still inside. Check them out first.` : 'This face looks like someone still inside. Use manual.');
      e.code = 'already-exists';
      throw e;
    }
    // Same visit record: pending -> in. Only normal visit fields go to Firestore.
    await visitRef(v).update({ status: 'in', inAt: serverTime(), checkInMethod: 'face-local' });
    FaceLocal.save(v.id, v.name, scan.embedding);
    FaceLocal.log({ event: 'check-in', visitor: v.name, result: 'saved', ...scan.quality });
  },
  async match(scan) {
    const inside = visits.filter((x) => state(x) === 'in');
    const r = FaceLocal.match(scan.embedding, new Set(inside.map((x) => x.id)));
    const v = r.visitId ? inside.find((x) => x.id === r.visitId) : null;
    FaceLocal.log({ event: 'check-out scan', visitor: v ? v.name : '', result: r.status, best: r.best, second: r.second, ...scan.quality });
    if (r.status !== 'match' || !v) return { status: r.status === 'match' ? 'unknown' : r.status, best: r.best };
    const inAt = toDate(v.inAt);
    return { status: 'match', score: r.best, second: r.second, visit: { id: v.id, name: v.name, purpose: v.purpose, car: v.car, inAt: inAt ? inAt.toISOString() : null } };
  },
  async confirmOut(m) {
    await visitRef({ id: m.visit.id }).update({ status: 'out', outAt: serverTime(), checkOutMethod: 'face-local' });
    FaceLocal.remove(m.visit.id);
    FaceLocal.log({ event: 'check-out confirmed', visitor: m.visit.name, result: 'correct person', best: m.score, second: m.second });
  },
  rejected(m) { FaceLocal.log({ event: 'not this person', visitor: m.visit.name, result: 'wrong person', best: m.score, second: m.second }); },
  release(v) { FaceLocal.remove(v.id); },
} : {
  enroll: (v, scan) => callFace('faceEnrollCheckIn', { visitId: v.id, embedding: scan.embedding, quality: scan.quality }),
  match: (scan) => callFace('faceMatchCheckOut', { embedding: scan.embedding, quality: scan.quality }),
  confirmOut: (m) => callFace('faceConfirmCheckOut', { visitId: m.visit.id, token: m.token }),
  rejected() {},
  release(v) {
    if (!v.faceEnrolled) return;
    callFace('faceRelease', { visitId: v.id }).catch((err) => console.warn('Face template release failed; hourly clean-up will remove it.', err.message));
  },
};

/** Visitors inside who can check out by face (for the Face Scanner tab). */
function faceInsideCount() {
  if (isLocalMode) return visits.filter((v) => state(v) === 'in' && FaceLocal.has(v.id)).length;
  return visits.filter((v) => state(v) === 'in' && v.faceEnrolled).length;
}

const faceUI = {
  mode: null,        // 'checkin' | 'checkout'
  visit: null,       // check-in target, or matched visitor at check-out
  scan: null,        // { embedding, quality, spoofWarning } — kept only until confirm/close
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
  const rows = [['Name', v.name], ['Purpose', v.purpose || '—'], ['Car Plate', v.car || '—'], ...extra];
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
  Object.assign(faceUI, { mode, visit: v, scan: null, match: null });
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
  Object.assign(faceUI, { mode: null, visit: null, scan: null, match: null });
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
async function startFaceScan() {
  stopScan();
  const id = faceUI.scanId;
  const ctrl = new AbortController();
  faceUI.abort = ctrl;
  const current = () => id === faceUI.scanId;
  faceSetError('');
  faceUI.scan = null;
  faceUI.match = null;
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

function qualityLine(q, score, second) {
  const p = document.createElement('p');
  p.className = 'face-quality';
  const scan = q.consistency >= 0.8 ? 'Good' : 'OK';
  let text = score != null ? `Match ${Math.round(score * 100)}% · Scan ${scan}` : `Scan quality: ${scan}`;
  p.textContent = text;
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
  box.append(ok, qualityLine(scan.quality));
  const confirmBtn = faceButton('Confirm Check-In', 'primary', confirmFaceCheckIn);
  box.hidden = false;
  faceActions(confirmBtn, faceButton('Scan Again', 'secondary', startFaceScan), faceButton('Manual Check In', 'secondary', manualFromModal));
}

async function confirmFaceCheckIn(e) {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  faceSetError('');
  try {
    await faceBackend.enroll(faceUI.visit, faceUI.scan);
    faceUI.scan = null;
    faceDone(`✓ ${faceUI.visit.name} checked in`);
  } catch (err) {
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

async function manualFromModal() {
  const v = faceUI.visit;
  if (!v || !confirm(`Check in ${v.name} manually?`)) return;
  try {
    await checkInVisit(v);
    faceDone(`✓ ${v.name} checked in`);
  } catch (err) { faceSetError(`Could not check in: ${err.message}`); }
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
  box.replaceChildren();

  if (res.status !== 'match') {
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
  box.append(lead, detailsList(v, [
    ['Checked In', inAt ? fmt.time(inAt) : '—'],
    ['Inside For', inAt ? fmt.duration(Date.now() - inAt.getTime()) : '—'],
  ]), qualityLine(faceUI.scan.quality, res.score, res.second));
  const confirmBtn = faceButton('Confirm Check-Out', 'primary', confirmFaceCheckOut);
  faceActions(confirmBtn, faceButton('Not This Person', 'secondary', notThisPerson));
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

if (isLocalMode) fEl('face-note').textContent = 'No photo saved. Face data stays on this phone and is deleted at check-out.';
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !fEl('face-modal').hidden) closeFaceModal(); });
// Phones stop the camera when the browser goes to the background; cancel cleanly.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && faceUI.abort) cancelScan(); });
// Signing out closes the scanner
vistaAuth.onAuthStateChanged((user) => { if (!user || user.isAnonymous) closeFaceModal(); });

window.openFaceCheckIn = (v) => openFaceModal('checkin', v);
window.faceInsideCount = faceInsideCount;
window.releaseFaceTemplate = releaseFaceTemplate;
