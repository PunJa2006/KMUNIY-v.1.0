import {banned} from '../lib/moderation.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaType } from '../lib/media.js';
test('recognizes supported signatures rather than trusting filename or browser MIME', () => {
  const png = Buffer.alloc(12); Buffer.from([137,80,78,71,13,10,26,10]).copy(png);
  assert.equal(mediaType(png), 'image/png');
  assert.equal(mediaType(Buffer.from('0000ftypisom')), 'video/mp4');
  assert.equal(mediaType(Buffer.from('<html>fake image</html>')), null);
  assert.equal(mediaType(Buffer.from('<svg onload="alert(1)">')), null);
  assert.equal(mediaType(Buffer.alloc(0)), null);
});
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
async function mediaFixture({ own = false, published = false, profilePhoto = false, guestAuthor = false } = {}) {
  const id = '11111111-1111-4111-8111-111111111111';
  const files = new Map();
  const records = new Map([
    ['users/viewer', {}],
    ['users/author', { isGuest: guestAuthor, photoMediaId: profilePhoto ? id : null }],
    ['media/' + id, { uid: own ? 'viewer' : 'author', type: 'image/png', postId: 'post' }],
    ...(published ? [['posts/post', { media: [{ id }] }]] : [])
  ]);
  const db = { collection: path => ({ doc: key => ({
    get: async () => ({ exists: records.has(path + '/' + key), data: () => records.get(path + '/' + key) }),
    create: async value => records.set(path + '/' + key, value)
  }) }) };
  const source = (await readFile(new URL('../api/media.js', import.meta.url), 'utf8'))
    .replace(/^\uFEFF?import .*;\r?\n/gm, '')
    .replace(/const root = .*;\r?\n/, "const root = '/media';\n")
    .replace('export const config', 'const config').replace('export default async function handler', 'async function handler');
  const handler = runInNewContext(`(() => { ${source}; return handler; })()`, {
    cloudMediaEnabled:()=>false, banned, URL, Buffer, process: { env: {} }, MAX_FILE_BYTES: 50 * 1024 * 1024, mediaType,
    randomUUID: () => id, join: (root, value) => root + '/' + value,
    mkdir: async () => {}, writeFile: async (path, bytes) => files.set(path, bytes), unlink: async path => files.delete(path), readFile: async () => Buffer.from('file bytes'),
    services: () => ({ db, auth: { verifyIdToken: async () => ({ uid: 'viewer' }) } })
  });
  async function request(method, bytes = Buffer.alloc(0), authenticated = true) {
    const req = { method, url: '/api/media?id=' + id, headers: authenticated ? { authorization: 'Bearer test' } : {}, async *[Symbol.asyncIterator]() { yield bytes; } };
    const res = { statusCode: 200, setHeader() {}, end(value) { this.value = value; } };
    await handler(req, res);
    return res;
  }
  return { request, files, records };
}
test('media access requires login and hides archived files from other users', async () => {
  const privateFile = await mediaFixture();
  assert.equal((await privateFile.request('GET', undefined, false)).statusCode, 401);
  assert.equal((await privateFile.request('GET')).statusCode, 404);
  assert.equal((await (await mediaFixture({ own: true })).request('GET')).statusCode, 200);
  assert.equal((await (await mediaFixture({ published: true })).request('GET')).statusCode, 200);
});
test('upload validates bytes, stores metadata and rejects unsupported files', async () => {
  const f = await mediaFixture();
  const bad = await f.request('POST', Buffer.from('<svg onload="alert(1)">'));
  assert.equal(bad.statusCode, 400);
  assert.equal(f.files.size, 0);
  const png = Buffer.alloc(12); Buffer.from([137,80,78,71,13,10,26,10]).copy(png);
  const good = await f.request('POST', png);
  assert.equal(good.statusCode, 201);
  assert.equal(JSON.parse(good.value).type, 'image/png');
  assert.equal(f.files.size, 1);
  assert.equal(f.records.get('media/11111111-1111-4111-8111-111111111111').uid, 'viewer');
});

test('current member profile photo is visible but unused and Guest photos remain private', async () => {
  assert.equal((await (await mediaFixture({ profilePhoto: true })).request('GET')).statusCode, 200);
  assert.equal((await (await mediaFixture({ profilePhoto: true, guestAuthor: true })).request('GET')).statusCode, 404);
  assert.equal((await (await mediaFixture()).request('GET')).statusCode, 404);
});

test('banned users cannot upload or read media even with a valid Firebase session',async()=>{const f=await mediaFixture({published:true});f.records.set('restrictions/viewer',{banned:true});assert.equal((await f.request('GET')).statusCode,403);assert.equal((await f.request('POST',Buffer.from('bad'))).statusCode,403);assert.equal(f.files.size,0);});
