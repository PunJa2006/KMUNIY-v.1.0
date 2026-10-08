import { createLogoutConfirmation } from '../public/logout-confirmation.js';
import { createSearchHistory } from '../public/search-history.js';
import { hashtagParts } from '../public/hashtags.js';
import { t, localizeError, dateLocale } from '../public/i18n.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
async function fixture({ guest = false, completed = true, posts = [], respond = null, cooldown = 0, language = 'th', languageStorageFails = false, admin = false, role = null } = {}) {
  const fields = new Map(), storage = new Map(), calls = [];
  const element = id => {
    if (!fields.has(id)) fields.set(id, { hidden: false, value: '', maxLength:5000, selectionStart:0, selectionEnd:0, setRangeText(text,start,end){this.value=this.value.slice(0,start)+text+this.value.slice(end);this.selectionStart=this.selectionEnd=start+text.length;}, dataset: {}, children: [], handlers: {}, getAttribute(name) { return this[name]; }, setAttribute(name, value) { this[name] = value; }, addEventListener(name, fn) { this.handlers[name] = fn; }, append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; }, showModal() { this.open = true; }, close() { this.open = false; }, focus() { this.focusCalls = (this.focusCalls || 0) + 1; } });
    return fields.get(id);
  };
  const user = { uid: 'owner', isAnonymous: guest };
  let callback; const timers=new Map(); let nextTimer=1;
  let clock = Date.now();
  class MockDate extends Date { static now() { return clock; } }
  const context = {
    createLogoutConfirmation, createSearchHistory, hashtagParts, t: (source, values) => t(source, values, language), localizeError: message => localizeError(message, language), dateLocale: () => dateLocale(language), getLanguage: () => language, setLanguage: value => { if(languageStorageFails) throw new Error('storage blocked'); storage.set('community-language', value); language = value; },
    Date: MockDate, setInterval: (fn,period) => { const id=nextTimer++; timers.set(id,{fn,period,next:clock+period});return id; }, clearInterval: id => timers.delete(id),
    setTimeout: (fn,period) => {const id=nextTimer++;timers.set(id,{fn,period,next:clock+period,once:true});return id;}, clearTimeout:id=>timers.delete(id),
    document: { addEventListener() {}, getElementById: element, documentElement: { dataset: {} }, createElement: name => element('dynamic-' + Math.random()) },
    status: {}, showError: error => { throw error; }, location: { replace: url => calls.push(url), reload: () => calls.push('reload') },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    connect: async () => ({ auth: { currentUser: user }, onAuthStateChanged: (_, fn) => { callback = fn; }, signOut: async () => {calls.push({action:'signOut'});} }),
    api: async (action, data) => { calls.push({ action, data }); if (respond && !['profile-read','profile'].includes(action)) return respond(action,data); return ['profile-read', 'profile'].includes(action) ? { role, canManageRoles:role==='dev', canModerate:admin || ['dev','admin'].includes(role), canReceiveReports:admin || ['dev','admin'].includes(role), canGrantMerchant:['dev','admin'].includes(role), postCooldownExempt:['dev','admin','merchant'].includes(role), profileCompleted: completed, displayName: 'Owner', username: guest ? null : 'owner', handle: guest ? null : 'public1', isGuest: guest, email: null, postAvailableAt: cooldown } : { posts }; }
  };
  const source = (await readFile(new URL('../public/main.js', import.meta.url), 'utf8')).replace(/^\uFEFF?import .*;\r?\n/gm, '');
  await runInNewContext(`(async () => { ${source} })()`, context);
  callback(user);
  await new Promise(resolve => setImmediate(resolve));
  const click = async id => { await element(id).handlers.click(); await new Promise(resolve => setImmediate(resolve)); };
  return { element, click, storage, calls, context, advanceTime: ms => { clock += ms; for(const [id,item] of [...timers.entries()])if(clock>=item.next){if(item.once)timers.delete(id);else item.next=clock+item.period;item.fn();} } };
}
test('settings contains theme and archive; Me loads personal posts and profile', async () => {
  const f = await fixture();
  await f.click('open-settings');
  assert.equal(f.element('settings-page').hidden, false);
  assert.equal(f.element('feed-view').hidden, true);
  assert.equal(f.element('open-settings')['aria-current'], 'page');
  await f.click('theme-dark');
  assert.equal(f.element('theme-dark')['aria-pressed'], 'true');
  assert.equal(f.element('theme-light')['aria-pressed'], 'false');
  assert.equal(f.context.document.documentElement.dataset.theme, 'dark');
  assert.equal(f.storage.get('community-theme:owner'), 'dark');
  await f.click('open-archive');
  assert.equal(f.element('settings-page').hidden, true);
  assert.equal(f.calls.at(-1).action, 'archive-list');
  assert.equal(f.element('me-profile').hidden, true);
  await f.click('me');
  assert.equal(f.calls.at(-1).action, 'my-posts');
  assert.equal(f.element('me-profile').hidden, false);
  assert.equal(f.element('university-announcement').hidden, true);
  assert.equal(f.element('feed-heading').hidden, false);
  assert.equal(f.element('display-name').textContent, 'Owner');
  await f.click('home');
  assert.equal(f.calls.at(-1).action, 'posts-list');
  assert.equal(f.element('me-profile').hidden, true);
});
test('posting opens a dialog and closing keeps draft text', async () => {
  const f = await fixture();
  await f.click('open-post');
  assert.equal(f.element('post-dialog').open, true);
  f.element('post-text').value = 'draft';
  await f.click('cancel-post');
  assert.equal(f.element('post-dialog').open, false);
  assert.equal(f.element('post-text').value, 'draft');
});

test('home category buttons request matching feeds and remember selection after visiting Me', async () => {
  const f = await fixture();
  await f.click('category-market');
  assert.equal(f.calls.at(-1).action, 'posts-list');
  assert.equal(f.calls.at(-1).data.category, 'ขายของ');
  assert.equal(f.element('category-market')['aria-pressed'], 'true');
  assert.equal(f.element('category-all')['aria-pressed'], 'false');
  await f.click('me');
  assert.equal(f.element('filter-controls').hidden, true);
  await f.click('home');
  assert.equal(f.element('filter-controls').hidden, false);
  assert.equal(f.calls.at(-1).data.category, 'ขายของ');
  await f.click('category-all');
  assert.equal(f.calls.at(-1).data.category, 'ทั้งหมด');
});
test('posting requires a category before making any upload or post request', async () => {
  const f = await fixture();
  f.element('post-text').value = 'hello';
  await f.element('post-form').handlers.submit({ preventDefault() {} });
  assert.equal(f.element('post-status').textContent, 'กรุณาเลือกหมวดหมู่โพสต์');
  assert.equal(f.calls.some(item => item.action === 'post-create'), false);
});

test('Guest uses default photo and cannot see photo picker', async () => {
  const f = await fixture({ guest: true });
  assert.equal(f.element('avatar').src, 'default-avatar.svg');
  await f.click('edit-profile');
  assert.equal(f.element('photo-fields').hidden, true);
  assert.equal(f.element('guest-photo-note').hidden, false);
});

test('direct Main navigation redirects an incomplete member to setup before loading feed', async () => {
  const f = await fixture({ completed: false });
  assert.ok(f.calls.includes('/setup-profile.html'));
  assert.equal(f.calls.some(item => item.action === 'posts-list'), false);
});


