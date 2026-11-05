'use strict';
// VISTA shared helpers: Malaysia-time formatting, durations and input clean-up.
// Loaded before app.js and guard.js.

const VISTA_TZ = 'Asia/Kuala_Lumpur';

/** Firestore Timestamp | Date | string | null -> Date or null */
function toDate(x) {
  if (!x) return null;
  const d = x.toDate ? x.toDate() : x instanceof Date ? x : new Date(x);
  return isNaN(d) ? null : d;
}

const fmt = {
  // e.g. 05/11/2026
  date(x) { const d = toDate(x); return d ? d.toLocaleDateString('en-GB', { timeZone: VISTA_TZ }) : ''; },
  // e.g. 2:35 pm
  time(x) { const d = toDate(x); return d ? d.toLocaleTimeString('en-MY', { timeZone: VISTA_TZ, hour: 'numeric', minute: '2-digit', hour12: true }) : ''; },
  // e.g. 2:35:08 pm
  timeSec(x) { const d = toDate(x); return d ? d.toLocaleTimeString('en-MY', { timeZone: VISTA_TZ, hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }) : ''; },
  // e.g. Thu, 5 Nov 2026 · 2:35 pm
  dateTime(x) {
    const d = toDate(x);
    if (!d) return '';
    const day = d.toLocaleDateString('en-GB', { timeZone: VISTA_TZ, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    return `${day} · ${fmt.time(d)}`;
  },
  // e.g. Thursday, 5 November 2026
  longDate(x) { const d = toDate(x); return d ? d.toLocaleDateString('en-GB', { timeZone: VISTA_TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : ''; },
  /** 'YYYY-MM-DD' in Malaysia time, for date filters */
  dayKey(x) { const d = toDate(x); return d ? d.toLocaleDateString('en-CA', { timeZone: VISTA_TZ }) : ''; },
  /** ms -> "45m", "2h 05m" */
  duration(ms) {
    if (ms == null || ms < 0) return '—';
    const m = Math.floor(ms / 60000);
    if (m < 1) return 'Less than 1m';
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  },
};

/** Time on site for a visit: until check-out, or until now if still inside. */
function stayMs(v, now = new Date()) {
  const a = toDate(v.inAt);
  if (!a) return null;
  const b = toDate(v.outAt) || now;
  return b - a;
}

const clean = {
  /** Trim, collapse spaces, upper-case (matches how names appear on MyKad). */
  name(s) { return String(s || '').replace(/\s+/g, ' ').trim().toUpperCase(); },

  /** Returns an error message, or '' when valid. */
  nameError(s) {
    if (!s) return 'Please enter your full name.';
    if (s.length < 3) return 'Name is too short. Please enter your full name.';
    if (/\d/.test(s)) return 'Name should not contain numbers.';
    if (!/^[A-Z][A-Z @'.\/-]*$/.test(s)) return 'Name may only contain letters, spaces and @ \' . / -';
    if ((s.match(/[A-Z]/g) || []).length < 3) return 'Please enter your full name.';
    return '';
  },

  /** "taa1234" -> "TAA 1234", "w 1234a" -> "W 1234 A" */
  plate(s) {
    return String(s || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .replace(/([A-Z])(\d)/g, '$1 $2')
      .replace(/(\d)([A-Z])/g, '$1 $2')
      .trim();
  },

  /** Malaysian plates: letters, 1–4 digits, optional suffix letters (e.g. TAA 1234, W 1234 A, PUTRAJAYA 88). */
  plateError(s) {
    if (!s) return '';
    if (!/^[A-Z]{1,10} \d{1,4}( [A-Z]{1,2})?$/.test(s)) return 'Car plate looks incorrect. Example: TAA 1234 or W 1234 A.';
    return '';
  },

  purpose(s) { return String(s || '').replace(/\s+/g, ' ').trim(); },
};

/** Keep an element showing the current Malaysia time. */
function startClock(timeEl, dateEl) {
  const tick = () => {
    const now = new Date();
    if (timeEl) timeEl.textContent = fmt.timeSec(now);
    if (dateEl) dateEl.textContent = fmt.longDate(now);
  };
  tick();
  return setInterval(tick, 1000);
}

/** Document id for the one-active-visit lock of a name: "RAJESH A/L MURUGAN" -> "RAJESH_A_L_MURUGAN" */
function activeKey(name) {
  return clean.name(name).replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120) || 'UNKNOWN';
}
