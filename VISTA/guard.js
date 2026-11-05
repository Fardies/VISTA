 'use strict';
// VISTA operator: Firebase email/password operator login (email checked in guard.js AND firestore.rules).
const OLD_KEY='vista_demo_visits_v1',OLD_ACTIVE='vista_demo_active_v1';
const $=id=>document.getElementById(id);
let visits=[],unsubscribe=null,authorized=false;
const OPERATOR_EMAIL='operator@gmail.com';
const dt=x=>x?.toDate?x.toDate():x instanceof Date?x:null;
const iso=x=>dt(x)?.toISOString()||'';
const date=x=>dt(x)?dt(x).toLocaleDateString('en-GB'):'';
const time=x=>dt(x)?dt(x).toLocaleTimeString('en-MY',{hour:'2-digit',minute:'2-digit'}):'';
const localDay=x=>{const d=dt(x);return d?[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-'):''};
const setError=(id,msg)=>{$(id).textContent=msg;$(id).hidden=!msg};
function filtered(){const term=$('search').value.trim().toLowerCase(),status=$('status').value,from=$('from').value,to=$('to').value;return visits.filter(v=>{if(!(v.name+' '+v.car+' '+v.purpose).toLowerCase().includes(term))return false;if(status==='inside'&&v.outAt)return false;if(status==='out'&&!v.outAt)return false;const d=localDay(v.inAt);return(!from||d>=from)&&(!to||d<=to)}).sort((a,b)=>iso(b.inAt).localeCompare(iso(a.inAt)))}
function row(label,value){const p=document.createElement('p'),strong=document.createElement('strong');strong.textContent=label+': ';p.append(strong,document.createTextNode(value));return p}
function render(){const all=visits;$('total').textContent=all.length;$('inside').textContent=all.filter(v=>!v.outAt).length;$('outside').textContent=all.filter(v=>v.outAt).length;const matches=filtered(),box=$('records');$('result-count').textContent=`Showing ${matches.length} of ${all.length} visits`;box.replaceChildren();if(!matches.length){const p=document.createElement('p');p.className='help-text';p.textContent='No matching visitor records.';box.append(p);return}
 for(const v of matches){const card=document.createElement('article');card.className='record-card';const h=document.createElement('h3');h.textContent=v.name;card.append(h,row('Purpose of Visit',v.purpose||'—'),row('Car Plate Number',v.car||'—'),row('Check-In Date',date(v.inAt)),row('Check-In Time',time(v.inAt)),row('Check-Out Date',date(v.outAt)||'—'),row('Check-Out Time',time(v.outAt)||'—'),row('Status',v.outAt?'Checked Out':'Inside'));
 if(v.source==='guard')card.append(row('Entry','Added by guard (manual check-in)'));
 if(!v.outAt){const btn=document.createElement('button');btn.className='btn secondary';btn.type='button';btn.textContent='Manual Check-Out';btn.addEventListener('click',async()=>{if(!confirm('Confirm that '+v.name+' has left?'))return;btn.disabled=true;try{await vistaDb.collection('visits').doc(v.id).update({outAt:firebase.firestore.FieldValue.serverTimestamp()})}catch(e){alert('Unable to check out: '+e.message);btn.disabled=false}});card.append(btn)}box.append(card)}}
function csvCell(x){let s=String(x??'');if(/^[\s]*[=+@\-]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"'}
$('export').addEventListener('click',()=>{const list=filtered();if(!list.length){alert('No records match your filters.');return}const rows=[['Visitor Name','Purpose of Visit','Car Plate Number','Check-In Date','Check-In Time','Check-Out Date','Check-Out Time','Status','Entry Type'],...list.map(v=>[v.name,v.purpose,v.car,date(v.inAt),time(v.inAt),date(v.outAt),time(v.outAt),v.outAt?'Checked Out':'Inside',v.source==='guard'?'Guard':'Self check-in'])];const csv='\uFEFF'+rows.map(r=>r.map(csvCell).join(',')).join('\r\n');const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='VISTA_Visitors_'+localDay(new Date())+'.csv';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000)});
for(const id of ['search','status','from','to'])$(id).addEventListener(id==='search'?'input':'change',render);
$('refresh').addEventListener('click',()=>{if(authorized){if(unsubscribe)unsubscribe();subscribe()}});
$('reset-filters').addEventListener('click',()=>{for(const id of ['search','from','to'])$(id).value='';$('status').value='all';render()});
$('clear-demo').addEventListener('click',()=>{if(!confirm('Delete old browser-only demo records? This does NOT delete Firebase records.'))return;localStorage.removeItem(OLD_KEY);localStorage.removeItem(OLD_ACTIVE);alert('Old local demo data cleared. Firebase data was not changed.')});
// ---- Manual check-in by guard ----
const mPurpose=$('manual-purpose'),mOther=$('manual-other'),mOtherWrap=$('manual-other-wrap');let manualBusy=false;
mPurpose.addEventListener('change',()=>{mOtherWrap.hidden=mPurpose.value!=='Other';mOther.required=mPurpose.value==='Other';if(!mOther.required)mOther.value=''});
$('manual-form').addEventListener('submit',async e=>{
 e.preventDefault();if(manualBusy)return;
 const form=e.currentTarget;setError('manual-error','');$('manual-success').hidden=true;
 const user=vistaAuth.currentUser;
 if(!authorized||!user){setError('manual-error','Please sign in as operator first.');return}
 const name=$('manual-name').value.trim(),p=(mPurpose.value==='Other'?mOther.value:mPurpose.value).trim(),car=$('manual-car').value.trim().toUpperCase();
 if(!name||!p){setError('manual-error','Please enter visitor name and purpose.');return}
 manualBusy=true;const btn=$('manual-submit');btn.disabled=true;btn.textContent='Saving...';
 try{
  await vistaDb.collection('visits').doc().set({ownerUid:user.uid,name,purpose:p,car,inAt:firebase.firestore.FieldValue.serverTimestamp(),outAt:null,source:'guard'});
  form.reset();mOtherWrap.hidden=true;mOther.required=false;
  $('manual-success').textContent='Saved: '+name+' is now checked in.';$('manual-success').hidden=false;
 }catch(err){setError('manual-error',err.code==='permission-denied'?'Permission denied. Publish the NEW firestore.rules in Firebase Console first.':err.message)}
 finally{manualBusy=false;btn.disabled=false;btn.textContent='Save Manual Check-In'}
});
$('portal-url').value=new URL('index.html',location.href).href;
$('make-qr').addEventListener('click',()=>{const url=$('portal-url').value.trim();try{const parsed=new URL(url);if(!['http:','https:'].includes(parsed.protocol))throw Error();if(parsed.hostname==='localhost'||parsed.hostname==='127.0.0.1'){$('qr-message').textContent='This is a local address. Publish the site first so visitors can open it on their phones.';return}}catch{$('qr-message').textContent='Enter a valid public website URL.';return} $('qr-message').textContent='';const qr=$('qr-code');qr.replaceChildren();if(typeof QRCode==='undefined'){$('qr-message').textContent='QR library unavailable. Connect to the internet and refresh.';return}new QRCode(qr,{text:url,width:220,height:220,correctLevel:QRCode.CorrectLevel.M});$('qr-link').textContent=url;$('qr-poster').hidden=false});
$('print-qr').addEventListener('click',()=>window.print());
function subscribe(){if(unsubscribe){unsubscribe();unsubscribe=null}unsubscribe=vistaDb.collection('visits').onSnapshot(snapshot=>{visits=snapshot.docs.map(doc=>({id:doc.id,...doc.data({serverTimestamps:'estimate'})}));setError('dashboard-error','');render()},err=>{visits=[];render();setError('dashboard-error',err.code==='permission-denied'?'Database access denied. Publish the included firestore.rules in Firebase Console → Firestore Database → Rules, then refresh.':err.message)})}
function showLogin(){authorized=false;visits=[];render();if(unsubscribe){unsubscribe();unsubscribe=null}$('operator-login').hidden=false;$('operator-dashboard').hidden=true}
function showDashboard(user){if((user.email||'').toLowerCase()!==OPERATOR_EMAIL){showLogin();setError('login-error','This account is not authorized as a VISTA operator.');return;}authorized=true;$('signed-in-as').textContent=user.email||'Operator';$('operator-login').hidden=true;$('operator-dashboard').hidden=false;subscribe()}
$('login-form').addEventListener('submit',async e=>{e.preventDefault();const btn=e.currentTarget.querySelector('button');btn.disabled=true;setError('login-error','');try{await vistaAuth.signInWithEmailAndPassword($('operator-email').value.trim(),$('operator-password').value)}catch(err){setError('login-error',err.message)}finally{btn.disabled=false}});
$('signout').addEventListener('click',()=>vistaAuth.signOut());
vistaAuth.onAuthStateChanged(user=>{if(user&&!user.isAnonymous)showDashboard(user);else showLogin()});
