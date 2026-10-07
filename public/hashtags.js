// Hashtags allow Thai/English letters, combining marks, numbers and underscores.
// A tag contributes once per post, regardless of how often it is repeated.
export function normalizeHashtag(value) {
  if (typeof value !== 'string') return null;
  const tag = value.trim().replace(/^#/, '').normalize('NFC').toLowerCase();
  return /^[\p{L}\p{M}\p{N}_]{1,64}$/u.test(tag) ? tag : null;
}
export function hashtagParts(text = '') {
  const parts = [];
  const pattern = /(^|[^\p{L}\p{M}\p{N}_/#])#([\p{L}\p{M}\p{N}_]{1,64})(?![\p{L}\p{M}\p{N}_])/gu;
  let cursor = 0;
  for (const match of String(text).matchAll(pattern)) {
    const start = match.index + match[1].length;
    if (start > cursor) parts.push({ text: text.slice(cursor, start), tag: null });
    parts.push({ text: '#' + match[2], tag: normalizeHashtag(match[2]) });
    cursor = start + match[2].length + 1;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), tag: null });
  return parts;
}
export function extractHashtags(text) { return [...new Set(hashtagParts(text).filter(part => part.tag).map(part => part.tag))]; }
