'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {normalizeImageAttachments}=require('./codex_steer');

// Queued images may be read after the CLI acknowledges enqueueing. These are
// retained user attachments, not scratch and never part of automatic log GC.
async function storeImageAttachments(directory, rawImages) {
  const images=normalizeImageAttachments(rawImages);
  if(!images.length)return [];
  if(typeof directory!=='string'||!path.isAbsolute(directory))throw new Error('Chưa cấu hình nơi lưu ảnh đính kèm.');
  await fs.mkdir(directory,{recursive:true});
  const root=await fs.lstat(directory);
  if(!root.isDirectory()||root.isSymbolicLink())throw new Error('Thư mục ảnh phải là thư mục thật.');
  const result=[];
  for(const image of images){
    const bytes=Buffer.from(image.dataUrl.split(',')[1],'base64');
    const sha256=crypto.createHash('sha256').update(bytes).digest('hex');
    const extension={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif'}[image.mimeType];
    const file=path.join(directory,sha256+'.'+extension);
    const temporary=path.join(directory,'.image-'+crypto.randomUUID()+'.tmp');
    let handle;
    try {
      handle=await fs.open(temporary,'wx');await handle.writeFile(bytes);await handle.sync();
      await handle.close();handle=null;
      await fs.link(temporary,file);
    } catch(error) {
      if(error.code!=='EEXIST')throw error;
      const stat=await fs.lstat(file);
      if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Đường dẫn ảnh lưu không hợp lệ.');
      const existing=await fs.readFile(file);
      if(!existing.equals(bytes))throw new Error('Ảnh lưu không khớp nội dung.');
    } finally { await handle?.close();await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;}); }
    result.push({path:file,sha256,name:image.name,mimeType:image.mimeType});
  }
  return result;
}
module.exports={storeImageAttachments};
