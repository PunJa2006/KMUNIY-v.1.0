import { connect, api, status, showError, t, localizeError } from './shared.js';
const $ = id => document.getElementById(id);
let sdk, busy=false, sendingAppeal=false;
if(new URLSearchParams(location.search).has('banned'))status.textContent=t('บัญชีนี้ถูกแบน กรุณาติดต่อ Dev หรือ Admin');
function lock(value){busy=value;$('login-fields').disabled=value;}
function showBannedAccount(error){
  if(error.code!=='ACCOUNT_BANNED' || !sdk.auth.currentUser)return false;
  $('banned-account').hidden=false;$('login-options').hidden=true;$('login-heading').textContent=t('บัญชีถูกระงับ');
  status.textContent=t('บัญชีนี้ถูกแบน กรุณาติดต่อ Dev หรือ Admin');return true;
}
async function checkMember(){
  if(!sdk.auth.currentUser)return;
  return api(sdk.auth.currentUser.isAnonymous?'profile':'profile-read',{},sdk.auth.currentUser);
}
async function run(action,guest=false){
  if(busy)return;lock(true);status.textContent=t('กำลังดำเนินการ…');
  try{
    await sdk.setPersistence(sdk.auth,$('remember').checked?sdk.browserLocalPersistence:sdk.browserSessionPersistence);
    await action();const profile=await checkMember();
    location.replace(!guest && (profile?.profileCompleted!==true || !profile?.handle)?'/setup-profile.html':'/main.html');
  }catch(error){
    if(showBannedAccount(error))return;
    if(sdk.auth.currentUser){try{await sdk.signOut(sdk.auth);}catch{status.textContent=t('ออกจากสถานะเข้าสู่ระบบไม่สำเร็จ กรุณาปิดหน้านี้แล้วเปิดใหม่');return;}}
    showError(error);
  }finally{lock(false);}
}
$('login-form').addEventListener('submit',event=>{
  event.preventDefault();run(async()=>{
    const identity=$('identity').value.trim(),password=$('password').value;
    try{
      if(identity.includes('@'))await sdk.signInWithEmailAndPassword(sdk.auth,identity,password);
      else{const {email}=await api('username-login',{username:identity,password,forAppeal:true});await sdk.signInWithEmailAndPassword(sdk.auth,email,password);}
    }finally{$('password').value='';}
  });
});
$('google-login').addEventListener('click',()=>run(async()=>{const provider=new sdk.GoogleAuthProvider();provider.setCustomParameters({prompt:'select_account'});await sdk.signInWithPopup(sdk.auth,provider);}));
$('guest').addEventListener('click',()=>run(()=>sdk.signInAnonymously(sdk.auth),true));
$('open-ban-appeal').addEventListener('click',()=>{if(sendingAppeal)return;$('ban-appeal-status').textContent='';$('ban-appeal-dialog').showModal();$('ban-appeal-details').focus();});
$('cancel-ban-appeal').addEventListener('click',()=>{if(!sendingAppeal)$('ban-appeal-dialog').close();});
$('ban-appeal-dialog').addEventListener('cancel',event=>{if(sendingAppeal)event.preventDefault();});
$('ban-appeal-form').addEventListener('submit',async event=>{
  event.preventDefault();if(sendingAppeal || !sdk.auth.currentUser)return;
  const details=$('ban-appeal-details').value.trim();
  if(!details){$('ban-appeal-status').textContent=t('กรุณาอธิบายคำร้องขอปลดแบน');return;}
  if(details.length>2000){$('ban-appeal-status').textContent=t('อธิบายเพิ่มเติมได้ไม่เกิน 2,000 ตัวอักษร');return;}
  sendingAppeal=true;$('ban-appeal-fields').disabled=true;$('ban-appeal-status').textContent=t('กำลังส่งรายงาน…');
  try{await api('usage-report-create',{details},sdk.auth.currentUser);$('ban-appeal-dialog').close();$('ban-appeal-details').value='';status.textContent=t('ส่งคำร้องให้ Dev และ Admin แล้ว');}
  catch(error){$('ban-appeal-status').textContent=localizeError(error.message);}
  finally{sendingAppeal=false;$('ban-appeal-fields').disabled=false;}
});
$('banned-signout').addEventListener('click',async()=>{
  if(busy || sendingAppeal)return;lock(true);
  try{await sdk.signOut(sdk.auth);$('banned-account').hidden=true;$('login-options').hidden=false;$('login-heading').textContent=t('เข้าสู่ระบบ');$('ban-appeal-details').value='';status.textContent='';}
  catch(error){showError(error);}finally{lock(false);}
});
try{
  sdk=await connect();
  if(sdk.auth.currentUser){
    try{const profile=await checkMember();location.replace(sdk.auth.currentUser.isAnonymous || (profile?.profileCompleted===true && profile?.handle)?'/main.html':'/setup-profile.html');}
    catch(error){if(!showBannedAccount(error)){await sdk.signOut(sdk.auth);showError(error);}lock(false);}
  }else{
    lock(false);const query=new URLSearchParams(location.search);
    status.textContent=query.has('banned')?t('บัญชีนี้ถูกแบน กรุณาติดต่อ Dev หรือ Admin'):query.has('unregistered')?t('บัญชีนี้ไม่มีข้อมูลในระบบ กรุณาสมัครเพื่อเข้าสู่ระบบ'):query.has('registered')?t('สมัครสมาชิกสำเร็จแล้ว กรุณาเข้าสู่ระบบ'):'';
  }
}catch(error){showError(error);}
