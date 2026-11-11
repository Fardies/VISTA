'use strict';
// VISTA operator: Firebase email/password operator login (email checked here AND in firestore.rules).

const OPERATOR_EMAIL = 'operator@gmail.com';
const LONG_STAY_HOURS = 8; // highlight visitors inside longer than this
const EXCELJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js';
const $ = (id) => document.getElementById(id);
let visits = [], unsubscribe = null, authorized = false, refreshTimer = null;
let showEarlier = false; // show visitors from earlier days who are still inside

const setError = (id, msg) => { $(id).textContent = msg; $(id).hidden = !msg; };
const squash = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
const sortMs = (v) => { const d = toDate(v.inAt || v.createdAt); return d ? d.getTime() : 0; };
const byNewest = (a, b) => sortMs(b) - sortMs(a);

// ---------- Visit state ----------
/** 'pending' | 'in' | 'out' | 'cancelled'. Visits made before the face upgrade have no status. */
const state = (v) => (v.status === 'pending' ? 'pending' : v.status === 'cancelled' ? 'cancelled' : (v.outAt ? 'out' : 'in'));
const isVisit = (v) => state(v) === 'in' || state(v) === 'out'; // pending and cancelled are not visits yet
const isOpen = (v) => state(v) === 'in' || state(v) === 'pending';
/** Day of check-in, or day of registration while still pending (YYYY-MM-DD, Malaysia time) */
const visitDay = (v) => fmt.dayKey(v.inAt || v.createdAt);

startClock($('clock-time'), $('clock-date'));

// ---------- Day scope: today only by default ----------
const todayKey = () => fmt.dayKey(new Date());
const customRange = () => Boolean($('from').value || $('to').value);

function niceKey(k) {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
}

/** Visitors from earlier days who are still inside, or registered but were never checked in. */
function earlierOpen() {
  const t = todayKey();
  return visits.filter((v) => { const d = visitDay(v); return isOpen(v) && d && d < t; });
}

/** Registrations made today that are waiting for the guard (first come, first served). */
function pendingToday() {
  const t = todayKey();
  return visits.filter((v) => state(v) === 'pending' && visitDay(v) === t).sort((a, b) => sortMs(a) - sortMs(b));
}

/** Records for the day(s) being viewed: today, or the dates chosen in the filter. */
function dateScoped() {
  const from = $('from').value, to = $('to').value;
  if (from || to) {
    return visits.filter((v) => { const d = visitDay(v); return (!from || d >= from) && (!to || d <= to); });
  }
  const t = todayKey();
  return visits.filter((v) => {
    const d = visitDay(v);
    return !d || d === t || (showEarlier && isOpen(v) && d < t);
  });
}

function viewLabel() {
  const from = $('from').value, to = $('to').value;
  if (!from && !to) return `Showing today · ${fmt.longDate(new Date())}`;
  if (from && to) return from === to ? `Showing ${niceKey(from)}` : `Showing ${niceKey(from)} – ${niceKey(to)}`;
  return from ? `Showing from ${niceKey(from)}` : `Showing up to ${niceKey(to)}`;
}

// ---------- Filtering ----------
const STATUS_MAP = { pending: 'pending', inside: 'in', out: 'out', cancelled: 'cancelled' };

function filtered(list = dateScoped()) {
  const term = squash($('search').value);
  const status = $('status').value;
  return list.filter((v) => {
    // spaces ignored, so "taa1234" finds "TAA 1234"
    if (term && !squash(`${v.name} ${v.car} ${v.purpose}`).includes(term)) return false;
    if (status === 'all') return state(v) !== 'cancelled'; // cancelled registrations show only when chosen
    return state(v) === STATUS_MAP[status];
  }).sort(byNewest);
}

// ---------- Rendering ----------
function row(label, value, cls) {
  const p = document.createElement('p');
  const strong = document.createElement('strong');
  strong.textContent = `${label}: `;
  const span = document.createElement('span');
  span.textContent = value;
  if (cls) span.className = cls;
  p.append(strong, span);
  return p;
}

