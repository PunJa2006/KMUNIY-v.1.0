import { connect, api, status, showError, t, localizeError } from './shared.js';
const $ = id => document.getElementById(id);
let sdk;
let pendingUser = null;
let busy = false;
function setBusy(value) {
  busy = value;
  $('register-fields').disabled = value;
  $('choose-google').disabled = value;
}
$('choose-google').addEventListener('click', async () => {
  if (!sdk || busy) return;
  setBusy(true);
  status.textContent = t('กำลังสมัครสมาชิก…');
  try {
    if (!pendingUser) {
      await sdk.setPersistence(sdk.auth, sdk.inMemoryPersistence);
      const provider = new sdk.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      const { user } = await sdk.signInWithPopup(sdk.auth, provider);
      if (!user.email) throw new Error(t('บัญชี Google นี้ไม่มี Email'));
      try {
        await api('profile-read', {}, user);
        await sdk.signOut(sdk.auth);
        status.textContent = t('บัญชีนี้สมัครแล้ว กรุณากลับหน้าเข้าสู่ระบบ');
        return;
      } catch (error) { if (error.status !== 404) throw error; }
      pendingUser = user;
    }
    await api('profile', { emailOnly: true }, pendingUser);
    await sdk.signOut(sdk.auth);
    pendingUser = null;
    location.replace('/?registered=1');
  } catch (error) {
    if (!pendingUser) await sdk.signOut(sdk.auth).catch(() => {});
    showError(error);
    if (pendingUser) $('choose-google').textContent = t('ลองสมัครด้วย Email อีกครั้ง');
  } finally { setBusy(false); }
});
$('register-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!sdk || busy) return;
  setBusy(true);
  status.textContent = t('กำลังสมัครสมาชิก…');
  try {
    const username = $('new-username').value.trim().toLowerCase();
    const password = $('new-password').value;
    if (!/^(?=.*[a-z])(?=.*[0-9])[a-z0-9_.^]{2,24}$/.test(username)) throw new Error(t('มีตัวอักษรอังกฤษและตัวเลขอย่างน้อยอย่างละ 1 ตัว ใช้ _ . ^ ได้'));
    if (password.length < 8) throw new Error(t('Password ต้องมีอย่างน้อย 8 ตัว'));
    if (password !== $('confirm-password').value) throw new Error(t('Password ทั้งสองช่องไม่ตรงกัน'));
    await api('username-register', { username, password });
    await sdk.signOut(sdk.auth);
    pendingUser = null;
    location.replace('/?registered=1');
  } catch (error) { showError(error); }
  finally { setBusy(false); }
});
try {
  sdk = await connect();
  if (sdk.auth.currentUser) await sdk.signOut(sdk.auth);
  setBusy(false);
  status.textContent = '';
} catch (error) { showError(error); }
