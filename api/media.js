import {banned} from '../lib/moderation.js';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { services } from './account.js';
import { mediaType, MAX_FILE_BYTES } from '../lib/media.js';
const root = fileURLToPath(new URL('../media-data/', import.meta.url));
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const error = (code, message) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ message })); };
  if (!['POST', 'GET'].includes(req.method)) return error(405, 'Method not allowed');
  if (process.env.VERCEL) return error(503, 'ยังไม่ได้ตั้งพื้นที่เก็บไฟล์ออนไลน์สำหรับเว็บที่เผยแพร่');
  try {
    const token = String(req.headers.authorization || '');
    if (!token.startsWith('Bearer ')) return error(401, 'กรุณาเข้าสู่ระบบใหม่');
    const { auth, db } = services();
    const user = await auth.verifyIdToken(token.slice(7), true).catch(() => null);
    if (!user) return error(401, 'กรุณาเข้าสู่ระบบใหม่');
    if(await banned(db,user.uid))return error(403,'บัญชีนี้ถูกแบน กรุณาติดต่อ Dev หรือ Admin');
    const profile = await db.collection('users').doc(user.uid).get();
    if (!profile.exists) return error(403, 'กรุณาสมัครสมาชิกก่อนใช้งาน');
    if (req.method === 'GET') {
      const id = new URL(req.url, 'http://localhost').searchParams.get('id');
      if (!/^[a-f0-9-]{36}$/.test(id || '')) return error(400, 'ไฟล์ไม่ถูกต้อง');
      const snap = await db.collection('media').doc(id).get();
      if (!snap.exists) return error(404, 'ไม่พบไฟล์');
      const media = snap.data();
      if (media.uid !== user.uid) {
        const post = media.postId ? await db.collection('posts').doc(media.postId).get() : null;
        const owner = await db.collection('users').doc(media.uid).get();
        const isProfile = owner.exists && !owner.data().isGuest && owner.data().photoMediaId === id && media.type.startsWith('image/');
        if (!isProfile && (!post?.exists || !post.data().media?.some(item => item.id === id))) return error(404, 'ไม่พบไฟล์');
      }
      const bytes = await readFile(join(root, id));
      res.setHeader('Content-Type', media.type);
      res.setHeader('Content-Length', bytes.length);
      return res.end(bytes);
    }
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_FILE_BYTES) return error(413, 'ไฟล์ต้องมีขนาดไม่เกิน 50 MB');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    const type = mediaType(bytes);
    if (!type) return error(400, 'รองรับรูป JPG, PNG, GIF, WebP และวิดีโอ MP4, WebM เท่านั้น');
    const id = randomUUID();
    await mkdir(root, { recursive: true });
    await writeFile(join(root, id), bytes, { flag: 'wx' });
    try { await db.collection('media').doc(id).create({ uid: user.uid, type, size, postId: null }); }
    catch (cause) { await unlink(join(root, id)).catch(() => {}); throw cause; }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.statusCode = 201;
    res.end(JSON.stringify({ id, type, size }));
  } catch { error(503, 'บันทึกหรือโหลดไฟล์ไม่สำเร็จ กรุณาตรวจฐานข้อมูลและพื้นที่เก็บไฟล์'); }
}