test('post buttons toggle a like and open identity list and comments with safe text', async () => {
  const post={id:'p1',displayName:'Member',text:'parent',category:'ถาม-ตอบ',media:[],likeCount:0,commentCount:1,liked:false};
  let comments=[{id:'c1',displayName:'Other',handle:'other1',text:'<img onerror=bad>',createdAt:null}];
  const f=await fixture({posts:[post],respond:async(action,data)=>{
    if(action==='posts-list') return {posts:[post]};
    if(action==='post-like') return {liked:data.liked,likeCount:data.liked?1:0};
    if(action==='post-detail') return {post:{...post,archived:false},likes:[{displayName:'Other',handle:'other1'}],comments};
    if(action==='comment-create') { comments=[{id:'c2',displayName:'Owner',text:data.text},...comments]; post.commentCount++; return {saved:true}; }
  }});
  const article=f.element('feed').children[0];
  const actions=article.children.find(item=>item.children?.some(child=>child.textContent==='ดูคนที่กดใจ'));
  const [heart,people,comment]=actions.children;
  await heart.handlers.click(); assert.equal(heart['aria-pressed'],'true'); assert.equal(heart.textContent,'♥ ถูกใจแล้ว 1');
  await heart.handlers.click(); assert.equal(heart['aria-pressed'],'false'); assert.equal(heart.textContent,'♡ กดใจ 0');
  people.handlers.click(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.element('likes-dialog').open,true); assert.equal(f.element('likes-list').children[0].children[1].textContent,'Other @other1');
  await f.click('close-likes');
  comment.handlers.click(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.element('comments-dialog').open,true);
  assert.equal(f.element('comment-post').children[0].children.at(-1).textContent,'parent');
  assert.equal(f.element('comments-list').children[0].children.find(child=>child.className==='post-content').textContent,'<img onerror=bad>');
  assert.equal(f.element('comment-form').hidden,false);
  f.element('comment-text').value=' new comment ';
  await f.element('comment-form').handlers.submit({preventDefault(){}});
  assert.equal(f.calls.find(item=>item.action==='comment-create').data.text,'new comment');
  assert.equal(f.element('comment-text').value,''); assert.equal(f.element('comments-list').children.length,2);
  assert.equal(f.element('comments-dialog').open,true);
});
test('failed comment retains draft and archive comments hide entry form', async () => {
  let archived=false;
  const post={id:'p1',displayName:'Member',text:'post',media:[]};
  const f=await fixture({respond:async(action)=>{
    if(action==='posts-list') return {posts:[post]};
    if(action==='post-detail') return {post:{...post,archived},likes:[],comments:[]};
    if(action==='comment-create') throw new Error('connection lost');
  }});
  const action=f.element('feed').children[0].children.find(item=>item.children?.some(child=>child.textContent==='ดูคนที่กดใจ'));
  action.children[2].handlers.click(); await new Promise(resolve=>setImmediate(resolve));
  f.element('comment-text').value='draft';
  await f.element('comment-form').handlers.submit({preventDefault(){}});
  assert.equal(f.element('comment-text').value,'draft'); assert.equal(f.element('comments-status').textContent,'connection lost');
  assert.equal(f.element('send-comment').disabled,false);
  archived=true; await f.click('refresh-comments');
  assert.equal(f.element('comment-form').hidden,true);
});

test('clicking author photo opens public profile and their posts; home returns to feed', async()=>{
 const post={id:'p1',displayName:'Other',text:'post',media:[]};
 const f=await fixture({respond:async(action)=>{
  if(action==='author-profile') return {profile:{displayName:'Other',handle:'other1',bio:'About'},posts:[post]};
  return {posts:[post]};
 }});
 const button=f.element('feed').children[0].children[0];
 assert.equal(button['aria-label'],'ดูโปรไฟล์ของ Other');
 button.handlers.click(); await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.calls.at(-1).action,'author-profile'); assert.equal(f.calls.at(-1).data.id,'p1');
 assert.equal(f.element('author-profile').hidden,false);
 assert.equal(f.element('author-name').textContent,'Other'); assert.equal(f.element('author-handle').textContent,'@other1');
 assert.equal(f.element('author-bio').textContent,'About'); assert.equal(f.element('me-profile').hidden,true);
 await f.click('back-feed'); assert.equal(f.element('author-profile').hidden,true); assert.equal(f.calls.at(-1).action,'posts-list');
});

test('posting starts 60-second button countdown; draft is retained when retried early',async()=>{
 const f=await fixture({respond:async action=>action==='post-create'?{}:{posts:[]}});
 f.element('post-category').value='ถาม-ตอบ';f.element('post-text').value='first';
 await f.element('post-form').handlers.submit({preventDefault(){}});
 assert.equal(f.element('submit-post').disabled,true);assert.equal(f.element('submit-post').textContent,'โพสต์ได้ใน 60 วินาที');
 f.element('post-text').value='draft';
 await f.element('post-form').handlers.submit({preventDefault(){}});
 assert.equal(f.calls.filter(c=>c.action==='post-create').length,1);assert.equal(f.element('post-text').value,'draft');
 f.advanceTime(59000);assert.equal(f.element('submit-post').textContent,'โพสต์ได้ใน 1 วินาที');
 f.advanceTime(1000);assert.equal(f.element('submit-post').disabled,false);assert.equal(f.element('post-status').textContent,'');
});
test('cooldown returned by server preserves draft and disables submit across open/close',async()=>{
 const f=await fixture({respond:async action=>{if(action==='post-create')throw Object.assign(new Error('กรุณารออีก 30 วินาทีก่อนโพสต์ถัดไป'),{status:429,retryAfter:30});return {posts:[]};}});
 f.element('post-category').value='ถาม-ตอบ';f.element('post-text').value='draft';
 await f.element('post-form').handlers.submit({preventDefault(){}});
 assert.equal(f.element('post-text').value,'draft');assert.equal(f.element('submit-post').disabled,true);
 await f.click('cancel-post');await f.click('open-post');assert.equal(f.element('submit-post').textContent,'โพสต์ได้ใน 30 วินาที');
 f.advanceTime(30000);assert.equal(f.element('submit-post').disabled,false);
});

test('changing language saves preference and reloads the whole page; selecting it again does nothing', async () => {
  const f = await fixture();
  assert.equal(f.element('language').value, 'th');
  f.element('language').value = 'en';
  f.element('language').handlers.change();
  assert.equal(f.storage.get('community-language'), 'en');
  assert.equal(f.calls.filter(call => call === 'reload').length, 1);
  f.element('language').handlers.change();
  assert.equal(f.calls.filter(call => call === 'reload').length, 1);
});

test('blocked storage does not reload or falsely claim a language change', async () => {
  const f = await fixture({ languageStorageFails: true });
  f.element('language').value = 'en';
  f.element('language').handlers.change();
  assert.equal(f.element('language').value, 'th');
  assert.equal(f.calls.includes('reload'), false);
  assert.match(f.context.status.textContent, /บันทึกภาษาไม่ได้/);
});

test('English UI preserves user content and stored Thai category keys', async () => {
  const f = await fixture({ language: 'en', posts: [{ id:'p1', displayName:'สมชาย', text:'ข้อความของผู้ใช้', category:'ขายของ', media:[] }] });
  assert.equal(f.element('language').value, 'en');
  assert.equal(f.element('feed-status').textContent, '');
  assert.equal(f.element('feed-heading').hidden, true);
  assert.equal(f.element('university-announcement').hidden, false);
  const allText = element => [element.textContent || '', ...(element.children || []).map(allText)].join(' ');
  assert.match(allText(f.element('feed')), /สมชาย/);
  assert.match(allText(f.element('feed')), /ข้อความของผู้ใช้/);
  assert.match(allText(f.element('feed')), /Category:\s+Marketplace/);
  await f.click('category-market');
  assert.equal(f.calls.at(-1).data.category, 'ขายของ');
  assert.equal(f.element('feed-heading').textContent, 'Community feed · Marketplace');
});

