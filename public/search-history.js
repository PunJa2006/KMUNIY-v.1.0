import { normalizeHashtag } from './hashtags.js';
const LIMIT = 20;
function entry(item) {
  if (!item || !['query', 'profile'].includes(item.kind) || typeof item.value !== 'string') return null;
  const value = item.value.trim();
  if (value.length > 65) return null;
  if (item.kind === 'query' && value.startsWith('#')) {
    const tag = normalizeHashtag(value);
    return tag ? { kind: 'query', value, key: '#' + tag } : null;
  }
  const handle = value.replace(/^@/, '');
  if (!/^[a-z0-9_.^]{1,24}$/i.test(handle)) return null;
  return { kind: item.kind, value: item.kind === 'profile' ? '@' + handle : value, key: '@' + handle.toLowerCase() };
}
function clean(items) {
  if (!Array.isArray(items)) return [];
  const seen = new Set(), result = [];
  for (const item of items) {
    const valid = entry(item);
    if (!valid || seen.has(valid.key)) continue;
    seen.add(valid.key); result.push(valid);
    if (result.length === LIMIT) break;
  }
  return result;
}
export function createSearchHistory(storage, uid) {
  const key = 'community-search-history:' + uid;
  let cached = [], pending = false;
  function list() {
    if (pending) return cached.map(item => ({ ...item }));
    try {
      const raw = storage().getItem(key);
      cached = raw && raw.length <= 20000 ? clean(JSON.parse(raw)) : [];
    } catch {}
    return cached.map(item => ({ ...item }));
  }
  function save(items) {
    cached = clean(items);
    try { storage().setItem(key, JSON.stringify(cached)); pending = false; } catch { pending = true; }
  }
  return {
    list,
    remember(item) {
      const valid = entry(item);
      if (valid) save([valid, ...list().filter(previous => previous.key !== valid.key)]);
    },
    remove(itemKey) { save(list().filter(item => item.key !== itemKey)); },
    clear() { save([]); }
  };
}
