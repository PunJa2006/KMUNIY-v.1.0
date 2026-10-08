import { uploadMedia, createLogoutConfirmation, connect, api, status, showError, t, localizeError, getLanguage, setLanguage, dateLocale, hashtagParts } from './shared.js';
import { createSearchHistory } from './search-history.js';
const $ = id => document.getElementById(id);
const personName = person => person?.suspended ? t('ผู้ใช้งานถูกระงับบัญชี') : person?.displayName || '';
let sdk, profile;
let view = 'home';
function updateAnnouncement() {
  $('university-announcement').hidden = view !== 'home';
  $('feed-heading').hidden = view === 'home';
}
updateAnnouncement();
let authorPostId = null, authorHandle = null, authorUid = null;
let selectedHashtag = null;
const authorUrls = [];
let selectedCategory = 'ทั้งหมด';
function closeFilter() {
  $('filter-dialog').close();
  $('toggle-filter').setAttribute('aria-expanded', 'false');
}
$('toggle-filter').addEventListener('click', () => {
  $('filter-dialog').showModal();
  $('toggle-filter').setAttribute('aria-expanded', 'true');
});
$('close-filter').addEventListener('click', closeFilter);
$('filter-dialog').addEventListener('close', () => {
  $('toggle-filter').setAttribute('aria-expanded', 'false');
});
const categoryButtons = { 'category-all': 'ทั้งหมด', 'category-general': 'ทั่วไป', 'category-qa': 'ถาม-ตอบ', 'category-market': 'ขายของ', 'category-lost': 'ของหาย', 'category-announcement': 'ประกาศ' };
for (const [id, category] of Object.entries(categoryButtons)) {
  $(id).addEventListener('click', () => {
    selectedCategory = category;
    closeFilter();
    $('toggle-filter').focus();
    for (const [buttonId, label] of Object.entries(categoryButtons)) $(buttonId).setAttribute('aria-pressed', String(label === selectedCategory));
    $('feed-heading').textContent = selectedCategory === 'ทั้งหมด' ? t('ฟีดโพสต์') : t('ฟีดโพสต์ · ') + t(selectedCategory);
    loadFeed();
  });
}
let loading = false, posting = false, editing = false, redirecting = false;
let feedVersion = 0, activeFeedMediaVersion = 0;
let homeFeed = null, homeFeedReady = false, homeScrollTop = 0;
const homeFeedKey = () => JSON.stringify([selectedCategory, selectedHashtag]);
function clearHomeFeed() {
  if (homeFeed) { releaseUrls(homeFeed.mediaUrls); releaseUrls(homeFeed.photoUrls); }
  homeFeed = null;
}
function rememberHomeFeed() {
  homeScrollTop = typeof window === 'undefined' ? 0 : window.scrollY;
  if (!homeFeedReady) return;
  homeFeed = {
    key: homeFeedKey(), nodes: [...$('feed').children],
    message: $('feed-status').textContent, version: activeFeedMediaVersion,
    mediaUrls: feedUrls, photoUrls: feedPhotoUrls
  };
  feedUrls = []; feedPhotoUrls = []; homeFeedReady = false;
}
function restoreHomeFeed() {
  if (!homeFeed || homeFeed.key !== homeFeedKey()) return false;
  feedVersion++;
  releaseUrls(feedUrls); releaseUrls(feedPhotoUrls);
  feedUrls = homeFeed.mediaUrls; feedPhotoUrls = homeFeed.photoUrls;
  activeFeedMediaVersion = homeFeed.version;
  postIdentityObserver?.disconnect();
  $('feed').replaceChildren(...homeFeed.nodes);
  for (const card of homeFeed.nodes) {
    for (const identity of card.querySelectorAll?.('.post-author-nickname, .post-author-handle') || []) postIdentityObserver?.observe(identity);
  }
  $('feed-status').textContent = homeFeed.message;
  $('feed-status').className = '';
  $('feed').setAttribute('aria-busy', 'false');
  homeFeed = null; homeFeedReady = true;
  return true;
}
let viewScrollVersion = 0;
function scrollView(top) {
  const version = ++viewScrollVersion;
  if (typeof window === 'undefined') return;
  const restore = () => {
    if (version === viewScrollVersion) window.scrollTo({top, left: 0, behavior: 'instant'});
  };
  restore();
  // Restore again after layout so browser scroll anchoring cannot shift the saved position.
  window.requestAnimationFrame?.(() => window.requestAnimationFrame(restore));
}
const postIdentityObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(entries => {
  for (const { target } of entries) target.dataset.clipped = String(target.scrollWidth > target.clientWidth + 1);
});
let postAvailableAt = 0, postCooldownTimer = null, editingPost = null;
let retainedMedia = [], postEditVersion = 0;
const postEditUrls = [];
function updatePostCooldown() {
  const remaining = profile?.postCooldownExempt === true ? 0 : Math.max(0, Math.ceil((postAvailableAt - Date.now()) / 1000));
  if (!editingPost && ($('post-status').textContent || '').startsWith(t('กรุณารออีก '))) $('post-status').textContent = remaining ? t('กรุณารออีก {seconds} วินาทีก่อนโพสต์ถัดไป', { seconds: remaining }) : '';
  $('submit-post').disabled = posting || (!editingPost && remaining > 0);
  $('submit-post').textContent = editingPost ? t('บันทึก') : remaining ? t('โพสต์ได้ใน {seconds} วินาที', { seconds: remaining }) : t('โพสต์');
  if (!remaining && postCooldownTimer !== null) { clearInterval(postCooldownTimer); postCooldownTimer = null; }
  return editingPost ? 0 : remaining;
}
function setPostCooldown(availableAt) {
  postAvailableAt = availableAt || 0;
  if (postCooldownTimer !== null) { clearInterval(postCooldownTimer); postCooldownTimer = null; }
  if (updatePostCooldown()) postCooldownTimer = setInterval(updatePostCooldown, 1000);
}
let selectedPhoto = null, uploadedPhotoId = null, photoPreviewUrl = null;
const profileUrls = [], editPhotoUrls = [];
let feedPhotoUrls = [];
const avatarLoads = new WeakMap();
async function loadAvatar(image, id, urls) {
  const version = Symbol();
  avatarLoads.set(image, version);
  image.src = 'default-avatar.svg';
  if (!id) return;
  try {
    const response = await fetch('/api/media?id=' + encodeURIComponent(id), { headers: { Authorization: 'Bearer ' + await sdk.auth.currentUser.getIdToken() } });
    if (!response.ok) return;
    const blob = await response.blob();
    if (avatarLoads.get(image) !== version) return;
    const url = URL.createObjectURL(blob); urls.push(url); image.src = url;
  } catch {}
}
function clearPhotoDraft(clearInput = true) {
  if (photoPreviewUrl) URL.revokeObjectURL(photoPreviewUrl);
  photoPreviewUrl = null; selectedPhoto = null; uploadedPhotoId = null;
  if (clearInput) $('edit-photo').value = '';
  releaseUrls(editPhotoUrls);
}
$('edit-photo-picker').addEventListener('click', () => {
  if (editing || profile?.isGuest) return;
  $('edit-photo').click();
});
$('edit-photo').addEventListener('change', () => {
  const file = $('edit-photo').files[0];
  clearPhotoDraft(false);
  if (!file) return;
  if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
    $('edit-status').textContent = t('เลือกรูป JPG, PNG, GIF หรือ WebP ไม่เกิน 5 MB');
    loadAvatar($('photo-preview'), profile.photoMediaId, editPhotoUrls);
    return;
  }
  avatarLoads.set($('photo-preview'), Symbol());
  selectedPhoto = file;
  photoPreviewUrl = URL.createObjectURL(file);
  $('photo-preview').src = photoPreviewUrl;
  $('remove-photo').checked = false;
  $('edit-status').textContent = '';
});
$('remove-photo').addEventListener('change', () => {
  clearPhotoDraft();
  loadAvatar($('photo-preview'), $('remove-photo').checked ? null : profile.photoMediaId, editPhotoUrls);
});
let selectedFiles = [], uploadedFiles = [], previewUrls = [], feedUrls = [];
function releaseUrls(urls) { for (const url of urls) URL.revokeObjectURL(url); urls.length = 0; }
function resetFiles(clearInput = true) {
  releaseUrls(previewUrls);
  selectedFiles = []; uploadedFiles = [];
  if (clearInput) $('post-files').value = '';
  $('media-preview').replaceChildren();
}
function mediaElement(type) {
  const element = document.createElement(type.startsWith('video/') ? 'video' : 'img');
  element.className = 'post-media';
  if (type.startsWith('video/')) { element.controls = true; element.preload = 'metadata'; }
  else element.alt = t('รูปภาพแนบในโพสต์');
  return element;
}
async function loadMedia(item, container, version) {
  try {
    const response = await fetch('/api/media?id=' + encodeURIComponent(item.id), { headers: { Authorization: 'Bearer ' + await sdk.auth.currentUser.getIdToken() } });
    if (!response.ok) throw new Error(t('โหลดไฟล์แนบไม่ได้'));
    const blob = await response.blob();
    const urls = version === activeFeedMediaVersion ? feedUrls : homeFeed?.version === version ? homeFeed.mediaUrls : null;
    if (!urls) return;
    const url = URL.createObjectURL(blob);
    urls.push(url);
    const media = mediaElement(item.type);
    media.src = url;
    container.replaceChildren(media);
    container.setAttribute('aria-busy', 'false');
  } catch { if (version === activeFeedMediaVersion || homeFeed?.version === version) { container.setAttribute('aria-busy', 'false'); container.textContent = t('โหลดไฟล์แนบไม่ได้ กรุณารีเฟรชอีกครั้ง'); } }
}
$('post-files').addEventListener('change', () => {
  const files = [...$('post-files').files];
  const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm'];
  if (files.length + retainedMedia.length > 4 || files.reduce((sum, file) => sum + file.size, 0) + retainedMedia.reduce((sum,item)=>sum+item.size,0) > 50 * 1024 * 1024 || files.some(file => !allowed.includes(file.type))) {
    resetFiles();
    $('post-status').textContent = t('เลือกไฟล์ที่รองรับไม่เกิน 4 ไฟล์ รวมไม่เกิน 50 MB');
    return;
  }
  resetFiles(false);
  selectedFiles = files;
  $('post-status').textContent = '';
  for (const file of files) {
    const media = mediaElement(file.type);
    const url = URL.createObjectURL(file);
    previewUrls.push(url); media.src = url;
    $('media-preview').append(media);
  }
});
$('clear-files').addEventListener('click', resetFiles);
const call = async (action, data = {}) => {
  try{return await api(action,data,sdk.auth.currentUser);}
  catch(error){if(error.code==='ACCOUNT_BANNED' && !redirecting){redirecting=true;$('app').hidden=true;location.replace('/?banned=1');}throw error;}
};
function isStaff(){return !!(profile?.canModerate ?? profile?.canReceiveReports);}
function roleBadge(element,role){
  element.textContent=role==='dev'?'Dev':role==='admin'?'Admin':role==='merchant'?t('Trader'):'';
  element.hidden=!element.textContent; element.dataset.role=element.hidden?'':role;
  if(role==='dev'){
    const label=document.createElement('span');label.className='role-label';label.textContent='Dev';element.replaceChildren(label);
  }
}
function updatePermissions(){
  updatePostCategories();
  $('admin-menu').hidden=!(profile.canReceiveReports || isStaff());
  $('open-reports').hidden=!profile.canReceiveReports;
  $('open-restricted').hidden=!isStaff();roleBadge($('my-role'),profile.role);
  setPostCooldown(profile.postAvailableAt);
  if(updateReportCategories() && $('reports-dialog').open)loadReports();
}
async function refreshPermissions(){
  if(!sdk?.auth.currentUser || !profile || redirecting)return;
  try{const fresh=await call('profile-read');Object.assign(profile,fresh);updatePermissions();}catch(error){if(error.code!=='ACCOUNT_BANNED')showError(error);}
}
function themeKey() { return `community-theme:${sdk.auth.currentUser.uid}`; }
function setTheme(theme, remember = false) {
  document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
  for (const value of ['light', 'dark']) $('theme-' + value).setAttribute('aria-pressed', String(value === document.documentElement.dataset.theme));
  if (remember) try { localStorage.setItem('community-last-theme', document.documentElement.dataset.theme); } catch {}
}
function updatePostCategories() {
  const guest = sdk?.auth.currentUser?.isAnonymous === true;
  for (const id of ['post-category-placeholder', 'post-category-market', 'post-category-lost']) $(id).disabled = guest;
  $('post-category-general').disabled = false;
  const staff=!guest && ['dev','admin'].includes(profile?.role);
  $('post-category-announcement').hidden=!staff;
  $('post-category-announcement').disabled=!staff;
  if(!staff && $('post-category').value==='ประกาศ')$('post-category').value='';
  $('guest-category-note').hidden = !guest;
  if (guest && !['ทั่วไป', 'ถาม-ตอบ'].includes($('post-category').value)) $('post-category').value = 'ถาม-ตอบ';
}
function renderProfile() {
  updatePostCategories();
  releaseUrls(profileUrls);
  loadAvatar($('avatar'), profile.isGuest ? null : profile.photoMediaId, profileUrls);
  $('display-name').textContent = profile.displayName;
  $('identity').textContent = profile.handle ? `@${profile.handle}` : profile.isGuest ? t('บัญชี Guest') : t('สมาชิกผ่าน Email');
  $('bio').textContent = profile.bio || t('ยังไม่ได้เพิ่มคำแนะนำตัว');
  $('guest-note').hidden = !profile.isGuest;
  updatePermissions();
}
let checkingPostNotice=false;
async function checkPostNotice(){
  if(checkingPostNotice || redirecting || document.visibilityState==='hidden' || !sdk?.auth.currentUser || $('post-notice-dialog').open)return;
  checkingPostNotice=true;
  try{
    const data=await call('post-notice-next');
    if(data.notice){
      $('post-notice-preview').textContent=data.notice.post?.text || t(data.notice.post?.hasMedia?'โพสต์พร้อมไฟล์แนบ':'โพสต์');
      $('post-notice-reason').textContent=data.notice.reason;
      $('post-notice-dialog').showModal();
    }
  }catch(error){
    // A failed request leaves unclaimed notices on the server for the next reset.
    if(error.code==='ACCOUNT_BANNED')showError(error);
  }finally{checkingPostNotice=false;}
}
function dismissPostNotice(){
  $('post-notice-dialog').close();
  checkPostNotice();
}
$('close-post-notice').addEventListener('click',dismissPostNotice);
$('post-notice-dialog').addEventListener('cancel',event=>{event.preventDefault();dismissPostNotice();});
window.addEventListener?.('pageshow',event=>{
  if(event.persisted && profile && !loading)checkPostNotice();
});
async function load() {
  if (loading || !sdk.auth.currentUser) return;
  loading = true;
  $('retry').hidden = true;
  try {
    profile = await call(sdk.auth.currentUser.isAnonymous ? 'profile' : 'profile-read');
    if (!sdk.auth.currentUser.isAnonymous && (profile.profileCompleted !== true || !profile.handle)) {
      redirecting = true; location.replace('/setup-profile.html'); return;
    }
    setPostCooldown(profile.postAvailableAt);
    renderProfile();
    let savedTheme;
    try { savedTheme = localStorage.getItem(themeKey()); } catch {}
    setTheme(['light', 'dark'].includes(savedTheme) ? savedTheme : document.documentElement.dataset.theme);
    $('open-reports').hidden = !profile.canReceiveReports;
    finishInitialLoading();
    $('app').hidden = false;
    status.textContent = '';
    await checkPostNotice();
    await loadFeed();
  } catch (error) {
    if (error.status === 404) {
      redirecting = true;
      await sdk.signOut(sdk.auth);
      location.replace('/?unregistered=1');
    } else { showError(error); $('retry').hidden = false; }
  } finally { loading = false; if (!redirecting) finishInitialLoading(); }
}

