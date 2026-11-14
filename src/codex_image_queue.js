'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {createStateStore}=require('./codex_state_store');
const {normalizeImageAttachments}=require('./codex_steer');
const {storeImageAttachments}=require('./codex_image_store');

function createImageQueue(options){
 const store=options.store||createStateStore(options.file,{schemaVersion:1,entries:{}});
 let state={entries:{}},ready=false,error='',timer,working=false,disposed=false,signature='';
 function publish(){const next=JSON.stringify(snapshot());if(next!==signature){signature=next;options.changed?.();}}
 async function sync(){state=await store.read();state.entries||={};ready=true;error='';publish();}
 function snapshot(){return {ready,error,jobs:Object.values(state.entries).map(({id,threadId,phase,createdAt,error,images,turnId})=>({id,threadId,phase,createdAt,error,imageCount:images?.length||0,turnId}))};}
 const initialized=sync().catch(failure=>{error=failure.message;publish();});
 async function enqueue(input){
  await initialized;if(!ready)throw new Error(error||'Hàng chờ ảnh chưa sẵn sàng.');
  const images=normalizeImageAttachments(input.images);
  if(!images.length||!input.threadId||!input.sourceTurnId)throw new Error('Thiếu ảnh hoặc lượt chat nguồn.');
  const id=input.requestId||crypto.randomUUID(),message=String(input.message||'');
  if(!/^[A-Za-z0-9-]{1,100}$/.test(id))throw new Error('Mã yêu cầu hàng chờ không hợp lệ.');
  const digest=crypto.createHash('sha256').update(JSON.stringify([input.threadId,message,images])).digest('hex');
  const existing=(await store.read()).entries?.[id];
  if(existing){if(existing.digest!==digest)throw new Error('Mã yêu cầu đã được dùng cho nội dung khác.');return existing;}
  const saved=await storeImageAttachments(options.imageDirectory,images);
  const result=await store.transaction(s=>{
   s.entries||={};
   if(s.entries[id]){if(s.entries[id].digest!==digest)throw new Error('Mã yêu cầu không khớp.');return s.entries[id];}
   if(Object.values(s.entries).filter(job=>['waiting','sending','unknown'].includes(job.phase)).length>=20)throw new Error('Tối đa 20 tin ảnh đang chờ.');
   const previous=Object.values(s.entries).filter(job=>job.threadId===input.threadId&&['waiting','sending','unknown','failed'].includes(job.phase)).sort((a,b)=>a.createdAt-b.createdAt).at(-1);
   const job={id,digest,threadId:input.threadId,sourceTurnId:input.sourceTurnId,previousId:previous?.id,message,images:saved,clientUserMessageId:crypto.randomUUID(),phase:'waiting',attempts:0,createdAt:Date.now()};
   s.entries[id]=job;return job;
  });
  await sync();return result;
 }
 async function cancel(id){await store.transaction(s=>{const job=s.entries?.[id];if(job&&['waiting','failed'].includes(job.phase))job.phase='cancelled';});await sync();}
 function predecessor(job,entries){
  const seen=new Set();let previous=entries[job.previousId];
  while(previous?.phase==='cancelled'&&!seen.has(previous.id)){seen.add(previous.id);previous=entries[previous.previousId];}
  if(!previous)return job.sourceTurnId;
  return previous.phase==='sent'?previous.turnId:null;
 }
 async function attachments(job){
  const root=path.resolve(options.imageDirectory),images=[];
  for(const image of job.images){
   if(path.dirname(path.resolve(image.path))!==root)throw new Error('Ảnh hàng chờ nằm ngoài kho đính kèm.');
   const stat=await fs.lstat(image.path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8*1024*1024)throw new Error('Ảnh hàng chờ không hợp lệ.');
   const bytes=await fs.readFile(image.path);
   if(crypto.createHash('sha256').update(bytes).digest('hex')!==image.sha256)throw new Error('Ảnh hàng chờ đã thay đổi.');
   images.push({name:image.name,mimeType:image.mimeType,dataUrl:'data:'+image.mimeType+';base64,'+bytes.toString('base64')});
  }
  return normalizeImageAttachments(images);
 }
 async function tick(){
  if(disposed||working)return;working=true;
  try{
   await initialized;if(!ready)return;await sync();
   for(const candidate of Object.values(state.entries).sort((a,b)=>a.createdAt-b.createdAt)){
    if(disposed)break;
    if(candidate.phase==='sending'){
     let alive=true;try{process.kill(candidate.ownerPid,0);}catch(failure){alive=failure.code!=='ESRCH';}
     if(!alive)await store.transaction(s=>{const job=s.entries[candidate.id];if(job?.phase==='sending')Object.assign(job,{phase:'unknown',error:'Lần gửi trước mất xác nhận. Kiểm tra chat; không tự gửi lại.'});});
     continue;
    }
    if(candidate.phase!=='waiting')continue;
    const current=await store.read(),job=current.entries[candidate.id],expected=job&&predecessor(job,current.entries);
    if(job?.phase!=='waiting'||!expected)continue;
    let live;try{live=await options.readStatus(job.threadId);}catch{continue;}
    if(disposed||live.active||live.waiting||live.goalPaused||live.turnId!==expected||live.status!=='completed')continue;
    const claimed=await store.transaction(s=>{const target=s.entries[job.id];if(target?.phase!=='waiting'||predecessor(target,s.entries)!==expected)return false;Object.assign(target,{phase:'sending',ownerPid:process.pid,attempts:(target.attempts||0)+1});return true;});
    if(!claimed)continue;
    try{
     const images=await attachments(job);
     const result=await options.send({...job,images,expectedPreviousTurnId:expected});
     if(!result?.turnId)throw new Error('Chưa xác nhận được lượt gửi ảnh.');
     await store.transaction(s=>Object.assign(s.entries[job.id],{phase:'sent',turnId:result.turnId,error:''}));
    }catch(failure){
     await store.transaction(s=>{const target=s.entries[job.id];Object.assign(target,{phase:failure.delivery==='not_sent'&&target.attempts<3?'waiting':failure.delivery==='unknown'?'unknown':'failed',error:failure.message});});
    }
   }
   await sync();
  }catch(failure){error=failure.message;publish();}
  finally{working=false;}
 }
 function start(){if(!timer){timer=setInterval(()=>tick(),1000);timer.unref?.();}}
 function dispose(){disposed=true;clearInterval(timer);}
 return {snapshot,enqueue,cancel,tick,start,dispose,ready:initialized};
}
module.exports={createImageQueue};
