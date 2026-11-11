'use strict';
// VISTA face backend (Cloud Functions for Firebase, 2nd gen).
// Face templates live in the "faceTemplates" collection, encrypted, and are only
// read here. firestore.rules blocks ALL browser access to that collection.
// The browser sends one scan at a time and gets back at most one matched visitor.

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { setGlobalOptions } = require('firebase-functions/v2');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const lib = require('./lib');

initializeApp();
const db = getFirestore();

// Singapore region (closest to Malaysia). Callable functions do not need to be in
// the same region as the Firestore database.
setGlobalOptions({ region: 'asia-southeast1', maxInstances: 3, memory: '256MiB', timeoutSeconds: 30 });

const FACE_KEY = defineSecret('FACE_TEMPLATE_KEY');
const OPERATOR_EMAIL = 'operator@gmail.com'; // same account as firestore.rules and guard.js
const RETENTION_HOURS = 24; // templates are deleted at check-out, or after this many hours at most

const visitRef = (id) => db.collection('visits').doc(id);
const templateRef = (id) => db.collection('faceTemplates').doc(id);

function requireOperator(request) {
  const t = request.auth && request.auth.token;
  if (!t) throw new HttpsError('unauthenticated', 'Please sign in as operator.');
  if ((t.email || '').toLowerCase() !== OPERATOR_EMAIL || t.firebase?.sign_in_provider !== 'password') {
    throw new HttpsError('permission-denied', 'This account is not authorized as a VISTA operator.');
  }
  return request.auth.uid;
}

/** Wraps a handler: input errors become clear messages, everything else is logged without data. */
function guarded(name, handler) {
  return async (request) => {
    try {
      return await handler(request);
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      if (err instanceof lib.InputError) throw new HttpsError('invalid-argument', err.message);
      logger.error(`${name} failed`, { message: err.message });
      throw new HttpsError('internal', 'The face service had a problem. Please use manual check-in or check-out.');
    }
  };
}

/** Audit trail without biometric data: scores and outcomes only (used to calibrate the threshold). */
function logEvent(event) {
  return db.collection('faceEvents').add({ ...event, at: FieldValue.serverTimestamp() })
    .catch((err) => logger.warn('faceEvents write failed', { message: err.message }));
}

/** Decrypts the templates of visitors currently inside. Expired or orphaned ones are skipped. */
async function activeTemplates(encKey) {
  const snap = await db.collection('faceTemplates').where('active', '==', true).get();
  const now = Date.now();
  const out = [];
  for (const doc of snap.docs) {
    const t = doc.data();
    if (t.expiresAt && t.expiresAt.toMillis() < now) continue;
    try {
      out.push({ visitId: doc.id, embedding: lib.decryptTemplate(t, doc.id, encKey) });
    } catch (err) {
      logger.warn('Unreadable face template skipped', { visitId: doc.id });
    }
  }
  return out;
}

const publicVisit = (id, v) => ({
  id,
  name: v.name || '',
  purpose: v.purpose || '',
  car: v.car || '',
  inAt: v.inAt ? v.inAt.toDate().toISOString() : null,
});

// ---------- 1. Face check-in: enrol the template on the visitor's pending record ----------
exports.faceEnrollCheckIn = onCall({ secrets: [FACE_KEY] }, guarded('faceEnrollCheckIn', async (request) => {
  const uid = requireOperator(request);
  const visitId = lib.validateVisitId(request.data?.visitId);
  const embedding = lib.validateEmbedding(request.data?.embedding);
  const quality = lib.validateQuality(request.data?.quality);
  const keys = lib.deriveKeys(FACE_KEY.value());

  // The same face must not be checked in twice at the same time.
  const dup = lib.pickMatch(embedding, (await activeTemplates(keys.enc)).filter((c) => c.visitId !== visitId));
  if (dup.status === 'match' || dup.status === 'ambiguous') {
    const other = dup.visitId ? (await visitRef(dup.visitId).get()).data() : null;
    await logEvent({ type: 'enrol-blocked', visitId, by: uid, best: dup.best });
    throw new HttpsError('already-exists', other
      ? `This face already matches ${other.name}, who is still checked in. Check that visitor out first, or use Manual Check In.`
      : 'This face is very similar to a visitor who is still checked in. Use Manual Check In.');
  }

  const sealed = lib.encryptTemplate(embedding, visitId, keys.enc);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(visitRef(visitId));
    if (!snap.exists) throw new HttpsError('not-found', 'This registration no longer exists.');
    const v = snap.data();
    if (v.status !== 'pending') throw new HttpsError('failed-precondition', 'This visitor is no longer waiting for check-in.');
    if (v.faceConsent !== true) throw new HttpsError('failed-precondition', 'This visitor did not agree to face recognition. Use Manual Check In.');
    tx.set(templateRef(visitId), {
      ...sealed,
      model: lib.MODEL_ID,
      active: true,
      createdAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromMillis(Date.now() + RETENTION_HOURS * 3600e3),
    });
    tx.update(visitRef(visitId), {
      status: 'in',
      inAt: FieldValue.serverTimestamp(),
      checkInMethod: 'face',
      faceEnrolled: true,
    });
  });
  await logEvent({ type: 'enrol', visitId, by: uid, quality });
  return { ok: true };
}));