let socialVersion = 0, socialMediaVersion = 0, commentPostId = null, commenting = false;
const socialUrls = [], socialPhotoUrls = [];
const socialCursors = { likes: null, comments: null };
let socialPostId = null, focusedSocialCommentId=null, replyTarget=null;
let editingComment=null,savingComment=false,commentEditTimer=null,commentMenuTimer=null;
let commentEditButtons=[];
function clearReply(){replyTarget=null;$('reply-banner').hidden=true;$('reply-label').textContent='';}
$('cancel-reply').addEventListener('click',()=>{if(!commenting){clearReply();$('comment-text').focus();}});
function updateCommentMenuTimes(){
  for(const {button,deadline} of commentEditButtons){button.disabled=Date.now()>=deadline;button.title=button.disabled?t('แก้ไขคอมเมนต์ได้ภายใน 5 นาทีหลังส่งเท่านั้น'):'';}
  if(!commentEditButtons.some(item=>Date.now()<item.deadline) && commentMenuTimer!==null){clearInterval(commentMenuTimer);commentMenuTimer=null;}
}
function renderComment(comment,post){
  const row=document.createElement('article');row.className='comment-row'+(comment.parentId?' comment-reply':'');row.setAttribute('data-comment-id',comment.id);
  if(comment.id===focusedSocialCommentId)row.className+=' comment-highlight';
  if(comment.deleted){const removed=document.createElement('p');removed.className='deleted-comment';removed.textContent=t('คอมเมนต์ถูกลบแล้ว');row.append(removed);return row;}
  const header=document.createElement('div');header.className='comment-header';header.append(personCard(comment));
  if(!post.archived){
    const tools=document.createElement('div');tools.className='comment-tools';const entries=[];
    if(comment.own){
      entries.push(['แก้ไข',()=>openCommentEdit(comment,post.id)]);
      entries.push(['ลบ',async()=>{try{await call('comment-delete',{id:post.id,commentId:comment.id});if(replyTarget?.id===comment.id)clearReply();if(socialPostId===post.id && $('comments-dialog').open)await showSocial('comments',post.id);await loadFeed();}catch(error){$('comments-status').textContent=localizeError(error.message);}},true]);
    }else entries.push(['รายงาน',()=>openReport(post.id,comment.id)]);
    staffMenu(tools,entries,'เมนูคอมเมนต์');header.append(tools);
    if(comment.own){
      const button=tools.children[0].children[1].children[0],deadline=comment.canEdit?Date.now()+Math.max(0,comment.editRemainingMs || 0):0;
      comment.editDeadline=deadline;commentEditButtons.push({button,deadline});button.disabled=!comment.canEdit;
    }
  }
  const time=document.createElement('p');time.className='post-time';time.textContent=comment.createdAt?new Date(comment.createdAt).toLocaleString(dateLocale()):'';
  const text=document.createElement('p');text.className='post-content';text.textContent=comment.text;
  row.append(header,time);
  if(comment.parentId){const context=document.createElement('p');context.className='reply-context';context.textContent=comment.replyToDeleted?t('ตอบกลับคอมเมนต์ที่ถูกลบแล้ว'):t('ตอบกลับ ')+personName(comment.replyTo)+(comment.replyTo?.handle?' @'+comment.replyTo.handle:'');row.append(context);}
  row.append(text);
  const actions=document.createElement('div');actions.className='comment-actions';const heart=document.createElement('button');heart.type='button';heart.className='comment-heart';heart.textContent=t(comment.liked?'♥ ถูกใจแล้ว':'♡ กดใจ')+' '+(comment.likeCount || 0);heart.setAttribute('aria-pressed',String(!!comment.liked));heart.disabled=post.archived;
  heart.addEventListener('click',async()=>{if(heart.disabled)return;heart.disabled=true;try{await call('comment-like',{id:post.id,commentId:comment.id,liked:!comment.liked});if(socialPostId===post.id && $('comments-dialog').open)await showSocial('comments',post.id);}catch(error){$('comments-status').textContent=localizeError(error.message);}finally{heart.disabled=post.archived;}});actions.append(heart);
  if(!post.archived){const reply=document.createElement('button');reply.type='button';reply.className='comment-reply-button';reply.textContent=t('ตอบกลับ');reply.addEventListener('click',()=>{if(commenting)return;replyTarget={id:comment.id};$('reply-label').textContent=t('ตอบกลับ ')+personName(comment)+(comment.handle?' @'+comment.handle:'');$('reply-banner').hidden=false;$('comment-text').focus();});actions.append(reply);}
  row.append(actions);return row;
}
function updateCommentEditTime(){
  const expired=editingComment && Date.now()>=editingComment.deadline;
  $('save-comment-edit').disabled=savingComment || !editingComment || expired;
  if(expired && !savingComment)$('comment-edit-status').textContent=t('แก้ไขคอมเมนต์ได้ภายใน 5 นาทีหลังส่งเท่านั้น');
}
function openCommentEdit(comment,id){
  if(savingComment || !comment.canEdit)return;
  const deadline=comment.editDeadline || Date.now()+Math.max(0,comment.editRemainingMs || 0);
  if(Date.now()>=deadline)return;
  editingComment={id,commentId:comment.id,deadline};$('comment-edit-text').value=comment.text;$('comment-edit-status').textContent='';updateCommentEditTime();
  if(commentEditTimer!==null)clearInterval(commentEditTimer);commentEditTimer=setInterval(updateCommentEditTime,1000);
  $('comment-edit-dialog').showModal();$('comment-edit-text').focus();
}
$('cancel-comment-edit').addEventListener('click',()=>{if(!savingComment)$('comment-edit-dialog').close();});
$('comment-edit-dialog').addEventListener('cancel',event=>{if(savingComment)event.preventDefault();});
$('comment-edit-dialog').addEventListener('close',()=>{editingComment=null;if(commentEditTimer!==null)clearInterval(commentEditTimer);commentEditTimer=null;});
$('comment-edit-form').addEventListener('submit',async event=>{
  event.preventDefault();if(savingComment || !editingComment)return;updateCommentEditTime();if($('save-comment-edit').disabled)return;
  const text=$('comment-edit-text').value.trim();if(!text || text.length>2000){$('comment-edit-status').textContent=t('พิมพ์คอมเมนต์ไม่เกิน 2,000 ตัวอักษร');return;}
  const target=editingComment;savingComment=true;$('comment-edit-fields').disabled=true;
  try{await call('comment-update',{id:target.id,commentId:target.commentId,text});$('comment-edit-dialog').close();if(socialPostId===target.id && $('comments-dialog').open)await showSocial('comments',target.id);}
  catch(error){$('comment-edit-status').textContent=localizeError(error.message);}
  finally{savingComment=false;$('comment-edit-fields').disabled=false;updateCommentEditTime();}
});
function openAuthor(id, handle = null, profileUid = null) {
  if (commenting) return;
  for (const kind of ['likes', 'comments']) if ($(kind + '-dialog').open) $(kind + '-dialog').close();
  closeSearch();
  authorPostId = id; authorHandle = handle; authorUid = profileUid;
  switchView('author');
}
function postAuthorName(container, person, handle, role) {
  container.className = 'post-author-line';
  const nickname = document.createElement('span'); nickname.className = 'post-author-nickname'; nickname.textContent = personName(person);
  container.title = personName(person) + (handle ? ' @' + handle : '');
  container.replaceChildren(nickname);
  if (!person.suspended && ['dev','admin','merchant'].includes(role)) {
    const badge = document.createElement('span'); badge.className = 'role-badge'; roleBadge(badge, role); container.append(badge);
  }
  let username = null;
  if (handle) { username = document.createElement('span'); username.className = 'post-author-handle'; username.textContent = '@' + handle; container.append(username); }
  return { nickname, username };
}
function personCard(person, postId = null) {
  const row = document.createElement('div');
  const photo = document.createElement('img');
  photo.className = 'post-avatar'; photo.alt = t('รูปโปรไฟล์');
  const canOpen = Boolean(postId || person.profileUid || person.handle);
  const name = document.createElement(canOpen ? 'button' : 'strong');
  const openProfile = () => openAuthor(postId, postId ? null : person.handle, postId ? null : person.profileUid);
  if (canOpen) { name.type = 'button'; name.className = 'person-name-button'; name.setAttribute('aria-label', t('ดูโปรไฟล์ของ ') + personName(person)); name.addEventListener('click', openProfile); }
  if (postId) postAuthorName(name, person, person.handle, person.role);
  else name.textContent = personName(person) + (person.handle ? ' @' + person.handle : '');
  if(person.edited){const edited=document.createElement('span');edited.className='comment-edited';edited.textContent=t('แก้ไขแล้ว');name.append(edited);}
  row.className='person-card';
  if (canOpen) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'author-button';
    button.setAttribute('aria-label', t('ดูโปรไฟล์ของ ') + personName(person));
    button.append(photo); button.addEventListener('click', openProfile);
    row.append(button, name);
  } else row.append(photo, name);
  loadAvatar(photo, person.photoId, socialPhotoUrls);
  return row;
}
async function loadSocialMedia(item, container, version) {
  try {
    const response = await fetch('/api/media?id=' + encodeURIComponent(item.id), { headers: { Authorization: 'Bearer ' + await sdk.auth.currentUser.getIdToken() } });
    if (!response.ok) throw new Error();
    const blob = await response.blob();
    if (version !== socialMediaVersion || !$('comments-dialog').open) return;
    const url = URL.createObjectURL(blob); socialUrls.push(url);
    const media = mediaElement(item.type); media.src = url;
    container.replaceChildren(media);
  } catch { if (version === socialMediaVersion) container.textContent = t('โหลดไฟล์แนบไม่ได้'); }
}
function clearSocial() {
  socialVersion++; socialMediaVersion++;
  clearReply();focusedSocialCommentId=null;commentEditButtons=[];if(commentMenuTimer!==null)clearInterval(commentMenuTimer);commentMenuTimer=null;
  commentPostId = null; socialPostId = null;
  socialCursors.likes = socialCursors.comments = null;
  $('more-likes').hidden = $('more-comments').hidden = true;
  $('comment-post').replaceChildren(); $('comments-list').replaceChildren();
      commentEditButtons=[];if(commentMenuTimer!==null)clearInterval(commentMenuTimer);commentMenuTimer=null; $('likes-list').replaceChildren();
  releaseUrls(socialUrls); releaseUrls(socialPhotoUrls);
}
async function showSocial(kind, id, more = false) {
  const version = ++socialVersion;
  const message = $(kind + '-status');
  message.textContent = t('กำลังโหลด…');
  $('more-' + kind).disabled = true;
  if (kind === 'comments') { $('comment-form').hidden = true; $('refresh-comments').disabled = true; }
  try {
    const data = await call('post-detail', { id, ...(!more && focusedSocialCommentId?{focusCommentId:focusedSocialCommentId}:{}), ...(more ? { [kind + 'After']: socialCursors[kind] } : {}) });
    if (version !== socialVersion || !$(kind + '-dialog').open) return;
    socialCursors[kind] = data[kind + 'After'];
    $('more-' + kind).hidden = !socialCursors[kind];
    if (kind === 'likes') {
      if (!more) $('likes-list').replaceChildren();
      for (const person of data.likes) $('likes-list').append(personCard(person));
      const shown = $('likes-list').children.length;
      message.textContent = shown ? t('แสดง {shown} คน จาก {total} คน', { shown, total: data.post.likeCount }) : t('ยังไม่มีคนกดใจ');
      return;
    }
    if (!more) {
      socialMediaVersion++;
      $('comment-post').replaceChildren(); $('comments-list').replaceChildren();
      releaseUrls(socialUrls); releaseUrls(socialPhotoUrls);
      const parent = document.createElement('article');
      const content = document.createElement('p'); content.className = 'post-content'; renderTaggedText(content, data.post.text);
      const category = document.createElement('p'); category.textContent = t('หมวดหมู่: ') + t(data.post.category || 'ยังไม่ระบุหมวดหมู่');
      parent.append(personCard(data.post, data.post.id), category, content);
      for (const item of data.post.media || []) {
        const container = document.createElement('div');
        container.className = 'post-attachment'; container.textContent = t('กำลังโหลดไฟล์แนบ…');
        parent.append(container); loadSocialMedia(item, container, socialMediaVersion);
      }
      $('comment-post').append(parent);
    }
    for (const comment of data.comments) $('comments-list').append(renderComment(comment,data.post));
    updateCommentMenuTimes();if(commentEditButtons.some(item=>Date.now()<item.deadline) && commentMenuTimer===null)commentMenuTimer=setInterval(updateCommentMenuTimes,1000);
    $('comment-form').hidden = data.post.archived;
    message.textContent = data.post.archived ? t('โพสต์ในคลัง อ่านคอมเมนต์ได้ แต่เพิ่มคอมเมนต์ไม่ได้') : !$('comments-list').children.length ? t('ยังไม่มีคอมเมนต์') : data.post.commentCount > $('comments-list').children.length ? t('แสดง {shown} คอมเมนต์ จาก {total} คอมเมนต์', { shown: $('comments-list').children.length, total: data.post.commentCount }) : t('{count} คอมเมนต์', { count: data.post.commentCount });
    if(focusedSocialCommentId && !more){const focused=[...$('comments-list').children].find(row=>row.getAttribute('data-comment-id')===focusedSocialCommentId);focused?.scrollIntoView?.({block:'nearest'});if(data.focusedCommentFound===false)message.textContent=t('คอมเมนต์นี้ถูกลบแล้ว');}
  } catch (error) { if (version === socialVersion) message.textContent = localizeError(error.message); }
  finally { if (version === socialVersion) { $('refresh-comments').disabled = false; $('more-' + kind).disabled = false; } }
}
function openSocial(kind, id, focusCommentId=null) {
  clearSocial();focusedSocialCommentId=focusCommentId;
  socialPostId = id;
  if (kind === 'comments') { commentPostId = id; $('comment-text').value = ''; }
  $(kind + '-dialog').showModal();
  showSocial(kind, id);
}
for (const kind of ['likes', 'comments']) $('more-' + kind).addEventListener('click', () => { if (!commenting && socialPostId) showSocial(kind, socialPostId, true); });
$('close-likes').addEventListener('click', () => $('likes-dialog').close());
$('close-comments').addEventListener('click', () => $('comments-dialog').close());
for (const kind of ['likes', 'comments']) $(kind + '-dialog').addEventListener('close', clearSocial);
$('comments-dialog').addEventListener('cancel', event => { if (commenting) event.preventDefault(); });
$('refresh-comments').addEventListener('click', () => { if (!commenting && commentPostId) showSocial('comments', commentPostId); });
$('comment-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (commenting || !commentPostId) return;
  const text = $('comment-text').value.trim();
  if (!text || text.length > 2000) { $('comments-status').textContent = t('พิมพ์คอมเมนต์ไม่เกิน 2,000 ตัวอักษร'); return; }
  const id = commentPostId;
  commenting = true;
  $('send-comment').disabled = $('close-comments').disabled = $('refresh-comments').disabled = $('more-comments').disabled = true;
  try {
    await call('comment-create', { id, text, ...(replyTarget?{replyTo:replyTarget.id}:{}) });
    $('comment-text').value = '';clearReply();
    await showSocial('comments', id);
    await loadFeed();
  } catch (error) { $('comments-status').textContent = localizeError(error.message); }
  finally { commenting = false; $('send-comment').disabled = $('close-comments').disabled = $('refresh-comments').disabled = false; }
});