test('search page lists trends and lets a result open a public profile without a post id',async()=>{
 const f=await fixture({respond:async(action)=>{
  if(action==='trending-tags')return {tags:[{tag:'kmutnb',count:3}]};
  if(action==='search-users')return {users:[{displayName:'Other',handle:'other1',photoId:null}]};
  if(action==='author-profile')return {profile:{displayName:'Other',handle:'other1',bio:'About'},posts:[]};
  return {posts:[]};
 }});
 await f.click('open-search');assert.equal(f.element('search-page').hidden,false);
 assert.equal(f.element('feed-view').hidden,true);
 assert.equal(f.element('open-search')['aria-current'],'page');
 assert.equal(f.element('home')['aria-current'],'false');
 assert.equal(f.element('search-input').focusCalls || 0,0);
 assert.equal(f.calls.filter(item=>item.action==='posts-list').length,1);
 assert.equal(f.element('trending-tags').children[0].children[0].children[0].textContent,'#kmutnb');
 f.element('search-input').value='@other';await f.element('search-form').handlers.submit({preventDefault(){}});
 assert.equal(f.calls.at(-1).action,'search-users');assert.equal(f.calls.at(-1).data.query,'@other');
 await f.element('search-results').children[0].handlers.click();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.element('search-page').hidden,true);assert.equal(f.calls.at(-1).action,'author-profile');assert.equal(f.calls.at(-1).data.handle,'other1');
 assert.equal(f.element('author-name').textContent,'Other');
});

test('trending and post hashtags filter the feed; title resets tag and category',async()=>{
 const f=await fixture({respond:async(action)=> action==='trending-tags'?{tags:[{tag:'kmutnb',count:2}]}:{posts:[{id:'p1',displayName:'Owner',text:'hello #KMUTNB',media:[]}]}});
 await f.click('open-search');await f.element('trending-tags').children[0].children[0].handlers.click();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.calls.at(-1).data.hashtag,'kmutnb');assert.equal(f.element('selected-hashtag').textContent,'#kmutnb');assert.equal(f.element('hashtag-filter').hidden,false);
 const text=f.element('feed').children[0].children.find(el=>el.className==='post-content');
 assert.equal(text.children[1].textContent,'#KMUTNB');assert.equal(text.children[1].className,'hashtag-link');
 await f.element('brand-home').handlers.click({preventDefault(){}});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.calls.at(-1).data.hashtag,undefined);assert.equal(f.element('hashtag-filter').hidden,true);
});

test('closed search page discards delayed trend response',async()=>{
 let resolveTrends;
 const f=await fixture({respond:async(action)=>action==='trending-tags'?new Promise(resolve=>resolveTrends=resolve):{posts:[]}});
 const pending=f.element('open-search').handlers.click();await f.click('home');
 resolveTrends({tags:[{tag:'late',count:9}]});await pending;
 assert.equal(f.element('trending-tags').children.length,0);
});

const findMenuOption=(f,label)=>{
 const options=f.element('feed').children[0].children.find(el=>el.className==='post-tools').children[1].children[1];
 return options.children.find(el=>el.textContent===label);
};
test('own three-dot menu edits during posting cooldown and submits update without creating another post',async()=>{
 const post={id:'p1',own:true,displayName:'Owner',text:'old',category:'ถาม-ตอบ',media:[]};
 const f=await fixture({cooldown:Date.now()+60000,respond:async(action)=>action==='post-update'?{updated:true}:{posts:[post]}});
 await findMenuOption(f,'แก้ไขโพสต์').handlers.click();
 assert.equal(f.element('post-heading').textContent,'แก้ไขโพสต์');assert.equal(f.element('post-text').value,'old');assert.equal(f.element('submit-post').disabled,false);
 f.element('post-text').value='edited';await f.element('post-form').handlers.submit({preventDefault(){}});
 const update=f.calls.find(call=>call.action==='post-update');assert.equal(update.data.id,'p1');assert.equal(update.data.text,'edited');assert.equal(f.calls.some(call=>call.action==='post-create'),false);
 assert.equal(f.element('post-dialog').open,false);assert.equal(f.element('submit-post').disabled,true);
});

test('other users’ menu reports and saves; saved view is accessible from settings',async()=>{
 const post={id:'p1',own:false,displayName:'Other',text:'post',media:[]};
 const f=await fixture({respond:async(action)=>['post-save','report-create'].includes(action)?{}:{posts:[post]}});
 assert.equal(findMenuOption(f,'แก้ไขโพสต์'),undefined);
 await findMenuOption(f,'รายงาน').handlers.click();assert.equal(f.element('report-dialog').open,true);
 f.element('report-reason').value='spam';f.element('report-details').value='explain';await f.element('report-form').handlers.submit({preventDefault(){}});
 assert.equal(f.calls.find(call=>call.action==='report-create').data.reason,'spam');assert.equal(f.element('report-dialog').open,false);
 await findMenuOption(f,'บันทึก').handlers.click();assert.equal(f.calls.find(call=>call.action==='post-save').data.saved,true);
 await f.click('open-saved');assert.equal(f.calls.at(-1).action,'saved-list');assert.equal(f.element('feed-heading').textContent,'โพสต์ที่บันทึกไว้');
});

test('deleting uses a confirmation dialog and report inbox appears only for the authorized account',async()=>{
 const post={id:'p1',own:true,displayName:'Owner',text:'post',media:[]};
 const f=await fixture({posts:[post]});await findMenuOption(f,'ลบ').handlers.click();assert.equal(f.calls.some(call=>call.action==='post-delete'),false);
 await f.click('confirm-delete-post');assert.equal(f.calls.find(call=>call.action==='post-delete').data.id,'p1');assert.equal(f.element('delete-post-dialog').open,false);
 assert.equal(f.element('open-reports').hidden,true);await f.click('open-reports');assert.equal(f.calls.some(call=>call.action==='reports-list'),false);
 const admin=await fixture({admin:true,respond:async action=>action==='reports-list'?{reports:[]}:{posts:[]}});assert.equal(admin.element('open-reports').hidden,false);await admin.click('open-reports');assert.equal(admin.calls.at(-1).action,'reports-list');
});

test('saved view refresh removes a post after its owner archives or deletes it',async()=>{
 let visible=true;
 const f=await fixture({respond:async action=>({posts:action==='saved-list' && visible ? [{id:'p1',displayName:'Other',text:'saved',own:false,saved:true,media:[]}] : []})});
 await f.click('open-saved');assert.equal(f.element('feed').children.length,1);
 visible=false;f.advanceTime(15000);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.element('feed').children.length,0);assert.equal(f.element('feed-status').textContent,'ยังไม่มีโพสต์ที่บันทึกไว้');
});

test('staff deletion waits 3 seconds and cancel never deletes a post',async()=>{
 const post={id:'p1',own:false,canDelete:true,displayName:'Other',text:'post',media:[]};
 for(const role of ['dev','admin']){
  const f=await fixture({role,respond:async action=>action==='moderation-confirm'?{confirmation:'test-confirmation'}:{posts:[post]}});
  await findMenuOption(f,'ลบโพสต์').handlers.click();assert.equal(f.element('moderation-dialog').open,true);assert.equal(f.element('moderation-confirm').disabled,true);
  await f.click('moderation-confirm');assert.equal(f.calls.some(item=>item.action==='post-delete'),false);
  f.advanceTime(2999);assert.equal(f.element('moderation-confirm').disabled,true);
  f.advanceTime(101);assert.equal(f.element('moderation-confirm').disabled,false);
  await f.click('moderation-confirm');assert.equal(f.calls.find(item=>item.action==='post-delete').data.confirmation,'test-confirmation');
  assert.equal(f.element('moderation-dialog').open,false);
 }
 const f=await fixture({role:'dev',respond:async action=>action==='moderation-confirm'?{confirmation:'token'}:{posts:[post]}});
 await findMenuOption(f,'ลบโพสต์').handlers.click();await f.click('moderation-cancel');f.advanceTime(4000);await f.click('moderation-confirm');
 assert.equal(f.calls.some(item=>item.action==='post-delete'),false);
 assert.equal(f.element('moderation-dialog').open,false);
});
test('Dev sees grant/revoke in profile tools, Admin only sees Ban and restricted list',async()=>{
 const post={id:'p1',own:false,displayName:'Other',text:'post',media:[]};
 for(const role of ['dev','admin']){
  const f=await fixture({role,respond:async action=>action==='author-profile'?{profile:{displayName:'Other',handle:'other1',role:'admin',management:{targetUid:'other',canManageRoles:true,canBan:true}},posts:[post]}:{posts:[post]}});
  await f.element('feed').children[0].children[0].handlers.click();await new Promise(resolve=>setImmediate(resolve));
  const options=f.element('author-tools').children[0].children[1].children.map(item=>item.textContent);
  assert.deepEqual(Array.from(options),role==='dev'?['Delete Admin','Ban']:['Ban']);
  assert.equal(f.element('open-restricted').hidden,false);assert.equal(f.element('my-role').textContent,role==='dev'?'Dev':'Admin');
 }
});

