import {moderationActions,roleFor,assignedRole,banned,permissions,handleModeration} from '../lib/moderation.js';
import {handlePostAction,savedPosts,moderationAccess} from '../lib/post-actions.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createHmac, randomUUID } from 'node:crypto';
import { extractHashtags, normalizeHashtag } from '../public/hashtags.js';
import { normalizeUsername, guestName } from '../lib/identity.js';
async function fixture({ existing = {}, race = false, guest = false, now = Date.now(), passwordResult = null, authUid = 'email-user', serverNow = null } = {}) {
  let clock = now;
  class MockDate extends Date { static now() { return clock; } }
  const records = new Map(Object.entries(existing));
  const created = [], deleted = [], removedFiles = [];
  const snap = ref => ({ref, id: ref.id, exists: records.has(ref.key), readTime: {toMillis: () => serverNow ?? clock}, data: () => records.get(ref.key) });
  const ref = key => ({ key, id: key.split('/').at(-1), get: async function() { return snap(this); }, update: async value => records.set(key, { ...records.get(key), ...value }), collection: name => collection(key + '/' + name) });
  function collection(path) {
    const comparable = value => value?.toDate ? value.toDate().getTime() : value instanceof Date ? value.getTime() : value;
    const query = (filter = () => true, order = null, direction = 'asc', after = null, lower = null, upper = null, count = Infinity) => {
      const field = doc => order === '__name__' ? doc.id : (comparable(doc.data()[order]) ?? 0);
      return {
        get: async () => {
          let rows = [...records.entries()].filter(([key, value]) => key.slice(0, key.lastIndexOf('/')) === path && filter(value)).map(([key, value]) => ({ ref:ref(key), exists:true, id: key.split('/').at(-1), data: () => value }));
          if (order) rows = rows.sort((a,b) => (field(a) < field(b) ? -1 : field(a) > field(b) ? 1 : a.id.localeCompare(b.id)) * (direction === 'desc' ? -1 : 1));
          if (lower !== null) rows = rows.filter(doc => field(doc) >= lower);
          if (upper !== null) rows = rows.filter(doc => field(doc) <= upper);
          if (after) rows = rows.slice(rows.findIndex(doc => doc.id === after) + 1);
          return { docs: rows.slice(0,count) };
        },
        where: (name, op, value) => query(data => filter(data) && (op === '==' ? data[name] === value : op === 'array-contains' ? data[name]?.includes(value) : op === '>=' ? comparable(data[name]) >= comparable(value) : op === '<=' ? comparable(data[name]) <= comparable(value) : false), order, direction, after, lower, upper, count),
        orderBy: (name, dir = 'asc') => query(filter, name, dir, after, lower, upper, count),
        startAfter: cursor => query(filter, order, direction, cursor.id, lower, upper, count),
        startAt: value => query(filter, order, direction, after, value, upper, count),
        endAt: value => query(filter, order, direction, after, lower, value, count),
        limit: value => query(filter, order, direction, after, lower, upper, value)
      };
    };
    return { key:path, ...query(), doc: (id = 'new-post') => ref(path + '/' + id), add: async value => { records.set(path + '/new-post', value); return { id: 'new-post' }; } };
  }
  let transactionQueue = Promise.resolve();
  const db = {
    collection, recursiveDelete: async ref=>{for(const key of records.keys())if(key===ref.key || key.startsWith(ref.key+'/'))records.delete(key);},
    runTransaction: fn => {
      const operation = transactionQueue.then(async () => {
      const pending = [], removals = [];
      const result = await fn({
        get: async ref => race && ['usernames/tester1', 'handles/tester1'].includes(ref.key) ? { exists: true, data: () => ({ uid: 'another-user' }) } : snap(ref),
        set: (ref, value) => pending.push([ref.key, value]),
        create: (ref, value) => pending.push([ref.key, value]),
        update: (ref, value) => pending.push([ref.key, { ...records.get(ref.key), ...value }]),
        delete: ref => removals.push(ref.key)
      });
      for (const [key, value] of pending) records.set(key, value);
      for (const key of removals) records.delete(key);
      return result;
      });
      transactionQueue = operation.catch(() => {});
      return operation;
    }
  };
  const auth = {
    getUser: async uid => ({uid,email:'internal@username.for-web-com1.invalid'}),
    createCustomToken: async () => { throw new Error('IAM signing must not be required'); },
    createUser: async user => { created.push(user); return user; },
    deleteUser: async uid => deleted.push(uid),
    verifyIdToken: async () => ({ uid: authUid, email: 'member@example.invalid', email_verified: true, name: 'Member', firebase: { sign_in_provider: guest ? 'anonymous' : 'google.com' } })
  };
  const source = (await readFile(new URL('../api/account.js', import.meta.url), 'utf8'))
    .replace(/^import .*;\r?\n/gm, '').replace(/^export \{ services \};\r?\n/gm, '').replace('export default async function handler', 'async function handler');
  const handler = runInNewContext(`(() => { ${source}; return handler; })()`, {
    Date: MockDate, getApps: () => [{}], getAuth: () => auth, getFirestore: () => db,
    moderationActions,roleFor,assignedRole,banned,permissions,handleModeration,handlePostAction:args=>handlePostAction({...args,removeFiles:async ids=>removedFiles.push(...ids)}),savedPosts,moderationAccess,extractHashtags, normalizeHashtag, normalizeUsername, guestName, createHmac, randomUUID,
    FieldValue: { serverTimestamp: () => { const time=clock; return {toDate:()=>new Date(time)}; } },
    fetch: async () => ({ok:passwordResult?.ok !== false,json:async()=>passwordResult?.body || {localId:'email-user',idToken:'verified'}}),
    AbortSignal, process: { env: { RATE_LIMIT_SECRET: 'test-only', FIREBASE_WEB_API_KEY: 'test-key' } }
  });
  async function request(body) {
    if (body.completeProfile === true && !Object.hasOwn(body, 'handle')) body = { ...body, handle: 'membername1' };
    if (body.action === 'post-create' && !Object.hasOwn(body, 'category')) body = { ...body, category: 'ถาม-ตอบ' };
    const res = { headers: {}, setHeader(name,value) { this.headers[name]=value; }, status(code) { this.code = code; return this; }, json(value) { this.value = value; return this; } };
    await handler({ method: 'POST', body, headers: { authorization: 'Bearer test-token' }, socket: { remoteAddress: '127.0.0.1' } }, res);
    return res;
  }
  return { records, created, deleted, removedFiles, request, setUser: value => { authUid = value; }, setTime: value => { clock = value; } };
}
test('username-only registration stores no personal email and uses Firebase password storage', async () => {
  const f = await fixture();
  const res = await f.request({ action: 'username-register', username: 'Tester1', password: 'test-password' });
  assert.equal(res.code, 201);
  const uid = f.records.get('usernames/tester1').uid;
  const profile = f.records.get(`users/${uid}`);
  assert.equal(profile.username, 'tester1'); assert.equal(profile.email, null);
  assert.equal(profile.password, undefined);
  assert.match(f.created[0].email, /@username\.for-web-com1\.invalid$/);
});
test('duplicate username is denied before creating an auth account', async () => {
  const f = await fixture({ existing: { 'usernames/tester1': { uid: 'existing' } } });
  assert.equal((await f.request({ action: 'username-register', username: 'tester1', password: 'test-password' })).code, 409);
  assert.equal(f.created.length, 0);
});
test('concurrent username collision rolls back only the newly created auth account', async () => {
  const f = await fixture({ race: true });
  assert.equal((await f.request({ action: 'username-register', username: 'tester1', password: 'test-password' })).code, 409);
  assert.deepEqual(f.deleted, [f.created[0].uid]);
  assert.equal([...f.records.keys()].some(key => key.startsWith('users/')), false);
});
test('email-only registration needs no username and remains eligible to log in', async () => {
  const f = await fixture();
  const res = await f.request({ action: 'profile', emailOnly: true });
  assert.equal(res.code, 200); assert.equal(res.value.email, 'member@example.invalid');
  assert.equal(res.value.username, null);
  assert.equal(f.records.has('usernames/null'), false);
  assert.equal((await f.request({ action: 'profile-read' })).code, 200);
});

test('post uses authenticated profile name and preserves text without trusting supplied author', async () => {
  const f = await fixture({ existing: { 'users/email-user': { email: 'member@example.invalid', displayName: 'Member' } } });
  const result = await f.request({ action: 'post-create', text: '  <script>hello</script>  ', displayName: 'Forged' });
  assert.equal(result.code, 201);
  const post = f.records.get('posts/new-post');
  assert.equal(post.displayName, 'Member');
  assert.equal(post.uid, 'email-user');
  assert.equal(post.text, '<script>hello</script>');
});
test('post rejects unregistered users, empty content and oversized content', async () => {
  const missing = await fixture();
  assert.equal((await missing.request({ action: 'post-create', text: 'hello' })).code, 403);
  const f = await fixture({ existing: { 'users/email-user': { email: 'member@example.invalid', displayName: 'Member' } } });
  for (const text of ['  ', 'x'.repeat(5001)]) {
    assert.equal((await f.request({ action: 'post-create', text })).code, 400);
  }
  assert.equal(f.records.has('posts/new-post'), false);
});
test('feed exposes post content without author uid or email', async () => {
  const f = await fixture({ existing: {
    'users/email-user': { email: 'member@example.invalid', displayName: 'Member' },
    'posts/one': { text: 'hello', displayName: 'Member', uid: 'private', createdAt: { toDate: () => new Date('2026-10-07T00:00:00Z') } }
  } });
  const result = await f.request({ action: 'posts-list' });
  assert.equal(result.code, 200);
  assert.equal(result.value.posts[0].text, 'hello');
  assert.equal(result.value.posts[0].uid, undefined);
});

test('archive removes public post, is private to owner, and restoration returns it to feed', async () => {
  const f = await fixture({ existing: {
    'users/email-user': { email: 'member@example.invalid', displayName: 'Member' },
    'posts/mine': { uid: 'email-user', text: 'my post', displayName: 'Member' },
    'users/another/archive/secret': { uid: 'another', text: 'private secret' }
  } });
  assert.equal((await f.request({ action: 'post-archive', id: 'mine' })).code, 200);
  assert.equal(f.records.has('posts/mine'), false);
  assert.equal((await f.request({ action: 'posts-list' })).value.posts.length, 0);
  const archive = (await f.request({ action: 'archive-list', uid: 'another' })).value.posts;
  assert.equal(archive.length, 1);
  assert.equal(archive[0].text, 'my post');
  assert.equal((await f.request({ action: 'post-restore', id: 'mine' })).code, 200);
  assert.equal(f.records.has('users/email-user/archive/mine'), false);
  assert.equal(f.records.has('posts/mine'), true);
});
test('cannot archive another user post or restore another user archive', async () => {
  const f = await fixture({ existing: {
    'users/email-user': { email: 'member@example.invalid', displayName: 'Member' },
    'posts/theirs': { uid: 'another', text: 'public' },
    'users/another/archive/secret': { uid: 'another', text: 'private' }
  } });
  assert.equal((await f.request({ action: 'post-archive', id: 'theirs' })).code, 403);
  assert.equal((await f.request({ action: 'post-restore', id: 'secret', uid: 'another' })).code, 404);
  assert.equal(f.records.has('posts/theirs'), true);
});
test('my posts only includes own public posts', async () => {
  const f = await fixture({ existing: {
    'users/email-user': { email: 'member@example.invalid', displayName: 'Member' },
    'posts/mine': { uid: 'email-user', text: 'mine' },
    'posts/theirs': { uid: 'another', text: 'theirs' }
  } });
  const result = await f.request({ action: 'my-posts', uid: 'another' });
  assert.equal(result.value.posts.length, 1);
  assert.equal(result.value.posts[0].text, 'mine');
});
test('profile edit changes display fields but cannot change login or another account', async () => {
  const f = await fixture({ existing: { 'users/email-user': { email: 'member@example.invalid', displayName: 'Member', username: 'member1' } } });
  assert.equal((await f.request({ action: 'profile-update', displayName: 'New name', bio: 'Hello', avatar: '🐱', username: 'hacked', email: 'changed', uid: 'another' })).code, 200);
  const profile = f.records.get('users/email-user');
  assert.equal(profile.displayName, 'New name');
  assert.equal(profile.username, 'member1');
  assert.equal(profile.email, 'member@example.invalid');
  assert.equal(profile.bio, 'Hello');
  assert.equal((await f.request({ action: 'profile-update', displayName: '', bio: '', avatar: '🐱' })).code, 400);
});

