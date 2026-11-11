'use strict';
// LOCAL FACE MATCHING (Spark plan, no Cloud Functions)
// Face templates are saved ONLY in this browser (localStorage) on the guard's phone.
// Nothing biometric is uploaded to Firestore. Check-in and check-out must use the
// same phone and browser. Templates are deleted at check-out or after 24 hours.
// Matching rules are the same as functions/lib.js, so results carry over to the
// Cloud Functions version later.

const FaceLocal = (() => {
  const STORE_KEY = 'vista_face_local_v1';
  const LOG_KEY = 'vista_face_testlog_v1';
  const RETENTION_MS = 24 * 3600e3;
  const MATCH = { threshold: 0.78, margin: 0.08 }; // keep in step with functions/lib.js

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

  /** All saved templates, with expired ones removed. { visitId: { e, name, at } } */
  function all() {
    const db = read(STORE_KEY, {});
    const now = Date.now();
    let changed = false;
    for (const [id, t] of Object.entries(db)) {
      if (!t || !t.e || now - t.at > RETENTION_MS) { delete db[id]; changed = true; }
    }
    if (changed) write(STORE_KEY, db);
    return db;
  }

  function save(visitId, name, embedding) {
    const db = all();
    db[visitId] = { e: pack(embedding), name, at: Date.now() };
    if (!write(STORE_KEY, db)) throw new Error('This browser could not save face data (storage blocked or full). Use manual instead.');
  }
  function remove(visitId) { const db = all(); if (db[visitId]) { delete db[visitId]; write(STORE_KEY, db); } }
  function has(visitId) { return Boolean(all()[visitId]); }
  function count() { return Object.keys(all()).length; }
  function clear() { try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ } }

  // ---------- Matching (same maths as Human.js and functions/lib.js) ----------
  function similarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let sum = 0;
    for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; sum += d * d; }
    const dist = Math.round(100 * 25 * sum) / 100;
    if (dist === 0) return 1;
    const norm = (1 - Math.sqrt(dist) / 100 - 0.2) / 0.6;
    return Math.round(100 * Math.max(Math.min(norm, 1), 0)) / 100;
  }

  /**
   * Compares a scan with saved templates. onlyIds: limit to these visits (e.g. visitors inside).
   * Returns { status: 'match'|'unknown'|'ambiguous'|'none', visitId?, best, second }.
   */
  function match(probe, onlyIds = null) {
    const db = all();
    const ids = Object.keys(db).filter((id) => !onlyIds || onlyIds.has(id));
    if (!ids.length) return { status: 'none', best: null, second: null };
    const scored = ids.map((id) => ({ id, score: similarity(probe, unpack(db[id].e)) })).sort((a, b) => b.score - a.score);
    const best = scored[0].score;
    const second = scored[1] ? scored[1].score : 0;
    if (best < MATCH.threshold) return { status: 'unknown', best, second };
    if (best - second < MATCH.margin) return { status: 'ambiguous', best, second };
    return { status: 'match', visitId: scored[0].id, best, second };
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

  return { MATCH, save, remove, has, count, clear, all, match, similarity, log, logs, clearLog, logCsv };
})();
