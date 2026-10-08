import {cloudMediaEnabled,deleteCloudMedia} from './cloud-media.js';
import {unlink} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const mediaRoot = fileURLToPath(new URL('../media-data/', import.meta.url));
export async function removeMediaFiles(ids) {
  if(cloudMediaEnabled())return deleteCloudMedia(ids);
  await Promise.all(ids.map(async id => {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid media id');
    try { await unlink(join(mediaRoot, id)); } catch(error) { if(error.code !== 'ENOENT') throw error; }
  }));
}