function renderPosts(posts, targetView) {
  postIdentityObserver?.disconnect();
  const feed = $('feed');
  feed.replaceChildren();
  for (const post of posts) {
    const article = document.createElement('article');
    article.className = 'post-card';
    const photo = document.createElement('img');
    photo.className = 'post-avatar'; photo.alt = t('รูปโปรไฟล์ผู้โพสต์');
    const authorButton = document.createElement('button');
    authorButton.type = 'button'; authorButton.className = 'author-button';
    authorButton.setAttribute('aria-label', t('ดูโปรไฟล์ของ ') + personName(post));
    authorButton.append(photo);
    authorButton.addEventListener('click', () => openAuthor(post.id));
    article.append(authorButton);
    loadAvatar(photo, post.authorPhotoId, feedPhotoUrls);
    const heading = document.createElement('h3');
    const identity = postAuthorName(heading, post, post.authorHandle, post.authorRole);
    postIdentityObserver?.observe(identity.nickname);
    if (identity.username) postIdentityObserver?.observe(identity.username);
    const time = document.createElement('p');
    time.className = 'post-time';
    time.textContent = post.createdAt ? new Date(post.createdAt).toLocaleString(dateLocale()) : '';
    const content = document.createElement('p');
    content.className = 'post-content';
    renderTaggedText(content, post.text);
    const category = document.createElement('p');
    category.className = 'post-category';
    category.dataset.category = post.category || '';
    const categoryPrefix = document.createElement('span'), categoryLabel = document.createElement('span');
    categoryPrefix.className = 'post-category-prefix'; categoryPrefix.textContent = t('หมวดหมู่: ');
    categoryLabel.textContent = t(post.category || 'ยังไม่ระบุหมวดหมู่');
    category.append(categoryPrefix, categoryLabel);
    category.setAttribute('aria-label', categoryPrefix.textContent + categoryLabel.textContent);
    article.append(heading, postTools(post, category, targetView), time, content);
    for (const item of post.media || []) {
      const container = document.createElement('div');
      container.className = 'post-attachment';
      container.setAttribute('aria-busy', 'true');
      const mediaStatus = document.createElement('span');
      mediaStatus.className = 'sr-only'; mediaStatus.setAttribute('role', 'status');
      mediaStatus.textContent = t('กำลังโหลดไฟล์แนบ…');
      const placeholder = skeletonBlock('media'); placeholder.setAttribute('aria-hidden', 'true');
      container.append(mediaStatus, placeholder);
      article.append(container);
      loadMedia(item, container, feedVersion);
    }
    const actions = document.createElement('p');
    actions.className = 'post-actions';
    const heart = document.createElement('button'); heart.type = 'button';
    const drawHeart = () => { heart.textContent = (post.liked ? t('♥ ถูกใจแล้ว') : t('♡ กดใจ')) + ' ' + (post.likeCount || 0); heart.setAttribute('aria-pressed', String(Boolean(post.liked))); };
    drawHeart(); heart.disabled = targetView === 'archive';
    heart.addEventListener('click', async () => {
      heart.disabled = true;
      try {
        const result = await call('post-like', { id: post.id, liked: !post.liked });
        post.liked = result.liked; post.likeCount = result.likeCount; drawHeart();
      } catch (error) { showError(error); }
      finally { heart.disabled = false; }
    });
    const people = document.createElement('button'); people.type = 'button'; people.textContent = t('ดูคนที่กดใจ');
    people.addEventListener('click', () => openSocial('likes', post.id));
    const comments = document.createElement('button'); comments.type = 'button'; comments.textContent = t('คอมเมนต์ ') + (post.commentCount || 0);
    comments.addEventListener('click', () => openSocial('comments', post.id));
    actions.append(heart, people, comments); article.append(actions);
    feed.append(article);
  }
  $('feed-status').textContent = posts.length ? (targetView === 'home' ? '' : t('แสดง {count} โพสต์', { count: posts.length })) : targetView === 'saved' ? t('ยังไม่มีโพสต์ที่บันทึกไว้') : targetView === 'archive' ? t('ยังไม่มีโพสต์ในคลัง') : targetView === 'me' ? t('คุณยังไม่มีโพสต์') : targetView === 'author' ? t('ยังไม่มีโพสต์ที่เผยแพร่') : selectedHashtag ? t('ยังไม่มีโพสต์ที่ใช้ #{tag}', { tag: selectedHashtag }) : selectedCategory === 'ทั้งหมด' ? t('ยังไม่มีโพสต์ เริ่มโพสต์แรกได้เลย') : t('ยังไม่มีโพสต์ในหมวด ') + t(selectedCategory);
}
let currentAnnouncements = [];
function renderAnnouncements(announcements = []) {
  currentAnnouncements = announcements;
  const track = $('announcement-track'), accessible = $('announcement-accessible');
  const fallback = 'System : Welcome to my website kub ^_^';
  const items = announcements.length ? announcements : [{ text: fallback }];
  const label = post => announcements.length ? t('ประกาศ') + ': ' + (post.text || t('ประกาศพร้อมไฟล์แนบ')).replace(/\s+/g, ' ') : fallback;
  accessible.textContent = items.map(label).join(' · ');
  track.replaceChildren();
  const makeRepeat = duplicate => {
    const repeat = document.createElement('span');
    repeat.className = 'announcement-repeat';
    if (duplicate) repeat.setAttribute('aria-hidden', 'true');
    for (const post of items) {
      const item = document.createElement(post.id ? 'button' : 'span');
      item.className = post.id ? 'announcement-link' : 'announcement-item';
      item.textContent = label(post);
      if (post.id) {
        item.type = 'button';
        if (duplicate) item.tabIndex = -1;
        item.addEventListener('click', () => openSocial('comments', post.id));
      }
      repeat.append(item);
    }
    return repeat;
  };
  const first = document.createElement('span');
  first.className = 'announcement-group';
  first.append(makeRepeat(false));
  track.append(first);
  const unitWidth = first.scrollWidth || 1;
  const repeats = Math.max(1, Math.ceil(($('university-announcement').clientWidth || 1) / unitWidth));
  for (let index = 1; index < repeats; index++) first.append(makeRepeat(true));
  const second = document.createElement('span');
  second.className = 'announcement-group';
  second.setAttribute('aria-hidden', 'true');
  for (let index = 0; index < repeats; index++) second.append(makeRepeat(true));
  track.append(second);
  track.setAttribute('style', '--announcement-duration: ' + Math.max(1, (first.scrollWidth || 720) / 45) + 's');
}
const announcementObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => renderAnnouncements(currentAnnouncements));
announcementObserver?.observe($('university-announcement'));
document.fonts?.ready.then(() => renderAnnouncements(currentAnnouncements));