test('media-only post claims its own uploads atomically and survives archive and restore', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const f = await fixture({ existing: {
    'users/email-user': { email: 'member@example.invalid', displayName: 'Member' },
    ['media/' + id]: { uid: 'email-user', type: 'video/mp4', size: 100, postId: null }
  } });
  assert.equal((await f.request({ action: 'post-create', text: '', mediaIds: [id] })).code, 201);
  assert.equal(f.records.get('media/' + id).postId, 'new-post');
  assert.equal(f.records.get('posts/new-post').media[0].type, 'video/mp4');
  f.setTime(f.records.get('users/email-user').postAvailableAt);
  assert.equal((await f.request({ action: 'post-create', mediaIds: [id] })).code, 403);
  await f.request({ action: 'post-archive', id: 'new-post' });
  assert.equal(f.records.get('users/email-user/archive/new-post').media[0].id, id);
  await f.request({ action: 'post-restore', id: 'new-post' });
  assert.equal(f.records.get('posts/new-post').media[0].id, id);
});
test('foreign, missing, duplicate or oversized attachments cannot be published', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  for (const attachment of [null, { uid: 'another', size: 10 }, { uid: 'email-user', size: 51 * 1024 * 1024 }]) {
    const f = await fixture({ existing: {
      'users/email-user': { email: 'member@example.invalid', displayName: 'Member' },
      ...(attachment ? { ['media/' + id]: attachment } : {})
    } });
    const result = await f.request({ action: 'post-create', text: 'hello', mediaIds: [id] });
    assert.ok([400, 403].includes(result.code));
    assert.equal(f.records.has('posts/new-post'), false);
  }
  const f = await fixture({ existing: { 'users/email-user': { email: 'member@example.invalid', displayName: 'Member' } } });
  assert.equal((await f.request({ action: 'post-create', mediaIds: [id, id] })).code, 400);
});

test('all four posting categories are saved and preserved when archived', async () => {
  for (const category of ['ทั่วไป', 'ถาม-ตอบ', 'ขายของ', 'ของหาย']) {
    const f = await fixture({ existing: { 'users/email-user': { email: 'member@example.invalid', displayName: 'Member' } } });
    assert.equal((await f.request({ action: 'post-create', text: 'hello', category })).code, 201);
    assert.equal(f.records.get('posts/new-post').category, category);
    await f.request({ action: 'post-archive', id: 'new-post' });
    assert.equal(f.records.get('users/email-user/archive/new-post').category, category);
    await f.request({ action: 'post-restore', id: 'new-post' });
    assert.equal(f.records.get('posts/new-post').category, category);
  }
});
test('category filters show matching posts and All also includes legacy posts', async () => {
  const f = await fixture({ existing: {
    'users/email-user': { email: 'member@example.invalid', displayName: 'Member' },
    'posts/qa': { uid: 'email-user', text: 'question', category: 'ถาม-ตอบ' },
    'posts/market': { uid: 'other', text: 'sale', category: 'ขายของ' },
    'posts/legacy': { uid: 'other', text: 'legacy' }
  } });
  const selected = await f.request({ action: 'posts-list', category: 'ขายของ' });
  assert.equal(selected.value.posts.length, 1);
  assert.equal(selected.value.posts[0].text, 'sale');
  assert.equal((await f.request({ action: 'posts-list', category: 'ทั้งหมด' })).value.posts.length, 3);
  assert.equal((await f.request({ action: 'posts-list', category: 'ของหาย' })).value.posts.length, 0);
});
test('All and arbitrary values cannot be used as a post category', async () => {
  const f = await fixture({ existing: { 'users/email-user': { email: 'member@example.invalid', displayName: 'Member' } } });
  for (const category of [null, '', 'ทั้งหมด', 'unknown']) {
    assert.equal((await f.request({ action: 'post-create', text: 'hello', category })).code, 400);
  }
  assert.equal(f.records.has('posts/new-post'), false);
  assert.equal((await f.request({ action: 'posts-list', category: 'unknown' })).code, 400);
});

test('profile photo belongs to authenticated member and appears with their posts', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const f = await fixture({ existing: {
    'users/email-user': { email: 'member@example.invalid', displayName: 'Member' },
    ['media/' + id]: { uid: 'email-user', type: 'image/jpeg', size: 100, postId: null },
    'posts/old': { uid: 'email-user', text: 'hello', displayName: 'Member' }
  } });
  assert.equal((await f.request({ action: 'profile-update', displayName: 'Member', bio: '', photoMediaId: id })).code, 200);
  assert.equal(f.records.get('users/email-user').photoMediaId, id);
  assert.equal((await f.request({ action: 'posts-list' })).value.posts[0].authorPhotoId, id);
  assert.equal((await f.request({ action: 'post-create', mediaIds: [id] })).code, 403);
  assert.equal((await f.request({ action: 'profile-update', displayName: 'Member', bio: '', photoMediaId: null })).code, 200);
  assert.equal(f.records.get('users/email-user').photoMediaId, null);
});
test('profile photo rejects foreign uploads, videos and oversized images', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  for (const media of [{ uid: 'other', type: 'image/png', size: 100 }, { uid: 'email-user', type: 'video/mp4', size: 100 }, { uid: 'email-user', type: 'image/png', size: 6 * 1024 * 1024 }]) {
    const f = await fixture({ existing: { 'users/email-user': { email: 'member@example.invalid', displayName: 'Member' }, ['media/' + id]: media } });
    assert.equal((await f.request({ action: 'profile-update', displayName: 'Member', bio: '', photoMediaId: id })).code, 400);
    assert.equal(f.records.get('users/email-user').photoMediaId, undefined);
  }
});
test('Guest cannot set a custom photo even through direct API request', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const f = await fixture({ guest: true, existing: {
    'users/email-user': { isGuest: true, displayName: 'Guest' },
    ['media/' + id]: { uid: 'email-user', type: 'image/png', size: 100 }
  } });
  assert.equal((await f.request({ action: 'profile-update', displayName: 'Guest', bio: '', photoMediaId: id })).code, 403);
});

test('first profile completion requires photo and persists after later profile edits', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const f = await fixture({ existing: {
    'users/email-user': { email: 'member@example.invalid', displayName: 'Member' },
    ['media/' + id]: { uid: 'email-user', type: 'image/png', size: 100 }
  } });
  assert.equal((await f.request({ action: 'profile-update', displayName: 'Nick', bio: '', completeProfile: true, photoMediaId: null })).code, 400);
  assert.equal((await f.request({ action: 'profile-update', displayName: 'Nick', bio: '', completeProfile: true, photoMediaId: id })).code, 200);
  assert.equal(f.records.get('users/email-user').profileCompleted, true);
  await f.request({ action: 'profile-update', displayName: 'New nick', bio: '', photoMediaId: null });
  assert.equal(f.records.get('users/email-user').profileCompleted, true);
});

test('first profile reserves normalized unique Username and rejects another owner', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const existing = {
    'users/email-user': { email: 'member@example.invalid', displayName: 'Member' },
    ['media/' + id]: { uid: 'email-user', type: 'image/png', size: 100 },
    'handles/taken1': { uid: 'other' }
  };
  const f = await fixture({ existing });
  const data = { action: 'profile-update', displayName: 'Nick', bio: '', photoMediaId: id, completeProfile: true };
  assert.equal((await f.request({ ...data, handle: 'Taken1' })).code, 409);
  assert.equal(f.records.get('users/email-user').profileCompleted, undefined);
  assert.equal((await f.request({ ...data, handle: 'Myname1' })).code, 200);
  assert.equal(f.records.get('handles/myname1').uid, 'email-user');
  assert.equal(f.records.get('users/email-user').handle, 'myname1');
  assert.equal((await f.request({ ...data, handle: 'different' })).code, 400);
});
test('profile handle preserves the independent login username', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const f = await fixture({ existing: {
    'users/email-user': { username: 'oldname', displayName: 'Old' },
    'usernames/oldname': { uid: 'email-user' },
    ['media/' + id]: { uid: 'email-user', type: 'image/png', size: 100 }
  } });
  assert.equal((await f.request({ action: 'profile-update', displayName: 'Nick', bio: '', photoMediaId: id, completeProfile: true, handle: 'newname1' })).code, 200);
  assert.equal(f.records.has('usernames/oldname'), true);
  assert.equal(f.records.get('handles/newname1').uid, 'email-user');
});
test('transaction prevents claiming a username that became occupied during signup', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const f = await fixture({ race: true, existing: {
    'users/email-user': { email: 'member@example.invalid', displayName: 'Member' },
    ['media/' + id]: { uid: 'email-user', type: 'image/png', size: 100 }
  } });
  assert.equal((await f.request({ action: 'profile-update', displayName: 'Nick', bio: '', photoMediaId: id, completeProfile: true, handle: 'tester1' })).code, 409);
  assert.equal(f.records.get('users/email-user').username, undefined);
});


test('profile handle uses a separate namespace and leaves login credentials untouched', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const f = await fixture({ existing: {
    'users/email-user': { username: 'login1', displayName: 'Member' },
    'usernames/login1': { uid: 'email-user' },
    'usernames/public1': { uid: 'different-login-user' },
    ['media/' + id]: { uid: 'email-user', type: 'image/png', size: 100 }
  } });
  const result = await f.request({ action: 'profile-update', displayName: 'Nick', bio: '', completeProfile: true, photoMediaId: id, handle: 'Public1', username: 'tampered1' });
  assert.equal(result.code, 200);
  assert.equal(result.value.username, 'login1');
  assert.equal(result.value.handle, 'public1');
  assert.equal(f.records.get('users/email-user').username, 'login1');
  assert.equal(f.records.get('handles/public1').uid, 'email-user');
  assert.equal(f.records.get('usernames/login1').uid, 'email-user');
  assert.equal(f.records.get('usernames/public1').uid, 'different-login-user');
  assert.equal(f.records.has('usernames/tampered1'), false);
});

test('handle changes once per calendar month and never changes login username', async () => {
  const now = Date.parse('2027-01-31T10:00:00+07:00');
  const f = await fixture({ now, existing: {
    'users/email-user': { username: 'login1', handle: 'old1', displayName: 'Nick', profileCompleted: true },
    'usernames/login1': { uid: 'email-user' }, 'handles/old1': { uid: 'email-user' }
  } });
  const data = { action: 'profile-update', displayName: 'Nick', bio: '', photoMediaId: null };
  assert.equal((await f.request({ ...data, handle: 'new1' })).code, 200);
  const available = f.records.get('users/email-user').handleAvailableAt;
  assert.equal(available, Date.parse('2027-02-28T10:00:00+07:00'));
  assert.equal((await f.request({ ...data, handle: 'next1' })).code, 429);
  assert.equal(f.records.get('users/email-user').username, 'login1');
  assert.equal(f.records.has('handles/next1'), false);
  assert.equal((await f.request({ ...data, handle: 'new1', bio: 'updated' })).code, 200);
  f.setTime(available);
  assert.equal((await f.request({ ...data, handle: 'next1' })).code, 200);
  assert.equal(f.records.has('handles/new1'), false);
});
test('nickname allows three changes then resets seven days after the third', async () => {
  const now = Date.parse('2027-01-01T00:00:00Z');
  const f = await fixture({ now, existing: { 'users/email-user': { username: 'login1', handle: 'public1', displayName: 'Original', profileCompleted: true } } });
  const data = { action: 'profile-update', bio: '', photoMediaId: null };
  for (const displayName of ['One', 'Two', 'Three']) assert.equal((await f.request({ ...data, displayName })).code, 200);
  assert.equal(f.records.get('users/email-user').nicknameChanges, 3);
  const reset = now + 7 * 24 * 60 * 60 * 1000;
  assert.equal(f.records.get('users/email-user').nicknameResetAt, reset);
  assert.equal((await f.request({ ...data, displayName: 'Four' })).code, 429);
  assert.equal((await f.request({ ...data, displayName: 'Three', bio: 'new bio' })).code, 200);
  assert.equal(f.records.get('users/email-user').nicknameChanges, 3);
  f.setTime(reset - 1);
  assert.equal((await f.request({ ...data, displayName: 'Four' })).code, 429);
  f.setTime(reset);
  assert.equal((await f.request({ ...data, displayName: 'Four' })).code, 200);
  assert.equal(f.records.get('users/email-user').nicknameChanges, 1);
});
test('initial setup and unsuccessful handle claim do not consume nickname changes', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const f = await fixture({ existing: {
    'users/email-user': { username: 'login1', displayName: 'Original' },
    ['media/' + id]: { uid: 'email-user', type: 'image/png', size: 100 },
    'handles/taken1': { uid: 'other' }
  } });
  assert.equal((await f.request({ action: 'profile-update', completeProfile: true, displayName: 'Nick', bio: '', photoMediaId: id, handle: 'public1' })).code, 200);
  assert.equal(f.records.get('users/email-user').nicknameChanges, 0);
  assert.equal((await f.request({ action: 'profile-update', displayName: 'Changed', bio: '', handle: 'taken1' })).code, 409);
  assert.equal(f.records.get('users/email-user').nicknameChanges, 0);
  assert.equal(f.records.get('users/email-user').handle, 'public1');
});


