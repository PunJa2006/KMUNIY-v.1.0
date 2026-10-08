import test from 'node:test';
import assert from 'node:assert/strict';
import {t,localizeError,dateLocale,getLanguage,setLanguage,LANGUAGE_KEY} from '../public/i18n.js';

test('language defaults to English and preserves explicitly selected Thai and other preferences', () => {
  const previous = globalThis.localStorage;
  const values = new Map([['community-last-theme','dark'],['firebase-session','unchanged']]);
  globalThis.localStorage = {getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};
  try {
    assert.equal(getLanguage(),'en');
    setLanguage('en'); assert.equal(values.get(LANGUAGE_KEY),'en'); assert.equal(getLanguage(),'en');
    assert.equal(dateLocale(),'en-US'); assert.equal(t('ตั้งค่า'),'Settings');
    assert.equal(values.get('community-last-theme'),'dark'); assert.equal(values.get('firebase-session'),'unchanged');
    setLanguage('th'); assert.equal(getLanguage(),'th'); assert.equal(dateLocale(),'th-TH'); assert.equal(t('ตั้งค่า'),'ตั้งค่า');
    assert.throws(()=>setLanguage('de'));
    values.set(LANGUAGE_KEY,'invalid'); assert.equal(getLanguage(),'en');
    globalThis.localStorage={getItem(){throw new Error('Storage unavailable');}};
    assert.equal(getLanguage(),'en');
  } finally { if(previous === undefined) delete globalThis.localStorage; else globalThis.localStorage = previous; }
});

test('localized counters, server errors and unknown user text remain correct', () => {
  assert.equal(t('โพสต์ได้ใน {seconds} วินาที',{seconds:1},'en'),'Post in 1 second');
  assert.equal(t('โพสต์ได้ใน {seconds} วินาที',{seconds:60},'en'),'Post in 60 seconds');
  assert.equal(t('เปลี่ยนใหม่ได้ใน {days} วัน',{days:7},'en'),'Available again in 7 days');
  assert.equal(localizeError('กรุณารออีก 59 วินาทีก่อนโพสต์ถัดไป','en'),'Please wait 59 seconds before your next post.');
  assert.equal(localizeError('บัญชีนี้ไม่มีข้อมูลในระบบ กรุณาสมัครเพื่อเข้าสู่ระบบ','en'),'This account is not registered. Please sign up before signing in.');
  assert.equal(localizeError('ชื่อเล่นเปลี่ยนได้อีกครั้งวันที่ 15/10/2569','en'),'You can change your nickname again on 15/10/2026.');
  assert.equal(t('ข้อความของผู้ใช้',{},'en'),'ข้อความของผู้ใช้');
});
