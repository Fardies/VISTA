'use strict';
// Run with: cd functions && npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const lib = require('../lib');

// Simple deterministic random generator so tests are repeatable
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
function face(seed) { const r = rng(seed); return Array.from({ length: 1024 }, () => (r() - 0.5) * 1.0); }
function noisy(base, amount, seed) { const r = rng(seed); return base.map((x) => x + (r() - 0.5) * amount); }
const keys = lib.deriveKeys(crypto.randomBytes(32).toString('base64'));

test('similarity: identical = 1, unrelated faces are low, small noise stays high', () => {
  const a = face(1), b = face(2);
  assert.equal(lib.similarity(a, a), 1);
  assert.ok(lib.similarity(a, b) < 0.5, `unrelated ${lib.similarity(a, b)}`);
  assert.ok(lib.similarity(a, noisy(a, 0.3, 9)) > 0.8);
  assert.equal(lib.similarity(a, a.slice(0, 10)), 0); // length mismatch
});

test('validateEmbedding rejects wrong length, NaN, huge and empty vectors', () => {
  assert.doesNotThrow(() => lib.validateEmbedding(face(3)));
  assert.throws(() => lib.validateEmbedding(face(3).slice(1)), lib.InputError);
  assert.throws(() => lib.validateEmbedding('x'), lib.InputError);
  const bad = face(3); bad[5] = NaN;
  assert.throws(() => lib.validateEmbedding(bad), lib.InputError);
  const huge = face(3); huge[5] = 1e9;
  assert.throws(() => lib.validateEmbedding(huge), lib.InputError);
  assert.throws(() => lib.validateEmbedding(new Array(1024).fill(0)), lib.InputError);
});

test('validateQuality enforces samples and consistency, clamps scores', () => {
  assert.deepEqual(lib.validateQuality({ samples: 5, consistency: 0.8, faceScore: 2, real: -1, live: 'x', extra: 'dropped' }),
    { samples: 5, consistency: 0.8, faceScore: 1, real: 0, live: null });
  assert.throws(() => lib.validateQuality({ samples: 2, consistency: 0.9 }), lib.InputError);
  assert.throws(() => lib.validateQuality({ samples: 5, consistency: 0.3 }), lib.InputError);
  assert.throws(() => lib.validateQuality(null), lib.InputError);
});

test('validateVisitId accepts Firestore auto IDs only', () => {
  assert.equal(lib.validateVisitId('aB3dE5gH7jK9mN1pQ3sT'), 'aB3dE5gH7jK9mN1pQ3sT');
  assert.throws(() => lib.validateVisitId('../faceTemplates/x'), lib.InputError);
  assert.throws(() => lib.validateVisitId(''), lib.InputError);
});

test('deriveKeys needs exactly 32 bytes', () => {
  assert.throws(() => lib.deriveKeys('short'));
  assert.throws(() => lib.deriveKeys(''));
  const k = lib.deriveKeys(Buffer.alloc(32, 7).toString('base64'));
  assert.equal(k.enc.length, 32);
  assert.notDeepEqual(k.enc, k.mac);
});

test('encrypt/decrypt round trip, bound to visit ID, tamper-proof', () => {
  const e = face(4);
  const sealed = lib.encryptTemplate(e, 'visitAAAAAAAAAA', keys.enc);
  assert.ok(!JSON.stringify(sealed).includes(String(e[0]).slice(0, 8)));
  const back = lib.decryptTemplate(sealed, 'visitAAAAAAAAAA', keys.enc);
  assert.equal(back.length, 1024);
  assert.ok(Math.abs(back[10] - e[10]) < 1e-6);
  // copied onto another visit: rejected
  assert.throws(() => lib.decryptTemplate(sealed, 'visitBBBBBBBBBB', keys.enc));
  // wrong key: rejected
  assert.throws(() => lib.decryptTemplate(sealed, 'visitAAAAAAAAAA', lib.deriveKeys(crypto.randomBytes(32).toString('base64')).enc));
  // modified data: rejected
  const t = { ...sealed, data: Buffer.from(sealed.data, 'base64').map((x, i) => (i === 3 ? x ^ 1 : x)).toString('base64') };
  assert.throws(() => lib.decryptTemplate(t, 'visitAAAAAAAAAA', keys.enc));
});

test('pickMatch: match, unknown, ambiguous, none', () => {
  const ali = face(10), siti = face(11), tan = face(12);
  const cands = [{ visitId: 'ali', embedding: ali }, { visitId: 'siti', embedding: siti }, { visitId: 'tan', embedding: tan }];
  const m = lib.pickMatch(noisy(ali, 0.6, 1), cands);
  assert.equal(m.status, 'match');
  assert.equal(m.visitId, 'ali');
  assert.equal(lib.pickMatch(face(99), cands).status, 'unknown');
  assert.equal(lib.pickMatch(face(99), []).status, 'none');
  // two nearly identical enrolled faces -> ambiguous, never auto-picked
  const twin = noisy(ali, 0.2, 5);
  const amb = lib.pickMatch(noisy(ali, 0.2, 6), [{ visitId: 'ali', embedding: ali }, { visitId: 'twin', embedding: twin }]);
  assert.equal(amb.status, 'ambiguous');
  assert.equal(amb.visitId, undefined);
});

test('match token: valid once for that visit, expires, cannot be forged', () => {
  const now = 1_000_000;
  const tok = lib.signToken('visitAAAAAAAAAA', keys.mac, 120000, now);
  assert.ok(lib.verifyToken(tok, 'visitAAAAAAAAAA', keys.mac, now + 1000));
  assert.ok(!lib.verifyToken(tok, 'visitBBBBBBBBBB', keys.mac, now + 1000));
  assert.ok(!lib.verifyToken(tok, 'visitAAAAAAAAAA', keys.mac, now + 130000));
  const other = lib.deriveKeys(crypto.randomBytes(32).toString('base64')).mac;
  assert.ok(!lib.verifyToken(tok, 'visitAAAAAAAAAA', other, now + 1000));
  const [body] = tok.split('.');
  const forged = `${Buffer.from(JSON.stringify({ v: 'visitAAAAAAAAAA', e: now + 9e9 })).toString('base64url')}.${tok.split('.')[1]}`;
  assert.ok(!lib.verifyToken(forged, 'visitAAAAAAAAAA', keys.mac, now + 1000));
  assert.ok(!lib.verifyToken('garbage', 'visitAAAAAAAAAA', keys.mac, now));
  assert.ok(body.length > 0);
});