const socialMember = { email: 'private@example.invalid', displayName: 'Member', handle: 'member1', username: 'private-login' };
test('likes are idempotent, use authenticated identity, and unlike decrements once', async () => {
  const f = await fixture({existing: { 'users/email-user': socialMember, 'posts/p1': { uid: 'email-user', text:'post' } }});
  for (let i=0;i<2;i++) {
    const r=await f.request({action:'post-like',id:'p1',liked:true,uid:'forged'});
    assert.equal(r.code,200); assert.equal(r.value.likeCount,1);
  }
  assert.equal(f.records.get('posts/p1/likes/email-user').uid,'email-user');
  assert.equal(f.records.has('posts/p1/likes/forged'),false);
  for (let i=0;i<2;i++) assert.equal((await f.request({action:'post-like',id:'p1',liked:false})).value.likeCount,0);
  assert.equal(f.records.has('posts/p1/likes/email-user'),false);
});
test('comments validate text, use actual member, and expose only public identity', async () => {
  const f=await fixture({existing:{'users/email-user':socialMember,'posts/p1':{uid:'email-user',text:'hello'}}});
  for (const text of ['', '  ', 'x'.repeat(2001)]) assert.equal((await f.request({action:'comment-create',id:'p1',text})).code,400);
  assert.equal((await f.request({action:'comment-create',id:'p1',text:' <script>text</script> ',uid:'forged'})).code,201);
  assert.equal(f.records.get('posts/p1').commentCount,1);
  const detail=await f.request({action:'post-detail',id:'p1'});
  assert.equal(detail.code,200);
  assert.equal(detail.value.comments[0].text,'<script>text</script>');
  assert.equal(detail.value.comments[0].displayName,'Member');
  assert.equal(detail.value.comments[0].handle,'member1');
  for (const key of ['uid','email','username']) assert.equal(detail.value.comments[0][key],undefined);
});
test('archive retains interactions privately and disallows new likes and comments', async () => {
  const f=await fixture({existing:{'users/email-user':socialMember,'posts/p1':{uid:'email-user',text:'hello'}}});
  await f.request({action:'post-like',id:'p1',liked:true});
  await f.request({action:'comment-create',id:'p1',text:'hello'});
  await f.request({action:'post-archive',id:'p1'});
  const privateDetail=await f.request({action:'post-detail',id:'p1'});
  assert.equal(privateDetail.value.post.archived,true); assert.equal(privateDetail.value.likes.length,1); assert.equal(privateDetail.value.comments.length,1);
  for (const body of [{action:'post-like',liked:true},{action:'comment-create',text:'new'}]) assert.equal((await f.request({...body,id:'p1'})).code,404);
  await f.request({action:'post-restore',id:'p1'});
  assert.equal((await f.request({action:'post-detail',id:'p1'})).value.comments.length,1);
  const other=await fixture({existing:{'users/email-user':socialMember,'users/other/archive/p1':{uid:'other',text:'secret'},'posts/p1/comments/c1':{uid:'other',text:'secret comment'}}});
  assert.equal((await other.request({action:'post-detail',id:'p1'})).code,404);
});
test('likes and comments paginate beyond 100 without losing or duplicating entries', async () => {
  const existing={'users/email-user':socialMember,'posts/p1':{uid:'email-user',text:'hello',likeCount:101,commentCount:101}};
  for(let i=0;i<101;i++) {
    const id='u'+String(i).padStart(3,'0');
    existing['users/'+id]={displayName:id,isGuest:true,photoMediaId:'private'};
    existing['posts/p1/likes/'+id]={uid:id};
    existing['posts/p1/comments/'+id]={uid:id,text:id,createdAt:{toDate:()=>new Date(i*1000)}};
  }
  const f=await fixture({existing});
  const first=(await f.request({action:'post-detail',id:'p1'})).value;
  const next=(await f.request({action:'post-detail',id:'p1',likesAfter:first.likesAfter,commentsAfter:first.commentsAfter})).value;
  assert.equal(first.likes.length,100); assert.equal(next.likes.length,1);
  assert.equal(first.comments.length,100); assert.equal(next.comments.length,1);
  assert.equal(new Set([...first.comments,...next.comments].map(c=>c.id)).size,101);
  assert.equal(next.commentsAfter,null); assert.equal(next.likesAfter,null);
  assert.equal(first.likes[0].photoId,null);
});

test('username password login works without IAM signing and does not expose tokens', async()=>{
 const f=await fixture({existing:{'usernames/tester1':{uid:'email-user'}}});
 const result=await f.request({action:'username-login',username:'tester1',password:'correct-password'});
 assert.equal(result.code,200); assert.equal(result.value.email,'internal@username.for-web-com1.invalid'); assert.equal(result.value.token,undefined);
});
test('username login refuses wrong password, mismatched identity and incomplete MFA', async()=>{
 for(const passwordResult of [{ok:false,body:{}},{body:{localId:'other',idToken:'token'}},{body:{localId:'email-user',idToken:'token',mfaPendingCredential:'pending'}}]) {
  const f=await fixture({existing:{'usernames/tester1':{uid:'email-user'}},passwordResult});
  const result=await f.request({action:'username-login',username:'tester1',password:'wrong'});
  assert.equal(result.code,401); assert.equal(result.value.email,undefined);
 }
});

test('author profile exposes public fields and only their published posts, including Guest', async()=>{
 for(const guest of [false,true]) {
  const f=await fixture({existing:{
   'users/email-user':socialMember,
   'users/other':{displayName:'Other',handle:guest?null:'other1',bio:'About',email:'private@example.invalid',username:'privateLogin',isGuest:guest,photoMediaId:guest?'hidden':'photo'},
   'posts/p1':{uid:'other',text:'public'},
   'posts/p2':{uid:'email-user',text:'someone else'},
   'users/other/archive/secret':{uid:'other',text:'private'}
  }});
  const r=await f.request({action:'author-profile',id:'p1'});
  assert.equal(r.code,200); assert.equal(r.value.profile.displayName,'Other'); assert.equal(r.value.profile.bio,'About');
  assert.equal(r.value.profile.photoMediaId,guest?null:'photo');
  for(const key of ['uid','email','username','nicknameChanges']) assert.equal(r.value.profile[key],undefined);
  assert.deepEqual(Array.from(r.value.posts,p=>p.id),['p1']);
  assert.equal((await f.request({action:'author-profile',id:'secret'})).code,404);
 }
});

test('post cooldown rejects attempts before one minute and allows exactly at the boundary',async()=>{
 const now=1700000000000;
 const f=await fixture({now,existing:{'users/email-user':socialMember}});
 assert.equal((await f.request({action:'post-create',text:'first'})).code,201);
 assert.equal(f.records.get('users/email-user').postAvailableAt,now+60000);
 f.setTime(now+59999);
 const blocked=await f.request({action:'post-create',text:'next',postAvailableAt:0});
 assert.equal(blocked.code,429); assert.equal(blocked.value.retryAfter,1); assert.equal(blocked.headers['Retry-After'],'1');
 assert.equal(f.records.get('users/email-user').postAvailableAt,now+60000);
 f.setTime(now+60000);
 assert.equal((await f.request({action:'post-create',text:'next'})).code,201);
});
test('simultaneous post requests allow one and profile edit/archive cannot reset cooldown',async()=>{
 const f=await fixture({existing:{'users/email-user':socialMember}});
 const responses=await Promise.all([f.request({action:'post-create',text:'one'}),f.request({action:'post-create',text:'two'})]);
 assert.deepEqual(responses.map(r=>r.code).sort(),[201,429]);
 await f.request({action:'post-archive',id:'new-post'});
 await f.request({action:'profile-update',displayName:'Member',bio:'',postAvailableAt:0});
 assert.equal((await f.request({action:'post-create',text:'still blocked'})).code,429);
});
test('bad content or rejected attachment does not consume cooldown or claim uploads',async()=>{
 const id='11111111-1111-4111-8111-111111111111';
 const f=await fixture({existing:{'users/email-user':socialMember,['media/'+id]:{uid:'other',type:'image/png',size:10}}});
 assert.equal((await f.request({action:'post-create',text:''})).code,400);
 assert.equal((await f.request({action:'post-create',mediaIds:[id]})).code,403);
 assert.equal(f.records.get('users/email-user').postAvailableAt,undefined);
 assert.equal(f.records.get('media/'+id).postId,undefined);
 assert.equal((await f.request({action:'post-create',text:'valid'})).code,201);
});
test('cooldown is per account and also applies to Guest and media posts',async()=>{
 const id='11111111-1111-4111-8111-111111111111';
 const f=await fixture({guest:true,existing:{'users/email-user':{displayName:'Guest',isGuest:true},'users/other':{displayName:'Other Guest',isGuest:true},['media/'+id]:{uid:'email-user',type:'image/png',size:10}}});
 assert.equal((await f.request({action:'post-create',mediaIds:[id]})).code,201);
 assert.equal((await f.request({action:'post-create',text:'again'})).code,429);
 f.setUser('other');
 assert.equal((await f.request({action:'post-create',text:'another user'})).code,201);
});

test('posts derive normalized unique hashtags server-side and ignore supplied tag metadata',async()=>{
 const f=await fixture({existing:{'users/email-user':{email:'member@example.invalid',displayName:'Member'}}});
 const response=await f.request({action:'post-create',text:'#KMUTNB #kmutnb #ชีวิตมหาลัย',hashtags:['forged']});
 assert.equal(response.code,201);
 assert.deepEqual([...f.records.get('posts/new-post').hashtags],['kmutnb','ชีวิตมหาลัย']);
});

test('trends count unique posts in the last three hours and exclude old, future, private and single-use tags',async()=>{
 const now=Date.now(),stamp=ms=>({toDate:()=>new Date(ms)});
 const f=await fixture({now,existing:{
  'users/email-user':{email:'member@example.invalid',displayName:'Member'},
  'posts/a':{text:'#KMUTNB #kmutnb #ชีวิตมหาลัย #once',createdAt:stamp(now-1000)},
  'posts/b':{text:'#kmutnb #ชีวิตมหาลัย',createdAt:stamp(now-2*3600000)},
  'posts/c':{text:'#kmutnb',createdAt:stamp(now-3*3600000)},
  'posts/old':{text:'#old #kmutnb',createdAt:stamp(now-3*3600000-1)},
  'posts/future':{text:'#future #kmutnb',createdAt:stamp(now+1)},
  'users/email-user/archive/private':{text:'#private #kmutnb',createdAt:stamp(now-500)}
 }});
 const response=await f.request({action:'trending-tags'});
 assert.equal(response.code,200);assert.equal(response.value.windowHours,3);
 assert.equal(JSON.stringify(response.value.tags),JSON.stringify([{tag:'kmutnb',count:3},{tag:'ชีวิตมหาลัย',count:2}]));
 f.setTime(now+3*3600000);assert.equal((await f.request({action:'trending-tags'})).value.tags.length,0);
});

test('hashtag feed matches whole tags, respects category filters and excludes archives',async()=>{
 const f=await fixture({existing:{
  'users/email-user':{email:'member@example.invalid',displayName:'Member'},
  'posts/a':{uid:'email-user',text:'#KMUTNB',hashtags:['kmutnb'],category:'ถาม-ตอบ'},
  'posts/b':{uid:'email-user',text:'#kmutnb',hashtags:['kmutnb'],category:'ขายของ'},
  'posts/c':{uid:'email-user',text:'#kmutnb2',hashtags:['kmutnb2'],category:'ขายของ'},
  'users/email-user/archive/private':{text:'#kmutnb',hashtags:['kmutnb']}
 }});
 const all=await f.request({action:'posts-list',hashtag:'#KMUTNB'});assert.equal(all.code,200);assert.equal(all.value.posts.length,2);
 const market=await f.request({action:'posts-list',hashtag:'kmutnb',category:'ขายของ'});assert.equal(market.value.posts.length,1);assert.equal(market.value.posts[0].id,'b');
 assert.equal((await f.request({action:'posts-list',hashtag:'bad/path'})).code,400);
});

