import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsername, guestName } from '../lib/identity.js';
test('username aliases normalize to the same unique key', () => {
  assert.equal(normalizeUsername('  Alice_123 '), normalizeUsername('ALICE_123'));
});
test('reject path traversal, reserved guest prefix, email and invalid length', () => {
  for (const value of ['../users', 'abc/def', 'guest_123', 'Guest_456', 'a@b.com', 'ab', 'a'.repeat(25), null, {}, 'ชื่อ']) {
    assert.equal(normalizeUsername(value), null);
  }
});
test('guest names stay in a separate namespace', () => {
  const names = new Set(Array.from({ length: 1000 }, guestName));
  assert.equal(names.size, 1000);
  for (const name of names) assert.match(name, /^guest_[a-f0-9]{16}$/);
});

test('new usernames require letters and digits and allow only underscore dot and caret as special characters', () => {
  assert.equal(normalizeUsername('A1', true), 'a1');
  assert.equal(normalizeUsername('Mairu123', true), 'mairu123');
  for (const value of ['mairu', '12345', 'mairu-1', '@mairu1', 'ชื่อ1', 'a', '1']) assert.equal(normalizeUsername(value, true), null);
  assert.equal(normalizeUsername('a1'), 'a1');
  assert.equal(normalizeUsername('old_name'), 'old_name');
});

test('underscore dot and caret work in creation and login', () => {
  for (const value of ['mairu_1', 'mairu.1', 'mairu^1']) {
    assert.equal(normalizeUsername(value, true), value);
    assert.equal(normalizeUsername(value), value);
  }
  for (const value of ['mairu@1', 'mairu-1', 'mairu/1', '../a1', 'guest_1', 'a.']) assert.equal(normalizeUsername(value, true), null);
});
