import test from 'node:test';
import assert from 'node:assert/strict';
import { createSearchHistory } from '../public/search-history.js';
const storage = () => { const data = new Map(); return { data, getItem:key=>data.get(key) || null, setItem:(key,value)=>data.set(key,value) }; };
test('history persists by account, deduplicates case and limits recent searches to 20',()=>{
 const store=storage(),one=createSearchHistory(()=>store,'one'),two=createSearchHistory(()=>store,'two');
 one.remember({kind:'query',value:'  @OTHER1  '});one.remember({kind:'profile',value:'@other1'});
 assert.deepEqual(one.list(),[{kind:'profile',value:'@other1',key:'@other1'}]);assert.deepEqual(two.list(),[]);
 for(let i=0;i<25;i++)one.remember({kind:'query',value:'name'+i});
 const reloaded=createSearchHistory(()=>store,'one');assert.equal(reloaded.list().length,20);assert.equal(reloaded.list()[0].value,'name24');assert.equal(reloaded.list().at(-1).value,'name5');
 reloaded.remove('@name24');assert.equal(reloaded.list()[0].value,'name23');reloaded.clear();assert.deepEqual(createSearchHistory(()=>store,'one').list(),[]);
});
test('history accepts Thai hashtags but rejects unsafe, malformed or oversized stored entries',()=>{
 const store=storage(),history=createSearchHistory(()=>store,'one');history.remember({kind:'query',value:'#ชีวิตมหาลัย'});assert.equal(history.list()[0].key,'#ชีวิตมหาลัย');
 for(const item of [{kind:'query',value:'<script>alert(1)</script>'},{kind:'profile',value:'#tag'},{kind:'query',value:'x'.repeat(66)},{kind:'unknown',value:'name1'}])history.remember(item);
 assert.equal(history.list().length,1);store.setItem('community-search-history:one','invalid json');assert.deepEqual(createSearchHistory(()=>store,'one').list(),[]);
 store.setItem('community-search-history:one',JSON.stringify([{kind:'query',value:'valid1',key:'forged'},null,{kind:'profile',value:'../user'}]));assert.deepEqual(createSearchHistory(()=>store,'one').list(),[{kind:'query',value:'valid1',key:'@valid1'}]);
});
test('unavailable browser storage or failed writes keep usable session history without breaking search',()=>{
 for(const store of [{getItem:()=>{throw Error('blocked');},setItem:()=>{throw Error('blocked');}},{getItem:()=>null,setItem:()=>{throw Error('quota');}}]){
  const history=createSearchHistory(()=>store,'one');history.remember({kind:'query',value:'name1'});assert.equal(history.list()[0].value,'name1');history.clear();assert.deepEqual(history.list(),[]);
 }
});
