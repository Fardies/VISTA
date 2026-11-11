'use strict';
// VISTA face backend: pure helpers (no Firebase), so they can be unit-tested.
// Templates are face embeddings from Human.js (FaceRes model, 1024 numbers).
// They are never returned to the browser.

const crypto = require('node:crypto');

const EMBEDDING_LENGTH = 1024;
const MODEL_ID = 'human-3.3.6/faceres';

/**
 * Match settings. START VALUES ONLY: validate them with your own test scans
 * (see FACE_SETUP.txt, "Calibrate the threshold") before real use.
 * - threshold: minimum similarity (0..1, Human.js scale) to suggest a match.
 *   Human.js documents 0.5 as the point where faces "can be considered a match";
 *   VISTA starts stricter.
 * - margin: the best match must beat the second best by this much,
 *   otherwise the result is "ambiguous" and the guard checks out manually.
 */
const MATCH = { threshold: 0.65, margin: 0.08 };

/** Minimum capture quality the server accepts (the browser checks this first). */
const QUALITY = { minSamples: 3, minConsistency: 0.6 };

// ---------- Similarity (port of Human.js 3.3.6 src/face/match.ts, default options) ----------
function distance(a, b, order = 2, multiplier = 25) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = order === 2 ? a[i] - b[i] : Math.abs(a[i] - b[i]);
    sum += order === 2 ? diff * diff : diff ** order;
  }
  return Math.round(100 * multiplier * sum) / 100;
}

function similarity(a, b, { order = 2, multiplier = 25, min = 0.2, max = 0.8 } = {}) {
  if (!a || !b || a.length !== b.length) return 0;
  const dist = distance(a, b, order, multiplier);
  if (dist === 0) return 1;
  const root = order === 2 ? Math.sqrt(dist) : dist ** (1 / order);
  const norm = (1 - root / 100 - min) / (max - min);
  return Math.round(100 * Math.max(Math.min(norm, 1), 0)) / 100;
}

// ---------- Input validation ----------
class InputError extends Error {}

function validateEmbedding(e) {
  if (!Array.isArray(e) || e.length !== EMBEDDING_LENGTH) {
    throw new InputError(`Face template must have ${EMBEDDING_LENGTH} numbers.`);
  }
  for (const x of e) {
    if (typeof x !== 'number' || !Number.isFinite(x) || Math.abs(x) > 100) {
      throw new InputError('Face template contains invalid values.');
    }
  }
  // An all-zero (or constant) vector is not a real face
  const spread = Math.max(...e) - Math.min(...e);
  if (spread < 1e-6) throw new InputError('Face template is empty.');
  return e;
}

const score01 = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : null);

/** Keeps only known numeric fields; rejects scans the browser should never have sent. */
function validateQuality(q) {
  if (!q || typeof q !== 'object') throw new InputError('Scan quality is missing.');
  const samples = Number.isInteger(q.samples) ? q.samples : 0;
  const consistency = score01(q.consistency);
  if (samples < QUALITY.minSamples) throw new InputError('Not enough face samples. Please rescan.');
  if (consistency == null || consistency < QUALITY.minConsistency) {
    throw new InputError('The face changed during the scan. Please rescan with one person only.');
  }
  return { samples, consistency, faceScore: score01(q.faceScore), real: score01(q.real), live: score01(q.live) };
}

function validateVisitId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9]{10,40}$/.test(id)) throw new InputError('Invalid visit ID.');
  return id;
}

// ---------- Keys ----------
/** One 32-byte secret (base64) -> separate keys for encryption and for match tokens. */
function deriveKeys(secretB64) {
  const master = Buffer.from(String(secretB64 || '').trim(), 'base64');
  if (master.length !== 32) throw new Error('FACE_TEMPLATE_KEY must be 32 random bytes, base64-encoded.');
  const derive = (info) => Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), Buffer.from(info), 32));
  return { enc: derive('vista-face-template-enc-v1'), mac: derive('vista-face-match-token-v1') };
}

// ---------- Template encryption (AES-256-GCM, bound to the visit ID) ----------
function encryptTemplate(embedding, visitId, encKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  cipher.setAAD(Buffer.from(`visit:${visitId}`));
  const plain = Buffer.from(new Float32Array(embedding).buffer);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { data: data.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

function decryptTemplate(t, visitId, encKey) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, Buffer.from(t.iv, 'base64'));
  decipher.setAAD(Buffer.from(`visit:${visitId}`));
  decipher.setAuthTag(Buffer.from(t.tag, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(t.data, 'base64')), decipher.final()]);
  return Array.from(new Float32Array(plain.buffer, plain.byteOffset, plain.byteLength / 4));
}

// ---------- Matching ----------
/**
 * probe: embedding from the check-out scan.
 * candidates: [{ visitId, embedding }] for visitors currently inside.
 * Returns status 'match' | 'unknown' | 'ambiguous' | 'none'. Never picks the
 * closest face unless it passes both the threshold and the margin.
 */
function pickMatch(probe, candidates, opts = MATCH) {
  if (!candidates.length) return { status: 'none', best: null, second: null };
  const scored = candidates
    .map((c) => ({ visitId: c.visitId, score: similarity(probe, c.embedding) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  const second = scored[1] ? scored[1].score : 0;
  if (best.score < opts.threshold) return { status: 'unknown', best: best.score, second };
  if (best.score - second < opts.margin) return { status: 'ambiguous', best: best.score, second };
  return { status: 'match', visitId: best.visitId, best: best.score, second };
}

// ---------- Short-lived match token ----------
// faceMatchCheckOut returns a token; faceConfirmCheckOut only accepts that token,
// so a face check-out always comes from a real match made in the last 2 minutes.
const b64url = (buf) => Buffer.from(buf).toString('base64url');

function signToken(visitId, macKey, ttlMs = 120000, now = Date.now()) {
  const body = b64url(JSON.stringify({ v: visitId, e: now + ttlMs }));
  const sig = b64url(crypto.createHmac('sha256', macKey).update(body).digest());
  return `${body}.${sig}`;
}

function verifyToken(token, visitId, macKey, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 400 || !token.includes('.')) return false;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', macKey).update(body).digest();
  let given;
  try { given = Buffer.from(sig, 'base64url'); } catch { return false; }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return false;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return false; }
  return payload.v === visitId && typeof payload.e === 'number' && payload.e > now;
}

module.exports = {
  EMBEDDING_LENGTH, MODEL_ID, MATCH, QUALITY, InputError,
  similarity, validateEmbedding, validateQuality, validateVisitId,
  deriveKeys, encryptTemplate, decryptTemplate, pickMatch, signToken, verifyToken,
};
