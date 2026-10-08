import {roleFor,consumeConfirmation,reportAccess} from './moderation.js';
import {createHash,randomUUID} from 'node:crypto';
import {extractHashtags} from '../public/hashtags.js';
import {removeMediaFiles} from './media-storage.js';
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const validMedia = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
export async function moderationAccess(db, uid) { return await reportAccess(db,uid); }
export async function savedPosts(db, uid) {
  const entries = await db.collection('users').doc(uid).collection('saved').orderBy('savedAt','desc').get();
  const docs = await Promise.all(entries.docs.map(async entry => {
    if(!validId(entry.id))return null;
    const postRef = db.collection('posts').doc(entry.id);
    const savedRef = db.collection('users').doc(uid).collection('saved').doc(entry.id);
    const matches = (post, bookmark) => post.exists && bookmark.exists && post.data().uid !== uid && bookmark.data().saveVersion === (post.data().saveVersion || 'initial');
    const post = await postRef.get();
    if(matches(post,entry))return post;
    return db.runTransaction(async tx => {
      const [current,bookmark] = await Promise.all([tx.get(postRef),tx.get(savedRef)]);
      if(matches(current,bookmark))return current;
      if(bookmark.exists)tx.delete(savedRef);
      return null;
    });
  }));
  return {docs:docs.filter(Boolean).slice(0,100)};
}
export async function handlePostAction({body,db,claims,member,archive,fail,FieldValue,throttle,removeFiles=removeMediaFiles}) {
  const action = body.action;
  if(!['post-update','post-delete','post-save','report-create','usage-report-create','contact-admin-create','reports-list','report-delete'].includes(action))return null;
  if(action==='reports-list') {
    if(!await moderationAccess(db,claims.uid))throw fail(403,'คุณไม่มีสิทธิ์เปิดกล่องรับรายงาน');
    const role=await roleFor(db,claims.uid),category=body.category;
    if(category!==undefined && !['post','comment','appeal','general','usage'].includes(category))throw fail(400,'หมวดหมู่รายงานไม่ถูกต้อง');
    if(category==='usage' && role!=='dev')throw fail(403,'เฉพาะ Dev เท่านั้นที่เปิดรายงานปัญหาการใช้งานได้');
    const config=await db.collection('settings').doc('moderation').get();
    const recipient=config.exists && (config.data().reportRecipientUid || config.data().developerUid);
    if(!recipient)throw fail(503,'ยังไม่ได้ตั้งค่าผู้รับรายงาน');
    const collection=db.collection('users').doc(recipient).collection('reports');
    const docs=[];let cursor=null;
    // Filter before applying the visible limit, including legacy post reports.
    while(docs.length<100){
      let query=collection.orderBy('createdAt','desc');if(cursor)query=query.startAfter(cursor);
      const page=await query.limit(100).get();
      for(const doc of page.docs){
        const value=doc.data(),kind=value.kind || (value.comment?'comment':'post');
        if(kind==='usage' && role!=='dev')continue;
        if(category!==undefined && kind!==category)continue;
        docs.push(doc);if(docs.length===100)break;
      }
      if(page.docs.length<100)break;
      cursor=page.docs.at(-1);
    }
    return {status:200,body:{reports:docs.map(doc=>{
      const report=doc.data();
      return {id:doc.id,kind:report.kind || (report.comment?'comment':'post'),...(report.comment?{comment:report.comment}:{}),reason:report.reason,details:report.details,reporter:report.reporter,post:report.post,createdAt:report.createdAt?.toDate().toISOString() || null};
    })}};
  }
  if(action==='report-delete') {
    if(!validId(body.id))throw fail(400,'รายงานไม่ถูกต้อง');
    await db.runTransaction(async tx=>{
      const role=await roleFor(db,claims.uid,tx);
      if(!['dev','admin'].includes(role))throw fail(403,'คุณไม่มีสิทธิ์จัดการรายงาน');
      const config=await tx.get(db.collection('settings').doc('moderation'));
      const recipient=config.exists && (config.data().reportRecipientUid || config.data().developerUid);
      if(!recipient)throw fail(503,'ยังไม่ได้ตั้งค่าผู้รับรายงาน');
      // This operation touches only the shared report record, never the post.
      const reportRef=db.collection('users').doc(recipient).collection('reports').doc(body.id);
      const report=await tx.get(reportRef);
      if(report.exists && report.data().kind==='usage' && role!=='dev')throw fail(403,'เฉพาะ Dev เท่านั้นที่เปิดรายงานปัญหาการใช้งานได้');
      tx.delete(reportRef);
    });
    return {status:200,body:{deleted:true}};
  }
  if(action==='usage-report-create' || action==='contact-admin-create') {
    const details=typeof body.details==='string' ? body.details.trim() : '';
    if(!details)throw fail(400,action==='contact-admin-create'?'กรุณาเขียนข้อความที่ต้องการติดต่อ':'กรุณาอธิบายปัญหาการใช้งาน');
    if(details.length>2000)throw fail(400,'อธิบายเพิ่มเติมได้ไม่เกิน 2,000 ตัวอักษร');
    const config=await db.collection('settings').doc('moderation').get();
    const recipient=config.exists && (config.data().reportRecipientUid || config.data().developerUid);
    if(!recipient)throw fail(503,'ยังไม่ได้ตั้งค่าผู้รับรายงาน');
    await throttle(db,'report:'+claims.uid,'ส่งรายงานถี่เกินไป กรุณารอ 15 นาที');
    const person=member.data();
    const reportRef=db.collection('users').doc(recipient).collection('reports').doc(randomUUID());
    let kind;
    await db.runTransaction(async tx=>{
      const restriction=await tx.get(db.collection('restrictions').doc(claims.uid));
      kind=restriction.exists && restriction.data().banned===true ? 'appeal' : action==='contact-admin-create' ? 'general' : 'usage';
      tx.create(reportRef,{kind,reason:kind,details,reporterUid:claims.uid,reporter:{displayName:person.displayName || 'ผู้ใช้',handle:person.handle || null},createdAt:FieldValue.serverTimestamp()});
    });
    return {status:201,body:{reported:true,kind}};
  }
  if(!validId(body.id))throw fail(400,'โพสต์ไม่ถูกต้อง');
  const publicRef = db.collection('posts').doc(body.id), privateRef = archive.doc(body.id);
  if(action==='post-save') {
    if(typeof body.saved !== 'boolean')throw fail(400,'คำขอไม่ถูกต้อง');
    const savedRef = db.collection('users').doc(claims.uid).collection('saved').doc(body.id);
    await db.runTransaction(async tx => {
      const [post,previous] = await Promise.all([tx.get(publicRef),tx.get(savedRef)]);
      if(!body.saved) { tx.delete(savedRef); return; }
      if(!post.exists)throw fail(404,'ไม่พบโพสต์ หรือโพสต์ถูกเก็บเข้าคลังแล้ว');
      if(post.data().uid===claims.uid)throw fail(400,'บันทึกได้เฉพาะโพสต์ของผู้ใช้คนอื่น');
      const saveVersion = post.data().saveVersion || 'initial';
      tx.set(savedRef,{postId:body.id,saveVersion,savedAt:previous.exists && previous.data().saveVersion===saveVersion ? previous.data().savedAt : FieldValue.serverTimestamp()});
    });
    return {status:200,body:{saved:body.saved}};
  }
  if(action==='report-create') {
    if(!['inappropriate','spam'].includes(body.reason))throw fail(400,'กรุณาเลือกหัวข้อรายงาน');
    const details = typeof body.details==='string' ? body.details.trim() : '';
    if(details.length>2000)throw fail(400,'อธิบายเพิ่มเติมได้ไม่เกิน 2,000 ตัวอักษร');
    const config = await db.collection('settings').doc('moderation').get();
    const recipientUid = config.exists && config.data().reportRecipientUid;
    if(!recipientUid)throw fail(503,'ยังไม่ได้ตั้งค่าผู้รับรายงาน');
    await throttle(db,'report:'+claims.uid,'ส่งรายงานถี่เกินไป กรุณารอ 15 นาที');
    const isComment=body.commentId!==undefined;
    if(isComment && !validId(body.commentId))throw fail(400,'คอมเมนต์ไม่ถูกต้อง');
    const reportId = createHash('sha256').update(body.id+'\0'+(isComment?body.commentId+'\0':'')+claims.uid).digest('hex');
    const reportRef = db.collection('users').doc(recipientUid).collection('reports').doc(reportId);
    await db.runTransaction(async tx => {
      const [post,previous,comment] = await Promise.all([tx.get(publicRef),tx.get(reportRef),isComment?tx.get(publicRef.collection('comments').doc(body.commentId)):null]);
      if(!post.exists)throw fail(404,'ไม่พบโพสต์ หรือโพสต์ถูกเก็บเข้าคลังแล้ว');
      if(isComment){
        if(!comment.exists || comment.data().deleted)throw fail(404,'ไม่พบคอมเมนต์');
        if(comment.data().uid===claims.uid)throw fail(400,'รายงานได้เฉพาะคอมเมนต์ของผู้ใช้คนอื่น');
      }else if(post.data().uid===claims.uid)throw fail(400,'รายงานได้เฉพาะโพสต์ของผู้ใช้คนอื่น');
      if(previous.exists)return;
      const data = post.data();
      const author = await tx.get(db.collection('users').doc(data.uid));
      const commentAuthor=isComment?await tx.get(db.collection('users').doc(comment.data().uid)):null;
      tx.create(reportRef,{kind:isComment?'comment':'post',...(isComment?{comment:{id:body.commentId,text:comment.data().text,displayName:commentAuthor.exists?commentAuthor.data().displayName:'ผู้ใช้',handle:commentAuthor.exists?commentAuthor.data().handle || null:null}}:{}),reporterUid:claims.uid,reporter:{displayName:member.data().displayName,handle:member.data().handle || null},reason:body.reason,details,
        post:{id:body.id,text:data.text,category:data.category || null,displayName:author.exists ? author.data().displayName : data.displayName,handle:author.exists ? author.data().handle || null : null},createdAt:FieldValue.serverTimestamp()});
    });
    return {status:201,body:{reported:true}};
  }
  let removedIds = [], deleteOwnArchive = false;
  await db.runTransaction(async tx => {
    removedIds = [];deleteOwnArchive = false;
    const [published,archived] = await Promise.all([tx.get(publicRef),tx.get(privateRef)]);
    const post = published.exists ? published : archived;
    if(!post.exists)throw fail(404,'ไม่พบโพสต์');
    const data = post.data();
    let confirmationRef=null;
    if(data.uid!==claims.uid){
      if(action!=='post-delete' || !published.exists || !['dev','admin'].includes(await roleFor(db,claims.uid,tx)))throw fail(403,'จัดการได้เฉพาะโพสต์ของตัวเอง');
      confirmationRef=await consumeConfirmation({db,tx,body,uid:claims.uid,operation:'post-delete',target:body.id,fail});
    }
    const oldIds = (data.media || []).map(item=>item.id).filter(validMedia);
    if(action==='post-delete') {
      deleteOwnArchive=data.uid===claims.uid;
      const refs = oldIds.map(id=>db.collection('media').doc(id));
      const media = await Promise.all(refs.map(ref=>tx.get(ref)));
      media.forEach((item,index)=>{if(item.exists && item.data().uid===data.uid && item.data().postId===body.id && !item.data().profileUsed){tx.delete(refs[index]);removedIds.push(oldIds[index]);}});
      tx.delete(publicRef); if(data.uid===claims.uid)tx.delete(privateRef);
      if(confirmationRef)tx.delete(confirmationRef);
      return;
    }
    if((body.category==='ประกาศ' || data.category==='ประกาศ') && !['dev','admin'].includes(await roleFor(db,claims.uid,tx)))throw fail(403,'เฉพาะ Admin และ Dev เท่านั้นที่โพสต์ประกาศได้');
    const text = typeof body.text==='string' ? body.text.trim() : '';
    if(!['ทั่วไป','ถาม-ตอบ','ขายของ','ของหาย','ประกาศ'].includes(body.category))throw fail(400,'กรุณาเลือกหมวดหมู่โพสต์');
    if(claims.firebase?.sign_in_provider==='anonymous' && !['ทั่วไป','ถาม-ตอบ'].includes(body.category))throw fail(403,'หากต้องการ Post หมวดหมู่ที่ถูกล็อกไว้ กรุณา Login');
    const ids = body.mediaIds === undefined ? oldIds : body.mediaIds;
    if(!Array.isArray(ids) || ids.length>4 || new Set(ids).size!==ids.length || ids.some(id=>!validMedia(id)))throw fail(400,'แนบไฟล์ได้ไม่เกิน 4 ไฟล์');
    if((!text && !ids.length) || text.length>5000)throw fail(400,'กรุณาพิมพ์ข้อความไม่เกิน 5,000 ตัวอักษร');
    const allIds = [...new Set([...oldIds,...ids])], refs = allIds.map(id=>db.collection('media').doc(id));
    const snapshots = await Promise.all(refs.map(ref=>tx.get(ref)));
    const mediaById = new Map(allIds.map((id,index)=>[id,snapshots[index]]));
    if(ids.some(id=>{const item=mediaById.get(id);return !item.exists || item.data().uid!==claims.uid || item.data().profileUsed || (item.data().postId && item.data().postId!==body.id);}))throw fail(403,'ไฟล์แนบไม่ใช่ของคุณ หรือใช้ในโพสต์แล้ว');
    const media = ids.map(id=>({id,type:mediaById.get(id).data().type,size:mediaById.get(id).data().size}));
    if(media.reduce((sum,item)=>sum+item.size,0)>50*1024*1024)throw fail(400,'ขนาดไฟล์รวมต้องไม่เกิน 50 MB');
    allIds.forEach((id,index)=>{
      if(ids.includes(id))tx.update(refs[index],{postId:body.id});
      else {const item=snapshots[index];if(item.exists && item.data().uid===claims.uid && item.data().postId===body.id && !item.data().profileUsed){tx.delete(refs[index]);removedIds.push(id);}}
    });
    tx.update(published.exists ? publicRef : privateRef,{text,category:body.category,hashtags:extractHashtags(text),media,updatedAt:FieldValue.serverTimestamp()});
  });
  await removeFiles(removedIds);
  if(action==='post-delete')await Promise.all([db.recursiveDelete(publicRef),...(deleteOwnArchive?[db.recursiveDelete(privateRef)]:[])]);
  return {status:200,body:action==='post-delete'?{deleted:true}:{updated:true}};
}