function badge(text, cls) {
  const b = document.createElement('span');
  b.className = `badge ${cls}`;
  b.textContent = text;
  return b;
}

/** A button that asks for confirmation, runs an action, and re-enables itself on failure. */
function actionButton(label, cls, confirmText, action) {
  const btn = document.createElement('button');
  btn.className = `btn ${cls}`;
  btn.type = 'button';
  btn.textContent = label;
  btn.addEventListener('click', async () => {
    if (!confirm(confirmText())) return;
    btn.disabled = true;
    try {
      await action();
    } catch (e) {
      alert(`Unable to complete this action: ${e.message}`);
      btn.disabled = false;
    }
  });
  return btn;
}

function buildCard(v, now) {
  const st = state(v);
  const ms = stayMs(v, now);
  const long = st === 'in' && ms != null && ms > LONG_STAY_HOURS * 3600e3;
  const card = document.createElement('article');
  card.className = `record-card ${st === 'pending' ? 'is-pending' : (st === 'in' ? 'is-in' : 'is-out')}${long ? ' is-long' : ''}`;

  const head = document.createElement('div');
  head.className = 'record-head';
  const h = document.createElement('h3');
  h.textContent = v.name;
  const tags = document.createElement('div');
  tags.className = 'badges';
  if (st === 'pending') tags.append(badge('Pending Check-In', 'pending'));
  else if (st === 'cancelled') tags.append(badge('Cancelled', 'out'));
  else tags.append(badge(st === 'out' ? 'Checked Out' : 'Inside', st === 'out' ? 'out' : 'in'));
  if (long) tags.append(badge(`Over ${LONG_STAY_HOURS}h`, 'warn'));
  if (v.source === 'guard') tags.append(badge('Walk-in', 'guard'));
  if (st === 'pending') tags.append(badge(v.faceConsent ? 'Face check-in' : 'Manual only', v.faceConsent ? 'guard' : 'out'));
  const faceIn = String(v.checkInMethod || '').startsWith('face');
  const faceOut = String(v.checkOutMethod || '').startsWith('face');
  if (st !== 'pending' && faceIn) tags.append(badge(faceOut ? 'Face in/out' : 'Face check-in', 'guard'));
  head.append(h, tags);

  card.append(head, row('Purpose of Visit', v.purpose || '—'), row('Car Plate Number', v.car || '—', 'mono'));

  if (st === 'pending' || st === 'cancelled') {
    card.append(row('Registered', `${fmt.time(v.createdAt) || '—'} · ${fmt.date(v.createdAt)}`));
  } else {
    const times = document.createElement('div');
    times.className = 'time-strip';
    const cell = (label, big, small) => {
      const d = document.createElement('div');
      const s = document.createElement('small'); s.textContent = label;
      const b = document.createElement('b'); b.className = 'mono'; b.textContent = big;
      const sp = document.createElement('span'); sp.textContent = small;
      d.append(s, b, sp);
      return d;
    };
    times.append(
      cell('Check-In', fmt.time(v.inAt) || '—', fmt.date(v.inAt)),
      cell('Check-Out', fmt.time(v.outAt) || '—', v.outAt ? fmt.date(v.outAt) : 'Still inside'),
      cell(st === 'out' ? 'Time on Site' : 'Inside For', fmt.duration(ms), st === 'out' ? '' : 'and counting'),
    );
    card.append(times);
  }

  if (st === 'pending') {
    if (v.faceConsent) {
      const scanBtn = document.createElement('button');
      scanBtn.type = 'button';
      scanBtn.className = 'btn primary';
      scanBtn.textContent = 'Scan Face';
      scanBtn.addEventListener('click', () => window.openFaceCheckIn && window.openFaceCheckIn(v));
      card.append(scanBtn);
    }
    card.append(
      actionButton(v.faceConsent ? 'Manual Check In' : 'Check In', v.faceConsent ? 'secondary' : 'primary',
        () => `Check in ${v.name}?\nCheck-in time will be recorded as now (${fmt.time(new Date())}).`,
        () => checkInVisit(v)),
      actionButton('Cancel Registration', 'secondary',
        () => `Cancel the registration for ${v.name}?\nThis visitor will not be checked in.`,
        () => cancelVisit(v)),
    );
  } else if (st === 'in') {
    card.append(actionButton('Manual Check-Out', 'secondary',
      () => `Confirm that ${v.name} has left the premises?\nCheck-out time will be recorded as now (${fmt.time(new Date())}).`,
      () => checkOutVisit(v)));
  }
  return card;
}

