 'use strict';
// VISTA visitor portal: Firebase anonymous auth, each visitor can access ONLY their own visits.
const ACTIVE='vista_firebase_active_v1';
const $=id=>document.getElementById(id);
const stamp=ts=>{const d=ts?.toDate?ts.toDate():ts?new Date(ts):null;return d&&!isNaN(d)?d.toLocaleString('en-MY',{dateStyle:'medium',timeStyle:'short'}):'Just now'};
const screens=[...document.querySelectorAll('.screen')];
let currentUser=null, busy=false;
function showScreen(id){screens.forEach(s=>{s.hidden=s.id!==id;s.classList.toggle('active',s.id===id)});if(id==='checkout-screen')updateCheckout();window.scrollTo(0,0)}
document.querySelectorAll('[data-screen]').forEach(b=>b.addEventListener('click',()=>showScreen(b.dataset.screen)));
const purpose=$('visit-purpose'),other=$('other-purpose'),otherWrap=$('other-purpose-wrap');
purpose.addEventListener('change',()=>{otherWrap.hidden=purpose.value!=='Other';other.required=purpose.value==='Other';if(!other.required)other.value=''});
function errorMessage(e){return e?.code==='permission-denied'?'Database permission denied. Publish the provided Firestore rules first.':e?.code==='unavailable'?'Unable to connect to Firebase. Check your internet connection.':(e?.message||'Something went wrong. Please try again.');}
async function ensureVisitor(){if(currentUser)return currentUser;const result=await vistaVisitorAuth.signInAnonymously();currentUser=result.user;return currentUser;}
async function activeVisit(){const id=localStorage.getItem(ACTIVE);if(!id)return null;const user=await ensureVisitor();const snap=await vistaVisitorDb.collection('visits').doc(id).get();if(!snap.exists){localStorage.removeItem(ACTIVE);return null}const v={id:snap.id,...snap.data()};if(v.ownerUid!==user.uid||v.outAt){localStorage.removeItem(ACTIVE);return null}return v;}
async function updateCheckout(){const known=$('checkout-known'),unknown=$('checkout-unknown');known.hidden=true;unknown.hidden=false;try{const v=await activeVisit();known.hidden=!v;unknown.hidden=!!v;if(v){$('checkout-name').textContent=v.name;$('checkout-in').textContent=stamp(v.inAt)}}catch(e){unknown.querySelector('p').textContent=errorMessage(e)}}
$('checkin-open').addEventListener('click',async()=>{try{if(await activeVisit())showScreen('checkout-screen');else showScreen('checkin-screen')}catch(e){alert(errorMessage(e))}});
$('checkin-form').addEventListener('submit',async e=>{
 e.preventDefault();if(busy)return;const form=e.currentTarget;if(!form.reportValidity())return;
 const name=$('visitor-name').value.trim(),p=(purpose.value==='Other'?other.value:purpose.value).trim(),car=$('car-plate').value.trim().toUpperCase();
 if(!name||!p){$('checkin-error').textContent='Please enter your name and purpose.';$('checkin-error').hidden=false;return}
 busy=true;const btn=form.querySelector('[type=submit]');btn.disabled=true;btn.textContent='Saving...';
 try{
  const user=await ensureVisitor();if(await activeVisit()){showScreen('checkout-screen');return}
  const doc=vistaVisitorDb.collection('visits').doc();await doc.set({ownerUid:user.uid,name,purpose:p,car,inAt:firebase.firestore.FieldValue.serverTimestamp(),outAt:null});
  localStorage.setItem(ACTIVE,doc.id);
  const saved=await doc.get();$('summary-name').textContent=name;$('summary-purpose').textContent=p;$('summary-car').textContent=car||'Not provided';$('summary-time').textContent=stamp(saved.data()?.inAt);$('demo-reference').textContent=doc.id.slice(0,8).toUpperCase();form.reset();otherWrap.hidden=true;$('checkin-error').hidden=true;showScreen('success-screen');
 }catch(err){$('checkin-error').textContent=errorMessage(err);$('checkin-error').hidden=false}finally{busy=false;btn.disabled=false;btn.textContent='Confirm Check-In →'}
});
$('checkout-now').addEventListener('click',async()=>{
 if(busy)return;busy=true;const btn=$('checkout-now');btn.disabled=true;btn.textContent='Saving checkout...';
 try{const v=await activeVisit();if(!v){await updateCheckout();return}
 // Rules enforce: owner-only checkout, and only outAt may change from null to timestamp.
 await vistaVisitorDb.collection('visits').doc(v.id).update({outAt:firebase.firestore.FieldValue.serverTimestamp()});
 localStorage.removeItem(ACTIVE);const saved=await vistaVisitorDb.collection('visits').doc(v.id).get();$('checkout-finished-name').textContent=v.name;$('checkout-finished-time').textContent=stamp(saved.data()?.outAt);showScreen('checkout-done-screen');
 }catch(err){alert(errorMessage(err))}finally{busy=false;btn.disabled=false;btn.textContent='Confirm Check-Out →'}
});
vistaVisitorAuth.onAuthStateChanged(user=>{currentUser=user;if(!user)ensureVisitor().catch(err=>console.warn('Visitor sign-in:',err.message))});
