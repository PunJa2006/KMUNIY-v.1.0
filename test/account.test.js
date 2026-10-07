import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/account.js';
async function request(method, body, headers = {}) {
  const res = { headers: {}, setHeader(k,v) { this.headers[k] = v; }, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } };
  await handler({ method, body, headers }, res);
  return res;
}
test('API disallows GET and caching of account responses', async () => {
  const result = await request('GET');
  assert.equal(result.code, 405);
  assert.equal(result.headers.Allow, 'POST');
  assert.equal(result.headers['Cache-Control'], 'no-store');
});
test('malformed JSON and unsupported actions are rejected', async () => {
  assert.equal((await request('POST', '{')).code, 400);
  assert.equal((await request('POST', { action: 'list-users' })).code, 400);
});
test('profile requires authentication before any database access', async () => {
  const result = await request('POST', { action: 'profile' });
  assert.equal(result.code, 401);
  assert.equal(result.data.uid, undefined);
});