test('search uses public handle prefix only and never returns login names, emails or private fields',async()=>{
 const f=await fixture({existing:{
  'users/email-user':{email:'member@example.invalid',displayName:'Member'},
  'handles/mind01':{uid:'other'},'handles/mind02':{uid:'incomplete'},'handles/mind03':{uid:'guest'},'handles/mind04':{uid:'missing'},
  'users/other':{displayName:'มายด์',handle:'mind01',profileCompleted:true,email:'secret@example.invalid',username:'private-login',bio:'bio',photoMediaId:'photo',uid:'other'},
  'users/incomplete':{displayName:'Incomplete',handle:'mind02',profileCompleted:false},
  'users/guest':{displayName:'guest_1',handle:'mind03',isGuest:true,profileCompleted:true}
 }});
 const res=await f.request({action:'search-users',query:'@MIND'});assert.equal(res.code,200);
 assert.equal(JSON.stringify(res.value.users),JSON.stringify([{displayName:'มายด์',handle:'mind01',photoId:'photo',suspended:false}]));
 assert.equal((await f.request({action:'search-users',query:'private-login'})).code,400);
 assert.equal((await f.request({action:'search-users',query:'../'})).code,400);
});

test('a searched profile with no posts can open by public handle and cannot expose its archive',async()=>{
 const f=await fixture({existing:{
  'users/email-user':{email:'member@example.invalid',displayName:'Member'},
  'handles/other1':{uid:'other'},
  'users/other':{displayName:'Other',handle:'other1',profileCompleted:true,email:'secret@example.invalid',username:'private-login',bio:'Public bio'},
  'users/other/archive/private':{uid:'other',text:'private'}
 }});
 const res=await f.request({action:'author-profile',handle:'OTHER1'});
 assert.equal(res.code,200);assert.equal(res.value.profile.displayName,'Other');assert.equal(res.value.posts.length,0);
 assert.equal(res.value.profile.email,undefined);assert.equal(res.value.profile.username,undefined);assert.equal(res.value.profile.uid,undefined);
 assert.equal((await f.request({action:'author-profile',handle:'missing1'})).code,404);
});

test('unregistered users cannot access user search or trending tags',async()=>{
 const f=await fixture();
 assert.equal((await f.request({action:'search-users',query:'member'})).code,403);
 assert.equal((await f.request({action:'trending-tags'})).code,403);
});

test('trend window follows Firestore server time when the local clock is behind',async()=>{
 const now=Date.now(),serverNow=now+3600000,stamp=ms=>({toDate:()=>new Date(ms)});
 const f=await fixture({now,serverNow,existing:{
  'users/email-user':{email:'member@example.invalid',displayName:'Member'},
  'posts/a':{text:'#new',createdAt:stamp(serverNow-1000)},
  'posts/b':{text:'#new',createdAt:stamp(serverNow-2000)},
  'posts/too-old':{text:'#new',createdAt:stamp(serverNow-3*3600000-1)}
 }});
 const res=await f.request({action:'trending-tags'});
 assert.equal(res.code,200);assert.equal(res.value.tags[0].tag,'new');assert.equal(res.value.tags[0].count,2);
});

test('editing an own post changes text/category/hashtags while preserving creation, likes and cooldown',async()=>{
 const time={toDate:()=>new Date()},createdAt={toDate:()=>new Date(123)};
 const f=await fixture({existing:{'users/email-user':{email:'member@example.invalid',postAvailableAt:9999999999999},'posts/p1':{uid:'email-user',text:'old #tag',category:'ถาม-ตอบ',createdAt,likeCount:7,commentCount:3,saveVersion:'version1'}}});
 const res=await f.request({action:'post-update',id:'p1',text:'new #KMUTNB',category:'ขายของ',uid:'forged',displayName:'forged'});
 assert.equal(res.code,200);const post=f.records.get('posts/p1');assert.equal(post.text,'new #KMUTNB');assert.equal(post.category,'ขายของ');assert.deepEqual(post.hashtags,['kmutnb']);assert.equal(post.createdAt,createdAt);assert.equal(post.likeCount,7);assert.equal(post.commentCount,3);assert.equal(post.saveVersion,'version1');assert.equal(post.uid,'email-user');assert.equal(f.records.get('users/email-user').postAvailableAt,9999999999999);
});

test('post edit rejects another owner, empty content and foreign media without changing the post',async()=>{
 const id='11111111-1111-4111-8111-111111111111';
 const f=await fixture({existing:{'users/email-user':{email:'member@example.invalid'},'posts/p1':{uid:'email-user',text:'old',category:'ถาม-ตอบ'},'posts/other':{uid:'other',text:'private'},['media/'+id]:{uid:'other',type:'image/png',size:50}}});
 assert.equal((await f.request({action:'post-update',id:'other',text:'new',category:'ขายของ'})).code,403);
 assert.equal((await f.request({action:'post-update',id:'p1',text:' ',category:'ขายของ'})).code,400);
 assert.equal((await f.request({action:'post-update',id:'p1',text:'new',category:'ขายของ',mediaIds:[id]})).code,403);
 assert.equal(f.records.get('posts/p1').text,'old');
});

test('editing media removes dropped attachments and accepts only the owner’s unused uploads',async()=>{
 const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
 const f=await fixture({existing:{'users/email-user':{email:'member@example.invalid'},'posts/p1':{uid:'email-user',text:'old',media:[{id:a,type:'image/png',size:50}]},['media/'+a]:{uid:'email-user',postId:'p1',type:'image/png',size:50},['media/'+b]:{uid:'email-user',postId:null,type:'image/png',size:60}}});
 assert.equal((await f.request({action:'post-update',id:'p1',text:'new',category:'ถาม-ตอบ',mediaIds:[b]})).code,200);
 assert.equal(f.records.has('media/'+a),false);assert.deepEqual(f.removedFiles,[a]);assert.equal(f.records.get('media/'+b).postId,'p1');assert.equal(f.records.get('posts/p1').media[0].id,b);
});

test('deletion permanently removes own public/archive posts, interaction children and attached media',async()=>{
 const id='11111111-1111-4111-8111-111111111111';
 const f=await fixture({existing:{'users/email-user':{email:'member@example.invalid'},'posts/p1':{uid:'email-user',text:'gone',media:[{id}]},'posts/p1/comments/c1':{text:'gone'},'posts/p1/likes/u1':{},['media/'+id]:{uid:'email-user',postId:'p1'},'users/email-user/archive/a1':{uid:'email-user',text:'archive'}}});
 assert.equal((await f.request({action:'post-delete',id:'p1'})).code,200);
 for(const key of ['posts/p1','posts/p1/comments/c1','posts/p1/likes/u1','media/'+id])assert.equal(f.records.has(key),false);
 assert.equal((await f.request({action:'post-restore',id:'p1'})).code,404);
 assert.equal((await f.request({action:'post-delete',id:'a1'})).code,200);assert.equal(f.records.has('users/email-user/archive/a1'),false);assert.deepEqual(f.removedFiles,[id]);
});

test('another user cannot permanently delete a post or its files',async()=>{
 const f=await fixture({existing:{'users/email-user':{email:'member@example.invalid'},'posts/p1':{uid:'other',text:'keep'}}});
 assert.equal((await f.request({action:'post-delete',id:'p1'})).code,403);assert.equal(f.records.get('posts/p1').text,'keep');
});

test('saved posts are private, idempotent and disappear permanently after archive and restore',async()=>{
 const f=await fixture({existing:{'users/email-user':{email:'member@example.invalid'},'users/other':{email:'other@example.invalid'},'posts/p1':{uid:'other',text:'saved',saveVersion:'v1'}}});
 assert.equal((await f.request({action:'post-save',id:'p1',saved:true})).code,200);
 const savedAt=f.records.get('users/email-user/saved/p1').savedAt;
 await f.request({action:'post-save',id:'p1',saved:true});assert.equal(f.records.get('users/email-user/saved/p1').savedAt,savedAt);
 assert.equal((await f.request({action:'saved-list'})).value.posts.length,1);
 f.setUser('other');assert.equal((await f.request({action:'saved-list',uid:'email-user'})).value.posts.length,0);
 await f.request({action:'post-archive',id:'p1'});await f.request({action:'post-restore',id:'p1'});
 f.setUser('email-user');assert.equal((await f.request({action:'saved-list'})).value.posts.length,0);assert.equal(f.records.has('users/email-user/saved/p1'),false);
 await f.request({action:'post-save',id:'p1',saved:true});assert.equal((await f.request({action:'saved-list'})).value.posts.length,1);
 f.setUser('other');await f.request({action:'post-delete',id:'p1'});
 f.setUser('email-user');assert.equal((await f.request({action:'saved-list'})).value.posts.length,0);
});

test('cannot save own, deleted or archived posts; unsaving a deleted post still succeeds',async()=>{
 const f=await fixture({existing:{'users/email-user':{email:'member@example.invalid'},'posts/own':{uid:'email-user',text:'own'},'users/other/archive/a1':{uid:'other',text:'private'}}});
 assert.equal((await f.request({action:'post-save',id:'own',saved:true})).code,400);
 assert.equal((await f.request({action:'post-save',id:'a1',saved:true})).code,404);
 assert.equal((await f.request({action:'post-save',id:'missing',saved:false})).code,200);
});

test('reports go only to the pinned admin account; ordinary users cannot read or grant themselves inbox access',async()=>{
 const f=await fixture({existing:{'settings/moderation':{reportRecipientUid:'admin'},'users/email-user':{email:'member@example.invalid',displayName:'Reporter',handle:'reporter1'},'users/author':{email:'author@example.invalid',displayName:'Author',handle:'author1'},'users/admin':{email:'admin@example.invalid',displayName:'PunJa',handle:'admin1'},'posts/p1':{uid:'author',text:'reported post'}}});
 const sent=await f.request({action:'report-create',id:'p1',reason:'spam',details:' explain ',recipientUid:'forged',reporterUid:'forged'});assert.equal(sent.code,201);
 await f.request({action:'report-create',id:'p1',reason:'spam',details:'duplicate'});
 assert.equal([...f.records.keys()].filter(key=>key.startsWith('users/admin/reports/')).length,1);
 assert.equal((await f.request({action:'reports-list',uid:'admin'})).code,403);
 assert.equal((await f.request({action:'profile-update',displayName:'Reporter',bio:'',canReceiveReports:true})).value.canReceiveReports,false);
 f.setUser('admin');const inbox=await f.request({action:'reports-list'});assert.equal(inbox.code,200);assert.equal(inbox.value.reports[0].details,'explain');assert.equal(inbox.value.reports[0].reporter.displayName,'Reporter');assert.equal(inbox.value.reports[0].reporter.email,undefined);
 // A changed public handle does not move the inbox to a different account.
 f.records.set('users/admin',{email:'admin@example.invalid',displayName:'PunJa',handle:'newadmin1'});
 assert.equal((await f.request({action:'profile-read'})).value.canReceiveReports,true);
 f.setUser('email-user');f.records.set('users/email-user',{email:'member@example.invalid',displayName:'PunJa',handle:'admin1'});
 assert.equal((await f.request({action:'profile-read'})).value.canReceiveReports,false);
});

test('reports validate reason/details and reject own or archived posts',async()=>{
 const f=await fixture({existing:{'settings/moderation':{reportRecipientUid:'admin'},'users/email-user':{email:'member@example.invalid'},'posts/own':{uid:'email-user',text:'own'},'posts/other':{uid:'other',text:'post'}}});
 assert.equal((await f.request({action:'report-create',id:'other',reason:'invalid'})).code,400);
 assert.equal((await f.request({action:'report-create',id:'other',reason:'spam',details:'x'.repeat(2001)})).code,400);
 assert.equal((await f.request({action:'report-create',id:'own',reason:'spam'})).code,400);
 assert.equal((await f.request({action:'report-create',id:'missing',reason:'inappropriate'})).code,404);
});