// ---------- 2. Face check-out, step 1: find the visitor (no status change yet) ----------
exports.faceMatchCheckOut = onCall({ secrets: [FACE_KEY] }, guarded('faceMatchCheckOut', async (request) => {
  const uid = requireOperator(request);
  const probe = lib.validateEmbedding(request.data?.embedding);
  const quality = lib.validateQuality(request.data?.quality);
  const keys = lib.deriveKeys(FACE_KEY.value());

  const candidates = await activeTemplates(keys.enc);
  let result = lib.pickMatch(probe, candidates);
  let visit = null;
  if (result.status === 'match') {
    const snap = await visitRef(result.visitId).get();
    if (snap.exists && snap.data().status === 'in') visit = publicVisit(snap.id, snap.data());
    else result = { ...result, status: 'unknown' }; // template left over from a closed visit
  }
  await logEvent({
    type: 'match', by: uid, result: result.status, visitId: visit ? visit.id : null,
    best: result.best, second: result.second, candidates: candidates.length, quality,
  });
  if (!visit) return { status: result.status, candidates: candidates.length };
  return { status: 'match', visit, score: result.best, token: lib.signToken(visit.id, keys.mac) };
}));

// ---------- 3. Face check-out, step 2: guard confirmed the match ----------
exports.faceConfirmCheckOut = onCall({ secrets: [FACE_KEY] }, guarded('faceConfirmCheckOut', async (request) => {
  const uid = requireOperator(request);
  const visitId = lib.validateVisitId(request.data?.visitId);
  const keys = lib.deriveKeys(FACE_KEY.value());
  if (!lib.verifyToken(request.data?.token, visitId, keys.mac)) {
    throw new HttpsError('failed-precondition', 'This match has expired. Please scan again.');
  }
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(visitRef(visitId));
    if (!snap.exists || snap.data().status !== 'in') {
      throw new HttpsError('failed-precondition', 'This visitor is no longer checked in.');
    }
    tx.update(visitRef(visitId), {
      status: 'out',
      outAt: FieldValue.serverTimestamp(),
      checkOutMethod: 'face',
      faceEnrolled: false,
      faceDeletedAt: FieldValue.serverTimestamp(),
    });
    tx.delete(templateRef(visitId)); // biometric template deleted with the check-out
  });
  await logEvent({ type: 'checkout', visitId, by: uid });
  return { ok: true };
}));

// ---------- 4. Delete a template after manual check-out or cancellation ----------
exports.faceRelease = onCall(guarded('faceRelease', async (request) => {
  const uid = requireOperator(request);
  const visitId = lib.validateVisitId(request.data?.visitId);
  const snap = await visitRef(visitId).get();
  if (snap.exists && snap.data().status === 'in') {
    throw new HttpsError('failed-precondition', 'This visitor is still checked in.');
  }
  await deleteTemplate(visitId, snap.exists);
  await logEvent({ type: 'release', visitId, by: uid });
  return { ok: true };
}));

async function deleteTemplate(visitId, visitExists = true) {
  const batch = db.batch();
  batch.delete(templateRef(visitId));
  if (visitExists) batch.update(visitRef(visitId), { faceEnrolled: false, faceDeletedAt: FieldValue.serverTimestamp() });
  await batch.commit();
}

// ---------- 5. Retention: hourly clean-up of expired or orphaned templates ----------
exports.facePurge = onSchedule({ schedule: 'every 60 minutes', timeZone: 'Asia/Kuala_Lumpur' }, async () => {
  const snap = await db.collection('faceTemplates').get();
  const now = Date.now();
  let removed = 0;
  for (const doc of snap.docs) {
    const t = doc.data();
    const visit = await visitRef(doc.id).get();
    const expired = !t.expiresAt || t.expiresAt.toMillis() < now;
    const closed = !visit.exists || visit.data().status !== 'in';
    if (expired || closed) {
      await deleteTemplate(doc.id, visit.exists);
      removed++;
    }
  }
  if (removed) logger.info('Face templates removed', { removed });
});
