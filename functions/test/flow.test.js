'use strict';
// End-to-end test of the Cloud Functions with an in-memory Firestore.
// Run with: cd functions && npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');

// ---------- Minimal in-memory Firestore ----------
const store = new Map(); // "col/id" -> data
const SERVER_TS = { __server: true };
class Ts { constructor(ms) { this.ms = ms; } toMillis() { return this.ms; } toDate() { return new Date(this.ms); } }
const resolve = (data) => Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v === SERVER_TS ? new Ts(Date.now()) : v]));
function docRef(col, id) {
  const key = `${col}/${id}`;
  return {
    id, key,
    async get() { const d = store.get(key); return { id, exists: !!d, data: () => (d ? { ...d } : undefined) }; },
    async set(d) { store.set(key, resolve(d)); },
    async update(d) { if (!store.has(key)) throw new Error('no doc'); store.set(key, { ...store.get(key), ...resolve(d) }); },
    async delete() { store.delete(key); },
  };
}
function collection(col) {
  const all = () => [...store.entries()].filter(([k]) => k.startsWith(`${col}/`)).map(([k, d]) => ({ id: k.slice(col.length + 1), data: () => ({ ...d }) }));
  return {
    doc: (id) => docRef(col, id || crypto.randomBytes(10).toString('hex')),
    async add(d) { const r = docRef(col, crypto.randomBytes(10).toString('hex')); await r.set(d); return r; },
    async get() { return { docs: all() }; },
    where(f, op, v) { return { get: async () => ({ docs: all().filter((d) => d.data()[f] === v) }) }; },
  };
}
const db = {
  collection,
  async runTransaction(fn) {
    const ops = [];
    await fn({ get: (r) => r.get(), set: (r, d) => ops.push(() => r.set(d)), update: (r, d) => ops.push(() => r.update(d)), delete: (r) => ops.push(() => r.delete()) });
    for (const op of ops) await op();
  },
  batch() { const ops = []; return { delete: (r) => ops.push(() => r.delete()), update: (r, d) => ops.push(() => r.update(d)), commit: async () => { for (const op of ops) await op(); } }; },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: { serverTimestamp: () => SERVER_TS }, Timestamp: { fromMillis: (ms) => new Ts(ms) } };
  if (req === 'firebase-admin/app') return { initializeApp: () => ({}) };
  return origLoad.call(this, req, ...rest);
};

process.env.FACE_TEMPLATE_KEY = crypto.randomBytes(32).toString('base64');
const fns = require('../index');

// ---------- Helpers ----------
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const face = (seed) => { const r = rng(seed); return Array.from({ length: 1024 }, () => r() - 0.5); };
const noisy = (b, a, seed) => { const r = rng(seed); return b.map((x) => x + (r() - 0.5) * a); };
const quality = { samples: 5, consistency: 0.85, faceScore: 0.95, real: 0.9, live: 0.8 };
const operator = { uid: 'op1', token: { email: 'operator@gmail.com', firebase: { sign_in_provider: 'password' } } };
const visitorAuth = { uid: 'anon', token: { firebase: { sign_in_provider: 'anonymous' } } };
const call = (fn, data, auth = operator) => fns[fn].run({ data, auth, rawRequest: {} });
async function pending(id, name, faceConsent = true) {
  store.set(`visits/${id}`, { ownerUid: 'v', name, purpose: 'Meeting', car: '', status: 'pending', createdAt: new Ts(Date.now()), inAt: null, outAt: null, faceConsent });
}
const visit = (id) => store.get(`visits/${id}`);
const template = (id) => store.get(`faceTemplates/${id}`);

const ALI = face(100), SITI = face(200);

test('only the operator can call face functions', async () => {
  await pending('aliVisit000001', 'ALI BIN ABU');
  await assert.rejects(call('faceEnrollCheckIn', { visitId: 'aliVisit000001', embedding: ALI, quality }, null), { code: 'unauthenticated' });
  await assert.rejects(call('faceEnrollCheckIn', { visitId: 'aliVisit000001', embedding: ALI, quality }, visitorAuth), { code: 'permission-denied' });
  await assert.rejects(call('faceMatchCheckOut', { embedding: ALI, quality }, visitorAuth), { code: 'permission-denied' });
  assert.equal(visit('aliVisit000001').status, 'pending');
});

test('face check-in enrols an encrypted template on the same visit record', async () => {
  const res = await call('faceEnrollCheckIn', { visitId: 'aliVisit000001', embedding: ALI, quality });
  assert.deepEqual(res, { ok: true });
  const v = visit('aliVisit000001');
  assert.equal(v.status, 'in');
  assert.equal(v.checkInMethod, 'face');
  assert.equal(v.faceEnrolled, true);
  assert.ok(v.inAt instanceof Ts);
  const t = template('aliVisit000001');
  assert.ok(t.data && t.iv && t.tag && t.active === true);
  assert.ok(!('embedding' in t), 'raw embedding must not be stored');
  assert.ok(t.expiresAt.toMillis() > Date.now() + 23 * 3600e3);
});