test('report options open the exact source post and delete only the report id',async()=>{
 let reports=[{id:'report1',reporter:{displayName:'Member',handle:'member1'},post:{id:'source-post',displayName:'Other',text:'source'},reason:'spam',details:''}];
 const f=await fixture({role:'admin',respond:async(action)=>{
  if(action==='reports-list')return {reports};
  if(action==='report-delete'){reports=[];return {deleted:true};}
  if(action==='post-detail')return {post:{id:'source-post',text:'source',displayName:'Other',media:[],archived:false},comments:[],likes:[]};
  return {posts:[]};
 }});
 await f.click('open-reports');let options=f.element('reports-list').children[0].children[0].children[1].children[0].children[1].children;
 assert.deepEqual(Array.from(options,b=>b.textContent),['ไปที่โพสต์','ลบ']);
 await options[0].handlers.click();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.element('reports-dialog').open,false);assert.equal(f.element('comments-dialog').open,true);assert.equal(f.calls.find(item=>item.action==='post-detail').data.id,'source-post');
 await f.click('close-comments');await f.click('open-reports');options=f.element('reports-list').children[0].children[0].children[1].children[0].children[1].children;
 await options[1].handlers.click();assert.equal(f.calls.find(item=>item.action==='report-delete').data.id,'report1');assert.equal(f.calls.some(item=>item.action==='post-delete'),false);assert.equal(f.element('reports-list').children.length,0);
});

const commentOptions=row=>row.children[0].children[1].children[0].children[1].children;
async function openTestComments(f){const actions=f.element('feed').children[0].children.find(item=>item.children?.some(child=>child.textContent==='ดูคนที่กดใจ'));actions.children[2].handlers.click();await new Promise(resolve=>setImmediate(resolve));}
test('own comment menu edits within its remaining time and marks edited text beside the author',async()=>{
 const post={id:'p1',displayName:'Other',text:'post',media:[]},comment={id:'c1',own:true,canEdit:true,editRemainingMs:2000,displayName:'Owner',handle:'owner1',text:'original',likeCount:0};
 const f=await fixture({respond:async(action,data)=>{if(action==='post-detail')return {post,comments:[comment],likes:[]};if(action==='comment-update'){comment.text=data.text;comment.edited=true;return {updated:true};}return {posts:[post]};}});
 await openTestComments(f);let options=commentOptions(f.element('comments-list').children[0]);assert.deepEqual(Array.from(options,b=>b.textContent),['แก้ไข','ลบ']);await options[0].handlers.click();assert.equal(f.element('comment-edit-dialog').open,true);
 f.element('comment-edit-text').value='edited';await f.element('comment-edit-form').handlers.submit({preventDefault(){}});assert.equal(f.calls.find(c=>c.action==='comment-update').data.commentId,'c1');assert.equal(f.element('comment-edit-dialog').open,false);
 const person=f.element('comments-list').children[0].children[0].children[0];assert.equal(person.children[1].children[0].textContent,'แก้ไขแล้ว');
 options=commentOptions(f.element('comments-list').children[0]);await options[0].handlers.click();f.advanceTime(2000);assert.equal(f.element('save-comment-edit').disabled,true);
 const before=f.calls.filter(c=>c.action==='comment-update').length;await f.element('comment-edit-form').handlers.submit({preventDefault(){}});assert.equal(f.calls.filter(c=>c.action==='comment-update').length,before);
});
test('other comment menu reports that comment and post reporting resets the comment target',async()=>{
 const post={id:'p1',own:false,displayName:'Other',text:'post',media:[]},comment={id:'c1',own:false,displayName:'Member',text:'comment'};
 const f=await fixture({respond:async action=>action==='post-detail'?{post,comments:[comment],likes:[]}:action==='report-create'?{}:{posts:[post]}});
 await openTestComments(f);const options=commentOptions(f.element('comments-list').children[0]);assert.deepEqual(Array.from(options,b=>b.textContent),['รายงาน']);await options[0].handlers.click();assert.equal(f.element('report-heading').textContent,'รายงานคอมเมนต์');f.element('report-reason').value='spam';await f.element('report-form').handlers.submit({preventDefault(){}});
 assert.equal(f.calls.find(c=>c.action==='report-create').data.commentId,'c1');await f.click('close-comments');await findMenuOption(f,'รายงาน').handlers.click();f.element('report-reason').value='spam';await f.element('report-form').handlers.submit({preventDefault(){}});assert.equal(f.calls.filter(c=>c.action==='report-create').at(-1).data.commentId,undefined);
});
test('comment hearts toggle the server state and reply submission binds the selected comment',async()=>{
 const post={id:'p1',displayName:'Other',text:'post',media:[]},comment={id:'c1',displayName:'Member',handle:'member1',text:'comment',liked:false,likeCount:0};
 const f=await fixture({respond:async(action,data)=>{if(action==='post-detail')return {post,comments:[comment],likes:[]};if(action==='comment-like'){comment.liked=data.liked;comment.likeCount=data.liked?1:0;return {liked:data.liked,likeCount:comment.likeCount};}return {posts:[post]};}});
 await openTestComments(f);let actions=f.element('comments-list').children[0].children.at(-1);await actions.children[0].handlers.click();assert.equal(f.calls.find(c=>c.action==='comment-like').data.commentId,'c1');assert.equal(f.element('comments-list').children[0].children.at(-1).children[0]['aria-pressed'],'true');
 actions=f.element('comments-list').children[0].children.at(-1);actions.children[1].handlers.click();assert.equal(f.element('reply-banner').hidden,false);f.element('comment-text').value='reply text';await f.element('comment-form').handlers.submit({preventDefault(){}});assert.equal(f.calls.find(c=>c.action==='comment-create').data.replyTo,'c1');assert.equal(f.element('reply-banner').hidden,true);
});

test('only ban confirmation shows and submits its reason, other confirmations clear it',async()=>{
 const post={id:'p1',own:false,canDelete:true,displayName:'Other',text:'post',media:[]};
 const f=await fixture({role:'dev',respond:async action=>action==='moderation-confirm'?{confirmation:'token'}:action==='author-profile'?{profile:{displayName:'Other',handle:'other1',management:{targetUid:'other',canBan:true}},posts:[post]}:action==='user-ban'?{updated:true}:{posts:[post]}});
 f.element('feed').children[0].children[0].handlers.click();await new Promise(resolve=>setImmediate(resolve));
 const ban=f.element('author-tools').children[0].children[1].children[0];await ban.handlers.click();assert.equal(f.element('moderation-reason-field').hidden,false);f.element('moderation-reason').value='  repeated spam  ';f.advanceTime(3100);await f.click('moderation-confirm');assert.equal(f.calls.find(c=>c.action==='user-ban').data.reason,'repeated spam');
 await findMenuOption(f,'ลบโพสต์').handlers.click();assert.equal(f.element('moderation-reason-field').hidden,true);assert.equal(f.element('moderation-reason').value,'');await f.click('moderation-cancel');
});


