import {moderationActions,roleFor,assignedRole,banned,permissions,handleModeration} from '../lib/moderation.js';
import {handlePostAction, savedPosts, moderationAccess} from '../lib/post-actions.js';
import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { createHmac, randomUUID } from 'node:crypto';
import { extractHashtags, normalizeHashtag } from '../public/hashtags.js';
import { normalizeUsername, guestName } from '../lib/identity.js';

function services() {
  if (!getApps().length) {
    const { FIREBASE_PROJECT_ID: projectId, FIREBASE_CLIENT_EMAIL: clientEmail, FIREBASE_PRIVATE_KEY: privateKey } = process.env;
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      initializeApp({ credential: applicationDefault(), projectId: projectId || 'for-web-com1' });
    } else {
      if (!projectId || !clientEmail || !privateKey) throw new Error('CONFIG');
      initializeApp({ credential: cert({ projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') }) });
    }
  }
  return { auth: getAuth(), db: getFirestore() };
}
const categories = ['ทั่วไป', 'ถาม-ตอบ', 'ขายของ', 'ของหาย', 'ประกาศ'];
const visibleCategory = category => category==='แจ้งเตือนด่วน' ? 'ทั่วไป' : category || null;
function nextMonth(now) {
  const offset = 7 * 60 * 60 * 1000;
  const date = new Date(now + offset);
  const day = date.getUTCDate();
  date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.getTime() - offset;
}
function fail(code, message) { return Object.assign(new Error(message), { status: code }); }
async function throttle(db, value, message = 'ลองเข้าสู่ระบบถี่เกินไป กรุณารอ 15 นาที') {
  if (!process.env.RATE_LIMIT_SECRET) throw new Error('CONFIG');
  const key = createHmac('sha256', process.env.RATE_LIMIT_SECRET).update(value).digest('hex');
  const ref = db.collection('loginLimits').doc(key);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const now = Date.now();
    const previous = snap.data();
    const active = previous && previous.until > now;
    const count = active ? previous.count : 0;
    if (count >= 15) throw fail(429, message);
    tx.set(ref, { count: count + 1, until: active ? previous.until : now + 900000 });
  });
}
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ message: 'Method not allowed' }); }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!body || ![...moderationActions, 'profile', 'profile-read', 'username-login', 'username-register', 'posts-list', 'post-create', 'my-posts', 'archive-list', 'post-archive', 'post-restore', 'profile-update', 'post-detail', 'post-like', 'comment-create', 'comment-update', 'comment-delete', 'comment-like', 'author-profile', 'search-users', 'trending-tags', 'post-update', 'post-delete', 'post-save', 'saved-list', 'report-create', 'usage-report-create', 'contact-admin-create', 'reports-list', 'report-delete'].includes(body.action)) throw fail(400, 'คำขอไม่ถูกต้อง');
    if (!['username-login', 'username-register'].includes(body.action) && !String(req.headers.authorization || '').startsWith('Bearer ')) throw fail(401, 'กรุณาเข้าสู่ระบบใหม่');
    const { auth, db } = services();
    if (body.action === 'username-register') {
      const username = normalizeUsername(body.username, true);
      if (!username) throw fail(400, 'มีตัวอักษรอังกฤษและตัวเลขอย่างน้อยอย่างละ 1 ตัว ใช้ _ . ^ ได้');
      if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 4096) throw fail(400, 'Password ต้องมีอย่างน้อย 8 ตัว');
      const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
      await throttle(db, `signup:${ip}`);
      const nameRef = db.collection('usernames').doc(username);
      if ((await nameRef.get()).exists) throw fail(409, 'Username นี้มีผู้ใช้แล้ว กรุณาเลือกชื่ออื่น');
      const uid = randomUUID();
      // Firebase password authentication requires an email identifier. This internal
      // .invalid address is not a user's email; the public profile stores email: null.
      await auth.createUser({ uid, email: `u.${uid}@username.for-web-com1.invalid`, password: body.password, displayName: username });
      try {
        await db.runTransaction(async tx => {
          if ((await tx.get(nameRef)).exists) throw fail(409, 'Username นี้มีผู้ใช้แล้ว กรุณาเลือกชื่ออื่น');
          tx.create(nameRef, { uid });
          tx.create(db.collection('users').doc(uid), {
            uid, username, email: null, displayName: username, isGuest: false,
            accountType: 'username', googleName: null, photoURL: null,
            createdAt: FieldValue.serverTimestamp()
          });
        });
      } catch (error) {
        await auth.deleteUser(uid).catch(() => {});
        throw error;
      }
      return res.status(201).json({ registered: true });
    }
    if (body.action === 'username-login') {
      const username = normalizeUsername(body.username);
      const invalid = () => fail(401, 'Email / Username หรือ Password ไม่ถูกต้อง');
      if (!username || typeof body.password !== 'string' || !body.password || body.password.length > 4096) throw invalid();
      // Vercel overwrites x-forwarded-for with the client address. Never log credentials.
      const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
      await throttle(db, `ip:${ip}`);
      await throttle(db, `username:${username}`);
      const mapping = await db.collection('usernames').doc(username).get();
      if (!mapping.exists) throw invalid();
      const user = await auth.getUser(mapping.data().uid).catch(() => null);
      if (!user?.email || user.disabled) throw invalid();
      if (!process.env.FIREBASE_WEB_API_KEY) throw new Error('CONFIG');
      const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(process.env.FIREBASE_WEB_API_KEY)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email, password: body.password, returnSecureToken: true }),
        signal: AbortSignal.timeout(10000)
      });
      const verified = await response.json();
      // Fail closed for MFA or any response that has not completed authentication.
      if (!response.ok || verified.localId !== user.uid || !verified.idToken || verified.mfaPendingCredential) throw invalid();
      if(await banned(db,user.uid) && body.forAppeal!==true)throw Object.assign(fail(403,'บัญชีนี้ถูกแบน กรุณาติดต่อ Dev หรือ Admin'),{code:'ACCOUNT_BANNED'});
      // Complete browser authentication with Firebase's password provider, which
      // does not require IAM token signing permissions on the server.
      return res.status(200).json({ email: user.email });
    }
    const bearer = req.headers.authorization || '';
    if (!bearer.startsWith('Bearer ')) throw fail(401, 'กรุณาเข้าสู่ระบบใหม่');
    const claims = await auth.verifyIdToken(bearer.slice(7), true).catch(() => { throw fail(401, 'กรุณาเข้าสู่ระบบใหม่'); });
    if(await banned(db,claims.uid) && body.action!=='usage-report-create')throw Object.assign(fail(403,'บัญชีนี้ถูกแบน กรุณาติดต่อ Dev หรือ Admin'),{code:'ACCOUNT_BANNED'});
    const isGuest = claims.firebase?.sign_in_provider === 'anonymous';
    const profileRef = db.collection('users').doc(claims.uid);
    if ([...moderationActions, 'posts-list', 'post-create', 'my-posts', 'archive-list', 'post-archive', 'post-restore', 'profile-update', 'post-detail', 'post-like', 'comment-create', 'comment-update', 'comment-delete', 'comment-like', 'author-profile', 'search-users', 'trending-tags', 'post-update', 'post-delete', 'post-save', 'saved-list', 'report-create', 'usage-report-create', 'contact-admin-create', 'reports-list', 'report-delete'].includes(body.action)) {
      const member = await profileRef.get();
      if (!member.exists || (!isGuest && (member.data().isGuest || (!member.data().username && !member.data().email)))) throw fail(403, 'กรุณาสมัครสมาชิกก่อนใช้งาน');
      const moderation=await handleModeration({body,db,claims,fail,FieldValue});
      if(moderation)return res.status(moderation.status).json(moderation.body);
      // Keep the original profile so unbanning restores it. Mask public reads.
      const visiblePeople = new Map();
      async function publicPerson(uid, person) {
        if (!visiblePeople.has(uid)) visiblePeople.set(uid, (async () => {
          const suspended = await banned(db, uid);
          return suspended ? { ...person, suspended: true, displayName: 'ผู้ใช้งานถูกระงับบัญชี', bio: 'ติดต่อปลดแบนได้ที่ "รายงานปัญหาการใช้งาน"', photoMediaId: null, photoURL: null } : { ...person, suspended: false };
        })());
        return visiblePeople.get(uid);
      }
      const archive = profileRef.collection('archive');
      const handled = await handlePostAction({body,db,claims,member,archive,fail,FieldValue,throttle});
      if(handled)return res.status(handled.status).json(handled.body);
      if (body.action === 'search-users') {
        const query = typeof body.query === 'string' ? body.query.trim().replace(/^@/, '').toLowerCase() : '';
        if (!/^[a-z0-9_.^]{1,24}$/.test(query)) throw fail(400, 'กรุณาพิมพ์ @username ที่ต้องการค้นหา');
        const matches = await db.collection('handles').orderBy('__name__').startAt(query).endAt(query + '\uf8ff').limit(20).get();
        const users = await Promise.all(matches.docs.map(async mapping => {
          const profile = await db.collection('users').doc(mapping.data().uid).get();
          const person = profile.exists ? profile.data() : null;
          if (!person || person.isGuest || person.profileCompleted !== true || person.handle !== mapping.id) return null;
          const visible = await publicPerson(mapping.data().uid, person);
          return { displayName: visible.displayName, handle: visible.handle, photoId: visible.photoMediaId || null, suspended: visible.suspended };
        }));
        return res.status(200).json({ users: users.filter(Boolean) });
      }
      if (body.action === 'trending-tags') {
        const now = member.readTime?.toMillis() ?? Date.now();
        const since = now - 3 * 60 * 60 * 1000;
        const recent = await db.collection('posts').where('createdAt', '>=', new Date(since)).where('createdAt', '<=', new Date(now)).get();
        const counts = new Map();
        for (const post of recent.docs) {
          const data = post.data(), createdAt = data.createdAt.toDate().getTime();
          for (const tag of extractHashtags(data.text || '')) {
            const previous = counts.get(tag) || { tag, count: 0, latest: 0 };
            previous.count++; previous.latest = Math.max(previous.latest, createdAt); counts.set(tag, previous);
          }
        }
        const tags = [...counts.values()].filter(item => item.count >= 2).sort((a,b) => b.count - a.count || b.latest - a.latest || a.tag.localeCompare(b.tag)).slice(0,10).map(({tag,count}) => ({tag,count}));
        return res.status(200).json({ tags, windowHours: 3 });
      }
      if (['post-detail', 'post-like', 'comment-create', 'comment-update', 'comment-delete', 'comment-like'].includes(body.action)) {
        if (typeof body.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.id)) throw fail(400, 'โพสต์ไม่ถูกต้อง');
        const ref = db.collection('posts').doc(body.id);
        const likes = ref.collection('likes');
        const comments = ref.collection('comments');
        if (body.action === 'post-like') {
          if (typeof body.liked !== 'boolean') throw fail(400, 'คำขอไม่ถูกต้อง');
          let result;
          await db.runTransaction(async tx => {
            const post = await tx.get(ref);
            const likeRef = likes.doc(claims.uid);
            const existing = await tx.get(likeRef);
            if (!post.exists) throw fail(404, 'ไม่พบโพสต์ หรือโพสต์ถูกเก็บเข้าคลังแล้ว');
            const changed = body.liked !== existing.exists;
            const likeCount = Math.max(0, (post.data().likeCount || 0) + (changed ? body.liked ? 1 : -1 : 0));
            if (changed) {
              if (body.liked) tx.create(likeRef, { uid: claims.uid, createdAt: FieldValue.serverTimestamp() });
              else tx.delete(likeRef);
              tx.update(ref, { likeCount });
            }
            result = { liked: body.liked, likeCount };
          });
          return res.status(200).json(result);
        }
        if (['comment-update','comment-delete','comment-like'].includes(body.action)) {
          if(typeof body.commentId!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.commentId))throw fail(400,'คอมเมนต์ไม่ถูกต้อง');
          const commentRef=comments.doc(body.commentId),likeRef=commentRef.collection('likes').doc(claims.uid);
          const text=typeof body.text==='string'?body.text.trim():'';
          if(body.action==='comment-update' && (!text || text.length>2000))throw fail(400,'พิมพ์คอมเมนต์ไม่เกิน 2,000 ตัวอักษร');
          if(body.action==='comment-like' && typeof body.liked!=='boolean')throw fail(400,'คำขอไม่ถูกต้อง');
          let result;
          await db.runTransaction(async tx=>{
            const [post,comment]=await Promise.all([tx.get(ref),tx.get(commentRef)]);
            if(!post.exists)throw fail(404,'ไม่พบโพสต์ หรือโพสต์ถูกเก็บเข้าคลังแล้ว');
            if(!comment.exists)throw fail(404,'ไม่พบคอมเมนต์');
            const data=comment.data();
            if(data.deleted){if(body.action==='comment-delete' && data.uid===claims.uid){result={deleted:true};return;}throw fail(404,'ไม่พบคอมเมนต์');}
            if(body.action==='comment-like'){
              const existing=await tx.get(likeRef),changed=body.liked!==existing.exists;
              const likeCount=Math.max(0,(data.likeCount || 0)+(changed?(body.liked?1:-1):0));
              if(changed){if(body.liked)tx.create(likeRef,{uid:claims.uid,createdAt:FieldValue.serverTimestamp()});else tx.delete(likeRef);tx.update(commentRef,{likeCount});}
              result={liked:body.liked,likeCount};return;
            }
            if(data.uid!==claims.uid)throw fail(403,'จัดการได้เฉพาะคอมเมนต์ของตัวเอง');
            if(body.action==='comment-delete'){
              tx.update(commentRef,{deleted:true,text:'',likeCount:0,edited:false,deletedAt:FieldValue.serverTimestamp()});tx.update(ref,{commentCount:Math.max(0,(post.data().commentCount || 0)-1)});result={deleted:true};return;
            }
            const now=comment.readTime?.toMillis() ?? Date.now(),created=data.createdAt?.toDate().getTime(),elapsed=now-created;
            if(!Number.isFinite(created) || elapsed<0 || elapsed>=300000)throw fail(403,'แก้ไขคอมเมนต์ได้ภายใน 5 นาทีหลังส่งเท่านั้น');
            const changed=text!==data.text;
            if(changed)tx.update(commentRef,{text,edited:true,updatedAt:FieldValue.serverTimestamp()});
            result={updated:changed,edited:changed || data.edited===true};
          });
          if(body.action==='comment-delete')await db.recursiveDelete(commentRef.collection('likes'));
          return res.status(200).json(result);
        }
        if (body.action === 'comment-create') {
          const text = typeof body.text === 'string' ? body.text.trim() : '';
          if (!text || text.length > 2000) throw fail(400, 'พิมพ์คอมเมนต์ไม่เกิน 2,000 ตัวอักษร');
          await throttle(db, 'comment:' + claims.uid, 'ส่งคอมเมนต์ถี่เกินไป กรุณารอ 15 นาที');
          if(body.replyTo!==undefined && (typeof body.replyTo!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.replyTo)))throw fail(400,'คอมเมนต์ไม่ถูกต้อง');
          const commentRef = comments.doc(randomUUID());
          await db.runTransaction(async tx => {
            const post = await tx.get(ref);
            if (!post.exists) throw fail(404, 'ไม่พบโพสต์ หรือโพสต์ถูกเก็บเข้าคลังแล้ว');
            let reply={parentId:null};
            if(body.replyTo){
              const target=await tx.get(comments.doc(body.replyTo));
              if(!target.exists || target.data().deleted)throw fail(404,'ไม่พบคอมเมนต์');
              const parentId=target.data().parentId || target.id;
              if(target.data().parentId && !(await tx.get(comments.doc(parentId))).exists)throw fail(404,'ไม่พบคอมเมนต์');
              reply={parentId,replyToId:target.id,replyToUid:target.data().uid};
            }
            tx.create(commentRef, { uid: claims.uid, text, ...reply, likeCount:0, createdAt: FieldValue.serverTimestamp() });
            tx.update(ref, { commentCount: (post.data().commentCount || 0) + 1 });
          });
          return res.status(201).json({ saved: true });
        }
        let post = await ref.get();
        let archived = false;
        if (!post.exists) { post = await archive.doc(body.id).get(); archived = true; }
        if (!post.exists || (archived && post.data().uid !== claims.uid)) throw fail(404, 'ไม่พบโพสต์');
        async function page(collection, after, ordered = false) {
          let query = collection.orderBy(ordered ? 'createdAt' : '__name__', ordered ? 'desc' : 'asc');
          if (after !== undefined && after !== null) {
            if (typeof after !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(after)) throw fail(400, 'หน้าข้อมูลไม่ถูกต้อง');
            const cursor = await collection.doc(after).get();
            if (!cursor.exists) throw fail(400, 'ข้อมูลเปลี่ยนแล้ว กรุณาเปิดโพสต์อีกครั้ง');
            query = query.startAfter(cursor);
          }
          return query.limit(100).get();
        }
        async function rankedComments(){
          // Include older comments without likeCount; sorting only recent comments
          // would miss an older comment with the most likes.
          const all=await comments.get();
          const byId=new Map(all.docs.map(doc=>[doc.id,doc])),children=new Map();
          const score=(a,b)=>(b.data().likeCount || 0)-(a.data().likeCount || 0) || (b.data().createdAt?.toDate().getTime() || 0)-(a.data().createdAt?.toDate().getTime() || 0) || a.id.localeCompare(b.id);
          for(const doc of all.docs)if(!doc.data().deleted && doc.data().parentId && byId.has(doc.data().parentId)){const group=children.get(doc.data().parentId)||[];group.push(doc);children.set(doc.data().parentId,group);}
          const roots=all.docs.filter(doc=>(!doc.data().parentId || !byId.has(doc.data().parentId)) && (!doc.data().deleted || children.has(doc.id))).sort(score);
          const ranked=roots.flatMap(doc=>[doc,...(children.get(doc.id)||[]).sort(score)]);
          let start=0;
          for(const key of ['commentsAfter','focusCommentId'])if(body[key]!=null && (typeof body[key]!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body[key])))throw fail(400,'หน้าข้อมูลไม่ถูกต้อง');
          if(body.commentsAfter){const index=ranked.findIndex(doc=>doc.id===body.commentsAfter);if(index<0)throw fail(400,'ข้อมูลเปลี่ยนแล้ว กรุณาเปิดโพสต์อีกครั้ง');start=index+1;}
          else if(body.focusCommentId){const index=ranked.findIndex(doc=>doc.id===body.focusCommentId);if(index>=0)start=Math.floor(index/100)*100;}
          const window=ranked.slice(start,start+100);
          if(body.focusCommentId && !body.commentsAfter && window[0]?.data().parentId){const parent=byId.get(window[0].data().parentId);if(parent && !window.some(doc=>doc.id===parent.id))window.unshift(parent);}
          return {allById:byId,docs:window,hasMore:start+100<ranked.length,focusedFound:body.focusCommentId?ranked.some(doc=>doc.id===body.focusCommentId):null};
        }
        const [likeList, commentList] = await Promise.all([page(likes, body.likesAfter), rankedComments()]);
        const commentLikes=new Map();
        await Promise.all(commentList.docs.map(async doc=>{commentLikes.set(doc.id,(await comments.doc(doc.id).collection('likes').doc(claims.uid).get()).exists);}));
        const serverNow=post.readTime?.toMillis() ?? Date.now();
        const people = new Map();
        await Promise.all([...new Set([post.data().uid, ...likeList.docs.map(doc => doc.data().uid), ...commentList.docs.flatMap(doc => [doc.data().uid,doc.data().replyToUid])])].filter(Boolean).map(async uid => {
          const person = uid === claims.uid ? member : await db.collection('users').doc(uid).get();
          const data = await publicPerson(uid, person.exists ? person.data() : {});
          const authorRole = uid === post.data().uid && person.exists && !data.isGuest && !data.suspended ? await roleFor(db,uid) : null;
          people.set(uid, { ...(uid === post.data().uid ? { role: authorRole } : {}), suspended: data.suspended, displayName: data.displayName || 'ผู้ใช้', handle: data.handle || null, photoId: data.isGuest ? null : data.photoMediaId || null });
        }));
        const data = post.data();
        return res.status(200).json({
          post: { id: body.id, text: data.text, category: visibleCategory(data.category), media: data.media || [], ...people.get(data.uid), archived, likeCount: data.likeCount || 0, commentCount: data.commentCount || 0 },
          likes: likeList.docs.map(doc => people.get(doc.data().uid)),
          likesAfter: likeList.docs.length === 100 ? likeList.docs.at(-1).id : null,
          commentsAfter: commentList.hasMore ? commentList.docs.at(-1).id : null,
          focusedCommentFound:commentList.focusedFound,
          comments: commentList.docs.map(doc => {
            const comment=doc.data(),own=comment.uid===claims.uid,created=comment.createdAt?.toDate().getTime(),elapsed=serverNow-created;
            const remaining=own && !comment.deleted && !archived && Number.isFinite(created) && elapsed>=0 ? Math.max(0,300000-elapsed):0;
            const parentId=comment.parentId && commentList.allById.has(comment.parentId)?comment.parentId:null;
            return {id:doc.id,text:comment.deleted?'':comment.text,...(comment.deleted?{displayName:'คอมเมนต์ถูกลบแล้ว',handle:null,photoId:null}:people.get(comment.uid)),parentId,replyToId:comment.replyToId || null,replyTo:comment.replyToUid?people.get(comment.replyToUid):null,replyToDeleted:!!commentList.allById.get(comment.replyToId)?.data().deleted,deleted:comment.deleted===true,own:own && !comment.deleted,edited:comment.edited===true,canEdit:remaining>0,editRemainingMs:remaining,likeCount:comment.likeCount || 0,liked:commentLikes.get(doc.id),createdAt:comment.createdAt?.toDate().toISOString() || null};
          })
        });
      }
      if (body.action === 'profile-update') {
        const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
        const bio = typeof body.bio === 'string' ? body.bio.trim() : '';
        if (!displayName || displayName.length > 50 || bio.length > 300) throw fail(400, 'ชื่อไม่เกิน 50 ตัว และแนะนำตัวไม่เกิน 300 ตัว');
        const photoMediaId = body.photoMediaId === undefined ? member.data().photoMediaId || null : body.photoMediaId;
        if (body.completeProfile === true && (isGuest || !photoMediaId)) throw fail(400, 'กรุณาใส่รูปโปรไฟล์และชื่อเล่นก่อนเข้าฟีด');
        const completion = body.completeProfile === true ? { profileCompleted: true } : {};
        if (isGuest && photoMediaId) throw fail(403, 'บัญชี Guest ใช้รูปโปรไฟล์เริ่มต้น');
        let savedHandle = member.data().handle || null;
        let savedLimits = {};
        await db.runTransaction(async tx => {
          const current = await tx.get(profileRef);
          const previousHandle = current.data().handle || null;
          const creating = body.completeProfile === true;
          const changingHandle = !isGuest && Object.hasOwn(body, 'handle');
          const handle = creating || changingHandle ? normalizeUsername(body.handle, true) : previousHandle;
          if ((creating || changingHandle) && !handle) throw fail(400, 'มีตัวอักษรอังกฤษและตัวเลขอย่างน้อยอย่างละ 1 ตัว ใช้ _ . ^ ได้');
          const now = Date.now();
          const changedHandle = handle !== previousHandle;
          const handleAvailableAt = current.data().handleAvailableAt || 0;
          if (changedHandle && previousHandle && now < handleAvailableAt) throw fail(429, '@username เปลี่ยนได้อีกครั้งวันที่ ' + new Date(handleAvailableAt).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }));
          const resetAt = current.data().nicknameResetAt || 0;
          let nicknameChanges = resetAt && now >= resetAt ? 0 : current.data().nicknameChanges || 0;
          let nicknameResetAt = resetAt && now >= resetAt ? 0 : resetAt;
          const initialSetup = creating && current.data().profileCompleted !== true;
          if (displayName !== current.data().displayName && !initialSetup) {
            if (nicknameChanges >= 3 && now < nicknameResetAt) throw fail(429, 'ชื่อเล่นเปลี่ยนได้อีกครั้งวันที่ ' + new Date(nicknameResetAt).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }));
            nicknameChanges++;
            if (nicknameChanges === 3) nicknameResetAt = now + 7 * 24 * 60 * 60 * 1000;
          }
          savedLimits = { handleAvailableAt: changedHandle && previousHandle ? nextMonth(now) : handleAvailableAt, nicknameChanges, nicknameResetAt };
          const nameRef = (creating || changingHandle) ? db.collection('handles').doc(handle) : null;
          const mapping = nameRef ? await tx.get(nameRef) : null;
          if (mapping?.exists && mapping.data().uid !== claims.uid) throw fail(409, '@username นี้มีผู้ใช้แล้ว กรุณาเลือกชื่ออื่น');
          const oldNameRef = (creating || changingHandle) && previousHandle && previousHandle !== handle ? db.collection('handles').doc(previousHandle) : null;
          const oldMapping = oldNameRef ? await tx.get(oldNameRef) : null;
          let photoRef = null;
          if (photoMediaId) {
            if (typeof photoMediaId !== 'string' || !/^[a-f0-9-]{36}$/.test(photoMediaId)) throw fail(400, 'รูปโปรไฟล์ไม่ถูกต้อง');
            photoRef = db.collection('media').doc(photoMediaId);
            const photo = await tx.get(photoRef);
            if (!photo.exists || photo.data().uid !== claims.uid || !photo.data().type?.startsWith('image/') || photo.data().size > 5 * 1024 * 1024 || photo.data().postId) throw fail(400, 'ใช้รูปที่อัปโหลดเองไม่เกิน 5 MB และยังไม่ได้ใช้ในโพสต์');
          }
          if (nameRef && !mapping.exists) tx.create(nameRef, { uid: claims.uid });
          if (oldMapping?.exists && oldMapping.data().uid === claims.uid) tx.delete(oldNameRef);
          if (photoRef) tx.update(photoRef, { profileUsed: true });
          const identity = (creating || changingHandle) ? { handle } : {};
          tx.update(profileRef, { ...completion, ...identity, ...savedLimits, displayName, bio, photoMediaId: isGuest ? null : photoMediaId });
          savedHandle = handle;
        });
        return res.status(200).json({ ...member.data(), ...await permissions(db,claims.uid), ...completion, ...savedLimits, handle: savedHandle, displayName, bio, photoMediaId: isGuest ? null : photoMediaId });
      }
      if (body.action === 'post-archive' || body.action === 'post-restore') {
        if (typeof body.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.id)) throw fail(400, 'โพสต์ไม่ถูกต้อง');
        const publicRef = db.collection('posts').doc(body.id);
        const privateRef = archive.doc(body.id);
        const restoring = body.action === 'post-restore';
        await db.runTransaction(async tx => {
          const source = restoring ? privateRef : publicRef;
          const target = restoring ? publicRef : privateRef;
          const post = await tx.get(source);
          if (!post.exists) throw fail(404, 'ไม่พบโพสต์');
          if (post.data().uid !== claims.uid) throw fail(403, 'จัดการได้เฉพาะโพสต์ของตัวเอง');
          if(post.data().category==='ประกาศ' && !['dev','admin'].includes(await roleFor(db,claims.uid,tx)))throw fail(403,'เฉพาะ Admin และ Dev เท่านั้นที่โพสต์ประกาศได้');
          if (restoring && isGuest && post.data().category !== 'ถาม-ตอบ') throw fail(403, 'หากต้องการ Post หมวดหมู่ที่ถูกล็อกไว้ กรุณา Login');
          tx.create(target, { ...post.data(), category:visibleCategory(post.data().category), ...(restoring ? {saveVersion:randomUUID()} : {}), hashtags: extractHashtags(post.data().text || '') });
          tx.delete(source);
        });
        return res.status(200).json({ saved: true });
      }
      if (['posts-list', 'my-posts', 'archive-list', 'author-profile', 'saved-list'].includes(body.action)) {
        let viewedAuthor = null, authorId = null;
        if (body.action === 'author-profile') {
          if (body.handle !== undefined) {
            const handle = normalizeUsername(body.handle);
            if (!handle) throw fail(400, 'กรุณาพิมพ์ @username ที่ต้องการค้นหา');
            const mapping = await db.collection('handles').doc(handle).get();
            if (!mapping.exists) throw fail(404, 'ไม่พบโปรไฟล์');
            authorId = mapping.data().uid;
          } else {
            if (typeof body.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.id)) throw fail(400, 'โพสต์ไม่ถูกต้อง');
            let source = await db.collection('posts').doc(body.id).get();
            if (!source.exists) source = await archive.doc(body.id).get();
            if (!source.exists || !source.data().uid) throw fail(404, 'ไม่พบโพสต์');
            authorId = source.data().uid;
          }
          const author = await db.collection('users').doc(authorId).get();
          if (!author.exists) throw fail(404, 'ไม่พบโปรไฟล์');
          const person = author.data();
          if (body.handle !== undefined && (person.isGuest || person.profileCompleted !== true || person.handle !== normalizeUsername(body.handle))) throw fail(404, 'ไม่พบโปรไฟล์');
          const visible = await publicPerson(authorId, person);
          const access=await permissions(db,claims.uid),targetRole=await assignedRole(db,authorId);
          viewedAuthor = { suspended:visible.suspended, role:targetRole, ...(access.canModerate && authorId!==claims.uid ? {management:{targetUid:authorId,canManageRoles:access.canManageRoles && targetRole!=='dev' && !person.isGuest,canGrantMerchant:access.canGrantMerchant && !targetRole && !person.isGuest,canBan:targetRole!=='dev',banned:visible.suspended}} : {}), displayName: visible.displayName || 'ผู้ใช้', handle: visible.handle || null, bio: visible.bio || '', photoMediaId: visible.isGuest ? null : visible.photoMediaId || null };
        }
        const filter = body.action === 'posts-list' ? body.category || 'ทั้งหมด' : 'ทั้งหมด';
        if (filter !== 'ทั้งหมด' && !categories.includes(filter)) throw fail(400, 'หมวดหมู่ไม่ถูกต้อง');
        const hashtag = body.hashtag === undefined ? null : normalizeHashtag(body.hashtag);
        if (body.action === 'posts-list' && body.hashtag !== undefined && !hashtag) throw fail(400, 'แฮชแท็กไม่ถูกต้อง');
        const query = body.action === 'posts-list' && hashtag ? db.collection('posts').where('hashtags', 'array-contains', hashtag) : body.action === 'author-profile' ? db.collection('posts').where('uid', '==', authorId) : body.action === 'archive-list' ? archive.limit(100) : body.action === 'my-posts' ? db.collection('posts').where('uid', '==', claims.uid).limit(100) : filter === 'ทั้งหมด' ? db.collection('posts').orderBy('createdAt', 'desc').limit(50) : db.collection('posts').where('category', '==', filter);
        let snapshot = body.action === 'saved-list' ? await savedPosts(db,claims.uid) : await query.get();
        if(body.action==='posts-list' && filter==='ทั่วไป' && !hashtag){
          const legacy=await db.collection('posts').where('category','==','แจ้งเตือนด่วน').get();
          snapshot={docs:[...snapshot.docs,...legacy.docs]};
        }
        let announcements;
        if(body.action==='posts-list'){
          const announcementDocs=filter==='ประกาศ' && !hashtag?snapshot:await db.collection('posts').where('category','==','ประกาศ').get();
          announcements=announcementDocs.docs.map(doc=>({id:doc.id,text:doc.data().text || '',createdAt:doc.data().createdAt?.toDate().toISOString() || null})).sort((a,b)=>(b.createdAt || '').localeCompare(a.createdAt || '')).slice(0,5);
        }
        const authors = new Map();
        await Promise.all([...new Set(snapshot.docs.map(doc => doc.data().uid))].filter(Boolean).map(async uid => {
          const author = uid === claims.uid ? member : await db.collection('users').doc(uid).get();
          const visible = await publicPerson(uid, author.exists ? author.data() : {});
          const authorRole = author.exists && !visible.isGuest && !visible.suspended ? await roleFor(db,uid) : null;
          authors.set(uid, { ...visible, authorRole });
        }));
        const access=await permissions(db,claims.uid);
        const ownLikes = new Map(), ownSaved = new Map();
        await Promise.all(snapshot.docs.map(async doc => { ownLikes.set(doc.id, (await db.collection('posts').doc(doc.id).collection('likes').doc(claims.uid).get()).exists); }));
        await Promise.all(snapshot.docs.map(async doc=>{const bookmark=await profileRef.collection('saved').doc(doc.id).get();ownSaved.set(doc.id,bookmark.exists && bookmark.data().saveVersion === (doc.data().saveVersion || 'initial'));}));
        const posts = snapshot.docs.filter(doc => !hashtag || filter === 'ทั้งหมด' || visibleCategory(doc.data().category) === filter).map(doc => {
          const post = doc.data();
          return { id: doc.id, suspended:authors.get(post.uid)?.suspended || false, canDelete:access.canModerate, saved: ownSaved.get(doc.id) || false, likeCount: post.likeCount || 0, commentCount: post.commentCount || 0, liked: ownLikes.get(doc.id) || false, text: post.text, category: visibleCategory(post.category), displayName: authors.get(post.uid)?.displayName || post.displayName, authorHandle: authors.get(post.uid)?.handle || null, authorRole: authors.get(post.uid)?.authorRole || null, authorPhotoId: authors.get(post.uid)?.isGuest ? null : authors.get(post.uid)?.photoMediaId || null, own: post.uid === claims.uid, media: post.media || [], createdAt: post.createdAt?.toDate().toISOString() || null };
        }).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        return res.status(200).json({ ...(viewedAuthor ? { profile: viewedAuthor } : {}), ...(announcements ? {announcements} : {}), posts: body.action === 'posts-list' ? posts.slice(0, 50) : viewedAuthor ? posts.slice(0, 100) : posts });
      }
      const category = body.category;
      if (!categories.includes(category)) throw fail(400, 'กรุณาเลือกหมวดหมู่โพสต์');
      if (isGuest && category !== 'ถาม-ตอบ') throw fail(403, 'หากต้องการ Post หมวดหมู่ที่ถูกล็อกไว้ กรุณา Login');
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      const mediaIds = body.mediaIds || [];
      if (!Array.isArray(mediaIds) || mediaIds.length > 4 || new Set(mediaIds).size !== mediaIds.length || mediaIds.some(id => typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id))) throw fail(400, 'แนบไฟล์ได้ไม่เกิน 4 ไฟล์');
      if ((!text && !mediaIds.length) || text.length > 5000) throw fail(400, 'กรุณาพิมพ์ข้อความไม่เกิน 5,000 ตัวอักษร');
      const ref = db.collection('posts').doc();
      let postAvailableAt, postCooldownExempt;
      await db.runTransaction(async tx => {
        const current = await tx.get(profileRef);
        const currentRole=await roleFor(db,claims.uid,tx);
        if(category==='ประกาศ' && (isGuest || !['dev','admin'].includes(currentRole)))throw fail(403,'เฉพาะ Admin และ Dev เท่านั้นที่โพสต์ประกาศได้');
        postCooldownExempt = !isGuest && ['dev','admin','merchant'].includes(currentRole);
        const now = Date.now();
        const availableAt = current.data().postAvailableAt || 0;
        if (!postCooldownExempt && now < availableAt) {
          const retryAfter = Math.ceil((availableAt - now) / 1000);
          throw Object.assign(fail(429, 'กรุณารออีก ' + retryAfter + ' วินาทีก่อนโพสต์ถัดไป'), { retryAfter });
        }
        const refs = mediaIds.map(id => db.collection('media').doc(id));
        const attachments = await Promise.all(refs.map(item => tx.get(item)));
        if (attachments.some(item => !item.exists || item.data().uid !== claims.uid || item.data().postId || item.data().profileUsed)) throw fail(403, 'ไฟล์แนบไม่ใช่ของคุณ หรือใช้ในโพสต์แล้ว');
        const media = attachments.map((item, index) => ({ id: mediaIds[index], type: item.data().type, size: item.data().size }));
        if (media.reduce((sum, item) => sum + item.size, 0) > 50 * 1024 * 1024) throw fail(400, 'ขนาดไฟล์รวมต้องไม่เกิน 50 MB');
        postAvailableAt = now + 60000;
        tx.create(ref, { text, saveVersion: randomUUID(), hashtags: extractHashtags(text), category, media, uid: claims.uid, displayName: current.data().displayName, createdAt: FieldValue.serverTimestamp() });
        for (const item of refs) tx.update(item, { postId: ref.id });
        tx.update(profileRef, { postAvailableAt });
      });
      return res.status(201).json({ id: ref.id, postAvailableAt: postCooldownExempt ? 0 : postAvailableAt, postCooldownExempt });
    }
    if (body.action === 'profile-read') {
      const profile = await profileRef.get();
      if (!profile.exists || (!isGuest && (profile.data().isGuest || (!profile.data().username && !profile.data().email)))) {
        throw fail(404, 'บัญชีนี้ไม่มีข้อมูลในระบบ กรุณาสมัครเพื่อเข้าสู่ระบบ');
      }
      return res.status(200).json({...profile.data(),...await permissions(db,claims.uid)});
    }
    const username = normalizeUsername(body.username);
    const emailOnly = body.emailOnly === true && !isGuest;
    if (emailOnly && (!claims.email || claims.email_verified !== true)) throw fail(400, 'กรุณาเลือกบัญชี Google เพื่อยืนยัน Email ก่อน');
    const result = await db.runTransaction(async tx => {
      const existing = await tx.get(profileRef);
      if (existing.exists) return existing.data();
      if (!isGuest && !emailOnly && !body.username) return { needsUsername: true };
      if (!isGuest && !emailOnly && !username) throw fail(400, 'มีตัวอักษรอังกฤษและตัวเลขอย่างน้อยอย่างละ 1 ตัว ใช้ _ . ^ ได้');
      if (!isGuest && !emailOnly) {
        const nameRef = db.collection('usernames').doc(username);
        const taken = await tx.get(nameRef);
        if (taken.exists) throw fail(409, 'Username นี้มีผู้ใช้แล้ว กรุณาเลือกชื่ออื่น');
        tx.create(nameRef, { uid: claims.uid });
      }
      const profile = {
        uid: claims.uid, username: isGuest || emailOnly ? null : username,
        displayName: isGuest ? guestName() : emailOnly ? claims.name || claims.email.split('@')[0] : username,
        accountType: isGuest ? 'guest' : emailOnly ? 'email' : 'member',
        email: isGuest ? null : claims.email || null, isGuest,
        googleName: isGuest ? null : claims.name || null,
        photoURL: isGuest ? null : claims.picture || null
      };
      tx.create(profileRef, { ...profile, createdAt: FieldValue.serverTimestamp() });
      return profile;
    });
    return res.status(200).json({...result,...await permissions(db,claims.uid)});
  } catch (error) {
    if (error instanceof SyntaxError) return res.status(400).json({ message: 'คำขอไม่ถูกต้อง' });
    if (error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
    return res.status(error.status || 503).json({ ...(error.code==='ACCOUNT_BANNED' ? {code:error.code} : {}), ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}), message: error.status ? error.message : 'ระบบยังไม่พร้อม กรุณาตรวจสอบการตั้งค่า Firebase ฝั่งเซิร์ฟเวอร์แล้วลองอีกครั้ง' });
  }
}



export { services };