function render() {
  const now = new Date();

  // Earlier-day visitors still open (only relevant in the default "today" view)
  const earlyAll = earlierOpen();
  if (!earlyAll.length) showEarlier = false;
  const early = customRange() ? [] : earlyAll;
  const carry = $('carry-over');
  carry.hidden = !early.length;
  if (early.length) {
    const inside = early.filter((v) => state(v) === 'in').length;
    const waiting = early.length - inside;
    const parts = [];
    if (inside) parts.push(`${inside} visitor${inside === 1 ? '' : 's'} still marked inside`);
    if (waiting) parts.push(`${waiting} registration${waiting === 1 ? '' : 's'} never checked in`);
    $('carry-text').textContent = `From earlier days: ${parts.join(' and ')}.`;
    $('carry-toggle').textContent = showEarlier ? 'Hide them' : 'Show them';
  }

  const scoped = dateScoped();
  const count = (s) => scoped.filter((v) => state(v) === s).length;
  const nIn = count('in'), nOut = count('out');
  $('view-label').textContent = viewLabel();
  $('inside').textContent = nIn;
  $('pending').textContent = count('pending');
  $('outside').textContent = nOut;
  $('total').textContent = nIn + nOut;

  // Face Scanner section: today's registrations waiting for the guard
  const queue = pendingToday();
  const faceInside = window.faceInsideCount ? window.faceInsideCount() : 0;
  $('face-inside-count').textContent = faceInside ? `${faceInside} can check out by face` : 'No one to check out by face.';
  $('pending-count').textContent = queue.length;
  $('pending-count').hidden = !queue.length;
  const pl = $('pending-list');
  pl.replaceChildren();
  if (!queue.length) {
    const p = document.createElement('p');
    p.className = 'help-text';
    p.textContent = 'No visitors are waiting for check-in.';
    pl.append(p);
  } else {
    for (const v of queue) pl.append(buildCard(v, now));
  }

  // Visitor Records section
  const status = $('status').value;
  const base = scoped.filter((v) => (state(v) === 'cancelled') === (status === 'cancelled')).length;
  const matches = filtered(scoped);
  const box = $('records');
  $('result-count').textContent = `Showing ${matches.length} of ${base} ${status === 'cancelled' ? 'cancelled registrations' : 'records'}`;
  box.replaceChildren();
  if (!matches.length) {
    const p = document.createElement('p');
    p.className = 'help-text';
    p.textContent = base
      ? 'No matching visitor records.'
      : (customRange() ? 'No visitor records in this date range.' : 'No visitors have registered or checked in today yet.');
    box.append(p);
    return;
  }
  for (const v of matches) box.append(buildCard(v, now));
}

// ---------- Guard actions on a visit ----------
const visitRef = (v) => vistaDb.collection('visits').doc(v.id);
const serverTime = () => firebase.firestore.FieldValue.serverTimestamp();

// Face check-in/check-out use Cloud Functions (face-scanner.js); these are the manual paths.

/** Pending Check-In -> Checked In (manual). The check-in time is recorded by the server. */
async function checkInVisit(v) { await visitRef(v).update({ status: 'in', inAt: serverTime(), checkInMethod: 'manual' }); }