function skeletonBlock(kind) {
  const block = document.createElement('span');
  block.className = 'skeleton-block skeleton-' + kind;
  return block;
}
function postSkeleton(withMedia) {
  const card = document.createElement('article');
  card.className = 'loading-card'; card.setAttribute('aria-hidden', 'true');
  const header = document.createElement('div'); header.className = 'loading-card-header';
  const identity = document.createElement('div'); identity.className = 'loading-identity';
  identity.append(skeletonBlock('name'), skeletonBlock('date'));
  header.append(skeletonBlock('avatar'), identity, skeletonBlock('category'));
  const text = document.createElement('div'); text.className = 'loading-text';
  text.append(skeletonBlock('line'), skeletonBlock('line-short'));
  card.append(header, text);
  if (withMedia) card.append(skeletonBlock('media'));
  const actions = document.createElement('div'); actions.className = 'loading-actions';
  actions.append(skeletonBlock('action'), skeletonBlock('action'), skeletonBlock('action'));
  card.append(actions);
  return card;
}
function showFeedSkeleton() {
  postIdentityObserver?.disconnect();
  $('feed').replaceChildren(postSkeleton(true), postSkeleton(false), postSkeleton(false));
  $('feed-status').className = 'sr-only';
  $('feed-status').textContent = t('กำลังโหลดโพสต์…');
}
function finishInitialLoading() {
  $('initial-loading').hidden = true;
  status.className = '';
}

