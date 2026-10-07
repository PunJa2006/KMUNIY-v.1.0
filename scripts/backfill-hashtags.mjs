import {loadEnvFile} from 'node:process';
import {services} from '../api/account.js';
import {extractHashtags} from '../public/hashtags.js';
try {loadEnvFile(new URL('../.env.local', import.meta.url));} catch(error) {if(error.code !== 'ENOENT') throw error;}
const {db}=services();
const posts=await db.collection('posts').select('text','hashtags').get();
let updated=0;
for(const post of posts.docs){
 const changed=await db.runTransaction(async tx=>{
  const current=await tx.get(post.ref);
  if(!current.exists)return false;
  const data=current.data(),hashtags=extractHashtags(data.text || '');
  if(JSON.stringify(data.hashtags)===JSON.stringify(hashtags))return false;
  tx.update(post.ref,{hashtags});return true;
 });
 if(changed)updated++;
}
console.log(`Hashtag metadata updated on ${updated} existing public posts; post text and authors are unchanged.`);
