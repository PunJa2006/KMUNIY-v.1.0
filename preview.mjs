import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';
import { randomBytes } from 'node:crypto';
const project = fileURLToPath(new URL('./', import.meta.url));
try { loadEnvFile(resolve(project, '.env.local')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
process.env.FIREBASE_PROJECT_ID ||= 'for-web-com1';
process.env.RATE_LIMIT_SECRET ||= randomBytes(32).toString('hex');
const { firebaseConfig } = await import('./public/firebase-config.js');
process.env.FIREBASE_WEB_API_KEY ||= firebaseConfig.apiKey;
let handlerPromise;
const root = fileURLToPath(new URL('./public/', import.meta.url)).replace(/[\\/]$/, '');
http.createServer(async (req, res) => {
  if (req.headers.host === '127.0.0.1:4173') {
    res.writeHead(307, { Location: 'http://localhost:4173' + req.url, 'Cache-Control': 'no-store' });
    return res.end();
  }
  const pathname = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('Cache-Control', 'no-store');
  if (pathname === '/api/media') {
    try { const { default: media } = await import('./api/media.js'); await media(req, res); }
    catch { res.writeHead(503); res.end(JSON.stringify({ message: 'ระบบไฟล์ยังไม่พร้อม' })); }
    return;
  }
  if (pathname === '/api/account') {
    res.status = code => { res.statusCode = code; return res; };
    res.json = data => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(data)); return res; };
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method not allowed' }); }
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS && !existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
      return res.status(503).json({ message: 'ยังไม่พบไฟล์ firebase-service-account.json ใน E:\\skibidi code กรุณาวางไฟล์สิทธิ์ Firebase ก่อน' });
    }
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && (!process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PRIVATE_KEY)) {
      return res.status(503).json({ message: 'ยังไม่ได้ตั้งไฟล์สิทธิ์ Firebase ของเซิร์ฟเวอร์ กรุณาตั้ง GOOGLE_APPLICATION_CREDENTIALS ใน .env.local แล้วเปิดเว็บใหม่' });
    }
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk.toString('utf8');
        if (Buffer.byteLength(body) > 16384) return res.status(413).json({ message: 'ข้อมูลคำขอใหญ่เกินไป' });
      }
      req.body = body;
      delete req.headers['x-forwarded-for'];
      handlerPromise ||= import('./api/account.js').catch(error => { handlerPromise = null; throw error; });
      const { default: handler } = await handlerPromise;
      await handler(req, res);
    } catch {
      if (!res.writableEnded) res.status(503).json({ message: 'เปิด API ไม่สำเร็จ กรุณาตรวจแพ็กเกจและไฟล์สิทธิ์ Firebase' });
    }
    return;
  }
  if (pathname.startsWith('/api/')) { res.writeHead(404); return res.end('Not found'); }
  const file = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + sep)) { res.writeHead(403); return res.end(); }
  try {
    const data = await readFile(file);
    res.setHeader('Content-Type', extname(file) === '.js' ? 'text/javascript; charset=utf-8' : extname(file) === '.css' ? 'text/css; charset=utf-8' : extname(file) === '.svg' ? 'image/svg+xml' : extname(file) === '.png' ? 'image/png' : 'text/html; charset=utf-8');
    res.end(data);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(4173, '127.0.0.1', () => console.log('Preview: http://localhost:4173'));