test('check-in is refused without consent, when not pending, or with bad input', async () => {
  await pending('noConsent00001', 'TAN WEI MING', false);
  await assert.rejects(call('faceEnrollCheckIn', { visitId: 'noConsent00001', embedding: SITI, quality }), { code: 'failed-precondition' });
  assert.equal(template('noConsent00001'), undefined);
  await assert.rejects(call('faceEnrollCheckIn', { visitId: 'aliVisit000001', embedding: noisy(ALI, 0.6, 3), quality }), { code: 'failed-precondition' }); // already checked in
  await assert.rejects(call('faceEnrollCheckIn', { visitId: 'missing0000001', embedding: SITI, quality }), { code: 'not-found' });
  await assert.rejects(call('faceEnrollCheckIn', { visitId: 'noConsent00001', embedding: [1, 2, 3], quality }), { code: 'invalid-argument' });
  await assert.rejects(call('faceEnrollCheckIn', { visitId: 'noConsent00001', embedding: SITI, quality: { samples: 1, consistency: 0.9 } }), { code: 'invalid-argument' });
});

test('the same face cannot be enrolled twice while still inside', async () => {
  await pending('aliAgain000001', 'ALI BIN ABU');
  await assert.rejects(call('faceEnrollCheckIn', { visitId: 'aliAgain000001', embedding: noisy(ALI, 0.6, 4), quality }), { code: 'already-exists' });
  assert.equal(visit('aliAgain000001').status, 'pending');
});

test('check-out scan returns only the matched visitor, never templates', async () => {
  await pending('sitiVisit00001', 'SITI HAJAR BINTI OMAR');
  await call('faceEnrollCheckIn', { visitId: 'sitiVisit00001', embedding: SITI, quality });
  const res = await call('faceMatchCheckOut', { embedding: noisy(SITI, 0.6, 7), quality });
  assert.equal(res.status, 'match');
  assert.equal(res.visit.id, 'sitiVisit00001');
  assert.equal(res.visit.name, 'SITI HAJAR BINTI OMAR');
  assert.ok(res.score >= 0.65 && typeof res.token === 'string');
  assert.ok(!JSON.stringify(res).includes('embedding') && !JSON.stringify(res).includes('"iv"'));
  assert.equal(visit('sitiVisit00001').status, 'in', 'match alone must not check out');
});

test('unknown face: no visitor returned', async () => {
  const res = await call('faceMatchCheckOut', { embedding: face(999), quality });
  assert.equal(res.status, 'unknown');
  assert.equal(res.visit, undefined);
  assert.equal(res.token, undefined);
});

test('confirm check-out needs the token from the match, then deletes the template', async () => {
  const m = await call('faceMatchCheckOut', { embedding: noisy(SITI, 0.6, 8), quality });
  await assert.rejects(call('faceConfirmCheckOut', { visitId: 'sitiVisit00001', token: 'forged.token' }), { code: 'failed-precondition' });
  await assert.rejects(call('faceConfirmCheckOut', { visitId: 'aliVisit000001', token: m.token }), { code: 'failed-precondition' });
  assert.equal(visit('aliVisit000001').status, 'in');
  await call('faceConfirmCheckOut', { visitId: 'sitiVisit00001', token: m.token });
  const v = visit('sitiVisit00001');
  assert.equal(v.status, 'out');
  assert.equal(v.checkOutMethod, 'face');
  assert.equal(v.faceEnrolled, false);
  assert.equal(template('sitiVisit00001'), undefined, 'template deleted at check-out');
  // the same token cannot check the visitor out twice
  await assert.rejects(call('faceConfirmCheckOut', { visitId: 'sitiVisit00001', token: m.token }), { code: 'failed-precondition' });
});

test('manual check-out + faceRelease deletes the template; release refused while inside', async () => {
  await assert.rejects(call('faceRelease', { visitId: 'aliVisit000001' }), { code: 'failed-precondition' });
  store.set('visits/aliVisit000001', { ...visit('aliVisit000001'), status: 'out', outAt: new Ts(Date.now()), checkOutMethod: 'manual' });
  await call('faceRelease', { visitId: 'aliVisit000001' });
  assert.equal(template('aliVisit000001'), undefined);
  assert.equal(visit('aliVisit000001').faceEnrolled, false);
  assert.equal((await call('faceMatchCheckOut', { embedding: ALI, quality })).status, 'none');
});

test('hourly purge removes expired and orphaned templates', async () => {
  await pending('oldVisit000001', 'RAJESH A/L MURUGAN');
  await call('faceEnrollCheckIn', { visitId: 'oldVisit000001', embedding: face(300), quality });
  await pending('orphan00000001', 'NURUL IZZATI');
  await call('faceEnrollCheckIn', { visitId: 'orphan00000001', embedding: face(400), quality });
  store.set('faceTemplates/oldVisit000001', { ...template('oldVisit000001'), expiresAt: new Ts(Date.now() - 1000) });
  store.set('visits/orphan00000001', { ...visit('orphan00000001'), status: 'out' }); // checked out manually, release never called
  await pending('keepVisit00001', 'KEEP ME');
  await call('faceEnrollCheckIn', { visitId: 'keepVisit00001', embedding: face(500), quality });
  await fns.facePurge.run({});
  assert.equal(template('oldVisit000001'), undefined);
  assert.equal(template('orphan00000001'), undefined);
  assert.ok(template('keepVisit00001'), 'active template kept');
});

test('audit log has scores and outcomes but no biometric data', () => {
  const events = [...store.entries()].filter(([k]) => k.startsWith('faceEvents/')).map(([, d]) => d);
  assert.ok(events.length >= 6);
  const text = JSON.stringify(events);
  assert.ok(!text.includes('embedding') && !text.includes('"iv"') && !text.includes('"tag"'));
  assert.ok(events.some((e) => e.type === 'match' && typeof e.best === 'number'));
});
