export async function uploadMedia(file, user, request = fetch) {
  const headers = {Authorization:'Bearer '+await user.getIdToken()};
  async function json(response) {
    const data = await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.message || 'อัปโหลดไม่สำเร็จ');
    return data;
  }
  const config = await json(await request('/api/media?upload=1',{headers}));
  if(!config.direct)return json(await request('/api/media',{method:'POST',headers:{...headers,'Content-Type':file.type},body:file}));
  const upload = await json(await request('/api/media',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({action:'prepare',type:file.type,size:file.size})}));
  const target = new URL(upload.uploadUrl);
  // Presigned PUT URLs use the Blob control API; object URLs use storage hosts.
  const blobApi = target.hostname === 'vercel.com' && target.pathname === '/api/blob/';
  const blobStorage = target.hostname === 'blob.vercel-storage.com' || target.hostname.endsWith('.blob.vercel-storage.com');
  if(target.protocol !== 'https:' || target.username || target.password || target.port || !(blobApi || blobStorage))throw new Error('ที่อยู่อัปโหลดไม่ถูกต้อง');
  const response = await request(upload.uploadUrl,{method:'PUT',headers:{'Content-Type':file.type},body:file});
  if(!response.ok)throw new Error('อัปโหลดไม่สำเร็จ กรุณาลองอีกครั้ง');
  return json(await request('/api/media',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({action:'complete',id:upload.id})}));
}