async function loadFeed({ navigation = false } = {}) {
  if (!navigation) clearHomeFeed();
  if (view === 'search' || view === 'settings') return;
  const version = ++feedVersion;
  const targetView = view;
  activeFeedMediaVersion = version;
  if (targetView === 'home') homeFeedReady = false;
  $('feed').setAttribute('aria-busy', 'true');
  releaseUrls(feedUrls);
  releaseUrls(feedPhotoUrls);
  showFeedSkeleton();
  try {
    const data = await call(targetView === 'saved' ? 'saved-list' : targetView === 'author' ? 'author-profile' : targetView === 'archive' ? 'archive-list' : targetView === 'me' ? 'my-posts' : 'posts-list', targetView === 'author' ? (authorUid ? { profileUid: authorUid } : authorHandle ? { handle: authorHandle } : { id: authorPostId }) : targetView === 'home' ? { category: selectedCategory, ...(selectedHashtag ? { hashtag: selectedHashtag } : {}) } : {});
    if (version === feedVersion) {
      if (targetView === 'author') {
        releaseUrls(authorUrls);
        loadAvatar($('author-avatar'), data.profile.photoMediaId, authorUrls);
        $('author-name').textContent = personName(data.profile);
        $('author-handle').textContent = data.profile.handle ? '@' + data.profile.handle : '';
        $('author-bio').textContent = data.profile.suspended ? t('ติดต่อปลดแบนได้ที่ "รายงานปัญหาการใช้งาน"') : data.profile.bio || t('ยังไม่ได้เพิ่มคำแนะนำตัว');
        authorHandle=data.profile.handle || null;
        renderAuthorTools(data.profile);
        $('author-profile').hidden = false;
        $('feed-heading').textContent = t('โพสต์ของ ') + personName(data.profile);
      }
      if(targetView==='home')renderAnnouncements(data.announcements || []);
      renderPosts(data.posts, targetView);
      if (targetView === 'home') homeFeedReady = true;
      if(targetView==='saved')savedSignature=JSON.stringify(data.posts);
    }
  } catch (error) {
    if (version === feedVersion) {
      $('feed').replaceChildren();
      $('feed-status').textContent = localizeError(error.message);
    }
  } finally {
    if (version === feedVersion) {
      $('feed').setAttribute('aria-busy', 'false');
      $('feed-status').className = '';
    }
  }
}
function switchView(next, { reset = false } = {}) {
  if (next === view && !reset && next !== 'author') return;
  if (view === 'home' && next !== 'home') rememberHomeFeed();
  if (reset) { clearHomeFeed(); homeFeedReady = false; homeScrollTop = 0; }
  if (next !== view && (typeof matchMedia !== 'function' || !matchMedia('(prefers-reduced-motion: reduce)').matches)) {
    $('community-content').getAnimations?.().forEach(animation => animation.cancel());
    $('community-content').animate?.([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 320, easing: 'cubic-bezier(.2,.7,.25,1)' });
  }
  if (view === 'search' && next !== 'search') closeSearch();
  view = next;
  $('search-page').hidden = view !== 'search';
  $('feed-view').hidden = view === 'search' || view === 'settings';
  $('settings-page').hidden = view !== 'settings';
  if(savedRefreshTimer!==null){clearInterval(savedRefreshTimer);savedRefreshTimer=null;}
  if(view==='saved')savedRefreshTimer=setInterval(refreshSaved,15000);
  updateAnnouncement();
  for (const [id, target] of [['home', 'home'], ['open-search', 'search'], ['me', 'me'], ['open-settings', 'settings']]) $(id).setAttribute('aria-current', view === target ? 'page' : 'false');
  $('me-profile').hidden = view !== 'me';
  $('author-profile').hidden = true;
  releaseUrls(authorUrls);
  $('filter-controls').hidden = view !== 'home';
  updateHashtagFilter();
  closeFilter();
  $('feed-heading').textContent = view === 'saved' ? t('โพสต์ที่บันทึกไว้') : view === 'me' ? t('โพสต์ของฉัน') : view === 'archive' ? t('คลังของฉัน · เห็นเฉพาะฉัน') : selectedCategory === 'ทั้งหมด' ? t('ฟีดโพสต์') : t('ฟีดโพสต์ · ') + t(selectedCategory);
  status.textContent = '';
  if (view === 'search' || view === 'settings') {
    feedVersion++;
    activeFeedMediaVersion = 0;
    releaseUrls(feedUrls); releaseUrls(feedPhotoUrls);
    $('feed').setAttribute('aria-busy', 'false');
  } else if (!(view === 'home' && restoreHomeFeed())) loadFeed({ navigation: true });
  scrollView(view === 'home' && !reset ? homeScrollTop : 0);
}
$('brand-home').addEventListener('click', event => {
  event.preventDefault();
  selectedCategory = 'ทั้งหมด'; selectedHashtag = null;
  for (const [id, category] of Object.entries(categoryButtons)) $(id).setAttribute('aria-pressed', String(category === selectedCategory));
  checkPostNotice();
  switchView('home', { reset: true });
});

let searchVersion = 0, trendingVersion = 0, searchTimer = null;
function cancelSearchTimer() {
  if (searchTimer !== null) { clearTimeout(searchTimer); searchTimer = null; }
}
const searchPhotoUrls = [];
const searchHistories = new Map();
function currentSearchHistory() {
  const uid = sdk?.auth.currentUser?.uid;
  if (!uid) return null;
  if (!searchHistories.has(uid)) searchHistories.set(uid, createSearchHistory(() => localStorage, uid));
  return searchHistories.get(uid);
}
function rememberSearch(kind, value) {
  currentSearchHistory()?.remember({ kind, value });
  renderSearchHistory();
}
function renderSearchHistory() {
  const history = currentSearchHistory(), items = history?.list() || [];
  $('search-history-list').replaceChildren();
  $('search-history-empty').hidden = items.length > 0;
  $('clear-search-history').hidden = items.length === 0;
  for (const item of items) {
    const row = document.createElement('div'); row.className = 'search-history-row';
    const button = document.createElement('button'); button.type = 'button'; button.className = 'search-history-item';
    const label = document.createElement('strong'), hint = document.createElement('small');
    label.textContent = item.value; hint.textContent = t(item.kind === 'profile' ? 'โปรไฟล์ที่ดู' : 'ค้นหาอีกครั้ง');
    button.append(label, hint);
    button.addEventListener('click', () => {
      if (item.kind === 'profile') { rememberSearch('profile', item.value); openAuthor(null, item.value.slice(1)); }
      else { $('search-input').value = item.value; runSearch(); }
    });
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove-search-history'; remove.textContent = '×';
    remove.setAttribute('aria-label', t('ลบ {query} ออกจากประวัติ', { query: item.value }));
    remove.addEventListener('click', () => { history.remove(item.key); renderSearchHistory(); });
    row.append(button, remove); $('search-history-list').append(row);
  }
}
$('clear-search-history').addEventListener('click', () => { currentSearchHistory()?.clear(); renderSearchHistory(); });
function closeSearch() {
  $('search-status').textContent = '';
  cancelSearchTimer();
  searchVersion++; trendingVersion++;
  releaseUrls(searchPhotoUrls);
}

function updateHashtagFilter() {
  $('hashtag-filter').hidden = view !== 'home' || !selectedHashtag;
  $('selected-hashtag').textContent = selectedHashtag ? '#' + selectedHashtag : '';
}
function selectHashtag(tag) {
  closeSearch();
  if ($('comments-dialog').open) $('comments-dialog').close();
  selectedHashtag = tag; selectedCategory = 'ทั้งหมด';
  for (const [id, category] of Object.entries(categoryButtons)) $(id).setAttribute('aria-pressed', String(category === selectedCategory));
  switchView('home', { reset: true });
}
$('clear-hashtag').addEventListener('click', () => { selectedHashtag = null; updateHashtagFilter(); loadFeed(); });
function renderTaggedText(container, text) {
  const parts = hashtagParts(text || '');
  if (!parts.some(part => part.tag)) { container.textContent = text || ''; return; }
  for (const part of parts) {
    const node = document.createElement(part.tag ? 'button' : 'span');
    node.textContent = part.text;
    if (part.tag) { node.type = 'button'; node.className = 'hashtag-link'; node.addEventListener('click', () => selectHashtag(part.tag)); }
    container.append(node);
  }
}
$('open-search').addEventListener('click', async () => {
  switchView('search');
  cancelSearchTimer();
  searchVersion++; releaseUrls(searchPhotoUrls);
  $('search-results').replaceChildren();
  $('search-input').value = '';
  renderSearchHistory();
  $('search-status').textContent = '';
  $('trending-tags').replaceChildren();
  $('trending-status').textContent = t('กำลังโหลด…');
  $('search-heading').focus();
  const version = ++trendingVersion;
  try {
    const data = await call('trending-tags');
    if (version !== trendingVersion || view !== 'search') return;
    for (const item of data.tags) {
      const row = document.createElement('li'), button = document.createElement('button');
      button.type = 'button'; button.className = 'trending-tag';
      const name = document.createElement('strong'), count = document.createElement('small');
      name.textContent = '#' + item.tag; count.textContent = t('{count} โพสต์', { count: item.count });
      button.append(name, count); button.addEventListener('click', () => { rememberSearch('query', '#' + item.tag); selectHashtag(item.tag); });
      row.append(button); $('trending-tags').append(row);
    }
    $('trending-status').textContent = data.tags.length ? '' : t('ยังไม่มีแฮชแท็กยอดนิยมในช่วงนี้');
  } catch (error) { if (version === trendingVersion && view === 'search') $('trending-status').textContent = localizeError(error.message); }
});
function suggestUsers(event) {
  cancelSearchTimer(); searchVersion++; releaseUrls(searchPhotoUrls);
  $('search-results').replaceChildren(); $('search-status').textContent = '';
  const query = $('search-input').value.trim().replace(/^@/, '');
  if (event?.isComposing || view !== 'search' || !/^[a-z0-9_.^]{1,24}$/i.test(query)) return;
  searchTimer = setTimeout(() => { searchTimer = null; runSearch({ live: true }); }, 200);
}
$('search-input').addEventListener('input', suggestUsers);
$('search-input').addEventListener('compositionstart', () => { cancelSearchTimer(); searchVersion++; });
$('search-input').addEventListener('compositionend', suggestUsers);
$('search-form').addEventListener('submit', event => { event.preventDefault(); return runSearch(); });
async function runSearch({ live = false } = {}) {
  cancelSearchTimer();
  const query = $('search-input').value.trim();
  if (!query || view !== 'search') return;
  if (query.startsWith('#')) {
    const parts = hashtagParts(query);
    if (parts.length === 1 && parts[0].tag && parts[0].text === query) { rememberSearch('query', query); selectHashtag(parts[0].tag); return; }
    $('search-status').textContent = t('แฮชแท็กไม่ถูกต้อง'); return;
  }
  const version = ++searchVersion;
  releaseUrls(searchPhotoUrls); $('search-results').replaceChildren();
  $('search-status').textContent = t('กำลังค้นหา…');
  try {
    const searchedHistory = currentSearchHistory();
    const data = await call('search-users', { query });
    if (version !== searchVersion || view !== 'search') return;
    if (!live) {
      searchedHistory?.remember({ kind: 'query', value: query });
      if (searchedHistory === currentSearchHistory()) renderSearchHistory();
    }
    for (const person of data.users) {
      const button = document.createElement('button'), photo = document.createElement('img'), name = document.createElement('span');
      button.type = 'button'; button.className = 'search-user';
      photo.className = 'post-avatar'; photo.alt = t('รูปโปรไฟล์');
      const nickname = document.createElement('strong'), handle = document.createElement('small');
      nickname.textContent = personName(person); handle.textContent = '@' + person.handle;
      name.append(nickname, handle); button.append(photo, name);
      button.addEventListener('click', () => { rememberSearch('profile', '@' + person.handle); openAuthor(null, person.handle); });
      $('search-results').append(button); loadAvatar(photo, person.photoId, searchPhotoUrls);
    }
    $('search-status').textContent = data.users.length ? t('พบ {count} ผู้ใช้', { count: data.users.length }) : t('ไม่พบผู้ใช้');
  } catch (error) { if (version === searchVersion && view === 'search') $('search-status').textContent = localizeError(error.message); }
}