const roleRecords = () => ({
 'settings/moderation':{reportRecipientUid:'dev',developerUid:'dev'},
 'users/dev':{email:'dev@example.invalid',displayName:'PunJa',handle:'admin1',profileCompleted:true},
 'users/admin':{email:'admin@example.invalid',displayName:'Admin',handle:'admin2',profileCompleted:true},
 'users/email-user':{email:'user@example.invalid',displayName:'Member',handle:'member1',profileCompleted:true},
 'handles/member1':{uid:'email-user'},'handles/admin1':{uid:'dev'},
 'roles/admin':{role:'admin'},'posts/p1':{uid:'email-user',text:'original',media:[]}
});
test('Dev grants/revokes Admin, uses immutable identity, and members cannot forge authority',async()=>{
 const f=await fixture({existing:roleRecords(),authUid:'dev'});
 assert.equal((await f.request({action:'profile-read'})).value.role,'dev');
 f.records.get('users/dev').handle='newname1';assert.equal((await f.request({action:'profile-read'})).value.role,'dev');
 assert.equal((await f.request({action:'role-grant',targetUid:'email-user',role:'dev'})).code,400);
 assert.equal((await f.request({action:'role-grant',targetUid:'email-user'})).code,200);
 f.setUser('email-user');const access=(await f.request({action:'profile-read'})).value;
 assert.equal(access.role,'admin');assert.equal(access.canManageRoles,false);
 assert.equal((await f.request({action:'role-grant',targetUid:'admin'})).code,403);
 assert.equal((await f.request({action:'role-revoke',targetUid:'admin'})).code,403);
 f.setUser('dev');assert.equal((await f.request({action:'role-revoke',targetUid:'email-user'})).code,200);
 f.setUser('email-user');await f.request({action:'profile-update',displayName:'Member',role:'dev',canModerate:true});
 assert.equal((await f.request({action:'profile-read'})).value.canModerate,false);
 for(const action of ['role-grant','restricted-list','reports-list','moderation-confirm'])assert.equal((await f.request({action,targetUid:'admin',operation:'user-ban'})).code,403);
});
test('Dev and Admin share the private report inbox; revoked Admin loses access immediately',async()=>{
 const f=await fixture({existing:roleRecords()});
 f.records.set('posts/p2',{uid:'dev',text:'reported'});
 assert.equal((await f.request({action:'report-create',id:'p2',reason:'spam'})).code,201);
 for(const uid of ['dev','admin']){f.setUser(uid);assert.equal((await f.request({action:'reports-list'})).value.reports.length,1);}
 f.setUser('dev');await f.request({action:'role-revoke',targetUid:'admin'});
 f.setUser('admin');assert.equal((await f.request({action:'reports-list'})).code,403);
 assert.equal((await f.request({action:'restricted-list'})).code,403);
});
test('ban confirmation enforces 3 seconds, binds actor/target/action and cannot be reused',async()=>{
 const now=Date.now(),f=await fixture({existing:roleRecords(),authUid:'dev',now});
 const challenge=await f.request({action:'moderation-confirm',operation:'user-ban',targetUid:'email-user'}),confirmation=challenge.value.confirmation;
 assert.equal((await f.request({action:'user-ban',targetUid:'email-user'})).code,400);
 assert.equal((await f.request({action:'user-ban',targetUid:'email-user',confirmation})).code,409);
 f.setTime(now+3000);f.setUser('admin');assert.equal((await f.request({action:'user-ban',targetUid:'email-user',confirmation})).code,400);
 f.setUser('dev');assert.equal((await f.request({action:'user-ban',targetUid:'admin',confirmation})).code,400);
 assert.equal((await f.request({action:'restricted-remove',targetUid:'email-user',confirmation})).code,400);
 assert.equal((await f.request({action:'user-ban',targetUid:'email-user',confirmation})).code,200);
 assert.equal((await f.request({action:'user-ban',targetUid:'email-user',confirmation})).code,400);
 assert.equal((await f.request({action:'restricted-list'})).value.users[0].banned,true);
});
test('banned accounts cannot log in with username or use profiles/feed/posts/media authority, including Guest',async()=>{
 const existing={...roleRecords(),'restrictions/email-user':{banned:true,listed:true},'usernames/member1':{uid:'email-user'}};
 for(const guest of [false,true]){
  const f=await fixture({existing,guest});
  for(const action of ['profile','profile-read','posts-list','post-create','comment-create','post-like','profile-update','report-create']){
   const response=await f.request({action,id:'p1',text:'blocked'});assert.equal(response.code,403);assert.equal(response.value.code,'ACCOUNT_BANNED');
  }
  assert.equal((await f.request({action:'username-login',username:'member1',password:'valid-password'})).value.code,'ACCOUNT_BANNED');
 }
});
test('Admin can unban, and removing a restricted entry keeps the ban enforced',async()=>{
 const now=Date.now(),f=await fixture({existing:{...roleRecords(),'restrictions/email-user':{banned:true,listed:true}},authUid:'admin',now});
 const confirmation=(await f.request({action:'moderation-confirm',operation:'restricted-remove',targetUid:'email-user'})).value.confirmation;
 assert.equal((await f.request({action:'restricted-remove',targetUid:'email-user',confirmation})).code,409);
 f.setTime(now+3000);assert.equal((await f.request({action:'restricted-remove',targetUid:'email-user',confirmation})).code,200);
 assert.equal((await f.request({action:'restricted-list'})).value.users.length,0);
 f.setUser('email-user');assert.equal((await f.request({action:'profile-read'})).value.code,'ACCOUNT_BANNED');
 f.setUser('admin');await f.request({action:'user-unban',targetUid:'email-user'});
 f.setUser('email-user');assert.equal((await f.request({action:'profile-read'})).code,200);
});
test('Dev is protected from banning/revoking; public profiles reveal moderation targets only to staff',async()=>{
 const f=await fixture({existing:roleRecords(),authUid:'admin'});
 for(const action of ['user-ban','user-unban','role-revoke','role-grant'])assert.equal((await f.request({action,targetUid:'dev'})).code,403);
 assert.equal((await f.request({action:'user-ban',targetUid:'admin'})).code,400);
 const own=(await f.request({action:'author-profile',handle:'admin1'})).value.profile;
 assert.equal(own.role,'dev');assert.equal(own.management.canBan,false);assert.equal(own.management.canManageRoles,false);
 f.setUser('email-user');assert.equal((await f.request({action:'author-profile',handle:'admin1'})).value.profile.management,undefined);
});
test('Dev/Admin delete others public posts after confirmation and remove attached media/interactions/bookmarks',async()=>{
 for(const uid of ['dev','admin']){
  const now=Date.now(),id='11111111-1111-4111-8111-111111111111';
  const existing={...roleRecords(),'posts/p1':{uid:'email-user',text:'remove',media:[{id,type:'image/png',size:10}]},['media/'+id]:{uid:'email-user',postId:'p1'},'posts/p1/comments/c1':{text:'comment'},'posts/p1/likes/dev':{},['users/'+uid+'/saved/p1']:{saveVersion:'initial'}};
  const f=await fixture({existing,authUid:uid,now});
  assert.equal((await f.request({action:'post-delete',id:'p1'})).code,400);
  const confirmation=(await f.request({action:'moderation-confirm',operation:'post-delete',id:'p1'})).value.confirmation;
  assert.equal((await f.request({action:'post-delete',id:'p1',confirmation})).code,409);
  f.setTime(now+3000);assert.equal((await f.request({action:'post-delete',id:'p1',confirmation})).code,200);
  for(const key of ['posts/p1','posts/p1/comments/c1','posts/p1/likes/dev','media/'+id])assert.equal(f.records.has(key),false);
  assert.deepEqual(f.removedFiles,[id]);assert.equal((await f.request({action:'saved-list'})).value.posts.length,0);
  assert.equal((await f.request({action:'post-restore',id:'p1'})).code,404);
 }
});
test('expired confirmations and confirmations held by demoted staff cannot authorize deletion',async()=>{
 const now=Date.now(),f=await fixture({existing:roleRecords(),authUid:'admin',now});
 const confirmation=(await f.request({action:'moderation-confirm',operation:'post-delete',id:'p1'})).value.confirmation;
 f.setTime(now+300001);assert.equal((await f.request({action:'post-delete',id:'p1',confirmation})).code,400);
 f.records.delete('roles/admin');assert.equal((await f.request({action:'post-delete',id:'p1',confirmation})).code,403);
 assert.equal(f.records.has('posts/p1'),true);
});

test('legacy report recipient keeps only inbox access until explicitly assigned Dev',async()=>{const existing=roleRecords();delete existing['settings/moderation'].developerUid;const f=await fixture({existing,authUid:'dev'});const access=(await f.request({action:'profile-read'})).value;assert.equal(access.role,null);assert.equal(access.canReceiveReports,true);assert.equal(access.canModerate,false);assert.equal((await f.request({action:'role-grant',targetUid:'email-user'})).code,403);});
test('staff deletion never removes a different own archived post with the same id',async()=>{const now=Date.now(),f=await fixture({existing:{...roleRecords(),'users/admin/archive/p1':{uid:'admin',text:'private keep'}},authUid:'admin',now});const confirmation=(await f.request({action:'moderation-confirm',operation:'post-delete',id:'p1'})).value.confirmation;f.setTime(now+3000);assert.equal((await f.request({action:'post-delete',id:'p1',confirmation})).code,200);assert.equal(f.records.get('users/admin/archive/p1').text,'private keep');});

test('only active Dev/Admin can delete reports and deletion leaves posts/interactions/media/archive untouched',async()=>{
 for(const uid of ['dev','admin']){
  const f=await fixture({existing:{...roleRecords(),'posts/p1/comments/c1':{text:'keep'},'posts/p1/likes/viewer':{},'media/photo':{uid:'email-user',postId:'p1'},'users/email-user/archive/private':{text:'private'}},authUid:uid});
  const report={post:{id:'p1'},reason:'spam'};f.records.set('users/dev/reports/r1',report);f.records.set('users/admin/reports/r1',{text:'not in shared inbox'});
  const keys=['posts/p1','posts/p1/comments/c1','posts/p1/likes/viewer','media/photo','users/email-user/archive/private','users/admin/reports/r1'],before=keys.map(key=>f.records.get(key));
  assert.equal((await f.request({action:'report-delete',id:'r1',recipientUid:'admin',postId:'p1'})).code,200);
  assert.equal(f.records.has('users/dev/reports/r1'),false);assert.deepEqual(keys.map(key=>f.records.get(key)),before);assert.deepEqual(f.removedFiles,[]);
  assert.equal((await f.request({action:'report-delete',id:'r1'})).code,200);
 }
 const f=await fixture({existing:{...roleRecords(),'users/dev/reports/r1':{reason:'spam'}}});
 assert.equal((await f.request({action:'report-delete',id:'r1',role:'dev'})).code,403);assert.equal(f.records.has('users/dev/reports/r1'),true);
 f.setUser('admin');f.records.delete('roles/admin');assert.equal((await f.request({action:'report-delete',id:'r1'})).code,403);
 f.setUser('dev');assert.equal((await f.request({action:'report-delete',id:'../../posts/p1'})).code,400);
});
test('deleting a report for a removed post does not require or alter the original post',async()=>{
 const f=await fixture({existing:roleRecords(),authUid:'admin'});f.records.delete('posts/p1');f.records.set('users/dev/reports/r1',{post:{id:'p1'}});
 assert.equal((await f.request({action:'report-delete',id:'r1'})).code,200);assert.equal(f.records.has('posts/p1'),false);assert.equal(f.records.has('users/dev/reports/r1'),false);
});