/** Pending Check-In -> Cancelled (visitor did not arrive, or registered by mistake). */
async function cancelVisit(v) {
  await visitRef(v).update({ status: 'cancelled' });
  if (window.releaseFaceTemplate) window.releaseFaceTemplate(v);
}

/** Checked In -> Checked Out (manual). Also deletes the visitor's face template, if any. */
async function checkOutVisit(v) {
  await visitRef(v).update({ status: 'out', outAt: serverTime(), checkOutMethod: 'manual' });
  if (window.releaseFaceTemplate) window.releaseFaceTemplate(v);
}

// ---------- Export: date-range sheet ----------
const pad2 = (n) => String(n).padStart(2, '0');
let exportMode = 'day';

/** [start, end] as YYYY-MM-DD in Malaysia time */
function rangeFor(mode) {
  const today = fmt.dayKey(new Date());
  const [y, m, d] = today.split('-').map(Number);
  const key = (dt) => `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
  if (mode === 'day') return [today, today];
  if (mode === 'week') return [key(new Date(Date.UTC(y, m - 1, d - 6))), today];
  if (mode === 'month') return [`${y}-${pad2(m)}-01`, today];
  if (mode === 'year') return [`${y}-01-01`, today];
  return ['', ''];
}

function exportList() {
  const s = $('export-start').value, e = $('export-end').value;
  if (exportMode !== 'all' && s && e && e < s) return null;
  return visits.filter(isVisit).filter((v) => {
    if (exportMode === 'all') return true;
    const d = fmt.dayKey(v.inAt);
    if (!d) return false;
    return (!s || d >= s) && (!e || d <= e);
  }).sort(byNewest);
}

function markChips() {
  document.querySelectorAll('#export-modal [data-range]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.range === exportMode)));
}

function refreshExportCount() {
  if ($('export-modal').hidden) return;
  const note = $('export-count'), go = $('export-go'), list = exportList();
  note.classList.toggle('warn', !list || !list.length);
  if (!list) { note.textContent = 'End date must be the same as or after the start date.'; go.disabled = true; return; }
  if (!list.length) { note.textContent = 'No visitor records in this range.'; go.disabled = true; return; }
  note.textContent = `${list.length} ${list.length === 1 ? 'record' : 'records'} will be exported.`;
  go.disabled = false;
}

function setExportMode(mode) {
  exportMode = mode;
  markChips();
  const s = $('export-start'), e = $('export-end');
  if (mode === 'all') { s.value = ''; e.value = ''; } else if (mode !== 'range') { [s.value, e.value] = rangeFor(mode); }
  s.disabled = e.disabled = (mode === 'all');
  refreshExportCount();
}

function openExport() {
  if (!authorized) return;
  $('export-modal').hidden = false;
  document.body.classList.add('modal-open');
  setExportMode('day');
  const first = document.querySelector('#export-modal [data-range="day"]');
  if (first) first.focus();
}

function closeExport() { $('export-modal').hidden = true; document.body.classList.remove('modal-open'); }

// ---------- Export: formatted Excel report ----------
function loadExcelJS() {
  if (window.ExcelJS) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = EXCELJS_URL;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Excel library could not be loaded'));
    document.head.append(s);
  });
}

function periodLabel() {
  const s = $('export-start').value, e = $('export-end').value;
  const nice = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' }); };
  if (exportMode === 'all' || (!s && !e)) return 'All records';
  if (s === e) return nice(s);
  return `${s ? nice(s) : 'Beginning'} – ${e ? nice(e) : 'Today'}`;
}

function fileTag() {
  const s = $('export-start').value, e = $('export-end').value;
  if (exportMode === 'all') return 'All';
  return s && e ? (s === e ? s : `${s}_to_${e}`) : (s || e || 'All');
}

function reportRows(list, now) {
  return list.map((v, i) => {
    const ms = stayMs(v, now);
    return {
      no: i + 1,
      name: v.name,
      purpose: v.purpose || '',
      car: v.car || '—',
      inDate: fmt.date(v.inAt),
      inTime: fmt.time(v.inAt),
      outDate: v.outAt ? fmt.date(v.outAt) : '—',
      outTime: v.outAt ? fmt.time(v.outAt) : '—',
      stay: v.outAt ? fmt.duration(ms) : `${fmt.duration(ms)} (inside)`,
      status: v.outAt ? 'Checked Out' : 'Inside',
      entry: v.source === 'guard' ? 'Walk-in (guard)' : (String(v.checkInMethod || '').startsWith('face') ? 'Online registration · Face' : 'Online registration'),
    };
  });
}

function summary(list, now) {
  const done = list.filter((v) => v.outAt).map((v) => stayMs(v, now)).filter((x) => x != null);
  const avg = done.length ? done.reduce((a, b) => a + b, 0) / done.length : null;
  return {
    total: list.length,
    inside: list.filter((v) => !v.outAt).length,
    out: list.filter((v) => v.outAt).length,
    walkIn: list.filter((v) => v.source === 'guard').length,
    avg: avg == null ? '—' : fmt.duration(avg),
  };
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function buildXlsx(list) {
  const now = new Date();
  const rows = reportRows(list, now);
  const sum = summary(list, now);
  const C = { green: 'FF173C32', green2: 'FF216047', mint: 'FFE8F2EB', zebra: 'FFF6FAF6', line: 'FFCFDDD2', grey: 'FF6B7B70', inFill: 'FFDFF0E4', inText: 'FF1D6A43', outFill: 'FFECEFF0', outText: 'FF5F6D66', white: 'FFFFFFFF' };

  const wb = new ExcelJS.Workbook();
  wb.creator = 'VISTA';
  wb.created = now;
  const ws = wb.addWorksheet('Visitor Report', {
    views: [{ state: 'frozen', ySplit: 10, showGridLines: false }],
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } },
    headerFooter: { oddFooter: '&L VISTA Visitor Report&R Page &P of &N' },
  });

  const cols = [
    ['No.', 'no', 6], ['Visitor Name', 'name', 30], ['Purpose of Visit', 'purpose', 24], ['Car Plate', 'car', 13],
    ['Check-In Date', 'inDate', 14], ['Check-In Time', 'inTime', 13], ['Check-Out Date', 'outDate', 14], ['Check-Out Time', 'outTime', 14],
    ['Time on Site', 'stay', 17], ['Status', 'status', 14], ['Entry Type', 'entry', 17],
  ];
  ws.columns = cols.map(([, key, width]) => ({ key, width }));
  const last = String.fromCharCode(64 + cols.length); // K

  // Title block
  ws.mergeCells(`A1:${last}1`);
  Object.assign(ws.getCell('A1'), { value: 'VISTA  ·  VISITOR REPORT' });
  ws.getCell('A1').font = { name: 'Calibri', size: 18, bold: true, color: { argb: C.white } };
  ws.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.green } };
  ws.getCell('A1').alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  ws.getRow(1).height = 34;

  ws.mergeCells(`A2:${last}2`);
  ws.getCell('A2').value = 'Visitor Information & Smart Tracking Application';
  ws.getCell('A2').font = { size: 11, italic: true, color: { argb: 'FFC7DACF' } };
  ws.getCell('A2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.green } };
  ws.getCell('A2').alignment = { vertical: 'middle', indent: 1 };
  ws.getRow(2).height = 20;

  // Report details (left) and summary (right)
  const info = [
    ['Report Period', periodLabel()],
    ['Generated On', `${fmt.longDate(now)}, ${fmt.time(now)}`],
    ['Generated By', vistaAuth.currentUser?.email || 'Operator'],
  ];
  const sums = [['Total Visits', sum.total], ['Currently Inside', sum.inside], ['Checked Out', sum.out], ['Average Time on Site', sum.avg]];
  for (let i = 0; i < 4; i++) {
    const r = 4 + i;
    if (info[i]) {
      ws.getCell(`A${r}`).value = info[i][0];
      ws.mergeCells(`A${r}:B${r}`);
      ws.getCell(`A${r}`).font = { bold: true, color: { argb: C.grey }, size: 10 };
      ws.mergeCells(`C${r}:F${r}`);
      ws.getCell(`C${r}`).value = info[i][1];
      ws.getCell(`C${r}`).font = { size: 11, color: { argb: C.green } };
    }
    ws.mergeCells(`H${r}:I${r}`);
    ws.getCell(`H${r}`).value = sums[i][0];
    ws.getCell(`H${r}`).font = { bold: true, size: 10, color: { argb: C.grey } };
    ws.getCell(`J${r}`).value = sums[i][1];
    ws.getCell(`J${r}`).font = { bold: true, size: 12, color: { argb: C.green2 } };
    ws.getCell(`J${r}`).alignment = { horizontal: 'center' };
    for (const c of ['H', 'I', 'J']) {
      ws.getCell(`${c}${r}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.mint } };
      ws.getCell(`${c}${r}`).border = { bottom: { style: 'thin', color: { argb: C.white } } };
    }
  }

  // Section label
  ws.mergeCells(`A9:${last}9`);
  ws.getCell('A9').value = `VISITOR RECORDS  (${rows.length})`;
  ws.getCell('A9').font = { bold: true, size: 10, color: { argb: 'FF428366' } };

  // Table header
  const HEADER = 10;
  const hr = ws.getRow(HEADER);
  cols.forEach(([label], i) => { hr.getCell(i + 1).value = label; });
  hr.height = 24;
  hr.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: C.white }, size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.green2 } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = { top: { style: 'thin', color: { argb: C.green2 } }, bottom: { style: 'thin', color: { argb: C.green2 } }, left: { style: 'thin', color: { argb: 'FF2E7457' } }, right: { style: 'thin', color: { argb: 'FF2E7457' } } };
  });

  // Data rows
  const center = new Set(['no', 'car', 'inDate', 'inTime', 'outDate', 'outTime', 'stay', 'status']);
  rows.forEach((data, i) => {
    const r = ws.getRow(HEADER + 1 + i);
    cols.forEach(([, key], c) => { r.getCell(c + 1).value = data[key]; });
    r.height = 20;
    r.eachCell({ includeEmpty: true }, (cell, colNo) => {
      const key = cols[colNo - 1][1];
      cell.font = { size: 10.5, color: { argb: 'FF20372F' }, bold: key === 'name' };
      cell.alignment = { vertical: 'middle', horizontal: center.has(key) ? 'center' : 'left', indent: center.has(key) ? 0 : 1 };
      cell.border = { bottom: { style: 'thin', color: { argb: C.line } }, left: { style: 'thin', color: { argb: C.line } }, right: { style: 'thin', color: { argb: C.line } } };
      if (i % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.zebra } };
      if (key === 'status') {
        const inside = data.status === 'Inside';
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: inside ? C.inFill : C.outFill } };
        cell.font = { size: 10.5, bold: true, color: { argb: inside ? C.inText : C.outText } };
      }
    });
  });
  ws.autoFilter = { from: { row: HEADER, column: 1 }, to: { row: HEADER, column: cols.length } };

  // Closing note
  const endRow = HEADER + rows.length + 2;
  ws.mergeCells(`A${endRow}:${last}${endRow}`);
  ws.getCell(`A${endRow}`).value = `End of report · ${rows.length} record${rows.length === 1 ? '' : 's'} · Times shown in Malaysia time (GMT+8) · Confidential: contains personal data, handle in accordance with PDPA 2010.`;
  ws.getCell(`A${endRow}`).font = { italic: true, size: 9, color: { argb: C.grey } };

  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