let currentPostMenu = null, deletePostId = null, deletingPost = false, reportPostId = null, reportCommentId=null, reporting = false;
let reportsVersion = 0, savedRefreshTimer = null, savedSignature = '';
function postTools(post,category,targetView) {
  const tools=document.createElement('div');tools.className='post-tools';
  const menu=document.createElement('details');menu.className='post-menu';
  const summary=document.createElement('summary');summary.className='post-more';summary.textContent='⋮';summary.setAttribute('aria-label',t('เมนูโพสต์'));
  summary.addEventListener('click',()=>{if(currentPostMenu && currentPostMenu!==menu)currentPostMenu.open=false;currentPostMenu=menu;});
  menu.addEventListener('keydown',event=>{if(event.key==='Escape'){menu.open=false;summary.focus();}});
  const options=document.createElement('div');options.className='post-menu-options';
  const option=(label,fn,danger=false)=>{const button=document.createElement('button');button.type='button';button.textContent=t(label);if(danger)button.className='danger-action';button.addEventListener('click',async()=>{menu.open=false;await fn(button);});options.append(button);};
  if(post.own){
    option('แก้ไขโพสต์',()=>openEditPost(post));
    const restoring=targetView==='archive';
    option(restoring?'นำกลับไปเผยแพร่':'ย้ายเข้าคลัง',async button=>{button.disabled=true;try{await call(restoring?'post-restore':'post-archive',{id:post.id});status.textContent=t(restoring?'นำโพสต์กลับไปเผยแพร่แล้ว':'เก็บเข้าคลังแล้ว คนอื่นจะไม่เห็นโพสต์นี้');await loadFeed();}catch(error){showError(error);}finally{button.disabled=false;}});
    option('ลบ',()=>{deletePostId=post.id;$('delete-post-status').textContent='';$('delete-post-dialog').showModal();},true);
  }else{
    if(isStaff() && post.canDelete!==false)option('ลบโพสต์',()=>openModeration('post-delete',{id:post.id},'ลบโพสต์นี้?','โพสต์จะถูกลบถาวร และไม่อยู่ในคลัง'),true);
    option('รายงาน',()=>openReport(post.id));
    option(post.saved?'ยกเลิกบันทึก':'บันทึก',async button=>{button.disabled=true;try{await call('post-save',{id:post.id,saved:!post.saved});status.textContent=t(post.saved?'ยกเลิกบันทึกโพสต์แล้ว':'บันทึกโพสต์แล้ว');await loadFeed();}catch(error){showError(error);}finally{button.disabled=false;}});
  }
  menu.append(summary,options);tools.append(category,menu);return tools;
}
document.addEventListener('click',event=>{if(currentPostMenu && !currentPostMenu.contains(event.target)){currentPostMenu.open=false;currentPostMenu=null;}});
function clearRetained(){postEditVersion++;releaseUrls(postEditUrls);retainedMedia=[];$('existing-media').replaceChildren();}
function renderRetained(){
  const version=++postEditVersion;releaseUrls(postEditUrls);$('existing-media').replaceChildren();
  for(const item of retainedMedia){
    const row=document.createElement('div'),media=mediaElement(item.type),remove=document.createElement('button');
    remove.type='button';remove.textContent=t('นำไฟล์นี้ออก');remove.addEventListener('click',()=>{if(posting)return;retainedMedia=retainedMedia.filter(file=>file.id!==item.id);renderRetained();});
    row.append(media,remove);$('existing-media').append(row);
    (async()=>{try{const response=await fetch('/api/media?id='+encodeURIComponent(item.id),{headers:{Authorization:'Bearer '+await sdk.auth.currentUser.getIdToken()}});if(!response.ok)throw new Error();const blob=await response.blob();if(version!==postEditVersion || !media.isConnected)return;const url=URL.createObjectURL(blob);postEditUrls.push(url);media.src=url;}catch{if(version===postEditVersion)media.alt=t('โหลดไฟล์แนบไม่ได้');}})();
  }
}
function openEditPost(post){
  if(posting)return;resetFiles();clearRetained();editingPost=post;retainedMedia=[...(post.media || [])];
  $('post-heading').textContent=t('แก้ไขโพสต์');$('post-text').value=post.text || '';$('post-category').value=post.category || '';$('post-status').textContent='';
  updatePostCategories();$('post-dialog').showModal();renderRetained();updatePostCooldown();$('post-text').focus();
}
$('cancel-delete-post').addEventListener('click',()=>{if(!deletingPost)$('delete-post-dialog').close();});
$('delete-post-dialog').addEventListener('cancel',event=>{if(deletingPost)event.preventDefault();});
$('confirm-delete-post').addEventListener('click',async()=>{
  if(deletingPost || !deletePostId)return;deletingPost=true;$('confirm-delete-post').disabled=true;
  try{await call('post-delete',{id:deletePostId});$('delete-post-dialog').close();status.textContent=t('ลบโพสต์แล้ว');await loadFeed();}
  catch(error){$('delete-post-status').textContent=localizeError(error.message);}
  finally{deletingPost=false;$('confirm-delete-post').disabled=false;}
});
function bindMessageDialog(prefix,action,emptyMessage,successMessage){
  let sending=false;
  $('open-'+prefix).addEventListener('click',()=>{
    if(sending)return;
    
    $(prefix+'-status').textContent='';$(prefix+'-dialog').showModal();$(prefix+'-details').focus();
  });
  $('cancel-'+prefix).addEventListener('click',()=>{if(!sending)$(prefix+'-dialog').close();});
  $(prefix+'-dialog').addEventListener('cancel',event=>{if(sending)event.preventDefault();});
  $(prefix+'-form').addEventListener('submit',async event=>{
    event.preventDefault();if(sending)return;
    const details=$(prefix+'-details').value.trim();
    if(!details){$(prefix+'-status').textContent=t(emptyMessage);return;}
    if(details.length>2000){$(prefix+'-status').textContent=t('อธิบายเพิ่มเติมได้ไม่เกิน 2,000 ตัวอักษร');return;}
    sending=true;$(prefix+'-fields').disabled=true;$(prefix+'-status').textContent=t('กำลังส่งรายงาน…');
    try{await call(action,{details});$(prefix+'-dialog').close();$(prefix+'-details').value='';status.textContent=t(successMessage);}
    catch(error){$(prefix+'-status').textContent=localizeError(error.message);}
    finally{sending=false;$(prefix+'-fields').disabled=false;}
  });
}
bindMessageDialog('usage-report','usage-report-create','กรุณาอธิบายปัญหาการใช้งาน','ส่งรายงานปัญหาให้ Dev แล้ว');
bindMessageDialog('contact-admin','contact-admin-create','กรุณาเขียนข้อความที่ต้องการติดต่อ','ส่งข้อความให้ Dev และ Admin แล้ว');
function openReport(postId,commentId=null){
  if(reporting)return;reportPostId=postId;reportCommentId=commentId;$('report-heading').textContent=t(commentId?'รายงานคอมเมนต์':'รายงานโพสต์');
  $('report-reason').value='';$('report-details').value='';$('report-status').textContent='';$('report-dialog').showModal();
}
$('cancel-report').addEventListener('click',()=>{if(!reporting)$('report-dialog').close();});
$('report-dialog').addEventListener('cancel',event=>{if(reporting)event.preventDefault();});
$('report-form').addEventListener('submit',async event=>{
  event.preventDefault();if(reporting || !reportPostId)return;reporting=true;$('report-fields').disabled=true;$('report-status').textContent=t('กำลังส่งรายงาน…');
  try{await call('report-create',{id:reportPostId,...(reportCommentId?{commentId:reportCommentId}:{}),reason:$('report-reason').value,details:$('report-details').value});$('report-dialog').close();status.textContent=t('ส่งรายงานให้ PunJa @Admin1 แล้ว');}
  catch(error){$('report-status').textContent=localizeError(error.message);}
  finally{reporting=false;$('report-fields').disabled=false;}
});
$('open-saved').addEventListener('click',()=>{switchView('saved');});
async function refreshSaved(){
  if(view!=='saved' || document.hidden || loading || $('feed').getAttribute('aria-busy')==='true')return;
  const version=feedVersion;
  try{const data=await call('saved-list');if(view==='saved' && version===feedVersion && JSON.stringify(data.posts)!==savedSignature){activeFeedMediaVersion=++feedVersion;releaseUrls(feedUrls);releaseUrls(feedPhotoUrls);renderPosts(data.posts,'saved');savedSignature=JSON.stringify(data.posts);}}
  catch(error){if(view==='saved' && version===feedVersion)$('feed-status').textContent=localizeError(error.message);}
}
let reportsCategory='post';
const reportsCategories={post:'โพสต์',comment:'คอมเมนต์',appeal:'คำร้องจากผู้ถูก Ban',general:'ทั่วไป',usage:'ปัญหาการใช้งาน'};
function updateReportCategories(){
  const reset=reportsCategory==='usage' && profile?.role!=='dev';
  if(reset){reportsCategory='post';reportsVersion++;$('reports-list').replaceChildren();}
  $('reports-category-usage').hidden=profile?.role!=='dev';
  for(const category of Object.keys(reportsCategories))$('reports-category-'+category).setAttribute('aria-pressed',String(category===reportsCategory));
  return reset;
}
for(const category of Object.keys(reportsCategories))$('reports-category-'+category).addEventListener('click',()=>{
  if(category==='usage' && profile?.role!=='dev')return;
  reportsCategory=category;updateReportCategories();return loadReports();
});
async function loadReports(){
  if(!profile.canReceiveReports)return;
  updateReportCategories();
  const version=++reportsVersion;$('reports-status').textContent=t('กำลังโหลด…');$('reports-list').replaceChildren();
  try{const data=await call('reports-list',{category:reportsCategory});if(version!==reportsVersion || !$('reports-dialog').open)return;
    for(const report of data.reports){
      const article=document.createElement('article'),heading=document.createElement('h3'),reason=document.createElement('p'),post=document.createElement('blockquote'),details=document.createElement('p'),time=document.createElement('p');
      heading.textContent=t('รายงานจาก ')+report.reporter.displayName+(report.reporter.handle?' @'+report.reporter.handle:'');const messageReport=['usage','appeal','general'].includes(report.kind);reason.textContent=t(messageReport?reportsCategories[report.kind]:report.reason==='spam'?'สแปม':'ไม่เหมาะสม');
      if(messageReport)post.hidden=true;
      else{const target=report.comment || report.post;post.textContent=(report.comment?t('รายงานคอมเมนต์')+'\n':'')+target.displayName+(target.handle?' @'+target.handle:'')+'\n'+target.text;}
      post.className=details.className='post-content';details.textContent=report.details;time.className='post-time';time.textContent=report.createdAt?new Date(report.createdAt).toLocaleString(dateLocale()):'';
      const header=document.createElement('div');header.className='report-card-header';header.append(heading);
      if(isStaff()){
        const tools=document.createElement('div');tools.className='report-tools';
        const entries=[];
        if(!messageReport)entries.push(['ไปที่โพสต์',()=>{$('reports-dialog').close();openSocial('comments',report.post.id,report.comment?.id || null);}]);
        entries.push(['ลบ',async()=>{try{await call('report-delete',{id:report.id});await loadReports();}catch(error){$('reports-status').textContent=localizeError(error.message);}},true]);
        staffMenu(tools,entries,'เมนูรายงาน');header.append(tools);
      }
      article.append(header,reason,post,details,time);$('reports-list').append(article);
    }
    $('reports-status').textContent=data.reports.length?'':t('ยังไม่มีรายงานในหมวดนี้');
  }catch(error){if(version===reportsVersion && $('reports-dialog').open)$('reports-status').textContent=localizeError(error.message);}
}
let moderationTimer=null,moderationReadyAt=0,moderationPending=null,moderationBusy=false,moderationVersion=0;
function stopModerationTimer(){if(moderationTimer!==null)clearInterval(moderationTimer);moderationTimer=null;}
async function openModeration(operation,data,title,description){
  if(moderationBusy)return;
  const version=++moderationVersion;stopModerationTimer();moderationPending=null;
  $('moderation-heading').textContent=t(title);$('moderation-description').textContent=t(description);
  const needsReason=['user-ban','post-delete'].includes(operation);
  const reasonLabel=operation==='post-delete'?'เหตุผลที่ลบโพสต์':'เหตุผลที่แบน';
  const reasonPlaceholder=operation==='post-delete'?'อธิบายเหตุผลที่ลบโพสต์':'อธิบายเหตุผลที่แบน';
  $('moderation-reason-field').hidden=!needsReason;$('moderation-reason').value='';$('moderation-reason').disabled=false;
  $('moderation-reason-label').textContent=t(reasonLabel);$('moderation-reason-label').setAttribute('data-i18n',reasonLabel);
  $('moderation-reason').placeholder=t(reasonPlaceholder);$('moderation-reason').setAttribute('data-i18n-placeholder',reasonPlaceholder);
  $('moderation-status').textContent=t('กำลังเตรียมการยืนยัน…');
  $('moderation-confirm').disabled=true;$('moderation-confirm').textContent=t('แน่ใจ');$('moderation-cancel').disabled=false;
  $('moderation-dialog').showModal();
  try{
    const result=await call('moderation-confirm',{operation,...data});
    if(version!==moderationVersion || !$('moderation-dialog').open)return;
    moderationPending={operation,data,confirmation:result.confirmation};moderationReadyAt=Date.now()+3000;
    $('moderation-status').textContent='';
    const update=()=>{const seconds=Math.max(0,Math.ceil((moderationReadyAt-Date.now())/1000));$('moderation-confirm').disabled=seconds>0 || moderationBusy;$('moderation-confirm').textContent=seconds?t('แน่ใจ')+' ('+seconds+')':t('แน่ใจ');if(!seconds)stopModerationTimer();};
    update();moderationTimer=setInterval(update,100);
  }catch(error){if(version===moderationVersion)$('moderation-status').textContent=localizeError(error.message);}
}
$('moderation-cancel').addEventListener('click',()=>{if(!moderationBusy)$('moderation-dialog').close();});
$('moderation-dialog').addEventListener('cancel',event=>{if(moderationBusy)event.preventDefault();});
$('moderation-dialog').addEventListener('close',()=>{moderationVersion++;stopModerationTimer();moderationPending=null;});
$('moderation-confirm').addEventListener('click',async()=>{
  if(moderationBusy || !$('moderation-dialog').open || !moderationPending || Date.now()<moderationReadyAt)return;
  const pending=moderationPending;const reason=['user-ban','post-delete'].includes(pending.operation)?$('moderation-reason').value.trim():null;
  if(pending.operation==='post-delete' && !reason){$('moderation-status').textContent=t('กรุณาอธิบายเหตุผลที่ลบโพสต์');$('moderation-reason').focus();return;}
  moderationBusy=true;$('moderation-reason').disabled=true;$('moderation-confirm').disabled=true;$('moderation-cancel').disabled=true;
  try{
    await call(pending.operation,{...pending.data,confirmation:pending.confirmation,...(reason!==null?{reason}:{})});
    $('moderation-dialog').close();
    status.textContent=t(pending.operation==='post-delete'?'ลบโพสต์แล้ว':pending.operation==='user-ban'?'แบนผู้ใช้แล้ว':'ลบรายชื่อแล้ว');
    if($('restricted-dialog').open)await loadRestricted();
    if(pending.operation==='post-delete' && view==='author' && !authorHandle)switchView('home');else await loadFeed();
  }catch(error){$('moderation-status').textContent=localizeError(error.message);}
  finally{moderationBusy=false;$('moderation-reason').disabled=false;$('moderation-cancel').disabled=false;$('moderation-confirm').disabled=false;}
});
function staffMenu(container,entries,label){
  container.replaceChildren();const menu=document.createElement('details');menu.className='post-menu';
  const summary=document.createElement('summary');summary.className='post-more';summary.textContent='⋮';summary.setAttribute('aria-label',t(label));
  summary.addEventListener('click',()=>{if(currentPostMenu && currentPostMenu!==menu)currentPostMenu.open=false;currentPostMenu=menu;});
  menu.addEventListener('keydown',event=>{if(event.key==='Escape'){menu.open=false;summary.focus();}});
  const options=document.createElement('div');options.className='post-menu-options';
  if(container.className==='comment-tools')menu.addEventListener('toggle',()=>{
    if(!menu.open || !summary.getBoundingClientRect || !$('comments-scroll').getBoundingClientRect)return;
    menu.classList.remove('menu-up');
    const edge=$('comments-scroll').getBoundingClientRect(),button=summary.getBoundingClientRect(),height=options.getBoundingClientRect().height;
    const above=button.top-edge.top-4,below=edge.bottom-button.bottom-4;
    const upwards=height>below && above>below;menu.classList.toggle('menu-up',upwards);
    options.style.maxHeight=Math.max(40,upwards?above:below)+'px';options.style.overflowY='auto';
  });
  for(const [text,action,danger] of entries){const button=document.createElement('button');button.type='button';button.textContent=t(text);if(danger)button.className='danger-action';button.addEventListener('click',async()=>{menu.open=false;button.disabled=true;try{await action();}catch(error){showError(error);}finally{button.disabled=false;}});options.append(button);}
  menu.append(summary,options);container.append(menu);
}
function renderAuthorTools(person){
  roleBadge($('author-role'),person.role);const management=person.management,entries=[];
  if(isStaff() && management){
    if(profile.canManageRoles && management.canManageRoles){
      const changeRole=async role=>{await call(role?'role-grant':'role-revoke',{targetUid:management.targetUid,...(role?{role}:{})});await loadFeed();};
      if(person.role==='admin')entries.push(['Delete Admin',()=>changeRole(null),true]);
      else if(person.role==='merchant')entries.push(['Delete Trader',()=>changeRole(null),true]);
      else entries.push(['Give Admin',()=>changeRole('admin')],['Give Trader',()=>changeRole('merchant')]);
    }else if(profile.canGrantMerchant && management.canGrantMerchant && !person.role){
      entries.push(['Give Trader',async()=>{await call('role-grant',{targetUid:management.targetUid,role:'merchant'});await loadFeed();}]);
    }
    if(management.canBan)entries.push([management.banned?'ปลดแบน':'Ban',()=>management.banned?unban(management.targetUid):openModeration('user-ban',{targetUid:management.targetUid},'แบนผู้ใช้นี้?','ผู้ใช้จะเข้าสู่ระบบและใช้งานไม่ได้'),true]);
  }
  $('author-tools').hidden=!entries.length;staffMenu($('author-tools'),entries,'จัดการผู้ใช้');
}
async function unban(targetUid){await call('user-unban',{targetUid});status.textContent=t('ปลดแบนแล้ว');if($('restricted-dialog').open)await loadRestricted();if(view==='author')await loadFeed();}
let restrictedVersion=0;
async function loadRestricted(){
  const version=++restrictedVersion;$('restricted-status').textContent=t('กำลังโหลดรายชื่อ…');$('restricted-list').replaceChildren();
  try{
    const result=await call('restricted-list');if(version!==restrictedVersion || !$('restricted-dialog').open)return;
    for(const person of result.users){
      const row=document.createElement('article');row.className='restricted-user';const info=document.createElement('div'),name=document.createElement('strong'),handle=document.createElement('p'),state=document.createElement('span');
      name.textContent=person.displayName;handle.textContent=person.handle?'@'+person.handle:'';state.className='ban-status';state.textContent=t('โดนแบน');info.append(name,handle,state);
      if(person.reason){const reason=document.createElement('p');reason.className='ban-reason';reason.textContent=t('เหตุผล: ')+person.reason;info.append(reason);}
      const tools=document.createElement('div');staffMenu(tools,[['ปลดแบน',()=>unban(person.uid)],['ลบรายชื่อ',()=>openModeration('restricted-remove',{targetUid:person.uid},'ลบรายชื่อนี้?','ลบเฉพาะรายชื่อ บัญชีนี้ยังถูกแบนอยู่'),true]],'จัดการผู้ใช้');row.append(info,tools);$('restricted-list').append(row);
    }
    $('restricted-status').textContent=result.users.length?'':t('ยังไม่มีผู้ใช้ที่ถูกจำกัด');
  }catch(error){if(version===restrictedVersion)$('restricted-status').textContent=localizeError(error.message);}
}
$('open-restricted').addEventListener('click',()=>{if(!isStaff())return;$('restricted-dialog').showModal();loadRestricted();});
$('close-restricted').addEventListener('click',()=>{$('restricted-dialog').close();restrictedVersion++;});
$('refresh-restricted').addEventListener('click',loadRestricted);
$('open-settings').addEventListener('click',refreshPermissions);
document.addEventListener('visibilitychange',()=>{if(!document.hidden){refreshPermissions();if(profile && !loading)checkPostNotice();}});
setInterval(refreshPermissions,30000);
$('open-reports').addEventListener('click',()=>{if(!profile.canReceiveReports)return;$('reports-dialog').showModal();loadReports();});
$('refresh-reports').addEventListener('click',loadReports);
$('close-reports').addEventListener('click',()=>{reportsVersion++;$('reports-dialog').close();});
$('reports-dialog').addEventListener('close',()=>{reportsVersion++;});

