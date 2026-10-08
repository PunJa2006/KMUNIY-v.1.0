import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudMedia} from '../lib/cloud-media.js';
import {uploadMedia} from '../public/media-upload.js';
const id='11111111-1111-4111-8111-111111111111';
function fixture(){
  const records=new Map(), calls=[];
  const ref=key=>({key,get:async()=>snap(key),create:async value=>records.set(key,value),delete:async()=>records.delete(key)});
  const snap=key=>({exists:records.has(key),data:()=>records.get(key)});
  const db={collection:path=>({doc:key=>ref(path+'/'+key)}),runTransaction:async fn=>fn({get:r=>r.get(),set:(r,v)=>records.set(r.key,v),create:(r,v)=>records.set(r.key,v),delete:r=>records.delete(r.key)})};
  const png=Buffer.alloc(12);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);
  let bytes=png, clock=100;
  const blob={issueSignedToken:async options=>{calls.push(options);return {};},presignUrl:async(_,options)=>{calls.push(options);return {presignedUrl:'https://blob.vercel-storage.com/put'};},head:async()=>({size:12,contentType:'image/png'}),get:async()=>({stream:new ReadableStream({start(c){c.enqueue(bytes);c.close();}})}),del:async path=>calls.push({delete:path})};
  return {service:createCloudMedia({db,blob,now:()=>clock,uuid:()=>id}),records,calls,setBytes:v=>bytes=v,advance:()=>clock+=3600000};
}
test('cloud upload is limited to one private pathname, type, size and 15 minutes',async()=>{
  const f=fixture(), result=await f.service.prepare('owner',{type:'image/png',size:12});
  assert.equal(result.id,id);assert.equal(f.calls[0].pathname,'media/'+id);assert.deepEqual(f.calls[0].operations,['put']);
  assert.equal(f.calls[1].access,'private');assert.equal(f.calls[1].allowOverwrite,false);assert.equal(f.calls[0].maximumSizeInBytes,12);
  assert.equal(f.records.get('mediaUploads/'+id).uid,'owner');
  const saved=await f.service.complete('owner',id);assert.equal(saved.type,'image/png');assert.equal(f.records.get('media/'+id).storage,'blob');
  assert.deepEqual(await f.service.complete('owner',id),saved);
});
test('finalization rejects another user, expiry, suspended account and invalid signatures',async()=>{
  const f=fixture();await f.service.prepare('owner',{type:'image/png',size:12});
  await assert.rejects(f.service.complete('other',id),e=>e.status===403);
  f.records.set('restrictions/owner',{banned:true});await assert.rejects(f.service.complete('owner',id),e=>e.status===403);
  f.records.delete('restrictions/owner');f.setBytes(Buffer.from('<html>bad file</html>'));
  await assert.rejects(f.service.complete('owner',id),e=>e.status===400);assert.equal(f.records.has('media/'+id),false);
  const expired=fixture();await expired.service.prepare('owner',{type:'image/png',size:12});expired.advance();await assert.rejects(expired.service.complete('owner',id),e=>e.status===410);
});
test('cloud upload size and hourly reservation prevent unbounded uploads',async()=>{
  const f=fixture();await assert.rejects(f.service.prepare('owner',{type:'text/html',size:12}),e=>e.status===400);
  await f.service.prepare('owner',{type:'video/mp4',size:50*1024*1024});await f.service.prepare('owner',{type:'video/mp4',size:50*1024*1024});
  await assert.rejects(f.service.prepare('owner',{type:'image/png',size:12}),e=>e.status===429);
  f.advance();await f.service.prepare('owner',{type:'image/png',size:12});
});
test('direct client upload keeps Firebase token on our API and finalizes before returning',async()=>{
  const calls=[], responses=[{direct:true},{id,uploadUrl:'https://blob.vercel-storage.com/put'},{},{id}];
  const result=await uploadMedia({type:'image/png',size:12},{getIdToken:async()=>'private-login-token'},async(url,options)=>{calls.push({url,options});const data=responses.shift();return {ok:true,json:async()=>data};});
  assert.equal(result.id,id);assert.equal(calls[2].options.headers.Authorization,undefined);
  assert.equal(calls[3].options.headers.Authorization,'Bearer private-login-token');assert.equal(JSON.parse(calls[3].options.body).action,'complete');
});
test('failed direct upload never creates media metadata and local upload still works',async()=>{
  let count=0;await assert.rejects(uploadMedia({type:'image/png',size:12},{getIdToken:async()=>''},async()=>{count++;return {ok:count!==3,json:async()=>count===1?{direct:true}:{id,uploadUrl:'https://blob.vercel-storage.com/put'}};}));assert.equal(count,3);
  const result=await uploadMedia({type:'image/png',size:12},{getIdToken:async()=>''},async url=>({ok:true,json:async()=>url.includes('?')?{direct:false}:{id}}));assert.equal(result.id,id);
});

test('client accepts the SDK control API upload URL and finalizes selected bytes',async()=>{
  const uploadUrl='https://vercel.com/api/blob/?pathname=media%2F'+id+'&vercel-blob-signature=test';
  const file={type:'image/png',size:12},calls=[];
  const responses=[{direct:true},{id,uploadUrl},{},{id}];
  const result=await uploadMedia(file,{getIdToken:async()=>'login-token'},async(url,options)=>{
    calls.push({url,options});const data=responses.shift();return {ok:true,json:async()=>data};
  });
  assert.equal(result.id,id);assert.equal(calls[2].url,uploadUrl);
  assert.equal(calls[2].options.body,file);assert.equal(calls[2].options.headers.Authorization,undefined);
  assert.equal(JSON.parse(calls[3].options.body).action,'complete');
});

test('client rejects foreign, deceptive and unsafe upload URLs before sending the file',async()=>{
  const targets=['https://example.com/api/blob/','https://vercel.com.evil.example/api/blob/',
    'https://evilblob.vercel-storage.com/put','http://vercel.com/api/blob/',
    'https://vercel.com/other/','https://vercel.com/api/blob/other',
    'https://user:password@vercel.com/api/blob/','https://vercel.com:444/api/blob/'];
  for(const uploadUrl of targets){
    let count=0;
    await assert.rejects(uploadMedia({type:'image/png',size:12},{getIdToken:async()=>'login-token'},async()=>{
      count++;return {ok:true,json:async()=>count===1?{direct:true}:{id,uploadUrl}};
    }),/ที่อยู่อัปโหลดไม่ถูกต้อง/);
    assert.equal(count,2);
  }
});

