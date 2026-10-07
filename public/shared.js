export { createLogoutConfirmation } from './logout-confirmation.js';
export { hashtagParts } from './hashtags.js';
import { t, localizeError } from './i18n.js';
export { t, localizeError, getLanguage, setLanguage, dateLocale } from './i18n.js';
import { firebaseConfig } from './firebase-config.js';
export const status = document.querySelector('#status');
export async function connect() {
  if (!firebaseConfig.apiKey || !firebaseConfig.appId) throw new Error(t('ยังไม่ได้ตั้งค่า Firebase Web app'));
  const [app, authSDK] = await Promise.all([
    import('https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js')
  ]);
  const auth = authSDK.getAuth(app.initializeApp(firebaseConfig));
  await auth.authStateReady();
  return { auth, ...authSDK };
}
export async function api(action, data = {}, user = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (user) headers.Authorization = `Bearer ${await user.getIdToken()}`;
  const response = await fetch('/api/account', {
    method: 'POST', headers, body: JSON.stringify({ action, ...data })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(localizeError(body.message) || t('ติดต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองอีกครั้ง')), { status: response.status, retryAfter: body.retryAfter, ...(body.code ? {code:body.code} : {}) });
  return body;
}
export function showError(error) {
  const messages = {
    'ACCOUNT_BANNED': t('บัญชีนี้ถูกแบน กรุณาติดต่อ Dev หรือ Admin'),
    'auth/invalid-credential': t('Email / Username หรือ Password ไม่ถูกต้อง'),
    'auth/invalid-email': t('รูปแบบ Email ไม่ถูกต้อง'),
    'auth/email-already-in-use': t('Email นี้มีบัญชีแล้ว กรุณาเข้าสู่ระบบ'),
    'auth/weak-password': t('รหัสผ่านไม่ผ่านเงื่อนไขของระบบ'),
    'auth/too-many-requests': t('ลองเข้าสู่ระบบถี่เกินไป กรุณารอสักครู่'),
    'auth/network-request-failed': t('เชื่อมต่อไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ต'),
    'auth/operation-not-allowed': t('ยังไม่ได้เปิดวิธีเข้าสู่ระบบนี้ใน Firebase'),
    'auth/popup-closed-by-user': t('ยกเลิกการเลือกบัญชี Google แล้ว'),
    'auth/popup-blocked': t('เบราว์เซอร์บล็อกหน้าต่างเลือกบัญชี กรุณาอนุญาต popup แล้วลองอีกครั้ง'),
    'auth/unauthorized-domain': t('ยังไม่ได้เพิ่มโดเมนเว็บนี้ใน Authorized domains ของ Firebase'),
    'auth/user-disabled': t('บัญชีนี้ถูกระงับ'),
    'auth/unsupported-persistence-type': t('เบราว์เซอร์นี้ไม่รองรับการจำสถานะเข้าสู่ระบบ')
  };
  status.textContent = messages[error.code] || (error.code ? t('เข้าสู่ระบบไม่สำเร็จ กรุณาลองอีกครั้ง') : localizeError(error.message));
}