$('back-feed').addEventListener('click', () => switchView('home'));
$('home').addEventListener('click', () => switchView('home'));
$('me').addEventListener('click', () => switchView('me'));
$('retry').addEventListener('click', load);
$('open-settings').addEventListener('click', () => { switchView('settings'); $('settings-heading').focus(); });
$('language').value = getLanguage();
$('language').addEventListener('change', () => {
  const language = $('language').value;
  if (language === getLanguage()) return;
  try { setLanguage(language); location.reload(); }
  catch { $('language').value = getLanguage(); status.textContent = t('บันทึกภาษาไม่ได้ กรุณาอนุญาตให้เบราว์เซอร์เก็บการตั้งค่าแล้วลองอีกครั้ง'); }
});
for (const theme of ['light', 'dark']) {
  $('theme-' + theme).addEventListener('click', () => {
    setTheme(theme, true);
    try { localStorage.setItem(themeKey(), theme); }
    catch { status.textContent = t('เปลี่ยนธีมแล้ว แต่เบราว์เซอร์ไม่อนุญาตให้จำการตั้งค่า'); }
  });
}
$('open-archive').addEventListener('click', () => {  switchView('archive'); });
const confirmLogout=createLogoutConfirmation({
  dialog:$('logout-dialog'),confirm:$('confirm-logout'),cancel:$('cancel-logout'),status:$('logout-status'),
  t,errorText:error=>localizeError(error.message),now:()=>Date.now(),schedule:setInterval,unschedule:clearInterval,
  logout:async()=>{await sdk.signOut(sdk.auth);location.replace('/');}
});
$('logout').addEventListener('click',confirmLogout);
$('open-post').addEventListener('click', () => { if(editingPost){editingPost=null;resetFiles();clearRetained();$('post-text').value='';$('post-category').value='';} $('post-heading').textContent=t('เขียนโพสต์'); updatePostCategories(); updatePostCooldown(); $('post-status').textContent = ''; $('post-dialog').showModal(); $('post-text').focus(); });
$('insert-post-hashtag').addEventListener('click', () => {
  if (posting) return;
  const input = $('post-text'), start = input.selectionStart, end = input.selectionEnd;
  const before = input.value.slice(0, start), selected = input.value.slice(start, end), after = input.value.slice(end);
  const leadingSpace = before && !/\s$/u.test(before) ? ' ' : '';
  const trailingSpace = selected && after && !/\s/u.test(after[0]) ? ' ' : '';
  const inserted = leadingSpace + '#' + selected + trailingSpace;
  if (input.value.length - selected.length + inserted.length > input.maxLength) {
    $('post-status').textContent = t('กรุณาพิมพ์ข้อความไม่เกิน 5,000 ตัวอักษร'); input.focus(); return;
  }
  input.setRangeText(inserted, start, end, 'end'); input.focus();
});
$('cancel-post').addEventListener('click', () => $('post-dialog').close());
$('post-dialog').addEventListener('cancel', event => { if (posting) event.preventDefault(); });
$('post-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (posting) return;
  const remaining = updatePostCooldown();
  if (remaining) { $('post-status').textContent = t('กรุณารออีก {seconds} วินาทีก่อนโพสต์ถัดไป', { seconds: remaining }); return; }
  const category = $('post-category').value;
  if (!Object.values(categoryButtons).filter(label => label !== 'ทั้งหมด').includes(category)) { $('post-status').textContent = t('กรุณาเลือกหมวดหมู่โพสต์'); return; }
  if (sdk.auth.currentUser.isAnonymous && !['ทั่วไป', 'ถาม-ตอบ'].includes(category)) { $('post-status').textContent = t('หากต้องการ Post หมวดหมู่ที่ถูกล็อกไว้ กรุณา Login'); return; }
  if(category==='ประกาศ' && !['dev','admin'].includes(profile?.role)){ $('post-status').textContent=t('เฉพาะ Admin และ Dev เท่านั้นที่โพสต์ประกาศได้');return;}
  const text = $('post-text').value.trim();
  if (!text && !selectedFiles.length) { $('post-status').textContent = t('กรุณาพิมพ์ข้อความหรือแนบรูปภาพ/วิดีโอ'); return; }
  posting = true;
  $('submit-post').disabled = $('cancel-post').disabled = $('post-files').disabled = $('clear-files').disabled = $('insert-post-hashtag').disabled = true;
  try {
    for (let index = uploadedFiles.length; index < selectedFiles.length; index++) {
      $('post-status').textContent = t('กำลังอัปโหลดไฟล์ {current}/{total}', { current: index + 1, total: selectedFiles.length });
      const file = selectedFiles[index];
      const result = await uploadMedia(file,sdk.auth.currentUser);
      uploadedFiles.push(result.id);
    }
    $('post-status').textContent = t('กำลังบันทึกโพสต์…');
    const wasEditing=Boolean(editingPost);
    const result = await call(wasEditing?'post-update':'post-create', { ...(wasEditing?{id:editingPost.id}:{}), text, category, mediaIds: [...retainedMedia.map(item=>item.id),...uploadedFiles] });
    if(!wasEditing){profile.postCooldownExempt = result.postCooldownExempt ?? profile.postCooldownExempt;profile.postAvailableAt = result.postAvailableAt ?? Date.now() + 60000;setPostCooldown(profile.postAvailableAt);}
    editingPost=null;clearRetained();
    resetFiles();
    $('post-text').value = '';
    $('post-category').value = '';
    if (view === 'home' && selectedCategory !== 'ทั้งหมด' && selectedCategory !== category) {
      selectedCategory = category;
    closeFilter();
    $('toggle-filter').focus();
      for (const [id, label] of Object.entries(categoryButtons)) $(id).setAttribute('aria-pressed', String(label === category));
      $('feed-heading').textContent = t('ฟีดโพสต์ · ') + t(category);
    }
    $('post-dialog').close();
    status.textContent = t(wasEditing?'แก้ไขโพสต์แล้ว':'โพสต์แล้ว');
    await loadFeed();
  } catch (error) {
    if (error.status === 429 && error.retryAfter) { profile.postCooldownExempt = false; profile.postAvailableAt = Date.now() + error.retryAfter * 1000; setPostCooldown(profile.postAvailableAt); }
    $('post-status').textContent = localizeError(error.message);
  }
  finally { posting = false; $('cancel-post').disabled = $('post-files').disabled = $('clear-files').disabled = $('insert-post-hashtag').disabled = false; updatePostCooldown(); }
});
$('edit-profile').addEventListener('click', () => {
  $('edit-name').value = profile.displayName;
  $('edit-handle').value = profile.handle || '';
  $('handle-fields').hidden = profile.isGuest;
  const now = Date.now();
  const remaining = profile.nicknameResetAt && now >= profile.nicknameResetAt ? 3 : Math.max(0, 3 - (profile.nicknameChanges || 0));
  $('nickname-limit').textContent = remaining ? t('เปลี่ยนไปได้อีก {count} ครั้ง', { count: remaining }) : t('เปลี่ยนใหม่ได้ใน {days} วัน', { days: Math.max(1, Math.ceil((profile.nicknameResetAt - now) / 86400000)) });
  $('edit-name').readOnly = remaining === 0;
  const handleLocked = profile.handleAvailableAt && now < profile.handleAvailableAt;
  $('edit-handle').readOnly = Boolean(handleLocked);
  $('handle-limit').textContent = handleLocked ? t('เปลี่ยนใหม่ได้ใน {days} วัน', { days: Math.max(1, Math.ceil((profile.handleAvailableAt - now) / 86400000)) }) : t('เปลี่ยนไปได้อีก {count} ครั้ง', { count: 1 });
  $('edit-bio').value = profile.bio || '';
  clearPhotoDraft();
  $('remove-photo').checked = false;
  $('photo-fields').hidden = profile.isGuest;
  $('guest-photo-note').hidden = !profile.isGuest;
  loadAvatar($('photo-preview'), profile.isGuest ? null : profile.photoMediaId, editPhotoUrls);
  $('edit-status').textContent = '';
  $('edit-dialog').showModal();
});
$('cancel-edit').addEventListener('click', () => $('edit-dialog').close());
$('edit-dialog').addEventListener('cancel', event => { if (editing) event.preventDefault(); });
$('edit-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (editing) return;
  editing = true;
  $('edit-fields').disabled = true;
  try {
    let photoMediaId = profile.isGuest || $('remove-photo').checked ? null : profile.photoMediaId || null;
    if (!profile.isGuest && !$('remove-photo').checked && selectedPhoto) {
      if (!uploadedPhotoId) {
        $('edit-status').textContent = t('กำลังอัปโหลดรูปโปรไฟล์…');
        const result = await uploadMedia(selectedPhoto,sdk.auth.currentUser);
        uploadedPhotoId = result.id;
      }
      photoMediaId = uploadedPhotoId;
    }
    profile = await call('profile-update', { displayName: $('edit-name').value, bio: $('edit-bio').value, photoMediaId, ...(profile.isGuest ? {} : { handle: $('edit-handle').value }) });
    clearPhotoDraft();
    renderProfile();
    $('edit-dialog').close();
    status.textContent = t('บันทึกโปรไฟล์แล้ว');
    await loadFeed();
  } catch (error) { $('edit-status').textContent = localizeError(error.message); }
  finally { editing = false; $('edit-fields').disabled = false; }
});
try {
  sdk = await connect();
  sdk.onAuthStateChanged(sdk.auth, user => {
    if (!user) { $('app').hidden = true; if (!redirecting) location.replace('/'); }
    else load();
  });
} catch (error) { finishInitialLoading(); showError(error); }


$('close-moderation').addEventListener('click',()=>$('moderation-cancel').click());
$('close-logout').addEventListener('click',()=>$('cancel-logout').click());
