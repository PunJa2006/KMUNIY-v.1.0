import {randomUUID} from 'node:crypto';
export const moderationActions = ['moderation-confirm','role-grant','role-revoke','user-ban','user-unban','restricted-list','restricted-remove'];
export async function assignedRole(db, uid, tx = null) {
  const read = ref => tx ? tx.get(ref) : ref.get();
  const [config,role] = await Promise.all([read(db.collection('settings').doc('moderation')),read(db.collection('roles').doc(uid))]);
  if(config.exists && config.data().developerUid===uid)return 'dev';
  return role.exists && ['admin','merchant'].includes(role.data().role) ? role.data().role : null;
}
export async function roleFor(db,uid,tx=null){
  const ref=db.collection('restrictions').doc(uid),restriction=tx?await tx.get(ref):await ref.get();
  if(restriction.exists && restriction.data().banned)return null;
  return assignedRole(db,uid,tx);
}
export async function banned(db,uid) {
  const restriction=await db.collection('restrictions').doc(uid).get();
  return restriction.exists && restriction.data().banned===true;
}
export async function reportAccess(db,uid,role=undefined){
  if(role===undefined)role=await roleFor(db,uid);
  if(['dev','admin'].includes(role))return true;
  const config=await db.collection('settings').doc('moderation').get();
  return !!(config.exists && config.data().reportRecipientUid===uid && !await banned(db,uid));
}
export async function permissions(db,uid) {
  const role=await roleFor(db,uid);
  return {role,canReceiveReports:await reportAccess(db,uid,role),canModerate:['dev','admin'].includes(role),canManageRoles:role==='dev',canGrantMerchant:['dev','admin'].includes(role),postCooldownExempt:['dev','admin','merchant'].includes(role)};
}
export async function consumeConfirmation({db,tx,body,uid,operation,target,fail}) {
  if(typeof body.confirmation!=='string' || !/^[a-f0-9-]{36}$/.test(body.confirmation))throw fail(400,'กรุณายืนยันรายการก่อน');
  const ref=db.collection('moderationConfirmations').doc(body.confirmation),snap=await tx.get(ref);
  const now=snap.readTime?.toMillis() ?? Date.now(),value=snap.data();
  const created=value?.createdAt?.toDate().getTime();
  if(!snap.exists || value.uid!==uid || value.operation!==operation || value.target!==target || !Number.isFinite(created) || now-created>300000)throw fail(400,'การยืนยันหมดอายุ กรุณาลองใหม่');
  if(now-created<3000)throw fail(409,'กรุณารอให้ครบ 3 วินาที');
  // Caller deletes this single-use token after completing all transaction reads.
  return ref;
}
export async function handleModeration({body,db,claims,fail,FieldValue}) {
  if(!moderationActions.includes(body.action))return null;
  const uid=claims.uid,role=await roleFor(db,uid);
  if(!['dev','admin'].includes(role))throw fail(403,'คุณไม่มีสิทธิ์จัดการผู้ใช้');
  if(body.action==='restricted-list') {
    const records=await db.collection('restrictions').where('listed','==',true).get();
    const users=await Promise.all(records.docs.map(async doc=>{
      const person=await db.collection('users').doc(doc.id).get();
      if(!person.exists || !doc.data().banned)return null;
      return {uid:doc.id,displayName:person.data().displayName,handle:person.data().handle || null,banned:true,reason:doc.data().reason || ''};
    }));
    return {status:200,body:{users:users.filter(Boolean)}};
  }
  if(body.action==='moderation-confirm') {
    const target=body.operation==='post-delete' ? body.id : body.targetUid;
    if(!['user-ban','restricted-remove','post-delete'].includes(body.operation) || typeof target!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(target))throw fail(400,'คำขอไม่ถูกต้อง');
    const confirmation=randomUUID();
    await db.runTransaction(async tx=>{
      if(!['dev','admin'].includes(await roleFor(db,uid,tx)))throw fail(403,'คุณไม่มีสิทธิ์จัดการผู้ใช้');
      tx.set(db.collection('moderationConfirmations').doc(confirmation),{uid,operation:body.operation,target,createdAt:FieldValue.serverTimestamp()});
    });
    return {status:201,body:{confirmation,waitSeconds:3}};
  }
  let reason='';
  if(body.action==='user-ban'){if(body.reason!==undefined && typeof body.reason!=='string')throw fail(400,'เหตุผลการแบนไม่ถูกต้อง');reason=(body.reason || '').trim();if(reason.length>2000)throw fail(400,'เหตุผลการแบนต้องไม่เกิน 2,000 ตัวอักษร');}
  const target=body.targetUid;
  if(typeof target!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(target) || target===uid)throw fail(400,'จัดการบัญชีของตัวเองไม่ได้');
  await db.runTransaction(async tx=>{
    const actorRole=await roleFor(db,uid,tx);
    if(!['dev','admin'].includes(actorRole))throw fail(403,'คุณไม่มีสิทธิ์จัดการผู้ใช้');
    const config=await tx.get(db.collection('settings').doc('moderation'));
    if(config.exists && (config.data().developerUid || config.data().reportRecipientUid)===target)throw fail(403,'จัดการบัญชี Dev ไม่ได้');
    const person=await tx.get(db.collection('users').doc(target));
    if(!person.exists)throw fail(404,'ไม่พบโปรไฟล์');
    const restrictionRef=db.collection('restrictions').doc(target),previous=await tx.get(restrictionRef);
    let confirmationRef=null;
    if(['user-ban','restricted-remove'].includes(body.action))confirmationRef=await consumeConfirmation({db,tx,body,uid,operation:body.action,target,fail});
    if(['role-grant','role-revoke'].includes(body.action)) {
      const givingMerchant=body.action==='role-grant' && body.role==='merchant';
      if(actorRole!=='dev' && !(actorRole==='admin' && givingMerchant))throw fail(403,'เฉพาะ Dev เท่านั้นที่จัดการยศได้');
      if(actorRole==='admin' && ![null,'merchant'].includes(await assignedRole(db,target,tx)))throw fail(403,'Admin ให้ยศพ่อค้าแม่ค้าได้เฉพาะผู้ใช้ทั่วไป');
      if(person.data().isGuest)throw fail(400,'ให้ยศได้เฉพาะบัญชีสมาชิก');
      if(body.action==='role-grant'){
        const grantedRole=body.role ?? 'admin';
        if(!['admin','merchant'].includes(grantedRole))throw fail(400,'ยศไม่ถูกต้อง');
        tx.set(db.collection('roles').doc(target),{role:grantedRole,grantedBy:uid,updatedAt:FieldValue.serverTimestamp()});
      }
      else tx.delete(db.collection('roles').doc(target));
    }else if(body.action==='user-ban') {
      tx.set(restrictionRef,{banned:true,listed:true,reason,by:uid,createdAt:FieldValue.serverTimestamp()});
    }else if(body.action==='user-unban') {
      tx.set(restrictionRef,{banned:false,listed:false,by:uid,updatedAt:FieldValue.serverTimestamp()});
    }else if(body.action==='restricted-remove') {
      if(!previous.exists || !previous.data().banned)throw fail(404,'ไม่พบรายชื่อผู้ใช้ที่ถูกจำกัด');
      tx.update(restrictionRef,{listed:false});
    }
    if(confirmationRef)tx.delete(confirmationRef);
  });
  return {status:200,body:{updated:true}};
}
