'use strict';
// VISTA visitor portal: Firebase anonymous auth.
// The visitor only REGISTERS. The security guard completes check-in and check-out.
// Saved per registration: ownerUid, name, purpose, car, status ('pending'), createdAt,
// inAt (null until the guard checks the visitor in), outAt (null), faceConsent (the tick box: true or false).
// One phone can register many visits (for example for workers who have no phone).

const $ = (id) => document.getElementById(id);
const screens = [...document.querySelectorAll('.screen')];
let currentUser = null;
let busy = false;

// ---------- Screens ----------
function showScreen(id) {
  screens.forEach((s) => { s.hidden = s.id !== id; s.classList.toggle('active', s.id === id); });
  window.scrollTo(0, 0);
}
document.querySelectorAll('[data-screen]').forEach((b) => b.addEventListener('click', () => showScreen(b.dataset.screen)));

// ---------- Live clock ----------
startClock($('clock-time'), $('clock-date'));

// ---------- Form helpers ----------
const purpose = $('visit-purpose');
const other = $('other-purpose');
const otherWrap = $('other-purpose-wrap');
const nameInput = $('visitor-name');
const carInput = $('car-plate');
const faceConsent = $('face-consent');

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
  if (e?.code === 'permission-denied') return 'Database permission denied. Check the published Firestore rules and Firebase sign-in.';
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

/** Fill the confirmation screen from a visit document. */
function showSummary(v) {
  const checkedIn = v.status === 'in';
  $('success-eyebrow').textContent = checkedIn ? 'CHECKED IN' : 'REGISTRATION RECEIVED';
  $('success-title').textContent = checkedIn ? 'You Are Checked In' : 'Registration Submitted';
  $('success-intro').textContent = checkedIn
    ? 'The security guard will check you out when you leave.'
    : 'Please go to the security guard to complete your check-in. You are not checked in until the guard confirms it.';
  $('summary-name').textContent = v.name;
  $('summary-purpose').textContent = v.purpose;
  $('summary-car').textContent = v.car || 'Not provided';
  $('summary-registered').textContent = fmt.dateTime(v.createdAt) || fmt.dateTime(new Date());
  $('summary-method').textContent = v.faceConsent ? 'Face scan by guard' : 'Manual by guard';
  $('summary-status').textContent = checkedIn ? `Checked in at ${fmt.time(v.inAt)}` : 'Pending check-in';
  showScreen('success-screen');
}

// Open a fresh form. This phone can register as many visits as needed.
$('checkin-open').addEventListener('click', () => {
  showScreen('checkin-screen');
  nameInput.focus();
});

// ---------- Registration ----------
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
    // Registration only: status "pending", no check-in time yet.
    const doc = vistaVisitorDb.collection('visits').doc();
    await doc.set({
      ownerUid: user.uid, name, purpose: p, car,
      status: 'pending',
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      inAt: null, outAt: null,
      faceConsent: faceConsent.checked === true   // the tick box: true only if the visitor ticked it
    });
    const saved = await doc.get();
    showSummary({ id: doc.id, ...saved.data() });
    form.reset();
    otherWrap.hidden = true;
  } catch (err) {
    setFormError(errorMessage(err));
  } finally {
    busy = false;
    btn.disabled = false;
    btn.innerHTML = 'Submit Registration <span aria-hidden="true">→</span>';
  }
});

vistaVisitorAuth.onAuthStateChanged((user) => {
  currentUser = user;
  if (!user) ensureVisitor().catch((err) => console.warn('Visitor sign-in:', err.message));
});