# Mairu KMUTNB Community

เวอร์ชัน 0.2

เว็บชุมชนสำหรับโพสต์ ถามตอบ และค้นหาผู้ใช้ เขียนด้วย HTML, CSS และ JavaScript ใช้ Firebase Authentication และ Firestore ผ่าน API ฝั่งเซิร์ฟเวอร์

## ระบบที่มีในเวอร์ชันนี้

- สมัครและล็อกอินด้วย Google หรือ Username + Password พร้อม Remember me
- Guest มีชื่อสุ่มและโพสต์ได้เฉพาะหมวด Q&A
- โปรไฟล์มีรูป ชื่อเล่น @username และแนะนำตัว การกดรูปในหน้าแก้ไขเปิดตัวเลือกไฟล์ใหม่
- โพสต์ข้อความ รูปภาพ และวิดีโอ หมวดทั่วไป, Q&A, ขายของ, ของหาย และประกาศ
- Admin และ Dev โพสต์หมวดประกาศได้ ประกาศแสดงทั้งในฟีดและแถบข้อความวิ่ง แถบแสดงประกาศล่าสุดไม่เกิน 5 รายการและเปลี่ยนตามการแก้ไข ลบ หรือเก็บโพสต์เข้าคลังเมื่อโหลดฟีดใหม่
- โพสต์แจ้งเตือนด่วนเดิมแสดงในหมวดทั่วไป
- ปุ่มติดต่อแอดมินส่งข้อความเข้า Report inbox หมวดทั่วไปให้ Admin และ Dev เห็น
- กดใจ คอมเมนต์ ตอบกลับ เรียงคอมเมนต์ตามยอดใจ และแก้ไขคอมเมนต์ตัวเองได้ภายใน 5 นาที
- แก้ไขโพสต์ คลังส่วนตัว บันทึกโพสต์คนอื่น และรายงานโพสต์หรือคอมเมนต์
- ค้นหา @username ขณะพิมพ์ พร้อมประวัติการค้นหาและแฮชแท็กยอดนิยมใน 3 ชั่วโมงล่าสุด
- ปุ่ม # ช่วยใส่แฮชแท็กพร้อมเว้นวรรคในช่องเขียนโพสต์
- ยศ Dev, Admin และ Trader แสดงข้างชื่อในโปรไฟล์และโพสต์ Dev เป็นสี RGB เคลื่อนไหว และ Trader เป็นสีเขียว
- Admin และ Dev ให้ยศ Trader ได้ ส่วน Dev ให้หรือถอด Admin และถอด Trader ได้
- Dev และ Admin แบน ปลดแบน และลบโพสต์คนอื่นได้ กล่องรายงานแยกหมวด และปัญหาการใช้งานเปิดได้เฉพาะ Dev
- ผู้ใช้ทั่วไปและ Guest รอ 1 นาทีต่อโพสต์ ส่วน Dev, Admin และ Trader ไม่ต้องรอ
- ธีมขาว/ดำ ภาษาไทย/อังกฤษ และหน้าจอรองรับมือถือ

## เปิดในเครื่อง

ใช้ Node.js 22 และติดตั้ง dependencies:

```text
pnpm install --frozen-lockfile
```

หากไม่มี pnpm ใช้ `npm install` ได้

1. ตั้งค่า Firebase Web app ใน `public/firebase-config.js` ให้ตรงกับโปรเจกต์ของคุณ
2. เปิด Email/Password, Google และ Anonymous ใน Firebase Authentication
3. เพิ่ม `localhost` ใน Authorized domains ของ Firebase
4. สร้าง Firestore และใช้กฎใน `firestore.rules` ให้ client เข้าถึงข้อมูลผ่าน API เท่านั้น
5. คัดลอก `local-env.example` เป็น `.env.local` แล้วตั้ง `GOOGLE_APPLICATION_CREDENTIALS` เป็นตำแหน่ง service account JSON ในเครื่อง เก็บไฟล์ JSON ไว้นอก repository
6. กำหนด `FIREBASE_WEB_API_KEY` ให้ตรงกับ Firebase Web app และกำหนด `RATE_LIMIT_SECRET` เป็นข้อความสุ่ม โดยดูชื่อตัวแปรจาก `.env.example`

เปิดเว็บด้วย:

```text
npm start
```

จากนั้นเปิด http://localhost:4173 หรือใช้ `open-web.cmd` บน Windows หน้าล็อกอินคือหน้าแรกของเว็บ การดับเบิลคลิก HTML โดยตรงจะไม่เปิด API

ทดสอบระบบด้วย:

```text
npm test
```

## ข้อมูลและสิทธิ์

Firebase Authentication จัดการรหัสผ่าน ไม่เก็บรหัสผ่านไว้ใน Firestore

ข้อมูลหลักอยู่ใน `users`, `usernames`, `handles`, `posts`, `roles` และ `restrictions` คลัง โพสต์ที่บันทึก และรายงานเก็บแยกตามผู้ใช้ API ตรวจ Firebase ID token และสิทธิ์ก่อนอ่านหรือแก้ข้อมูล

Dev ผูกกับ UID ใน `settings/moderation.developerUid` ผู้รับรายงานกำหนดใน `settings/moderation.reportRecipientUid` ไม่ตัดสินยศจากชื่อที่ผู้ใช้ตั้งเอง การติดตั้ง Firebase โปรเจกต์ใหม่ต้องกำหนดค่าทั้งสองนี้โดยเจ้าของโปรเจกต์

## Vercel และไฟล์แนบ

มี `vercel.json` สำหรับหน้าเว็บใน `public` และ API ใน `api` ใช้ Environment Variables ตาม `.env.example`

เวอร์ชัน 0.2 เก็บไฟล์รูปและวิดีโอใน `media-data` บนเครื่องเซิร์ฟเวอร์ ระบบอัปโหลดไฟล์จะปฏิเสธเมื่อรันบน Vercel จนกว่าจะเชื่อมพื้นที่เก็บไฟล์ออนไลน์ จึงยังใช้ Vercel แทนเซิร์ฟเวอร์ในเครื่องสำหรับอัปโหลดไฟล์ไม่ได้

## ไฟล์ที่ไม่อยู่ใน repository

ไม่รวม `.env.local`, service account JSON, private key, ข้อมูลใน Firebase, ไฟล์รูป/วิดีโอของผู้ใช้, `node_modules` และผลการตรวจชั่วคราวใน `outputs` Firebase Web config ใน `public` เป็นค่าที่ใช้ฝั่ง client และไม่ใช่ service account
