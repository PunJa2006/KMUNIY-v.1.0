import { t, localizeError, dateLocale } from '../public/i18n.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

async function fixture(profileFails = false, emailMode = true) {
  const source = (await readFile(new URL('../public/register.js', import.meta.url), 'utf8')).replace(/^\uFEFF?import .*;\r?\n/, '');
  const fields = new Map();
  const element = id => {
    if (!fields.has(id)) fields.set(id, { value: '', addEventListener(_, fn) { this.submit = fn; } });
    return fields.get(id);
  };
  element('new-username').value = 'tester1';
  element('register-email').checked = emailMode;
  element('new-password').value = element('confirm-password').value = 'test-only-password';
  const calls = [];
  const user = { uid: 'test', email: 'test@example.invalid', providerData: [{ providerId: 'google.com' }] };
  const sdk = {
    auth: { currentUser: null }, inMemoryPersistence: 'memory',
    async setPersistence(_, mode) { calls.push(mode); },
    GoogleAuthProvider: class { setCustomParameters() {} },
    EmailAuthProvider: { credential: () => ({}) },
    async signInWithPopup() { calls.push('google'); return { user }; },
    async linkWithCredential() { calls.push('link'); user.providerData.push({ providerId: 'password' }); return { user }; },
    async signOut() { calls.push('signOut'); }
  };
  const context = {
    t, localizeError, dateLocale, getLanguage: () => 'th', setLanguage: () => {},
    document: { getElementById: element }, status: {},
    connect: async () => sdk,
    api: async action => {
      calls.push(action);
      if (action === 'profile-read') throw Object.assign(new Error('missing'), { status: 404 });
      if (profileFails) throw new Error('offline');
    },
    showError: () => {}, location: { replace: url => calls.push(url) }
  };
  await runInNewContext(`(async () => { ${source} })()`, context);
  return { calls, choose: () => element('choose-google').submit(), submit: () => element('register-form').submit({ preventDefault() {} }) };
}
test('Email button registers without username or password and returns to login', async () => {
  const f = await fixture();
  await f.choose();
  assert.deepEqual(f.calls, ['memory', 'google', 'profile-read', 'profile', 'signOut', '/?registered=1']);
});
test('failed Email profile save retries without another Google popup', async () => {
  const f = await fixture(true);
  await f.choose();
  await f.choose();
  assert.deepEqual(f.calls, ['memory', 'google', 'profile-read', 'profile', 'profile']);
});
test('username registration does not require Google or email', async () => {
  const f = await fixture();
  await f.submit();
  assert.deepEqual(f.calls, ['username-register', 'signOut', '/?registered=1']);
});
