import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
const source = await readFile(new URL('../public/theme.js', import.meta.url), 'utf8');
function bootstrap({dark = false, saved = null, storageBlocked = false, supported = true} = {}) {
  const root = {dataset: {}};
  const context = {document: {documentElement: root}, localStorage: {getItem: key => {
    if (storageBlocked) throw Error('Storage blocked');
    return key === 'community-last-theme' ? saved : null;
  }}};
  if (supported) context.matchMedia = () => ({matches: dark});
  runInNewContext(source, context);
  return root.dataset.theme;
}
test('first paint uses the browser dark or light preference without a saved choice', () => {
  assert.equal(bootstrap({dark: true}), 'dark');
  assert.equal(bootstrap({dark: false}), 'light');
});
test('explicit saved light and dark choices override the opposite browser preference', () => {
  assert.equal(bootstrap({dark: true, saved: 'light'}), 'light');
  assert.equal(bootstrap({dark: false, saved: 'dark'}), 'dark');
});
test('blocked storage or invalid stored theme still use the system preference', () => {
  assert.equal(bootstrap({dark: true, storageBlocked: true}), 'dark');
  assert.equal(bootstrap({dark: true, saved: 'invalid'}), 'dark');
});
test('browsers without color preference support use light unless a manual theme was saved', () => {
  assert.equal(bootstrap({supported: false}), 'light');
  assert.equal(bootstrap({supported: false, saved: 'dark'}), 'dark');
});
