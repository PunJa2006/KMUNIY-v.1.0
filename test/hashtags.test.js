import test from 'node:test';
import assert from 'node:assert/strict';
import {extractHashtags,hashtagParts,normalizeHashtag} from '../public/hashtags.js';

test('hashtags support Thai combining marks and English case-insensitive deduplication',()=>{
 assert.deepEqual(extractHashtags('เรียน #ชีวิตมหาลัย #KMUTNB #kmUTNB #ถาม_ตอบ'),['ชีวิตมหาลัย','kmutnb','ถาม_ตอบ']);
 assert.equal(normalizeHashtag('#KMUTNB'),'kmutnb');
 assert.equal(normalizeHashtag('#bad/tag'),null);
});
test('hashtags preserve original text and ignore embedded words, URLs and overly long tags',()=>{
 const text='<img onerror=x> (#KMUTNB) #หาเพื่อน! word#skip https://example/#skip #'+ 'a'.repeat(65);
 const parts=hashtagParts(text);
 assert.equal(parts.map(p=>p.text).join(''),text);
 assert.deepEqual(extractHashtags(text),['kmutnb','หาเพื่อน']);
});
