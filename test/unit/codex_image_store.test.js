'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {storeImageAttachments}=require('../../src/codex_image_store');
const {queueMessage,probeQueueSupport}=require('../../src/codex_queue');
const dataUrl='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNoaGgAAAMEAYFL09IQAAAAAElFTkSuQmCC';
const image={name:'image.png',mimeType:'image/png',dataUrl};
async function fixture(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'image-store-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));return directory;}
test('concurrent image staging retains one complete content-addressed image and no temp files',async t=>{
 const directory=await fixture(t);
 const [a,b]=await Promise.all([storeImageAttachments(directory,[image]),storeImageAttachments(directory,[image])]);
 assert.equal(a[0].path,b[0].path);
 assert.deepEqual(await fs.readFile(a[0].path),Buffer.from(dataUrl.split(',')[1],'base64'));
 assert.equal((await fs.readdir(directory)).length,1);
});
test('invalid images do not create retained files',async t=>{
 const directory=await fixture(t);
 await assert.rejects(storeImageAttachments(directory,[{...image,dataUrl:'data:image/png;base64,aGVsbG8='}]));
 assert.deepEqual(await fs.readdir(directory),[]);
});
test('generic image help flags never falsely advertise native queue image support',async()=>{
 const options={execFileImpl(exe,args,settings,callback){callback(null,args[0]==='queue'?'--thread --message --image <FILE>':'codex fixture','');}};
 assert.equal((await probeQueueSupport('fixture',options)).imagesAvailable,false);
 await assert.rejects(queueMessage({executable:'fixture',threadId:'t',message:'x',images:[image]}),/không nhận ảnh/);
});
