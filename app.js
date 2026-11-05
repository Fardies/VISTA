'use strict';
// VISTA visitor portal: Firebase anonymous auth; each visitor can access ONLY their own visits.
// Data saved per visit is unchanged: ownerUid, name, purpose, car, inAt, outAt.

const ACTIVE = 'vista_firebase_active_v1';
const $ = (id) => document.getElementById(id);
const screens = [...document.querySelectorAll('.screen')];
let currentUser = null;
let busy = false;
let stayTimer = null;

// ---------- Screens ----------
function showScreen(id) {
  screens.forEach((s) => { s.hidden = s.id !== id; s.classList.toggle('active', s.id === id); });
  clearInterval(stayTimer);
  if (id === 'checkout-screen') updateCheckout();
  window.scrollTo(0, 0);
}
document.querySelectorAll('[data-screen]').forEach((b) => b.addEventListener('click', () => showScreen(b.dataset.screen)));

// ---------- Live clock ----------
startClock($('clock-time'), $('clock-date'));
startClock($('checkin-time-preview'));

// ---------- Form helpers ----------
const purpose = $('visit-purpose');
const other = $('other-purpose');
const otherWrap = $('other-purpose-wrap');
const nameInput = $('visitor-name');
const carInput = $('car-plate');

purpose.addEventListener('change', () => {
  otherWrap.hidden = purpose.value !== 'Other';
  other.required = purpose.value === 'Other';
  if (!other.required) other.value = '';
  fieldError(purpose, '');
});

// Tidy values as the visitor types, so records are consistent
nameInput.addEventListener('blur', () => { nameInput.value = clean.name(nameInput.value); fieldError(nameInput, ''); });
carInput.addEventListener('input', () => {
  const pos = carInput.value.length;
  carInput.value = clean.plate(carInput.value);
  if (pos === carInput.value.length) carInput.setSelectionRange(pos, pos);
  fieldError(carInput, '');
});

function fieldError(input, msg) {
  const el = $(`${input.id}-error`);
  input.setAttribute('aria-invalid', msg ? 'true' : 'false');
  if (el) { el.textContent = msg; el.hidden = !msg; }
}

function setFormError(msg) { $('checkin-error').textContent = msg; $('checkin-error').hidden = !msg; }

function errorMessage(e) {
  if (e?.code === 'permission-denied') return 'Database permission denied. Publish the provided Firestore rules first.';
  if (e?.code === 'unavailable') return 'Unable to connect. Check your internet connection and try again.';
  return e?.message || 'Something went wrong. Please try again.';
}

// ---------- Firebase ----------
async function ensureVisitor() {
  if (currentUser) return currentUser;
  const result = await vistaVisitorAuth.signInAnonymously();
  currentUser = result.user;
  return currentUser;
}

async function activeVisit() {
  const id = localStorage.getItem(ACTIVE);
  if (!id) return null;
  const user = await ensureVisitor();
  const snap = await vistaVisitorDb.collection('visits').doc(id).get();
  if (!snap.exists) { localStorage.removeItem(ACTIVE); return null; }
  const v = { id: snap.id, ...snap.data() };
  // Checked out already (by the visitor or manually by the guard): forget it
  if (v.ownerUid !== user.uid || v.outAt) { localStorage.removeItem(ACTIVE); return null; }
  return v;
}

// ---------- Check-out screen ----------
async function updateCheckout() {
  const known = $('checkout-known');
  const unknown = $('checkout-unknown');
  known.hidden = true;
  unknown.hidden = true;
  $('checkout-loading').hidden = false;
  try {
    const v = await activeVisit();
    known.hidden = !v;
    unknown.hidden = !!v;
    if (v) {
      $('checkout-name').textContent = v.name;
      $('checkout-purpose').textContent = v.purpose;
      $('checkout-car').textContent = v.car || 'Not provided';
      $('checkout-in').textContent = fmt.dateTime(v.inAt);
      const paint = () => { $('checkout-stay').textContent = fmt.duration(stayMs(v)); };
      paint();
      clearInterval(stayTimer);
      stayTimer = setInterval(paint, 15000);
    }
  } catch (e) {
    unknown.hidden = false;
    unknown.querySelector('p').textContent = errorMessage(e);
  } finally {
    $('checkout-loading').hidden = true;
  }
}

$('checkin-open').addEventListener('click', async () => {
  try {
    if (await activeVisit()) showScreen('checkout-screen');
    else { showScreen('checkin-screen'); nameInput.focus(); }
  } catch (e) { alert(errorMessage(e)); }
});