test('suspended author profile and feed show the replacement identity and default avatar',async()=>{
 const post={id:'p1',displayName:'ผู้ใช้งานถูกระงับบัญชี',suspended:true,authorHandle:'member1',authorPhotoId:null,text:'post',media:[]};
 const f=await fixture({respond:async action=>action==='author-profile'?{profile:{displayName:post.displayName,suspended:true,handle:'member1',bio:'ติดต่อปลดแบนได้ที่ "รายงานปัญหาการใช้งาน"',photoMediaId:null},posts:[post]}:{posts:[post]}});
 assert.equal(f.element('feed').children[0].children[0].children[0].src,'default-avatar.svg');
 f.element('feed').children[0].children[0].handlers.click();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.element('author-name').textContent,'ผู้ใช้งานถูกระงับบัญชี');assert.equal(f.element('author-bio').textContent,'ติดต่อปลดแบนได้ที่ "รายงานปัญหาการใช้งาน"');assert.equal(f.element('author-avatar').src,'default-avatar.svg');
});


test('search history retains queries and viewed profiles, replays both and removes individual or all entries',async()=>{
 const f=await fixture({respond:async action=>action==='trending-tags'?{tags:[]}:action==='search-users'?{users:[{displayName:'Other',handle:'other1',photoId:null}]}:action==='author-profile'?{profile:{displayName:'Other',handle:'other1'},posts:[]}:{posts:[]}});
 await f.click('open-search');assert.equal(f.element('search-history-empty').hidden,false);
 f.element('search-input').value='@other';await f.element('search-form').handlers.submit({preventDefault(){}});
 await f.element('search-results').children[0].handlers.click();await new Promise(resolve=>setImmediate(resolve));await f.click('open-search');
 let rows=f.element('search-history-list').children;assert.equal(rows.length,2);assert.equal(rows[0].children[0].children[0].textContent,'@other1');assert.equal(rows[0].children[0].children[1].textContent,'โปรไฟล์ที่ดู');
 await rows[1].children[0].handlers.click();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls.at(-1).data.query,'@other');
 rows=f.element('search-history-list').children;await rows[1].children[0].handlers.click();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls.at(-1).action,'author-profile');assert.equal(f.calls.at(-1).data.handle,'other1');
 await f.click('open-search');rows=f.element('search-history-list').children;rows[0].children[1].handlers.click();assert.equal(f.element('search-history-list').children.length,1);await f.click('clear-search-history');assert.equal(f.element('search-history-list').children.length,0);assert.equal(f.element('search-history-empty').hidden,false);
 assert.deepEqual(JSON.parse(f.storage.get('community-search-history:owner')),[]);
});
test('history keeps successful no-result searches and valid hashtags, but excludes failed queries',async()=>{
 const f=await fixture({language:'en',respond:async(action,data)=>action==='trending-tags'?{tags:[]}:action==='search-users'?(data.query==='invalid'?Promise.reject(Error('invalid')):{users:[]}):{posts:[]}});
 await f.click('open-search');f.element('search-input').value='missing1';await f.element('search-form').handlers.submit({preventDefault(){}});assert.equal(f.element('search-history-list').children[0].children[0].children[1].textContent,'Search again');
 f.element('search-input').value='invalid';await f.element('search-form').handlers.submit({preventDefault(){}});assert.equal(f.element('search-history-list').children.length,1);
 f.element('search-input').value='#มหาลัย';await f.element('search-form').handlers.submit({preventDefault(){}});assert.equal(f.element('search-page').hidden,true);await f.click('open-search');assert.equal(f.element('search-history-list').children[0].children[0].children[0].textContent,'#มหาลัย');
});


test('usage-report popup preserves drafts and failures, rejects empty messages, prevents duplicate sends and clears on success',async()=>{
 let reject=true,resolveSend;
 const f=await fixture({respond:async action=>{if(action==='usage-report-create'){if(reject)throw Error('server unavailable');return new Promise(resolve=>resolveSend=resolve);}return {posts:[]};}});
 await f.click('open-settings');await f.click('open-usage-report');assert.equal(f.element('settings-page').hidden,false);assert.equal(f.element('usage-report-dialog').open,true);f.element('usage-report-details').value=' draft problem ';await f.click('cancel-usage-report');await f.click('open-usage-report');assert.equal(f.element('usage-report-details').value,' draft problem ');
 f.element('usage-report-details').value=' ';await f.element('usage-report-form').handlers.submit({preventDefault(){}});assert.equal(f.calls.some(c=>c.action==='usage-report-create'),false);
 f.element('usage-report-details').value=' draft problem ';await f.element('usage-report-form').handlers.submit({preventDefault(){}});assert.equal(f.element('usage-report-dialog').open,true);assert.equal(f.element('usage-report-details').value,' draft problem ');assert.equal(f.element('usage-report-fields').disabled,false);
 reject=false;const pending=f.element('usage-report-form').handlers.submit({preventDefault(){}});assert.equal(f.element('usage-report-fields').disabled,true);await f.element('usage-report-form').handlers.submit({preventDefault(){}});await f.click('cancel-usage-report');assert.equal(f.element('usage-report-dialog').open,true);assert.equal(f.calls.filter(c=>c.action==='usage-report-create').length,2);
 resolveSend({reported:true});await pending;assert.equal(f.element('usage-report-dialog').open,false);assert.equal(f.element('usage-report-details').value,'');assert.equal(f.calls.filter(c=>c.action==='usage-report-create').at(-1).data.details,'draft problem');
});
test('usage reports render in the staff inbox without a post and offer only report deletion',async()=>{
 let reports=[{id:'usage1',kind:'usage',reason:'usage',reporter:{displayName:'Member',handle:'member1'},details:'Literal <script>text</script>'}];
 const f=await fixture({role:'dev',respond:async action=>action==='reports-list'?{reports}:action==='report-delete'?(reports=[],{deleted:true}):{posts:[]}});
 await f.click('open-reports');const card=f.element('reports-list').children[0];assert.equal(card.children[1].textContent,'ปัญหาการใช้งาน');assert.equal(card.children[2].hidden,true);assert.equal(card.children[3].textContent,'Literal <script>text</script>');
 const options=card.children[0].children[1].children[0].children[1].children;assert.deepEqual(Array.from(options,b=>b.textContent),['ลบ']);await options[0].handlers.click();assert.equal(f.calls.find(c=>c.action==='report-delete').data.id,'usage1');assert.equal(f.calls.some(c=>c.action==='post-delete'),false);assert.equal(f.element('reports-list').children.length,0);
});


test('staff report categories send the selected category, hide Dev-only usage from Admin and render appeals without a post',async()=>{
 for(const role of ['dev','admin']){
  const f=await fixture({role,respond:async(action,data)=>action==='reports-list'?{reports:data.category==='appeal'?[{id:'appeal1',kind:'appeal',reporter:{displayName:'Banned member'},details:'Please review'}]:[]}:{posts:[]}});
  await f.click('open-reports');assert.equal(f.calls.at(-1).data.category,'post');assert.equal(f.element('reports-category-usage').hidden,role!=='dev');
  await f.click('reports-category-comment');assert.equal(f.calls.at(-1).data.category,'comment');assert.equal(f.element('reports-category-comment')['aria-pressed'],'true');
  await f.click('reports-category-appeal');assert.equal(f.calls.at(-1).data.category,'appeal');const card=f.element('reports-list').children[0];assert.equal(card.children[1].textContent,'คำร้องจากผู้ถูก Ban');assert.equal(card.children[2].hidden,true);
  const previous=f.calls.length;await f.click('reports-category-usage');if(role==='admin')assert.equal(f.calls.length,previous);else assert.equal(f.calls.at(-1).data.category,'usage');
 }
});
test('a delayed previous report category cannot replace the currently selected category',async()=>{
 let resolvePosts;
 const f=await fixture({role:'dev',respond:async(action,data)=>action==='reports-list'?(data.category==='post'?new Promise(resolve=>resolvePosts=resolve):{reports:[{id:'a',kind:'appeal',reporter:{displayName:'Banned'},details:'current'}]}):{posts:[]}});
 const pending=f.element('open-reports').handlers.click();await f.click('reports-category-appeal');resolvePosts({reports:[{id:'old',kind:'post',reporter:{displayName:'Old'},post:{displayName:'Old',text:'stale'},details:''}]});await pending;assert.equal(f.element('reports-list').children[0].children[3].textContent,'current');
});


