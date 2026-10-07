import { randomBytes } from 'node:crypto';
export function normalizeUsername(input, forCreation = false) {
  if (typeof input !== 'string') return null;
  const value = input.trim().toLowerCase();
  if (forCreation) return /^(?=.*[a-z])(?=.*[0-9])[a-z0-9_.^]{2,24}$/.test(value) && !value.startsWith('guest_') ? value : null;
  return (/^[a-z0-9_]{3,24}$/.test(value) || /^(?=.*[a-z])(?=.*[0-9])[a-z0-9_.^]{2,24}$/.test(value)) && !value.startsWith('guest_') ? value : null;
}
export function guestName() { return `guest_${randomBytes(8).toString('hex')}`; }

