import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {put, get} from '@vercel/blob';
import {services} from '../api/account.js';
import {mediaType} from '../lib/media.js';
const root=fileURLToPath(new URL('../media-data/',import.meta.url));
if(!process.env.BLOB_STORE_ID && !process.env.BLOB_READ_WRITE_TOKEN)throw new Error('Set Blob credentials in the process environment before migration');
const {db}=services();
const snapshots=await db.collection('media').get();
const report={total:snapshots.size,migrated:0,alreadyOnline:0,missing:0,failed:0};
for(const snap of snapshots.docs){
  const data=snap.data();
  if(!/^[a-f0-9-]{36}$/.test(snap.id)){report.failed++;continue;}
  if(data.storage==='blob'){report.alreadyOnline++;continue;}
  let bytes;
  try{bytes=await readFile(join(root,snap.id));}catch(error){if(error.code==='ENOENT'){report.missing++;continue;}throw error;}
  if(bytes.length!==data.size || mediaType(bytes)!==data.type){report.failed++;continue;}
  try{
    const pathname='media/'+snap.id;
    let remote=await get(pathname,{access:'private',useCache:false});
    if(!remote){await put(pathname,bytes,{access:'private',contentType:data.type,addRandomSuffix:false,allowOverwrite:false,cacheControlMaxAge:60});remote=await get(pathname,{access:'private',useCache:false});}
    if(!remote?.stream)throw new Error('Missing migrated blob');
    const hash=createHash('sha256');let size=0;
    for await(const chunk of remote.stream){hash.update(chunk);size+=chunk.length;}
    if(size!==bytes.length || hash.digest('hex')!==createHash('sha256').update(bytes).digest('hex'))throw new Error('Migration integrity check failed');
    await snap.ref.update({storage:'blob'});report.migrated++;
  }catch{report.failed++;}
}
console.log(JSON.stringify(report));
if(report.missing || report.failed)process.exitCode=1;
