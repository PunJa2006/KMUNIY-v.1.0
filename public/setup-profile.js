import { createLogoutConfirmation, connect, api, status, showError, t, localizeError } from './shared.js';
const $ = id => document.getElementById(id);
let sdk, profile, selectedFile = null, uploadedId = null, previewUrl = null, busy = false;
let previewVersion = 0;
function releasePreview() {
  previewVersion++;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
}
async function load() {
  $('setup-fields').disabled = true;
  $('setup-retry').hidden = true;
  try {
    if (!sdk.auth.currentUser) { location.replace('/'); return; }
    if (sdk.auth.currentUser.isAnonymous) { location.replace('/main.html'); return; }
    profile = await api('profile-read', {}, sdk.auth.currentUser);
    if (profile.profileCompleted === true && profile.handle) { location.replace('/main.html'); return; }
    $('setup-name').value = profile.displayName || '';
    $('setup-handle').value = profile.handle || '';
    $('setup-fields').disabled = false;
    status.textContent = '';
    if (profile.photoMediaId) {
      const version = previewVersion;
      try {
        const response = await fetch('/api/media?id=' + encodeURIComponent(profile.photoMediaId), { headers: { Authorization: 'Bearer ' + await sdk.auth.currentUser.getIdToken() } });
        if (!response.ok) return;
        const blob = await response.blob();
        if (version !== previewVersion) return;
        previewUrl = URL.createObjectURL(blob);
        $('setup-preview').src = previewUrl;
      } catch {}
    }
  } catch (error) { showError(error); $('setup-retry').hidden = false; }
}
$('setup-photo').addEventListener('change', () => {
  releasePreview();
  selectedFile = null; uploadedId = null;
  const file = $('setup-photo').files[0];
  $('setup-preview').src = 'default-avatar.svg';
  if (!file) return;
  if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
    $('setup-photo').value = '';
    status.textContent = t('เลือกรูปที่รองรับ ขนาดไม่เกิน 5 MB'); return;
  }
  selectedFile = file;
  previewUrl = URL.createObjectURL(file);
  $('setup-preview').src = previewUrl;
  status.textContent = '';
});
$('setup-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !profile) return;
  const displayName = $('setup-name').value.trim();
  if (!displayName) { status.textContent = t('กรุณาตั้งชื่อเล่น'); return; }
  if (!selectedFile && !profile.photoMediaId) { status.textContent = t('กรุณาเลือกรูปโปรไฟล์'); return; }
  const handle = $('setup-handle').value.trim().toLowerCase();
  if (!/^(?=.*[a-z])(?=.*[0-9])[a-z0-9_.^]{2,24}$/.test(handle)) { status.textContent = t('มีตัวอักษรอังกฤษและตัวเลขอย่างน้อยอย่างละ 1 ตัว ใช้ _ . ^ ได้'); return; }
  busy = true;
  $('setup-fields').disabled = $('setup-logout').disabled = true;
  try {
    if (selectedFile && !uploadedId) {
      status.textContent = t('กำลังอัปโหลดรูปโปรไฟล์…');
      const response = await fetch('/api/media', { method: 'POST', headers: { Authorization: 'Bearer ' + await sdk.auth.currentUser.getIdToken(), 'Content-Type': selectedFile.type }, body: selectedFile });
      const result = await response.json();
      if (!response.ok) throw new Error(localizeError(result.message) || t('อัปโหลดรูปไม่สำเร็จ'));
      uploadedId = result.id;
    }
    status.textContent = t('กำลังบันทึกโปรไฟล์…');
    await api('profile-update', { displayName, handle, bio: profile.bio || '', photoMediaId: uploadedId || profile.photoMediaId, completeProfile: true }, sdk.auth.currentUser);
    releasePreview();
    location.replace('/main.html');
  } catch (error) { showError(error); }
  finally { busy = false; $('setup-fields').disabled = $('setup-logout').disabled = false; }
});
$('setup-retry').addEventListener('click', load);
const confirmLogout=createLogoutConfirmation({
  dialog:$('logout-dialog'),confirm:$('confirm-logout'),cancel:$('cancel-logout'),status:$('logout-status'),
  t,errorText:error=>localizeError(error.message),now:()=>Date.now(),schedule:setInterval,unschedule:clearInterval,
  logout:async()=>{await sdk.signOut(sdk.auth);location.replace('/');}
});
$('setup-logout').addEventListener('click',()=>{if(!busy && sdk)confirmLogout();});
try { sdk = await connect(); await load(); } catch (error) { showError(error); }