test('logout needs a fresh 3-second confirmation; cancel preserves the account and early forced clicks cannot sign out',async()=>{
 const f=await fixture();await f.click('open-settings');await f.click('logout');assert.equal(f.element('logout-dialog').open,true);assert.equal(f.element('confirm-logout').textContent,'แน่ใจ (3)');assert.equal(f.element('confirm-logout').disabled,true);
 await f.click('confirm-logout');assert.equal(f.calls.some(c=>c.action==='signOut'),false);f.advanceTime(3000);await f.click('cancel-logout');assert.equal(f.element('logout-dialog').open,false);assert.equal(f.element('settings-page').hidden,false);assert.equal(f.calls.some(c=>c.action==='signOut'),false);
 await f.click('logout');assert.equal(f.element('confirm-logout').disabled,true);f.advanceTime(2999);await f.click('confirm-logout');assert.equal(f.calls.some(c=>c.action==='signOut'),false);f.advanceTime(1);await f.click('confirm-logout');assert.equal(f.calls.filter(c=>c.action==='signOut').length,1);assert.equal(f.calls.at(-1),'/');
});

test('Guest composer allows General and Q&A, preserves General draft and rejects locked categories before upload',async()=>{
 const f=await fixture({guest:true});
 await f.click('open-post');
 assert.equal(f.element('post-category').value,'ถาม-ตอบ');assert.equal(f.element('guest-category-note').hidden,false);
 for(const id of ['post-category-placeholder','post-category-market','post-category-lost'])assert.equal(f.element(id).disabled,true);
 assert.equal(f.element('post-category-general').disabled,false);
 f.element('post-category').value='ทั่วไป';f.element('post-text').value='Guest question';await f.click('cancel-post');await f.click('open-post');
 assert.equal(f.element('post-text').value,'Guest question');assert.equal(f.element('post-category').value,'ทั่วไป');
 f.element('post-category').value='ขายของ';await f.element('post-form').handlers.submit({preventDefault(){}});
 assert.equal(f.calls.some(c=>c.action==='post-create'),false);assert.equal(f.element('post-status').textContent,'หากต้องการ Post หมวดหมู่ที่ถูกล็อกไว้ กรุณา Login');
 f.element('post-category').value='ทั่วไป';await f.element('post-form').handlers.submit({preventDefault(){}});
 assert.equal(f.calls.find(c=>c.action==='post-create').data.category,'ทั่วไป');
});
test('member composer keeps categories unlocked and hides Guest notice',async()=>{
 const f=await fixture();await f.click('open-post');
 assert.equal(f.element('guest-category-note').hidden,true);assert.equal(f.element('post-category').value,'');
 for(const id of ['post-category-placeholder','post-category-market','post-category-lost','post-category-general'])assert.equal(f.element(id).disabled,false);
});
test('editing a legacy Guest post uses Q&A and retains its text',async()=>{
 const post={id:'p1',own:true,displayName:'Guest',text:'old',category:'ขายของ',media:[]};
 const f=await fixture({guest:true,posts:[post]});await findMenuOption(f,'แก้ไขโพสต์').handlers.click();
 assert.equal(f.element('post-category').value,'ถาม-ตอบ');assert.equal(f.element('post-text').value,'old');assert.equal(f.element('guest-category-note').hidden,false);
});

test('all ranked members bypass existing and repeated posting cooldown, while Merchant has no admin menu',async()=>{
 for(const role of ['dev','admin','merchant']){
  const f=await fixture({role,cooldown:Date.now()+60000,respond:async action=>action==='post-create'?{postAvailableAt:0,postCooldownExempt:true}:{posts:[]}});
  await f.click('open-post');assert.equal(f.element('submit-post').disabled,false);assert.equal(f.element('submit-post').textContent,'โพสต์');
  for(let i=0;i<2;i++){
   f.element('post-category').value='ขายของ';f.element('post-text').value='Post '+i;
   await f.element('post-form').handlers.submit({preventDefault(){}});await f.click('open-post');assert.equal(f.element('submit-post').disabled,false);
  }
  assert.equal(f.calls.filter(c=>c.action==='post-create').length,2);
  if(role==='merchant'){assert.equal(f.element('my-role').textContent,'Trader');assert.equal(f.element('admin-menu').hidden,true);}
 }
});
test('Dev profile menu grants and revokes Merchant and translates the badge',async()=>{
 let currentRole=null;
 const post={id:'p1',displayName:'Seller',text:'post',media:[]};
 const f=await fixture({role:'dev',language:'en',respond:async(action,data)=>{
  if(action==='role-grant'){currentRole=data.role;return {updated:true};}
  if(action==='role-revoke'){currentRole=null;return {updated:true};}
  return {profile:{displayName:'Seller',handle:'seller1',role:currentRole,management:{targetUid:'seller',canManageRoles:true,canGrantMerchant:!currentRole,canBan:true}},posts:[post]};
 }});
 await f.element('feed').children[0].children[0].handlers.click();await new Promise(resolve=>setImmediate(resolve));
 const options=()=>f.element('author-tools').children[0].children[1].children;
 await options().find(item=>item.textContent==='Give Trader').handlers.click();
 assert.equal(f.calls.find(c=>c.action==='role-grant').data.role,'merchant');assert.equal(f.element('author-role').textContent,'Trader');
 await options().find(item=>item.textContent==='Delete Trader').handlers.click();assert.equal(currentRole,null);assert.equal(f.element('author-role').hidden,true);
});
test('Admin profile menu can give Merchant but cannot give or remove Admin',async()=>{
 const post={id:'p1',displayName:'Seller',text:'post',media:[]};
 const f=await fixture({role:'admin',respond:async action=>action==='role-grant'?{updated:true}:{profile:{displayName:'Seller',handle:'seller1',role:null,management:{targetUid:'seller',canGrantMerchant:true,canBan:true}},posts:[post]}});
 await f.element('feed').children[0].children[0].handlers.click();await new Promise(resolve=>setImmediate(resolve));
 const options=f.element('author-tools').children[0].children[1].children;assert.deepEqual(Array.from(options,item=>item.textContent),['Give Trader','Ban']);
 await options[0].handlers.click();assert.equal(f.calls.find(c=>c.action==='role-grant').data.role,'merchant');
});

