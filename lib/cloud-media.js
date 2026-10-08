import {randomUUID} from 'node:crypto';
import {issueSignedToken, presignUrl, head, get, del} from '@vercel/blob';
import {mediaType, MAX_FILE_BYTES} from './media.js';
// A store token configured as a Production Secret also works when OIDC upgrade is unavailable.
const credentials = options => process.env.BLOB_READ_WRITE_TOKEN ? {...options,token:process.env.BLOB_READ_WRITE_TOKEN} : options;
const privateBlob = {
  issueSignedToken: options => issueSignedToken(credentials(options)),
  presignUrl,
  head: (pathname,options={}) => head(pathname,credentials(options)),
  get: (pathname,options) => get(pathname,credentials(options)),
  del: (pathname,options={}) => del(pathname,credentials(options))
};
export const cloudMediaEnabled = () => Boolean(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN);
const types = ['image/jpeg','image/png','image/gif','image/webp','video/mp4','video/webm'];
const validId = id => /^[a-f0-9-]{36}$/.test(id || '');
const fail = (status, message) => Object.assign(new Error(message), {status});
export function createCloudMedia({db, blob = privateBlob, now = Date.now, uuid = randomUUID}) {
  async function prepare(uid, {type, size}) {
    if (!types.includes(type) || !Number.isInteger(size) || size < 12 || size > MAX_FILE_BYTES) throw fail(400,'รองรับรูปและวิดีโอ ขนาดไม่เกิน 50 MB');
    const id = uuid(), pathname = 'media/' + id, expiresAt = now() + 15*60*1000;
    const budget = db.collection('mediaUploadLimits').doc(uid);
    await db.runTransaction(async tx => {
      const snap = await tx.get(budget), old = snap.exists ? snap.data() : {};
      const active = Number(old.resetAt) > now();
      const bytes = (active ? old.bytes || 0 : 0) + size;
      if(bytes > 100*1024*1024) throw fail(429,'อัปโหลดไฟล์ครบโควตาชั่วโมงนี้แล้ว กรุณารอแล้วลองใหม่');
      tx.set(budget,{bytes,resetAt:active ? old.resetAt : now()+60*60*1000});
    });
    const constraints = {pathname,operations:['put'],validUntil:expiresAt,allowedContentTypes:[type],maximumSizeInBytes:size};
    const token = await blob.issueSignedToken(constraints);
    const {presignedUrl} = await blob.presignUrl(token,{operation:'put',pathname,access:'private',validUntil:expiresAt,allowedContentTypes:[type],maximumSizeInBytes:size,addRandomSuffix:false,allowOverwrite:false,cacheControlMaxAge:60});
    await db.collection('mediaUploads').doc(id).create({uid,type,size,expiresAt});
    return {id,uploadUrl:presignedUrl};
  }
  async function complete(uid, id) {
    if(!validId(id))throw fail(400,'ไฟล์ไม่ถูกต้อง');
    const ref = db.collection('media').doc(id), pending = db.collection('mediaUploads').doc(id);
    const [existing, upload] = await Promise.all([ref.get(),pending.get()]);
    if(existing.exists){if(existing.data().uid !== uid)throw fail(403,'ไฟล์ไม่ใช่ของคุณ');return {id,type:existing.data().type,size:existing.data().size};}
    if(!upload.exists || upload.data().uid !== uid)throw fail(403,'ไฟล์ไม่ใช่ของคุณ');
    const data = upload.data(), pathname = 'media/' + id;
    if(data.expiresAt < now())throw fail(410,'หมดเวลาอัปโหลด กรุณาเลือกไฟล์ใหม่');
    const metadata = await blob.head(pathname);
    if(metadata.size !== data.size || metadata.contentType !== data.type)throw fail(400,'ไฟล์อัปโหลดไม่ตรงกับข้อมูลที่เลือก');
    const content = await blob.get(pathname,{access:'private',useCache:false,headers:{Range:'bytes=0-4095'}});
    if(!content?.stream)throw fail(404,'ไม่พบไฟล์');
    const reader = content.stream.getReader(), chunks = [];let length=0;
    try {while(length<4096){const item=await reader.read();if(item.done)break;const chunk=Buffer.from(item.value).subarray(0,4096-length);chunks.push(chunk);length+=chunk.length;}}
    finally {await reader.cancel();}
    if(mediaType(Buffer.concat(chunks)) !== data.type){await blob.del(pathname);await pending.delete();throw fail(400,'ไฟล์ไม่ใช่รูปหรือวิดีโอที่รองรับ');}
    await db.runTransaction(async tx => {
      const [current, intent, restriction] = await Promise.all([tx.get(ref),tx.get(pending),tx.get(db.collection('restrictions').doc(uid))]);
      if(restriction.exists && restriction.data().banned)throw fail(403,'บัญชีนี้ถูกแบน กรุณาติดต่อ Dev หรือ Admin');
      if(current.exists){if(current.data().uid !== uid)throw fail(403,'ไฟล์ไม่ใช่ของคุณ');return;}
      if(!intent.exists || intent.data().uid !== uid || intent.data().expiresAt<now())throw fail(410,'หมดเวลาอัปโหลด กรุณาเลือกไฟล์ใหม่');
      tx.create(ref,{uid,type:data.type,size:data.size,postId:null,storage:'blob'});tx.delete(pending);
    });
    return {id,type:data.type,size:data.size};
  }
  return {prepare,complete};
}
export async function readCloudMedia(id) {
  if(!validId(id))throw fail(400,'ไฟล์ไม่ถูกต้อง');
  return privateBlob.get('media/'+id,{access:'private'});
}
export async function deleteCloudMedia(ids) {
  if(ids.some(id=>!validId(id)))throw new Error('Invalid media id');
  if(ids.length)await privateBlob.del(ids.map(id=>'media/'+id));
}