/** Fallback when the Excel library cannot load (no internet): CSV with a title block. */
function buildCsv(list) {
  const now = new Date();
  const sum = summary(list, now);
  const cell = (x) => { let s = String(x ?? ''); if (/^[\s]*[=+@\-]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; };
  const lines = [
    ['VISTA - VISITOR REPORT'], ['Visitor Information & Smart Tracking Application'], [],
    ['Report Period', periodLabel()], ['Generated On', `${fmt.longDate(now)}, ${fmt.time(now)}`],
    ['Total Visits', sum.total], ['Currently Inside', sum.inside], ['Checked Out', sum.out], ['Average Time on Site', sum.avg], [],
    ['No.', 'Visitor Name', 'Purpose of Visit', 'Car Plate', 'Check-In Date', 'Check-In Time', 'Check-Out Date', 'Check-Out Time', 'Time on Site', 'Status', 'Entry Type'],
    ...reportRows(list, now).map((r) => [r.no, r.name, r.purpose, r.car, r.inDate, r.inTime, r.outDate, r.outTime, r.stay, r.status, r.entry]),
  ];
  return new Blob([`\uFEFF${lines.map((l) => l.map(cell).join(',')).join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
}

async function doExport() {
  const list = exportList();
  if (!list || !list.length) return;
  const go = $('export-go');
  go.disabled = true;
  go.textContent = 'Preparing…';
  const name = `VISTA_Visitor_Report_${fileTag()}`;
  try {
    await loadExcelJS();
    download(await buildXlsx(list), `${name}.xlsx`);
  } catch (err) {
    console.warn('Excel export failed, using CSV:', err);
    download(buildCsv(list), `${name}.csv`);
    alert('The Excel library could not be loaded (check the internet connection). A CSV file was downloaded instead.');
  } finally {
    go.textContent = 'Export';
    go.disabled = false;
    closeExport();
  }
}

$('export').addEventListener('click', openExport);
$('export-cancel').addEventListener('click', closeExport);
$('export-go').addEventListener('click', doExport);
document.querySelectorAll('#export-modal [data-range]').forEach((b) => b.addEventListener('click', () => setExportMode(b.dataset.range)));
for (const id of ['export-start', 'export-end']) $(id).addEventListener('change', () => { exportMode = 'range'; markChips(); refreshExportCount(); });
$('export-modal').addEventListener('click', (e) => { if (e.target === $('export-modal')) closeExport(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('export-modal').hidden) closeExport(); });

// ---------- Filters ----------
for (const id of ['search', 'status', 'from', 'to']) $(id).addEventListener(id === 'search' ? 'input' : 'change', render);
$('refresh').addEventListener('click', () => { if (authorized) { if (unsubscribe) unsubscribe(); subscribe(); } });
$('reset-filters').addEventListener('click', () => { for (const id of ['search', 'from', 'to']) $(id).value = ''; $('status').value = 'all'; showEarlier = false; render(); });
$('carry-toggle').addEventListener('click', () => { showEarlier = !showEarlier; render(); });
// When the tab wakes up (e.g. next morning), re-check which day it is
document.addEventListener('visibilitychange', () => { if (authorized && document.visibilityState === 'visible') render(); });

// ---------- Dashboard sections ----------
function showTab(name) {
  for (const t of ['records', 'scanner']) {
    const on = t === name;
    $(`tab-${t}`).hidden = !on;
    $(`tab-${t}-btn`).setAttribute('aria-selected', String(on));
    $(`tab-${t}-btn`).classList.toggle('active', on);
  }
}
$('tab-records-btn').addEventListener('click', () => showTab('records'));
$('tab-scanner-btn').addEventListener('click', () => showTab('scanner'));

// ---------- Walk-in check-in by guard ----------
const mPurpose = $('manual-purpose'), mOther = $('manual-other'), mOtherWrap = $('manual-other-wrap'), mName = $('manual-name'), mCar = $('manual-car');
let manualBusy = false;
mPurpose.addEventListener('change', () => { mOtherWrap.hidden = mPurpose.value !== 'Other'; mOther.required = mPurpose.value === 'Other'; if (!mOther.required) mOther.value = ''; });
mName.addEventListener('blur', () => { mName.value = clean.name(mName.value); });
mCar.addEventListener('input', () => { mCar.value = clean.plate(mCar.value); });

$('manual-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (manualBusy) return;
  const form = e.currentTarget;
  setError('manual-error', '');
  $('manual-success').hidden = true;
  const user = vistaAuth.currentUser;
  if (!authorized || !user) { setError('manual-error', 'Please sign in as operator first.'); return; }

  const name = clean.name(mName.value);
  const p = clean.purpose(mPurpose.value === 'Other' ? mOther.value : mPurpose.value);
  const car = clean.plate(mCar.value);
  mName.value = name;
  mCar.value = car;
  const problem = clean.nameError(name)
    || (!mPurpose.value ? 'Please select the purpose of visit.' : '')
    || (mPurpose.value === 'Other' && p.length < 3 ? 'Please describe the purpose (at least 3 characters).' : '')
    || clean.plateError(car);
  if (problem) { setError('manual-error', problem); return; }

  manualBusy = true;
  const btn = $('manual-submit');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const doc = vistaDb.collection('visits').doc();
    await doc.set({
      ownerUid: user.uid, name, purpose: p, car,
      status: 'in',
      createdAt: serverTime(),
      inAt: serverTime(),
      outAt: null, source: 'guard',
      faceConsent: false,
      checkInMethod: 'walk-in'
    });
    form.reset();
    mOtherWrap.hidden = true;
    mOther.required = false;
    $('manual-success').textContent = `Saved: ${name} checked in at ${fmt.time(new Date())}.`;
    $('manual-success').hidden = false;
  } catch (err) {
    setError('manual-error', err.code === 'permission-denied' ? 'Permission denied. Publish the firestore.rules in Firebase Console first.' : err.message);
  } finally {
    manualBusy = false;
    btn.disabled = false;
    btn.textContent = 'Save Walk-in Check-In';
  }
});

// ---------- Auth and live data ----------
function subscribe() {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  unsubscribe = vistaDb.collection('visits').onSnapshot((snapshot) => {
    visits = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data({ serverTimestamps: 'estimate' }) }));
    setError('dashboard-error', '');
    render();
    refreshExportCount();
  }, (err) => {
    visits = [];
    render();
    setError('dashboard-error', err.code === 'permission-denied'
      ? 'Database access denied. Publish the included firestore.rules in Firebase Console → Firestore Database → Rules, then refresh.'
      : err.message);
  });
  // Keep "Inside For" durations ticking and roll over to the new day at midnight
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => { if (authorized && document.visibilityState === 'visible') render(); }, 30000);
}

function showLogin() {
  closeExport();
  authorized = false;
  visits = [];
  clearInterval(refreshTimer);
  render();
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  $('operator-login').hidden = false;
  $('operator-dashboard').hidden = true;
}

function showDashboard(user) {
  if ((user.email || '').toLowerCase() !== OPERATOR_EMAIL) {
    showLogin();
    setError('login-error', 'This account is not authorized as a VISTA operator.');
    return;
  }
  authorized = true;
  showTab('records');
  $('signed-in-as').textContent = user.email || 'Operator';
  $('operator-login').hidden = true;
  $('operator-dashboard').hidden = false;
  subscribe();
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.currentTarget.querySelector('button');
  btn.disabled = true;
  setError('login-error', '');
  try {
    await vistaAuth.signInWithEmailAndPassword($('operator-email').value.trim(), $('operator-password').value);
  } catch (err) {
    setError('login-error', ['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found', 'auth/invalid-login-credentials'].includes(err.code)
      ? 'Incorrect email or password.' : err.message);
  } finally { btn.disabled = false; }
});
$('signout').addEventListener('click', () => vistaAuth.signOut());
vistaAuth.onAuthStateChanged((user) => { if (user && !user.isAnonymous) showDashboard(user); else showLogin(); });