test('live search matches one-character prefixes, narrows results, opens a profile and records only the chosen profile',async()=>{
 const users=[{displayName:'Toded',handle:'toded',photoId:null},{displayName:'Toto',handle:'toto',photoId:null}];
 const f=await fixture({respond:async(action,data)=>action==='search-users'?{users:users.filter(u=>u.handle.startsWith(data.query.replace(/^@/,'').toLowerCase()))}:action==='author-profile'?{profile:{displayName:'Toto',handle:'toto'},posts:[]}:{tags:[],posts:[]}});
 await f.click('open-search');
 for(const [query,count] of [['T',2],['To',2],['Tot',1]]){
  f.element('search-input').value=query;f.element('search-input').handlers.input({});f.advanceTime(200);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.element('search-results').children.length,count);assert.equal(f.element('search-history-list').children.length,0);
 }
 assert.equal(f.element('search-results').children[0].children[1].children[0].textContent,'Toto');
 await f.element('search-results').children[0].handlers.click();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.calls.at(-1).action,'author-profile');assert.equal(f.calls.at(-1).data.handle,'toto');assert.equal(f.element('search-page').hidden,true);
 await f.click('open-search');assert.equal(f.element('search-history-list').children.length,1);assert.equal(f.element('search-history-list').children[0].children[0].children[0].textContent,'@toto');
});
test('live search combines rapid keystrokes; Enter cancels pending suggestions and keeps explicit query history',async()=>{
 const f=await fixture({respond:async action=>action==='search-users'?{users:[]}:{tags:[],posts:[]}});await f.click('open-search');
 f.element('search-input').value='T';f.element('search-input').handlers.input({});f.advanceTime(100);
 f.element('search-input').value='To';f.element('search-input').handlers.input({});f.advanceTime(199);assert.equal(f.calls.some(c=>c.action==='search-users'),false);
 f.advanceTime(1);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls.filter(c=>c.action==='search-users').length,1);assert.equal(f.calls.find(c=>c.action==='search-users').data.query,'To');
 f.element('search-input').value='Tot';f.element('search-input').handlers.input({});await f.element('search-form').handlers.submit({preventDefault(){}});f.advanceTime(200);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.calls.filter(c=>c.action==='search-users').length,2);assert.equal(f.element('search-history-list').children[0].children[0].children[0].textContent,'Tot');
});
test('live search discards stale responses and cancels on empty input, hashtags, composing text and closed dialogs',async()=>{
 const pending=[];const f=await fixture({respond:async action=>action==='search-users'?new Promise((resolve,reject)=>pending.push({resolve,reject})):{tags:[],posts:[]}});await f.click('open-search');
 f.element('search-input').value='T';f.element('search-input').handlers.input({});f.advanceTime(200);
 f.element('search-input').value='Tot';f.element('search-input').handlers.input({});f.advanceTime(200);
 pending[1].resolve({users:[{displayName:'Toto',handle:'toto'}]});await new Promise(resolve=>setImmediate(resolve));
 pending[0].resolve({users:[{displayName:'Toded',handle:'toded'}]});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.element('search-results').children.length,1);assert.equal(f.element('search-results').children[0].children[1].children[0].textContent,'Toto');
 for(const value of ['', '@', '#Test', 'bad/', 'ไทย']){f.element('search-input').value=value;f.element('search-input').handlers.input({});f.advanceTime(200);}
 assert.equal(pending.length,2);assert.equal(f.element('search-results').children.length,0);assert.equal(f.element('search-status').textContent,'');assert.equal(f.element('search-page').hidden,false);
 f.element('search-input').value='T';f.element('search-input').handlers.input({isComposing:true});f.advanceTime(200);assert.equal(pending.length,2);
 f.element('search-input').handlers.compositionend({});f.advanceTime(200);assert.equal(pending.length,3);await f.click('home');pending[2].reject(Error('late failure'));await new Promise(resolve=>setImmediate(resolve));assert.equal(f.element('search-status').textContent,'');
 await f.click('open-search');f.element('search-input').value='To';f.element('search-input').handlers.input({});await f.click('home');f.advanceTime(200);assert.equal(pending.length,3);
});

test('hashtag button inserts at the cursor with a space when needed and leaves surrounding text intact',async()=>{
 const f=await fixture();await f.click('open-post');const input=f.element('post-text');
 for(const [value,start,expected] of [['',0,'#'],['ข้อความ',7,'ข้อความ #'],['ข้อความ ',8,'ข้อความ #'],['ข้อความ\n',8,'ข้อความ\n#'],['Hello world',5,'Hello # world']]){
  input.value=value;input.selectionStart=input.selectionEnd=start;await f.click('insert-post-hashtag');assert.equal(input.value,expected);
 }
 input.value='ข้อความ';input.selectionStart=input.selectionEnd=input.value.length;await f.click('insert-post-hashtag');
 input.setRangeText('Test',input.selectionStart,input.selectionEnd);assert.equal(input.value,'ข้อความ #Test');assert.equal(hashtagParts(input.value).filter(p=>p.tag)[0].tag,'test');
});
test('hashtag button keeps selected text and respects maximum post length',async()=>{
 const f=await fixture();const input=f.element('post-text');input.value='Hello Test world';input.selectionStart=6;input.selectionEnd=10;
 await f.click('insert-post-hashtag');assert.equal(input.value,'Hello #Test world');assert.equal(input.selectionStart,11);
 input.value='x'.repeat(5000);input.selectionStart=input.selectionEnd=5000;await f.click('insert-post-hashtag');assert.equal(input.value.length,5000);assert.equal(f.element('post-status').textContent,'กรุณาพิมพ์ข้อความไม่เกิน 5,000 ตัวอักษร');
});
test('hashtag button cannot change a draft while its post request is pending',async()=>{
 let finish;const f=await fixture({respond:async action=>action==='post-create'?new Promise(resolve=>finish=resolve):{posts:[]}});
 const input=f.element('post-text');input.value='Draft';input.selectionStart=input.selectionEnd=5;f.element('post-category').value='ถาม-ตอบ';
 const pending=f.element('post-form').handlers.submit({preventDefault(){}});assert.equal(f.element('insert-post-hashtag').disabled,true);await f.click('insert-post-hashtag');assert.equal(input.value,'Draft');
 finish({postAvailableAt:0});await pending;assert.equal(f.element('insert-post-hashtag').disabled,false);
});

test('post author badge sits between nickname and handle, uses supported roles and also appears in the comment popup',async()=>{
 for(const [role,label] of [['dev','Dev'],['admin','Admin'],['merchant','Trader'],[null,null],['forged',null]]){
  const post={id:'p1',displayName:'Author',authorHandle:'author1',authorRole:role,text:'post',media:[]};
  const f=await fixture({respond:async action=>action==='post-detail'?{post:{id:'p1',displayName:'Author',handle:'author1',role,text:'post'},likes:[],comments:[]}:{posts:[post]}});
  const name=f.element('feed').children[0].children[1];assert.equal(name.children[0].textContent,'Author');assert.equal(name.children.at(-1).textContent,'@author1');
  const badges=name.children.filter(child=>child.className==='role-badge');assert.equal(badges.length,label?1:0);if(label)assert.equal(badges[0].textContent,label);
  const actions=f.element('feed').children[0].children.find(el=>el.className==='post-actions');await actions.children[2].handlers.click();await new Promise(resolve=>setImmediate(resolve));
  const popupName=f.element('comment-post').children[0].children[0].children[1];const popupBadges=popupName.children.filter(child=>child.className==='role-badge');assert.equal(popupBadges.length,label?1:0);if(label)assert.equal(popupBadges[0].textContent,label);
 }
});
test('suspended post author never shows a role badge even if old response data contains a role',async()=>{
 const f=await fixture({posts:[{id:'p1',displayName:'Old name',suspended:true,authorHandle:'author1',authorRole:'admin',text:'post',media:[]}]});
 const name=f.element('feed').children[0].children[1];assert.equal(name.children[0].textContent,'ผู้ใช้งานถูกระงับบัญชี');assert.equal(name.children.some(c=>c.className==='role-badge'),false);
});