// ---------- Check-in ----------
$('checkin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (busy) return;
  const form = e.currentTarget;
  setFormError('');

  const name = clean.name(nameInput.value);
  const p = clean.purpose(purpose.value === 'Other' ? other.value : purpose.value);
  const car = clean.plate(carInput.value);
  nameInput.value = name;
  carInput.value = car;

  // Field-by-field validation with clear messages
  const errors = [
    [nameInput, clean.nameError(name)],
    [purpose, purpose.value ? '' : 'Please select the purpose of your visit.'],
    [other, purpose.value === 'Other' && p.length < 3 ? 'Please describe the purpose (at least 3 characters).' : ''],
    [carInput, clean.plateError(car)],
  ];
  errors.forEach(([el, msg]) => fieldError(el, msg));
  const first = errors.find(([, msg]) => msg);
  if (first) { first[0].focus(); return; }

  busy = true;
  const btn = form.querySelector('[type=submit]');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const user = await ensureVisitor();
    if (await activeVisit()) { showScreen('checkout-screen'); return; }

    // One person, one active visit: a name stays locked until that visit is checked out
    const lockRef = vistaVisitorDb.collection('activeNames').doc(activeKey(name));
    const lock = await lockRef.get();
    if (lock.exists) {
      const since = fmt.time(lock.data().since);
      setFormError(`${name} is already checked in${since ? ` since ${since}` : ''}. Please check out first, or ask the security guard for assistance.`);
      fieldError(nameInput, ' ');
      nameInput.focus();
      return;
    }

    const doc = vistaVisitorDb.collection('visits').doc();
    const now = firebase.firestore.FieldValue.serverTimestamp(); // server time, not the phone's clock
    const batch = vistaVisitorDb.batch();
    batch.set(doc, { ownerUid: user.uid, name, purpose: p, car, inAt: now, outAt: null });
    batch.set(lockRef, { visitId: doc.id, ownerUid: user.uid, name, since: now });
    try {
      await batch.commit();
    } catch (err) {
      // Someone with the same name checked in a moment earlier
      if (err?.code === 'permission-denied' && (await lockRef.get().catch(() => null))?.exists) {
        setFormError(`${name} is already checked in. Please check out first, or ask the security guard for assistance.`);
        return;
      }
      throw err;
    }
    localStorage.setItem(ACTIVE, doc.id);
    const saved = await doc.get();
    const inAt = saved.data()?.inAt;
    $('summary-name').textContent = name;
    $('summary-purpose').textContent = p;
    $('summary-car').textContent = car || 'Not provided';
    $('summary-date').textContent = fmt.date(inAt) || fmt.date(new Date());
    $('summary-time').textContent = fmt.time(inAt) || fmt.time(new Date());
    form.reset();
    otherWrap.hidden = true;
    showScreen('success-screen');
  } catch (err) {
    setFormError(errorMessage(err));
  } finally {
    busy = false;
    btn.disabled = false;
    btn.innerHTML = 'Confirm Check-In <span aria-hidden="true">→</span>';
  }
});

// ---------- Check-out ----------
$('checkout-now').addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  const btn = $('checkout-now');
  btn.disabled = true;
  btn.textContent = 'Saving check-out…';
  try {
    const v = await activeVisit();
    if (!v) { await updateCheckout(); return; }
    // Rules enforce: owner-only checkout, and only outAt may change from null to server time.
    // The name lock is released in the same write so the person can check in again next time.
    const batch = vistaVisitorDb.batch();
    batch.update(vistaVisitorDb.collection('visits').doc(v.id), { outAt: firebase.firestore.FieldValue.serverTimestamp() });
    const lockRef = vistaVisitorDb.collection('activeNames').doc(activeKey(v.name));
    const lock = await lockRef.get();
    if (lock.exists && lock.data().visitId === v.id) batch.delete(lockRef);
    await batch.commit();
    localStorage.removeItem(ACTIVE);
    const saved = (await vistaVisitorDb.collection('visits').doc(v.id).get()).data() || {};
    $('checkout-finished-name').textContent = v.name;
    $('checkout-finished-in').textContent = fmt.dateTime(saved.inAt || v.inAt);
    $('checkout-finished-time').textContent = fmt.dateTime(saved.outAt) || fmt.dateTime(new Date());
    $('checkout-finished-stay').textContent = fmt.duration(stayMs({ inAt: saved.inAt || v.inAt, outAt: saved.outAt || new Date() }));
    showScreen('checkout-done-screen');
  } catch (err) {
    alert(errorMessage(err));
  } finally {
    busy = false;
    btn.disabled = false;
    btn.textContent = 'Confirm Check-Out →';
  }
});

vistaVisitorAuth.onAuthStateChanged((user) => {
  currentUser = user;
  if (!user) ensureVisitor().catch((err) => console.warn('Visitor sign-in:', err.message));
});