const commentRecords=now=>({...roleRecords(),
 'posts/p1':{uid:'email-user',text:'post',commentCount:2},
 'posts/p1/comments/own':{uid:'email-user',text:'old',likeCount:0,createdAt:{toDate:()=>new Date(now)}},
 'posts/p1/comments/other':{uid:'admin',text:'other',likeCount:0,createdAt:{toDate:()=>new Date(now-1000)}}
});
test('comment edit is owner-only, stops at 5 minutes, preserves creation/count and cannot extend its deadline',async()=>{
 const now=Date.now(),f=await fixture({existing:commentRecords(now),now});
 const created=f.records.get('posts/p1/comments/own').createdAt;
 assert.equal((await f.request({action:'comment-update',id:'p1',commentId:'own',text:'old'})).value.edited,false);
 f.setTime(now+299999);assert.equal((await f.request({action:'comment-update',id:'p1',commentId:'own',text:' <img onerror=bad> ',uid:'admin',createdAt:now+50000})).code,200);
 const comment=f.records.get('posts/p1/comments/own');assert.equal(comment.text,'<img onerror=bad>');assert.equal(comment.edited,true);assert.equal(comment.createdAt,created);assert.equal(f.records.get('posts/p1').commentCount,2);
 const detail=(await f.request({action:'post-detail',id:'p1'})).value.comments.find(c=>c.id==='own');assert.equal(detail.own,true);assert.equal(detail.edited,true);assert.equal(detail.editRemainingMs,1);
 f.setTime(now+300000);assert.equal((await f.request({action:'comment-update',id:'p1',commentId:'own',text:'too late'})).code,403);
 assert.equal((await f.request({action:'post-detail',id:'p1'})).value.comments.find(c=>c.id==='own').canEdit,false);
 f.setUser('dev');assert.equal((await f.request({action:'comment-update',id:'p1',commentId:'other',text:'staff cannot edit'})).code,403);
 assert.equal((await f.request({action:'comment-delete',id:'p1',commentId:'other'})).code,403);
});
test('comment edit deadline follows Firestore time and rejects invalid text, target and missing timestamps',async()=>{
 const serverNow=Date.now(),f=await fixture({existing:commentRecords(serverNow-1000),now:serverNow-3600000,serverNow});
 assert.equal((await f.request({action:'comment-update',id:'p1',commentId:'own',text:'edited'})).code,200);
 assert.equal((await f.request({action:'post-detail',id:'p1'})).value.comments.find(c=>c.id==='own').editRemainingMs,299000);
 for(const text of ['',' ','x'.repeat(2001)])assert.equal((await f.request({action:'comment-update',id:'p1',commentId:'own',text})).code,400);
 assert.equal((await f.request({action:'comment-update',id:'p1',commentId:'../other',text:'valid'})).code,400);
 delete f.records.get('posts/p1/comments/own').createdAt;assert.equal((await f.request({action:'comment-update',id:'p1',commentId:'own',text:'blocked'})).code,403);
});
test('comment hearts are idempotent, belong to authenticated users and rank older highly-liked comments first',async()=>{
 const now=Date.now(),f=await fixture({existing:commentRecords(now),now});
 for(let i=0;i<2;i++){const r=await f.request({action:'comment-like',id:'p1',commentId:'other',liked:true,uid:'forged'});assert.equal(r.code,200);assert.equal(r.value.likeCount,1);}
 assert.equal(f.records.has('posts/p1/comments/other/likes/email-user'),true);assert.equal(f.records.has('posts/p1/comments/other/likes/forged'),false);
 let detail=(await f.request({action:'post-detail',id:'p1'})).value;assert.equal(detail.comments[0].id,'other');assert.equal(detail.comments[0].liked,true);
 f.setUser('dev');assert.equal((await f.request({action:'comment-like',id:'p1',commentId:'other',liked:true})).value.likeCount,2);
 await Promise.all([f.request({action:'comment-like',id:'p1',commentId:'other',liked:false}),f.request({action:'comment-like',id:'p1',commentId:'other',liked:false})]);assert.equal(f.records.get('posts/p1/comments/other').likeCount,1);
 assert.equal((await f.request({action:'comment-like',id:'p1',commentId:'other',liked:'yes'})).code,400);
 assert.equal((await f.request({action:'comment-like',id:'p1',commentId:'missing',liked:true})).code,404);
});
test('ranking includes old and legacy comments beyond the first 100, paginates without duplicates and focuses reports',async()=>{
 const now=Date.now(),existing=commentRecords(now);for(let i=0;i<105;i++)existing['posts/p1/comments/c'+i]={uid:'admin',text:'text',likeCount:0,createdAt:{toDate:()=>new Date(now+i)}};
 existing['posts/p1/comments/top']={uid:'admin',text:'old winner',likeCount:99,createdAt:{toDate:()=>new Date(0)}};
 delete existing['posts/p1/comments/other'].likeCount;
 const f=await fixture({existing,now:now+500});const first=(await f.request({action:'post-detail',id:'p1'})).value,next=(await f.request({action:'post-detail',id:'p1',commentsAfter:first.commentsAfter})).value;
 assert.equal(first.comments[0].id,'top');assert.equal(new Set([...first.comments,...next.comments].map(c=>c.id)).size,108);assert.equal(next.commentsAfter,null);
 const focused=(await f.request({action:'post-detail',id:'p1',focusCommentId:'other'})).value;assert.equal(focused.comments.some(c=>c.id==='other'),true);assert.equal(focused.focusedCommentFound,true);
 assert.equal((await f.request({action:'post-detail',id:'p1',focusCommentId:'deleted'})).value.focusedCommentFound,false);
});
test('post owner and other members may report comments; own comments cannot be reported and evidence survives deletion',async()=>{
 const now=Date.now(),f=await fixture({existing:commentRecords(now),now});
 assert.equal((await f.request({action:'report-create',id:'p1',commentId:'own',reason:'spam'})).code,400);
 for(let i=0;i<2;i++)assert.equal((await f.request({action:'report-create',id:'p1',commentId:'other',reason:'spam',details:'Comment report'})).code,201);
 const reports=[...f.records.entries()].filter(([key])=>key.startsWith('users/dev/reports/'));assert.equal(reports.length,1);assert.equal(reports[0][1].kind,'comment');assert.equal(reports[0][1].comment.text,'other');
 f.setUser('admin');await f.request({action:'comment-delete',id:'p1',commentId:'other'});
 f.setUser('dev');const evidence=(await f.request({action:'reports-list'})).value.reports[0];assert.equal(evidence.comment.id,'other');assert.equal(evidence.comment.text,'other');assert.equal(evidence.kind,'comment');
 f.setUser('email-user');assert.equal((await f.request({action:'report-create',id:'p1',commentId:'other',reason:'spam'})).code,404);
});
test('replies are bound to the same post, nested replies stay under the root and have independent edit windows',async()=>{
 const now=Date.now(),f=await fixture({existing:commentRecords(now),authUid:'admin',now});
 assert.equal((await f.request({action:'comment-create',id:'p1',text:'reply',replyTo:'own',parentId:'forged',replyToUid:'dev'})).code,201);
 const entries=[...f.records.entries()].filter(([key,data])=>key.startsWith('posts/p1/comments/') && data.text==='reply'),[key,reply]=entries[0];
 assert.equal(reply.parentId,'own');assert.equal(reply.replyToId,'own');assert.equal(reply.replyToUid,'email-user');assert.equal(reply.uid,'admin');
 f.setTime(now+2000);f.setUser('dev');await f.request({action:'comment-create',id:'p1',text:'nested',replyTo:key.split('/').at(-1)});
 const nested=[...f.records.values()].find(item=>item.text==='nested');assert.equal(nested.parentId,'own');assert.equal(nested.replyToUid,'admin');
 const detail=(await f.request({action:'post-detail',id:'p1'})).value.comments;
 const rootIndex=detail.findIndex(c=>c.id==='own');assert.equal(detail[rootIndex+1].parentId,'own');assert.equal(detail[rootIndex+2].parentId,'own');
 const ownNested=detail.find(c=>c.text==='nested');assert.equal(ownNested.own,true);assert.equal(ownNested.editRemainingMs,300000);
 assert.equal((await f.request({action:'comment-create',id:'p1',text:'reply',replyTo:'absent'})).code,404);
 assert.equal((await f.request({action:'comment-create',id:'p1',text:'reply',replyTo:'../own'})).code,400);
});
test('deleting a comment removes its hearts once, preserves replies and exposes no deleted text or author identity',async()=>{
 const now=Date.now(),f=await fixture({existing:{...commentRecords(now),'posts/p1/comments/own/likes/admin':{uid:'admin'},'posts/p1/comments/reply':{uid:'admin',text:'keep reply',parentId:'own',replyToId:'own',replyToUid:'email-user',createdAt:{toDate:()=>new Date(now+1)}}},now:now+1000});
 f.records.get('posts/p1').commentCount=3;
 for(let i=0;i<2;i++)assert.equal((await f.request({action:'comment-delete',id:'p1',commentId:'own'})).code,200);
 assert.equal(f.records.get('posts/p1').commentCount,2);assert.equal(f.records.has('posts/p1/comments/own/likes/admin'),false);assert.equal(f.records.get('posts/p1/comments/reply').text,'keep reply');
 const detail=(await f.request({action:'post-detail',id:'p1'})).value.comments,root=detail.find(c=>c.id==='own');assert.equal(root.deleted,true);assert.equal(root.text,'');assert.equal(root.handle,null);assert.equal(root.own,false);assert.equal(root.canEdit,false);
 assert.equal(detail.find(c=>c.id==='reply').replyToDeleted,true);
 for(const action of ['comment-like','comment-update'])assert.equal((await f.request({action,id:'p1',commentId:'own',liked:true,text:'bring back'})).code,404);
 assert.equal((await f.request({action:'comment-create',id:'p1',text:'reply',replyTo:'own'})).code,404);
});
test('archived posts cannot receive comment edits/hearts/deletion/replies/reports through direct requests',async()=>{
 const now=Date.now(),f=await fixture({existing:commentRecords(now),now});await f.request({action:'post-archive',id:'p1'});
 for(const body of [{action:'comment-update',commentId:'own',text:'edit'},{action:'comment-like',commentId:'own',liked:true},{action:'comment-delete',commentId:'own'},{action:'comment-create',replyTo:'own',text:'reply'},{action:'report-create',commentId:'other',reason:'spam'}])assert.equal((await f.request({id:'p1',...body})).code,404);
 const detail=(await f.request({action:'post-detail',id:'p1'})).value;assert.equal(detail.post.archived,true);assert.equal(detail.comments.every(c=>!c.canEdit),true);assert.equal(f.records.get('posts/p1/comments/own').text,'old');
});

test('ban reason is bounded, trimmed and visible only in the staff restricted list',async()=>{
 const now=Date.now(),f=await fixture({existing:roleRecords(),authUid:'dev',now});
 const confirmation=(await f.request({action:'moderation-confirm',operation:'user-ban',targetUid:'email-user'})).value.confirmation;f.setTime(now+3000);
 for(const reason of [{text:'object'},'x'.repeat(2001)])assert.equal((await f.request({action:'user-ban',targetUid:'email-user',confirmation,reason})).code,400);
 assert.equal(f.records.has('restrictions/email-user'),false);
 const reason='ผิดกติกา\n<script>plain text</script>';assert.equal((await f.request({action:'user-ban',targetUid:'email-user',confirmation,reason:'  '+reason+'  '})).code,200);
 assert.equal(f.records.get('restrictions/email-user').reason,reason);assert.equal((await f.request({action:'restricted-list'})).value.users[0].reason,reason);
 f.setUser('admin');assert.equal((await f.request({action:'restricted-list'})).value.users[0].reason,reason);
 f.setUser('email-user');assert.equal((await f.request({action:'restricted-list'})).code,403);
});


test('banned public identities are masked across profiles, feeds, bookmarks, search, likes and replies, and restored by unban',async()=>{
 const now=Date.now(),stamp={toDate:()=>new Date(now)},original={email:'member@example.invalid',displayName:'Original name',handle:'member1',bio:'Original bio',photoMediaId:'original-photo',profileCompleted:true};
 const f=await fixture({authUid:'dev',now,existing:{...roleRecords(),'users/email-user':original,'handles/member1':{uid:'email-user'},'restrictions/email-user':{banned:true,listed:false},'roles/email-user':{role:'admin'},
 'posts/p1':{uid:'email-user',displayName:'Old name snapshot',text:'public post',createdAt:stamp,saveVersion:'v1'},'users/dev/saved/p1':{saveVersion:'v1'},
 'posts/p1/likes/email-user':{uid:'email-user'},'posts/p1/comments/root':{uid:'email-user',text:'comment',createdAt:stamp},'posts/p1/comments/reply':{uid:'admin',text:'reply',parentId:'root',replyToId:'root',replyToUid:'email-user',createdAt:stamp}}});
 for(const lookup of [{id:'p1'},{handle:'member1'}]){
  const res=await f.request({action:'author-profile',...lookup});assert.equal(res.code,200);const p=res.value.profile;
  assert.equal(p.displayName,'ผู้ใช้งานถูกระงับบัญชี');assert.equal(p.bio,'ติดต่อปลดแบนได้ที่ "รายงานปัญหาการใช้งาน"');assert.equal(p.photoMediaId,null);assert.equal(p.suspended,true);assert.equal(p.management.banned,true);
 }
 for(const action of ['posts-list','saved-list','author-profile']){
  const res=await f.request({action,id:'p1'});assert.equal(res.code,200);const post=res.value.posts[0];assert.equal(post.displayName,'ผู้ใช้งานถูกระงับบัญชี');assert.equal(post.authorPhotoId,null);assert.equal(post.suspended,true);assert.equal(post.text,'public post');
 }
 const search=await f.request({action:'search-users',query:'member'});assert.equal(search.value.users[0].displayName,'ผู้ใช้งานถูกระงับบัญชี');assert.equal(search.value.users[0].photoId,null);
 const detail=(await f.request({action:'post-detail',id:'p1'})).value;
 for(const person of [detail.post,detail.likes[0],detail.comments.find(c=>c.id==='root'),detail.comments.find(c=>c.id==='reply').replyTo]){assert.equal(person.displayName,'ผู้ใช้งานถูกระงับบัญชี');assert.equal(person.photoId,null);assert.equal(person.suspended,true);}
 assert.equal(f.records.get('users/email-user'),original);f.setUser('email-user');assert.equal((await f.request({action:'profile-read'})).value.code,'ACCOUNT_BANNED');
 f.setUser('dev');assert.equal((await f.request({action:'user-unban',targetUid:'email-user'})).code,200);
 const restored=(await f.request({action:'author-profile',handle:'member1'})).value.profile;assert.equal(restored.displayName,original.displayName);assert.equal(restored.bio,original.bio);assert.equal(restored.photoMediaId,original.photoMediaId);assert.equal(restored.suspended,false);assert.equal(restored.management.banned,false);
 assert.equal((await f.request({action:'posts-list'})).value.posts[0].displayName,original.displayName);
});