test('contact admin preserves drafts on cancel/error, rejects empty input and prevents duplicate sends',async()=>{
 let reject=true,resolveSend;
 const f=await fixture({respond:async action=>action==='contact-admin-create'?(reject?Promise.reject(Error('unavailable')):new Promise(resolve=>resolveSend=resolve)):{posts:[]}});
 await f.click('open-settings');await f.click('open-contact-admin');assert.equal(f.element('settings-page').hidden,false);assert.equal(f.element('contact-admin-dialog').open,true);
 f.element('contact-admin-details').value=' draft ';await f.click('cancel-contact-admin');await f.click('open-contact-admin');assert.equal(f.element('contact-admin-details').value,' draft ');
 f.element('contact-admin-details').value=' ';await f.element('contact-admin-form').handlers.submit({preventDefault(){}});assert.equal(f.calls.some(c=>c.action==='contact-admin-create'),false);
 f.element('contact-admin-details').value=' draft ';await f.element('contact-admin-form').handlers.submit({preventDefault(){}});assert.equal(f.element('contact-admin-dialog').open,true);assert.equal(f.element('contact-admin-details').value,' draft ');
 reject=false;const pending=f.element('contact-admin-form').handlers.submit({preventDefault(){}});await f.element('contact-admin-form').handlers.submit({preventDefault(){}});await f.click('cancel-contact-admin');assert.equal(f.element('contact-admin-dialog').open,true);assert.equal(f.element('contact-admin-fields').disabled,true);
 resolveSend({reported:true,kind:'general'});await pending;assert.equal(f.element('contact-admin-dialog').open,false);assert.equal(f.element('contact-admin-details').value,'');assert.equal(f.calls.filter(c=>c.action==='contact-admin-create').length,2);assert.equal(f.calls.at(-1).data.details,'draft');
});
test('Admin and Dev can select general inbox and render messages without post links',async()=>{
 for(const role of ['admin','dev']){
  const f=await fixture({role,respond:async(action,data)=>action==='reports-list'?{reports:data.category==='general'?[{id:'general1',kind:'general',reporter:{displayName:'Member'},details:'<script>literal</script>'}]:[]}:{posts:[]}});
  await f.click('open-reports');await f.click('reports-category-general');assert.equal(f.calls.at(-1).data.category,'general');assert.equal(f.element('reports-category-general')['aria-pressed'],'true');
  const card=f.element('reports-list').children[0];assert.equal(card.children[1].textContent,'ทั่วไป');assert.equal(card.children[2].hidden,true);assert.equal(card.children[3].textContent,'<script>literal</script>');assert.deepEqual(Array.from(card.children[0].children[1].children[0].children[1].children,b=>b.textContent),['ลบ']);
 }
});

test('announcement composer is staff-only and ordinary members cannot submit a forged category',async()=>{
 for(const role of [null,'merchant','admin','dev']){
  const f=await fixture({role});await f.click('open-post');const staff=['admin','dev'].includes(role);assert.equal(f.element('post-category-announcement').hidden,!staff);assert.equal(f.element('post-category-announcement').disabled,!staff);
  f.element('post-category').value='ประกาศ';f.element('post-text').value='announcement';await f.element('post-form').handlers.submit({preventDefault(){}});assert.equal(f.calls.some(c=>c.action==='post-create'),staff);
 }
 const guest=await fixture({guest:true});assert.equal(guest.element('post-category-announcement').hidden,true);assert.equal(guest.element('post-category-general').disabled,false);
});
test('announcement ticker renders API announcements independently of category filters and opens their post',async()=>{
 const post={id:'a1',displayName:'Admin',text:'<script>literal</script>',category:'ประกาศ',media:[]};
 const f=await fixture({respond:async(action,data)=>action==='posts-list'?{posts:data.category==='ทั้งหมด'?[post]:[],announcements:[post]}:action==='post-detail'?{post,comments:[],likes:[]}:{posts:[]}});
 assert.equal(f.element('feed').children.length,1);const track=f.element('announcement-track');assert.equal(track.children[0].children[0].children[0].textContent,'ประกาศ: <script>literal</script>');
 await f.click('category-general');assert.equal(f.element('feed').children.length,0);assert.equal(track.children[0].children[0].children[0].textContent,'ประกาศ: <script>literal</script>');
 await track.children[0].children[0].children[0].handlers.click();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.element('comments-dialog').open,true);assert.equal(f.calls.at(-1).data.id,'a1');
});
test('an empty announcement list clears previous ticker content and restores the welcome message',async()=>{
 let announcements=[{id:'a1',text:'old'}];const f=await fixture({respond:async()=>({posts:[],announcements})});assert.equal(f.element('announcement-track').children.length,2);announcements=[];await f.click('home');assert.equal(f.element('announcement-track').children.length,2);assert.equal(f.element('announcement-track').children[0].children[0].children[0].textContent,'System : Welcome to my website kub ^_^');
});

test('selected post attachment remains in native picker until cleared or successfully posted',async()=>{
 const f=await fixture(),uploads=[];
 f.context.URL={createObjectURL:()=> 'blob:phone',revokeObjectURL(){}};
 f.context.uploadMedia=async file=>{uploads.push(file);return {id:'phone-photo'};};
 const file={name:'phone.jpg',type:'image/jpeg',size:500};
 const input=f.element('post-files');input.files=[file];input.value='C:\\fakepath\\phone.jpg';
 await input.handlers.change();assert.equal(input.value,'C:\\fakepath\\phone.jpg');
 assert.equal(f.element('media-preview').children.length,1);
 await f.click('open-post');await f.click('cancel-post');assert.equal(input.value,'C:\\fakepath\\phone.jpg');
 f.element('post-category').value='ทั่วไป';
 await f.element('post-form').handlers.submit({preventDefault(){}});
 assert.deepEqual(uploads,[file]);assert.equal(input.value,'');assert.equal(f.calls.find(c=>c.action==='post-create').data.mediaIds[0],'phone-photo');
 input.files=[file];input.value='C:\\fakepath\\phone.jpg';await input.handlers.change();
 await f.click('clear-files');assert.equal(input.value,'');assert.equal(f.element('media-preview').children.length,0);
});
test('profile photo keeps its filename after selection and uploads the selected image on save',async()=>{
 const f=await fixture(),uploads=[];
 f.context.URL={createObjectURL:()=> 'blob:phone',revokeObjectURL(){}};
 f.context.uploadMedia=async file=>{uploads.push(file);return {id:'phone-avatar'};};
 await f.click('edit-profile');
 const file={name:'phone.jpg',type:'image/jpeg',size:500};
 const input=f.element('edit-photo');input.files=[file];input.value='C:\\fakepath\\phone.jpg';
 await input.handlers.change();assert.equal(input.value,'C:\\fakepath\\phone.jpg');
 assert.equal(f.element('photo-preview').src,'blob:phone');
 await f.element('edit-form').handlers.submit({preventDefault(){}});
 assert.deepEqual(uploads,[file]);assert.equal(f.calls.find(c=>c.action==='profile-update').data.photoMediaId,'phone-avatar');assert.equal(input.value,'');
});



test('feed skeleton stays pending and is replaced by the successful response', async () => {
  let finish;
  const request = new Promise(resolve => { finish = resolve; });
  const f = await fixture({respond: action => action === 'posts-list' ? request : {posts: []}});
  assert.equal(f.element('initial-loading').hidden, true);
  assert.equal(f.element('feed')['aria-busy'], 'true');
  assert.equal(f.element('feed').children.length, 3);
  assert.equal(f.element('feed').children[0].className, 'loading-card');
  assert.equal(f.element('feed').children[0]['aria-hidden'], 'true');
  finish({posts: [{id: 'loaded', displayName: 'Member', text: 'Loaded', category: 'ทั่วไป', media: []}]});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.element('feed')['aria-busy'], 'false');
  assert.equal(f.element('feed-status').className, '');
  assert.equal(f.element('feed').children.length, 1);
  assert.equal(f.element('feed').children[0].className, 'post-card');
});

test('failed feed request removes skeletons and makes the error visible', async () => {
  let fail;
  const request = new Promise((resolve, reject) => { fail = reject; });
  const f = await fixture({respond: action => action === 'posts-list' ? request : {posts: []}});
  fail(new Error('Network unavailable'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.element('feed')['aria-busy'], 'false');
  assert.equal(f.element('feed').children.length, 0);
  assert.equal(f.element('feed-status').textContent, 'Network unavailable');
  assert.equal(f.element('feed-status').className, '');
});

test('a stale feed response cannot clear a newer view loading state', async () => {
  let finishHome, finishMe;
  const home = new Promise(resolve => { finishHome = resolve; });
  const me = new Promise(resolve => { finishMe = resolve; });
  const f = await fixture({respond: action => action === 'posts-list' ? home : action === 'my-posts' ? me : {posts: []}});
  await f.click('me');
  finishHome({posts: []});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.element('feed')['aria-busy'], 'true');
  assert.equal(f.element('feed').children[0].className, 'loading-card');
  finishMe({posts: []});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.element('feed')['aria-busy'], 'false');
  assert.equal(f.element('feed').children.length, 0);
  assert.equal(f.element('feed-status').textContent, 'คุณยังไม่มีโพสต์');
});
