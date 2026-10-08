import { createLogoutConfirmation } from '../public/logout-confirmation.js';
import { t, localizeError, dateLocale } from '../public/i18n.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
async function fixture({ guest = false, completed = false, saveFails = false, language = 'th' } = {}) {
  const fields = new Map(), calls = [];
  const element = id => {
    if (!fields.has(id)) fields.set(id, { value: '', files: [], handlers: {},showModal(){this.open=true;},close(){this.open=false;},addEventListener(name, fn) { this.handlers[name] = fn; } });
    return fields.get(id);
  };
  const status = {};
  const sdk = { auth: { currentUser: { isAnonymous: guest, getIdToken: async () => 'test-token' } },signOut:async()=>calls.push({action:'signOut'}) };
  const source = (await readFile(new URL('../public/setup-profile.js', import.meta.url), 'utf8')).replace(/^\uFEFF?import .*;\r?\n/, '');
  await runInNewContext(`(async () => { ${source} })()`, {
    uploadMedia:async()=>{calls.push({action:"upload"});return {id:"test-photo"};},createLogoutConfirmation,setInterval,clearInterval,t:(message,values)=>t(message,values,language), localizeError:message=>localizeError(message,language), dateLocale:()=>dateLocale(language), document: { getElementById: element }, status, connect: async () => sdk,
    api: async (action, data) => {
      calls.push({ action, data });
      if (action === 'profile-read') return { displayName: 'member', username: 'login1', handle: 'member1', profileCompleted: completed };
      if (saveFails) throw new Error('offline');
      return { profileCompleted: true };
    },
    fetch: async () => { calls.push({ action: 'upload' }); return { ok: true, json: async () => ({ id: 'test-photo' }) }; },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    location: { replace: url => calls.push({ action: url }) }, showError: error => { status.textContent = error.message; }
  });
  return { calls, status, element, submit: () => element('setup-form').handlers.submit({ preventDefault() {} }), selectPhoto: () => { element('setup-photo').files = [{ type: 'image/png', size: 100 }]; element('setup-photo').handlers.change(); } };
}
test('setup bypasses Guest and already completed members', async () => {
  const guest = await fixture({ guest: true });
  assert.equal(guest.calls[0].action, '/main.html');
  const member = await fixture({ completed: true });
  assert.equal(member.calls.at(-1).action, '/main.html');
});
test('setup requires nickname and photo before saving', async () => {
  const f = await fixture();
  f.element('setup-name').value = '';
  await f.submit(); assert.equal(f.status.textContent, 'กรุณาตั้งชื่อเล่น');
  f.element('setup-name').value = 'Nickname';
  await f.submit(); assert.equal(f.status.textContent, 'กรุณาเลือกรูปโปรไฟล์');
  assert.equal(f.calls.length, 1);
});
test('setup uploads image, saves completion and then enters feed', async () => {
  const f = await fixture();
  f.selectPhoto(); f.element('setup-name').value = 'Nickname';
  await f.submit();
  assert.deepEqual(f.calls.map(call => call.action), ['profile-read', 'upload', 'profile-update', '/main.html']);
  assert.equal(f.calls[2].data.displayName, 'Nickname');
  assert.equal(f.calls[2].data.completeProfile, true);
});
test('failed save stays on setup and reuses uploaded image when retried', async () => {
  const f = await fixture({ saveFails: true });
  f.selectPhoto(); await f.submit(); await f.submit();
  assert.deepEqual(f.calls.map(call => call.action), ['profile-read', 'upload', 'profile-update', 'profile-update']);
  assert.equal(f.status.textContent, 'offline');
});


test('setup logout opens confirmation and cancelling keeps profile setup active',async()=>{
 const f=await fixture();f.element('setup-logout').handlers.click();assert.equal(f.element('logout-dialog').open,true);assert.equal(f.element('confirm-logout').disabled,true);await f.element('confirm-logout').handlers.click();assert.equal(f.calls.some(c=>c.action==='signOut'),false);f.element('cancel-logout').handlers.click();assert.equal(f.element('logout-dialog').open,false);assert.equal(f.calls.some(c=>c.action==='/'),false);
});