test('usage reports need no post and go to the configured shared inbox with authenticated reporter identity',async()=>{
 const f=await fixture({existing:roleRecords()}),original=f.records.get('posts/p1');
 const sent=await f.request({action:'usage-report-create',details:'  หน้าเว็บเปิดไม่ได้ <script>text</script>  ',recipientUid:'forged',reporterUid:'forged',reporter:{displayName:'Forged'},id:'missing-post'});assert.equal(sent.code,201);
 const reports=[...f.records.entries()].filter(([key])=>key.startsWith('users/dev/reports/'));assert.equal(reports.length,1);assert.equal(reports[0][1].kind,'usage');assert.equal(reports[0][1].details,'หน้าเว็บเปิดไม่ได้ <script>text</script>');assert.equal(reports[0][1].reporterUid,'email-user');assert.equal(reports[0][1].reporter.displayName,'Member');assert.equal(reports[0][1].post,undefined);
 assert.equal((await f.request({action:'reports-list'})).code,403);
 f.setUser('admin');assert.equal((await f.request({action:'reports-list'})).value.reports.length,0);assert.equal((await f.request({action:'report-delete',id:reports[0][0].split('/').at(-1)})).code,403);
 f.setUser('dev');const inbox=await f.request({action:'reports-list'});assert.equal(inbox.code,200);assert.equal(inbox.value.reports[0].kind,'usage');assert.equal(inbox.value.reports[0].reporter.email,undefined);
 assert.equal((await f.request({action:'report-delete',id:reports[0][0].split('/').at(-1)})).code,200);assert.equal(f.records.has(reports[0][0]),false);assert.equal(f.records.get('posts/p1'),original);
});
test('usage reporting validates text, routes bans to appeals, blocks unregistered users, and limits spam',async()=>{
 const f=await fixture({existing:roleRecords()});
 for(const details of [undefined,123,' ','x'.repeat(2001)])assert.equal((await f.request({action:'usage-report-create',details})).code,400);
 for(let i=0;i<15;i++)assert.equal((await f.request({action:'usage-report-create',details:'problem '+i})).code,201);
 assert.equal((await f.request({action:'usage-report-create',details:'too many'})).code,429);
 const banned=await fixture({existing:{...roleRecords(),'restrictions/email-user':{banned:true}}});assert.equal((await banned.request({action:'usage-report-create',details:'problem'})).value.kind,'appeal');assert.equal((await banned.request({action:'posts-list'})).value.code,'ACCOUNT_BANNED');
 const unregistered=await fixture();assert.equal((await unregistered.request({action:'usage-report-create',details:'problem'})).code,403);
 const noRecipient=roleRecords();delete noRecipient['settings/moderation'];const missing=await fixture({existing:noRecipient});assert.equal((await missing.request({action:'usage-report-create',details:'problem'})).code,503);
});
test('Guest can report usage problems and a developer-only recipient configuration is supported',async()=>{
 const existing=roleRecords();existing['settings/moderation']={developerUid:'dev'};existing['users/email-user']={isGuest:true,displayName:'guest_123'};
 const f=await fixture({existing,guest:true});assert.equal((await f.request({action:'usage-report-create',details:'Guest problem'})).code,201);const report=[...f.records.entries()].find(([key])=>key.startsWith('users/dev/reports/'))[1];assert.equal(report.reporter.displayName,'guest_123');assert.equal(report.reporter.handle,null);
});


test('report categories isolate post/comment/appeal messages, include legacy reports, and enforce Dev-only usage access',async()=>{
 const now=Date.now(),report=(kind,offset=0)=>({...(kind?{kind}:{}),reporter:{displayName:'Member'},details:'message '+kind,createdAt:{toDate:()=>new Date(now-offset)}});
 const f=await fixture({existing:{...roleRecords(),'users/dev/reports/post':report('post'),'users/dev/reports/legacy':report(null,1000),'users/dev/reports/comment':report('comment'),'users/dev/reports/appeal':report('appeal'),'users/dev/reports/private':report('usage')},authUid:'dev'});
 for(const [category,count] of [['post',2],['comment',1],['appeal',1],['usage',1]]){const response=await f.request({action:'reports-list',category});assert.equal(response.code,200);assert.equal(response.value.reports.length,count);assert.equal(response.value.reports.every(r=>r.kind===category),true);}
 assert.equal((await f.request({action:'reports-list',category:'invalid'})).code,400);
 f.setUser('admin');assert.equal((await f.request({action:'reports-list',category:'usage'})).code,403);const all=(await f.request({action:'reports-list'})).value.reports;assert.equal(all.length,4);assert.equal(all.some(r=>r.kind==='usage'),false);
 assert.equal((await f.request({action:'report-delete',id:'private'})).code,403);assert.equal(f.records.has('users/dev/reports/private'),true);assert.equal((await f.request({action:'report-delete',id:'appeal'})).code,200);
 f.setUser('dev');assert.equal((await f.request({action:'report-delete',id:'private'})).code,200);
});
test('category pagination does not lose older posts when over 100 newer private usage reports exist',async()=>{
 const now=Date.now(),existing={...roleRecords(),'users/dev/reports/older':{reporter:{displayName:'Member'},details:'legacy post',createdAt:{toDate:()=>new Date(now-1000)}}};
 for(let i=0;i<110;i++)existing['users/dev/reports/usage'+i]={kind:'usage',reporter:{displayName:'Member'},details:'private '+i,createdAt:{toDate:()=>new Date(now)}};
 const f=await fixture({existing,authUid:'admin'});const result=await f.request({action:'reports-list',category:'post'});assert.equal(result.code,200);assert.equal(result.value.reports.length,1);assert.equal(result.value.reports[0].id,'older');
});
test('ban appeals are classified from server restriction state, retain authenticated identity and never unlock other actions',async()=>{
 const f=await fixture({existing:{...roleRecords(),'restrictions/email-user':{banned:true,listed:false},'usernames/member1':{uid:'email-user'}}});
 const sent=await f.request({action:'usage-report-create',details:'please review',kind:'usage',category:'post',reporterUid:'admin'});assert.equal(sent.code,201);assert.equal(sent.value.kind,'appeal');
 const report=[...f.records.entries()].find(([key])=>key.startsWith('users/dev/reports/'))[1];assert.equal(report.kind,'appeal');assert.equal(report.reporterUid,'email-user');assert.equal(f.records.get('restrictions/email-user').banned,true);
 for(const action of ['profile-read','posts-list','post-create','comment-create','report-create','reports-list','user-unban'])assert.equal((await f.request({action,id:'p1',text:'invalid bypass',targetUid:'email-user'})).value.code,'ACCOUNT_BANNED');
 assert.equal((await f.request({action:'username-login',username:'member1',password:'valid-password',forAppeal:true})).code,200);
 const badPassword=await fixture({existing:{...roleRecords(),'restrictions/email-user':{banned:true},'usernames/member1':{uid:'email-user'}},passwordResult:{ok:false}});assert.equal((await badPassword.request({action:'username-login',username:'member1',password:'bad',forAppeal:true})).code,401);
 f.setUser('admin');assert.equal((await f.request({action:'reports-list',category:'appeal'})).value.reports.length,1);
 f.setUser('email-user');f.records.set('restrictions/email-user',{banned:false});assert.equal((await f.request({action:'usage-report-create',details:'ordinary problem',kind:'appeal'})).value.kind,'usage');
});

test('Guest category restriction uses verified auth and leaves blocked requests without posts, media changes or cooldown',async()=>{
 const id='11111111-1111-4111-8111-111111111111';
 const f=await fixture({guest:true,existing:{'users/email-user':{isGuest:false,displayName:'Guest'},['media/'+id]:{uid:'email-user',type:'image/png',size:10}}});
 for(const category of ['ทั่วไป','ขายของ','ของหาย']){
  const result=await f.request({action:'post-create',text:'blocked',category,mediaIds:[id],isGuest:false});
  assert.equal(result.code,403);assert.equal(result.value.message,'หากต้องการ Post หมวดหมู่ที่ถูกล็อกไว้ กรุณา Login');
 }
 assert.equal(f.records.has('posts/new-post'),false);assert.equal(f.records.get('media/'+id).postId,undefined);assert.equal(f.records.get('users/email-user').postAvailableAt,undefined);
 assert.equal((await f.request({action:'post-create',category:'ถาม-ตอบ',mediaIds:[id]})).code,201);
});
test('Guest cannot change post category or republish a locked category from archive',async()=>{
 const post={uid:'email-user',text:'original',category:'ถาม-ตอบ',media:[]};
 const f=await fixture({guest:true,existing:{'users/email-user':{isGuest:true,displayName:'Guest'},'posts/p1':post,'users/email-user/archive/old':{...post,category:'ขายของ'}}});
 for(const category of ['ทั่วไป','ขายของ','ของหาย'])assert.equal((await f.request({action:'post-update',id:'p1',text:'changed',category})).code,403);
 assert.equal(f.records.get('posts/p1').text,'original');
 assert.equal((await f.request({action:'post-restore',id:'old'})).code,403);assert.equal(f.records.has('users/email-user/archive/old'),true);assert.equal(f.records.has('posts/old'),false);
 assert.equal((await f.request({action:'post-update',id:'old',text:'converted',category:'ถาม-ตอบ'})).code,200);
 assert.equal((await f.request({action:'post-restore',id:'old'})).code,200);assert.equal(f.records.get('posts/old').category,'ถาม-ตอบ');
 assert.equal((await f.request({action:'post-archive',id:'p1'})).code,200);assert.equal((await f.request({action:'post-restore',id:'p1'})).code,200);
});

test('Merchant badge and cooldown exemption never grant moderation authority',async()=>{
 const f=await fixture({existing:roleRecords(),authUid:'dev'});
 assert.equal((await f.request({action:'role-grant',targetUid:'email-user',role:'merchant'})).code,200);
 f.setUser('email-user');const profile=(await f.request({action:'profile-read'})).value;
 assert.equal(profile.role,'merchant');assert.equal(profile.postCooldownExempt,true);
 for(const key of ['canModerate','canManageRoles','canReceiveReports'])assert.equal(profile[key],false);
 for(const action of ['role-grant','role-revoke','user-ban','user-unban','restricted-list','restricted-remove','moderation-confirm','reports-list','report-delete']){
  assert.equal((await f.request({action,targetUid:'admin',id:'p1',operation:'post-delete',role:'admin'})).code,403);
 }
 assert.equal((await f.request({action:'post-delete',id:'other'})).code,404);
 f.records.set('posts/other',{uid:'admin',text:'keep'});
 assert.equal((await f.request({action:'post-delete',id:'other'})).code,403);assert.equal(f.records.has('posts/other'),true);
 f.setUser('admin');assert.equal((await f.request({action:'role-grant',targetUid:'email-user',role:'merchant'})).code,200);
 f.setUser('dev');assert.equal((await f.request({action:'role-revoke',targetUid:'email-user'})).code,200);
 f.setUser('email-user');assert.equal((await f.request({action:'profile-read'})).value.postCooldownExempt,false);
});
test('all supported roles can post back-to-back with an existing cooldown, and revocation restores normal delay',async()=>{
 const now=Date.now();
 for(const role of ['dev','admin','merchant']){
  const existing=roleRecords();const uid=role==='dev'?'dev':'email-user';
  existing['users/'+uid].postAvailableAt=now+60000;
  if(role!=='dev')existing['roles/'+uid]={role};
  const f=await fixture({existing,authUid:uid,now});
  for(let i=0;i<2;i++){
   const result=await f.request({action:'post-create',text:'Post '+i,category:'ขายของ'});
   assert.equal(result.code,201);assert.equal(result.value.postAvailableAt,0);assert.equal(result.value.postCooldownExempt,true);
  }
  if(role==='merchant'){
   f.setUser('dev');assert.equal((await f.request({action:'role-revoke',targetUid:uid})).code,200);f.setUser(uid);
   const result=await f.request({action:'post-create',text:'after revoke',role:'merchant',postCooldownExempt:true});assert.equal(result.code,429);
   f.setTime(now+60000);assert.equal((await f.request({action:'post-create',text:'after waiting'})).code,201);
  }
 }
 const unknown=await fixture({existing:{...roleRecords(),'roles/email-user':{role:'invented'}}});
 assert.equal((await unknown.request({action:'post-create',text:'first',role:'admin',postCooldownExempt:true})).code,201);
 assert.equal((await unknown.request({action:'post-create',text:'second',role:'admin',postCooldownExempt:true})).code,429);
});
test('Merchant cannot be granted to Guest, and Guest cannot bypass cooldown with a forged or stale role',async()=>{
 const existing={...roleRecords(),'users/guest':{isGuest:true,displayName:'Guest'}};
 const staff=await fixture({existing,authUid:'dev'});assert.equal((await staff.request({action:'role-grant',targetUid:'guest',role:'merchant'})).code,400);
 const guest=await fixture({guest:true,authUid:'guest',existing:{...existing,'roles/guest':{role:'merchant'}}});
 assert.equal((await guest.request({action:'post-create',text:'first'})).code,201);assert.equal((await guest.request({action:'post-create',text:'second',role:'merchant'})).code,429);
});
test('Admin can give Merchant but cannot replace staff roles or give Admin, revoke roles or target Guest',async()=>{
 const f=await fixture({existing:{...roleRecords(),'users/other-admin':{email:'other@example.invalid'},'roles/other-admin':{role:'admin'},'users/guest':{isGuest:true}},authUid:'admin'});
 assert.equal((await f.request({action:'role-grant',targetUid:'email-user',role:'merchant'})).code,200);
 assert.equal(f.records.get('roles/email-user').role,'merchant');
 assert.equal((await f.request({action:'role-grant',targetUid:'other-admin',role:'merchant'})).code,403);
 assert.equal((await f.request({action:'role-grant',targetUid:'dev',role:'merchant'})).code,403);
 assert.equal((await f.request({action:'role-grant',targetUid:'guest',role:'merchant'})).code,400);
 assert.equal((await f.request({action:'role-grant',targetUid:'email-user',role:'admin'})).code,403);
 assert.equal((await f.request({action:'role-revoke',targetUid:'email-user'})).code,403);
 const target=(await f.request({action:'author-profile',handle:'member1'})).value.profile;
 assert.equal(target.role,'merchant');assert.equal(target.management.canManageRoles,false);assert.equal(target.management.canGrantMerchant,false);
});

