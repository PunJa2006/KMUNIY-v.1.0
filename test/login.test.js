import { t, localizeError, dateLocale } from '../public/i18n.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
async function fixture(error, completed = true, options = {}) {
  const source = (await readFile(new URL('../public/login.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/, '');
  const fields = new Map();
  const element = id => {
    if (!fields.has(id)) fields.set(id, { value: '', checked: false, hidden:id==='banned-account', showModal(){this.open=true;},close(){this.open=false;},focus(){},addEventListener(_, fn) { this.callback = fn; } });
    return fields.get(id);
  };
  const calls = [];
  const sdk = {
    auth: { currentUser: null }, browserSessionPersistence: 'session',
    GoogleAuthProvider: class { setCustomParameters() {} },
    async setPersistence() {},
    async signInWithEmailAndPassword(_,email,password) { calls.push({email,password}); sdk.auth.currentUser={uid:'password-user'}; },
    async signInAnonymously() { sdk.auth.currentUser = { uid: 'guest', isAnonymous: true }; },
    async signInWithPopup() { sdk.auth.currentUser = { uid: 'verified-google-user' }; },
    async signOut() { calls.push('signOut'); sdk.auth.currentUser = null; }
  };
  if(options.user)sdk.auth.currentUser=options.user;
  const payloads=[];
  const status = {};
  const context = {
    t, localizeError, dateLocale, getLanguage: () => 'th', setLanguage: () => {},
    document: { getElementById: element }, status, URLSearchParams,
    connect: async () => sdk,
    api: async (action,data,user) => { calls.push(action);payloads.push({action,data,user});if(options.respond)return options.respond(action,data,user); if (error) throw error; if(action==='username-login') return {email:'internal@username.for-web-com1.invalid'}; return { username: 'registered', handle: 'public1', profileCompleted: completed }; },
    showError: err => { status.textContent = err.message; },
    location: { search: '', replace: url => calls.push(url) }
  };
  await runInNewContext(`(async () => { ${source} })()`, context);
  return { calls, payloads, sdk, status, element, submit:async()=>{element('login-form').callback({preventDefault(){}}); await new Promise(resolve=>setImmediate(resolve));}, click: () => element('google-login').callback(), guest: () => element('guest').callback() };
}
test('verified Google account without a member record is signed out and denied Main', async () => {
  const message = 'บัญชีนี้ไม่มีข้อมูลในระบบ กรุณาสมัครเพื่อเข้าสู่ระบบ';
  const f = await fixture(Object.assign(new Error(message), { status: 404 }));
  await f.click();
  assert.deepEqual(f.calls, ['profile-read', 'signOut']);
  assert.equal(f.status.textContent, message);
});
test('registered Google member may enter Main', async () => {
  const f = await fixture(); await f.click();
  assert.deepEqual(f.calls, ['profile-read', '/main.html']);
});
test('database outage denies entry without claiming the account is unregistered', async () => {
  const f = await fixture(Object.assign(new Error('server unavailable'), { status: 503 }));
  await f.click();
  assert.deepEqual(f.calls, ['profile-read', 'signOut']);
  assert.equal(f.status.textContent, 'server unavailable');
});

test('first member login goes to profile setup', async () => {
  const f = await fixture(null, false); await f.click();
  assert.deepEqual(f.calls, ['profile-read', '/setup-profile.html']);
});
test('Guest goes straight to feed without profile setup', async () => {
  const f = await fixture(); await f.guest();
  assert.deepEqual(f.calls, ['profile', '/main.html']);
});

test('Username logs in through Firebase password provider and clears password field',async()=>{
 const f=await fixture(); f.element('identity').value='tester1'; f.element('password').value='my-password';
 await f.submit();
 assert.deepEqual(f.calls,['username-login',{email:'internal@username.for-web-com1.invalid',password:'my-password'},'profile-read','/main.html']);
 assert.equal(f.element('password').value,'');
});


test('banned Google login keeps verified identity only for appeals and does not enter Main or sign out',async()=>{
 const error=Object.assign(Error('banned'),{status:403,code:'ACCOUNT_BANNED'}),f=await fixture(error);await f.click();
 assert.deepEqual(f.calls,['profile-read']);assert.equal(f.element('banned-account').hidden,false);assert.equal(f.element('login-options').hidden,true);assert.equal(f.sdk.auth.currentUser.uid,'verified-google-user');assert.equal(f.calls.includes('/main.html'),false);
});
test('existing banned session and banned Guest can reach the appeal form instead of looping back to Main',async()=>{
 const error=Object.assign(Error('banned'),{status:403,code:'ACCOUNT_BANNED'}),saved=await fixture(error,true,{user:{uid:'saved-user'}});assert.equal(saved.element('banned-account').hidden,false);assert.deepEqual(saved.calls,['profile-read']);
 const guest=await fixture(error);await guest.guest();assert.equal(guest.element('banned-account').hidden,false);assert.deepEqual(guest.calls,['profile']);
});
test('banned username login authenticates password for the appeal path, then profile denial keeps Main closed',async()=>{
 const error=Object.assign(Error('banned'),{status:403,code:'ACCOUNT_BANNED'}),f=await fixture(null,true,{respond:async action=>{if(action==='username-login')return {email:'internal@example.invalid'};throw error;}});
 f.element('identity').value='member1';f.element('password').value='password';await f.submit();assert.equal(f.payloads[0].data.forAppeal,true);assert.equal(f.element('banned-account').hidden,false);assert.equal(f.element('password').value,'');assert.equal(f.calls.includes('/main.html'),false);
});
test('appeal submits with the verified banned account, preserves a failed draft, and allows switching accounts',async()=>{
 let failSend=true;const error=Object.assign(Error('banned'),{status:403,code:'ACCOUNT_BANNED'});
 const f=await fixture(null,true,{user:{uid:'saved-user'},respond:async action=>{if(action==='profile-read')throw error;if(action==='usage-report-create'){if(failSend)throw Error('network');return {reported:true,kind:'appeal'};}}});
 f.element('open-ban-appeal').callback();assert.equal(f.element('ban-appeal-dialog').open,true);f.element('ban-appeal-details').value=' Please review ';
 await f.element('ban-appeal-form').callback({preventDefault(){}});assert.equal(f.element('ban-appeal-details').value,' Please review ');assert.equal(f.element('ban-appeal-dialog').open,true);
 failSend=false;await f.element('ban-appeal-form').callback({preventDefault(){}});const sent=f.payloads.at(-1);assert.equal(sent.action,'usage-report-create');assert.equal(sent.user.uid,'saved-user');assert.equal(sent.data.details,'Please review');assert.equal(f.element('ban-appeal-dialog').open,false);
 await f.element('banned-signout').callback();assert.equal(f.sdk.auth.currentUser,null);assert.equal(f.element('banned-account').hidden,true);assert.equal(f.element('login-options').hidden,false);
});
