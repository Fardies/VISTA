'use strict';
// FACE MATCHING WITH SHARED TEMPLATES (Spark plan, no Cloud Functions)
// Matching runs on the guard's phone (Human.js). The face templates (numbers, no photos)
// are saved in Firestore collection "faceTemplatesShared", so ANY signed-in guard phone can
// recognise a visitor that another guard phone checked in.
//  - Only the operator account can read or write them (see firestore.rules). Visitors cannot.
//  - Deleted at check-out (face or manual). Every template also has an expiry (24 hours);
//    expired or leftover templates are removed by the guard app when it is open.
//  - Templates made before this update stay in that phone's localStorage; they still work on
//    that phone only, until check-out or 24 hours (they are never uploaded).
// Matching rules are the same as functions/lib.js.

const FaceLocal = (() => {
  const STORE_KEY = 'vista_face_local_v1';
  const LOG_KEY = 'vista_face_testlog_v1';
  const RETENTION_MS = 24 * 3600e3;
  const MATCH = { threshold: 0.75, margin: 0.08 }; // strong match (keep in step with functions/lib.js)
  /** "Possible match": a lower score is accepted only when this person is clearly ahead of
   *  everyone else (e.g. glasses on/off, different lighting). The guard must check carefully. */
  const POSSIBLE = { threshold: 0.65, margin: 0.12 };

  // ---------- Storage (fails safely if the browser blocks storage) ----------
  function read(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  }
  function write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  }

  // Float32 -> base64 keeps each template small (about 5.5 KB)
  function pack(embedding) {
    const bytes = new Uint8Array(new Float32Array(embedding).buffer);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function unpack(b64) {
    const s = atob(b64);
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return Array.from(new Float32Array(bytes.buffer));
  }

  // ---------- Shared templates (Firestore) ----------
  const SHARED = 'faceTemplatesShared';
  let sharedDb = null;      // Firestore instance of the signed-in operator
  let sharedUnsub = null;   // stops the live listener
  let shared = {};          // { visitId: { e, es, expiresAt } } kept in memory only
  let sharedReady = false;  // first snapshot received
  let sharedError = '';     // why shared templates are unavailable (shown to the guard)
  let onChange = () => {};

  function sharedCol() { return sharedDb.collection(SHARED); }
  function expiresMs(t) { return t && t.expiresAt && typeof t.expiresAt.toMillis === 'function' ? t.expiresAt.toMillis() : 0; }

  /** Starts listening to the shared templates. Call once after the operator signs in. */
  function connect(db, changed = () => {}) {
    disconnect();
    sharedDb = db;
    onChange = changed;
    sharedUnsub = sharedCol().onSnapshot((snap) => {
      const next = {};
      snap.forEach((doc) => { next[doc.id] = doc.data(); });
      shared = next;
      sharedReady = true;
      sharedError = '';
      onChange();
    }, (err) => {
      shared = {};
      sharedReady = false;
      sharedError = err && err.code === 'permission-denied'
        ? 'Shared face storage is blocked. Publish the new firestore.rules, then refresh.'
        : 'Shared face storage is not available. Check the internet, or use manual.';
      onChange();
    });
  }
  /** Stops listening and forgets every template held in memory (sign-out). */
  function disconnect() {
    if (sharedUnsub) { sharedUnsub(); sharedUnsub = null; }
    sharedDb = null; shared = {}; sharedReady = false; sharedError = '';
  }
  const isReady = () => sharedReady;
  /** True while connecting (no answer yet and no error). */
  const loading = () => Boolean(sharedDb) && !sharedReady && !sharedError;
  /** Plain-language reason shared face data cannot be used right now, or ''. */
  function problem() {
    if (sharedReady) return '';
    return sharedError || 'Loading shared face data… try again in a few seconds.';
  }

  /** All usable templates: this phone's older local ones plus the shared ones (shared wins).
   *  Expired entries are ignored. { visitId: { e: average, es: [each frame] } } */
  function all() {
    const db = Object.assign({}, legacy());
    const now = Date.now();
    for (const [id, t] of Object.entries(shared)) {
      if (t && typeof t.e === 'string' && expiresMs(t) > now) db[id] = t;
    }
    return db;
  }

  /** Templates saved in this browser by the older version (kept so existing visitors still work). */
  function legacy() {
    const db = read(STORE_KEY, {});
    const now = Date.now();
    let changed = false;
    for (const [id, t] of Object.entries(db)) {
      if (!t || (!t.e && !Array.isArray(t.es)) || !Number.isFinite(t.at) || now - t.at > RETENTION_MS) { delete db[id]; changed = true; }
    }
    if (changed) write(STORE_KEY, db);
    return db;
  }

  function validEmbedding(e) {
    return Array.isArray(e) && e.length === 1024 && e.every(Number.isFinite);
  }

  /** Adds "save this visitor's face template" to a Firestore batch (commit it together with the check-in). */
  function queueSave(batch, visitId, embedding, samples = []) {
    if (!sharedReady) throw new Error(problem());
    if (!validEmbedding(embedding)) throw new Error('Invalid face data. Scan again.');
    const good = samples.filter(validEmbedding).slice(0, 5);
    batch.set(sharedCol().doc(visitId), {
      e: pack(embedding),
      es: good.map(pack),
      expiresAt: firebase.firestore.Timestamp.fromMillis(Date.now() + RETENTION_MS),
    });
  }
  /** Adds "delete this visitor's face template" to a Firestore batch (commit it together with the check-out). */
  function queueDelete(batch, visitId) {
    if (sharedDb) batch.delete(sharedCol().doc(visitId));
  }
  /** Forgets a visitor's template on this phone (memory + older local copy) after a successful delete. */
  function forgetLocal(visitId) {
    delete shared[visitId];
    const db = read(STORE_KEY, {});
    if (db[visitId]) { delete db[visitId]; write(STORE_KEY, db); }
  }
  /** Deletes a visitor's template everywhere (shared + this phone). Rejects if the shared delete fails. */
  async function remove(visitId) {
    if (sharedDb) await sharedCol().doc(visitId).delete();
    forgetLocal(visitId);
  }
  /** Removes expired templates, and templates of visits that are finished (isFinished(visitId) true). */
  let purging = false;
  async function purge(isFinished) {
    if (!sharedDb || !sharedReady || purging) return 0;
    purging = true;
    try {
      const now = Date.now();
      const ids = Object.keys(shared).filter((id) => expiresMs(shared[id]) <= now || isFinished(id));
      let n = 0;
      for (const id of ids) { try { await remove(id); n++; } catch { /* try again next time */ } }
      return n;
    } finally { purging = false; }
  }
  function has(visitId) { return Boolean(all()[visitId]); }
  function count() { return Object.keys(all()).length; }
  function clear() { try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ } }

  // ---------- Matching (same maths as Human.js and functions/lib.js) ----------
  function similarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let sum = 0;
    for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; sum += d * d; }
    const dist = 25 * sum; // unrounded for finer comparisons
    if (dist === 0) return 1;
    const norm = (1 - Math.sqrt(dist) / 100 - 0.2) / 0.6;
    return Math.max(Math.min(norm, 1), 0);
  }

  /** Average of the two strongest scores against the saved frames (not one lucky hit). */
  function top2(p, savedFrames) {
    const scores = savedFrames.map((t) => similarity(p, t)).sort((a, b) => b - a);
    return scores.length > 1 ? (scores[0] + scores[1]) / 2 : (scores[0] || 0);
  }

  /**
   * Robust score between a new scan and one saved person.
   * - Each new frame is compared with all saved frames (average of its 2 best scores).
   * - The middle value (median) across new frames is used, so one blurry frame, glasses
   *   glare or a shadow does not decide the result.
   * - The averaged new scan is a second opinion; the higher of the two is kept.
   */
  function personScore(probe, saved) {
    const encoded = [saved.e, ...(Array.isArray(saved.es) ? saved.es : []), ...(Array.isArray(saved.s) ? saved.s : [])]
      .filter((x) => typeof x === 'string');
    const savedFrames = [];
    for (const x of encoded) { try { savedFrames.push(unpack(x)); } catch { /* skip damaged entry */ } }
    if (!savedFrames.length) return 0;
    const probeFrames = (probe.samples || probe.embeddings || []).filter(validEmbedding);
    const perFrame = (probeFrames.length ? probeFrames : [probe.embedding]).map((p) => top2(p, savedFrames)).sort((a, b) => a - b);
    const median = perFrame[Math.floor(perFrame.length / 2)];
    return Math.max(median, top2(probe.embedding, savedFrames));
  }

  /** Every saved person (optionally only onlyIds), most similar first: [{ id, score }]. */
  function rank(probe, onlyIds = null) {
    if (Array.isArray(probe)) probe = { embedding: probe, samples: [probe] };
    const db = all();
    return Object.keys(db)
      .filter((id) => !onlyIds || onlyIds.has(id))
      .map((id) => ({ id, score: Math.round(100 * personScore(probe, db[id])) / 100 }))
      .sort((a, b) => b.score - a.score);
  }

  /** The most similar saved person if the face looks alike (>= possible level), else null. */
  function similar(probe, onlyIds = null) {
    const top = rank(probe, onlyIds)[0];
    return top && top.score >= POSSIBLE.threshold ? top : null;
  }

  /**
   * Compares a scan { embedding, samples } with saved people. onlyIds: limit to these visits.
   * Returns { status: 'match'|'possible'|'unknown'|'ambiguous'|'none', visitId?, best, second, candidates? }.
   *  match     = strong (>= threshold and clearly ahead of the next person)
   *  possible  = 65%+ and well ahead of everyone else
   *  ambiguous = several people look alike; candidates = up to 3 of them, most similar first
   */
  function match(probe, onlyIds = null) {
    const scored = rank(probe, onlyIds);
    if (!scored.length) return { status: 'none', best: null, second: null };
    const best = scored[0].score;
    const second = scored[1] ? scored[1].score : 0;
    const gap = best - second;
    if (best >= MATCH.threshold && gap >= MATCH.margin) return { status: 'match', visitId: scored[0].id, best, second };
    if (best >= POSSIBLE.threshold && gap >= POSSIBLE.margin) return { status: 'possible', visitId: scored[0].id, best, second };
    if (best >= POSSIBLE.threshold) {
      const candidates = scored.filter((x) => best - x.score < POSSIBLE.margin).slice(0, 3).map((x) => x.id);
      return { status: 'ambiguous', best, second, candidates };
    }
    return { status: 'unknown', best, second };
  }

  // ---------- Test log (for accuracy testing; no face data) ----------
  function log(entry) {
    const list = read(LOG_KEY, []);
    list.push({ time: new Date().toISOString(), ...entry });
    write(LOG_KEY, list.slice(-500));
  }
  function logs() { return read(LOG_KEY, []); }
  function clearLog() { try { localStorage.removeItem(LOG_KEY); } catch { /* ignore */ } }

  function logCsv() {
    const cols = ['time', 'event', 'visitor', 'result', 'best', 'second', 'consistency', 'real', 'live'];
    const cell = (x) => `"${String(x ?? '').replace(/"/g, '""')}"`;
    const rows = logs().map((r) => cols.map((c) => cell(r[c])).join(','));
    return `﻿${cols.join(',')}\r\n${rows.join('\r\n')}`;
  }

  return { MATCH, POSSIBLE, connect, disconnect, isReady, loading, problem, queueSave, queueDelete, forgetLocal, remove, purge, rank, similar, has, count, clear, all, match, similarity, log, logs, clearLog, logCsv };
})();