test('user search supports T, To and Tot prefixes case-insensitively without requiring a full handle',async()=>{
 const f=await fixture({existing:{'users/email-user':{email:'member@example.invalid'},'handles/toded':{uid:'one'},'handles/toto':{uid:'two'},'users/one':{displayName:'Toded',handle:'toded',profileCompleted:true},'users/two':{displayName:'Toto',handle:'toto',profileCompleted:true}}});
 for(const [query,expected] of [['T',['toded','toto']],['To',['toded','toto']],['Tot',['toto']],['@tOT',['toto']]]){
  const result=await f.request({action:'search-users',query});assert.equal(result.code,200);assert.deepEqual(Array.from(result.value.users,u=>u.handle),expected);
 }
});

test('post badges use current assigned roles, ignore forged profile/post roles and disappear after role revocation or ban',async()=>{
 const now=Date.now(),stamp={toDate:()=>new Date(now)};
 const existing={...roleRecords(),'users/seller':{email:'seller@example.invalid',displayName:'Seller',handle:'seller1'},'roles/seller':{role:'merchant'},'users/guest':{isGuest:true,displayName:'Guest'},'roles/guest':{role:'admin'},'users/email-user':{...roleRecords()['users/email-user'],role:'dev'}};
 for(const uid of ['dev','admin','seller','email-user','guest'])existing['posts/p-'+uid]={uid,text:'post',role:'dev',authorRole:'dev',createdAt:stamp,saveVersion:'v1'};
 const f=await fixture({existing,authUid:'dev'});
 const roles={dev:'dev',admin:'admin',seller:'merchant','email-user':null,guest:null};
 let posts=(await f.request({action:'posts-list'})).value.posts;
 for(const [uid,role] of Object.entries(roles)){
  assert.equal(posts.find(p=>p.id==='p-'+uid).authorRole,role);
  assert.equal((await f.request({action:'post-detail',id:'p-'+uid})).value.post.role,role);
 }
 assert.equal((await f.request({action:'role-revoke',targetUid:'seller'})).code,200);
 assert.equal((await f.request({action:'posts-list'})).value.posts.find(p=>p.id==='p-seller').authorRole,null);
 assert.equal((await f.request({action:'role-grant',targetUid:'seller',role:'admin'})).code,200);
 assert.equal((await f.request({action:'post-detail',id:'p-seller'})).value.post.role,'admin');
 f.records.set('restrictions/seller',{banned:true});
 const banned=(await f.request({action:'posts-list'})).value.posts.find(p=>p.id==='p-seller');assert.equal(banned.authorRole,null);assert.equal(banned.suspended,true);assert.equal((await f.request({action:'post-detail',id:'p-seller'})).value.post.role,null);
});
test('own, archive, profile and saved feeds expose the same current post author role',async()=>{
 const stamp={toDate:()=>new Date()};const existing={...roleRecords(),'posts/staff':{uid:'admin',text:'staff',createdAt:stamp,saveVersion:'v1'},'users/dev/saved/staff':{saveVersion:'v1'},'users/admin/archive/private':{uid:'admin',text:'private',createdAt:stamp,authorRole:'dev'}};
 const f=await fixture({existing,authUid:'dev'});assert.equal((await f.request({action:'saved-list'})).value.posts[0].authorRole,'admin');
 assert.equal((await f.request({action:'author-profile',id:'staff'})).value.posts[0].authorRole,'admin');
 f.setUser('admin');assert.equal((await f.request({action:'my-posts'})).value.posts[0].authorRole,'admin');assert.equal((await f.request({action:'archive-list'})).value.posts[0].authorRole,'admin');assert.equal((await f.request({action:'post-detail',id:'private'})).value.post.role,'admin');
});

test('contact admin uses authenticated identity and routes to general shared inbox for Admin and Dev',async()=>{
 const f=await fixture({existing:roleRecords()});
 const sent=await f.request({action:'contact-admin-create',details:'  Please help <script>text</script>  ',kind:'usage',recipientUid:'forged',reporterUid:'forged'});assert.equal(sent.code,201);assert.equal(sent.value.kind,'general');
 const [key,report]=[...f.records.entries()].find(([key])=>key.startsWith('users/dev/reports/'));const id=key.split('/').at(-1);assert.equal(report.reporterUid,'email-user');assert.equal(report.kind,'general');assert.equal(report.details,'Please help <script>text</script>');
 assert.equal((await f.request({action:'reports-list',category:'general'})).code,403);
 for(const uid of ['admin','dev']){f.setUser(uid);const inbox=await f.request({action:'reports-list',category:'general'});assert.equal(inbox.code,200);assert.equal(inbox.value.reports.length,1);assert.equal(inbox.value.reports[0].id,id);assert.equal(inbox.value.reports[0].post,undefined);assert.equal(inbox.value.reports[0].reporter.email,undefined);}
 f.setUser('admin');assert.equal((await f.request({action:'report-delete',id})).code,200);assert.equal(f.records.has(key),false);
});
test('contact messages validate text, use shared report spam limits, and preserve account restrictions',async()=>{
 const f=await fixture({existing:roleRecords()});
 for(const details of [undefined,123,' ','x'.repeat(2001)])assert.equal((await f.request({action:'contact-admin-create',details})).code,400);
 for(let i=0;i<15;i++)assert.equal((await f.request({action:i%2?'usage-report-create':'contact-admin-create',details:'message '+i})).code,201);
 assert.equal((await f.request({action:'contact-admin-create',details:'too many'})).code,429);
 const unregistered=await fixture();assert.equal((await unregistered.request({action:'contact-admin-create',details:'hello'})).code,403);
 const banned=await fixture({existing:{...roleRecords(),'restrictions/email-user':{banned:true}}});assert.equal((await banned.request({action:'contact-admin-create',details:'hello'})).value.code,'ACCOUNT_BANNED');
 const guest=await fixture({existing:{...roleRecords(),'users/email-user':{isGuest:true,displayName:'guest_123'}},guest:true});assert.equal((await guest.request({action:'contact-admin-create',details:'hello'})).value.kind,'general');
});

test('only current Admin and Dev can publish announcements, including through edit and archive restore',async()=>{
 for(const uid of ['email-user','seller','admin','dev']){
  const f=await fixture({existing:{...roleRecords(),'users/seller':{email:'seller@example.invalid',displayName:'Seller'},'roles/seller':{role:'merchant'}},authUid:uid});const staff=['admin','dev'].includes(uid);
  assert.equal((await f.request({action:'post-create',text:'announcement',category:'ประกาศ',role:'dev'})).code,staff?201:403);
  if(staff){assert.equal((await f.request({action:'post-update',id:'new-post',text:'edited',category:'ประกาศ'})).code,200);await f.request({action:'post-archive',id:'new-post'});assert.equal((await f.request({action:'post-restore',id:'new-post'})).code,200);}
 }
 const revoked=await fixture({existing:{...roleRecords(),'posts/a1':{uid:'admin',text:'old',category:'ประกาศ'},'users/admin/archive/a2':{uid:'admin',text:'archived',category:'ประกาศ'}},authUid:'admin'});revoked.records.delete('roles/admin');
 assert.equal((await revoked.request({action:'post-update',id:'a1',text:'changed',category:'ทั่วไป'})).code,403);assert.equal((await revoked.request({action:'post-restore',id:'a2'})).code,403);assert.equal(revoked.records.get('posts/a1').text,'old');
 const ordinary=await fixture({existing:{...roleRecords(),'posts/p1':{uid:'email-user',text:'original',category:'ทั่วไป'}}});assert.equal((await ordinary.request({action:'post-update',id:'p1',text:'upgrade',category:'ประกาศ'})).code,403);assert.equal(ordinary.records.get('posts/p1').category,'ทั่วไป');
});
test('announcements reach every reader in both feed and ticker and follow edits, archive, restore and deletion',async()=>{
 const f=await fixture({existing:roleRecords(),authUid:'admin'});assert.equal((await f.request({action:'post-create',text:'First',category:'ประกาศ'})).code,201);
 f.setUser('email-user');let data=(await f.request({action:'posts-list'})).value;assert.equal(data.posts[0].category,'ประกาศ');assert.equal(data.announcements[0].text,'First');assert.equal((await f.request({action:'posts-list',category:'ทั่วไป'})).value.announcements[0].text,'First');
 f.setUser('admin');await f.request({action:'post-update',id:'new-post',text:'Edited',category:'ประกาศ'});assert.equal((await f.request({action:'posts-list'})).value.announcements[0].text,'Edited');
 await f.request({action:'post-archive',id:'new-post'});data=(await f.request({action:'posts-list'})).value;assert.equal(data.posts.some(post=>post.id==='new-post'),false);assert.equal(data.announcements.length,0);
 await f.request({action:'post-restore',id:'new-post'});assert.equal((await f.request({action:'posts-list'})).value.announcements.length,1);await f.request({action:'post-delete',id:'new-post'});assert.equal((await f.request({action:'posts-list'})).value.announcements.length,0);
 const guest=await fixture({existing:{...roleRecords(),'users/email-user':{isGuest:true,displayName:'Guest'},'posts/a1':{uid:'admin',text:'Public announcement',category:'ประกาศ'}},guest:true});data=(await guest.request({action:'posts-list',category:'ประกาศ'})).value;assert.equal(data.posts.length,1);assert.equal(data.announcements[0].text,'Public announcement');
});
test('removed urgent category is read as General without removing old posts and cannot be used for new posts',async()=>{
 const f=await fixture({existing:{...roleRecords(),'posts/old':{uid:'email-user',text:'Old urgent post',category:'แจ้งเตือนด่วน'},'posts/new':{uid:'email-user',text:'General post',category:'ทั่วไป'}}});const data=(await f.request({action:'posts-list',category:'ทั่วไป'})).value;assert.equal(data.posts.length,2);assert.equal(data.posts.every(p=>p.category==='ทั่วไป'),true);assert.equal((await f.request({action:'post-detail',id:'old'})).value.post.category,'ทั่วไป');
 assert.equal((await f.request({action:'post-create',category:'แจ้งเตือนด่วน',text:'rejected'})).code,400);assert.equal((await f.request({action:'posts-list',category:'แจ้งเตือนด่วน'})).code,400);assert.equal(f.records.has('posts/old'),true);
});
