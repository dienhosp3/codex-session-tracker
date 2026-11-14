'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {createStateStore}=require('./codex_state_store');
const MiB=1024*1024,DAY=86400000;
const DEFAULT_POLICY=Object.freeze({automatic:true,days:7,maxMiB:512});
const FILES=new Set(['request.json','request.body','request.original.body','response.body','response.events.jsonl','response.json','timeline.jsonl','captures.jsonl','gaps.jsonl']);
const TERMINAL=new Set(['CLIENT_RESPONSE_FINISHED','CLIENT_TRANSPORT_ERROR','UPSTREAM_FINISHED','UPSTREAM_ERROR','DISCONNECTED']);
const canonical=value=>path.resolve(value).toLowerCase();
async function safePath(root,target){
 const base=path.resolve(root),full=path.resolve(target);
 if(canonical(full)!==canonical(base)&&!canonical(full).startsWith(canonical(base)+path.sep))throw new Error('Đường dẫn dọn nằm ngoài phạm vi.');
 let current=full;
 while(true){
  let stat;try{stat=await fs.lstat(current);}catch(error){if(error.code==='ENOENT')return false;throw error;}
  if(stat.isSymbolicLink())throw new Error('Bỏ qua junction/symlink khi dọn dữ liệu.');
  if(canonical(current)===canonical(base))break;
  current=path.dirname(current);
 }
 if(canonical(await fs.realpath(base))!==canonical(base))throw new Error('Thư mục gốc đi qua junction/symlink.');
 return true;
}
function validatePolicy(value){
 const policy={...DEFAULT_POLICY,...value};
 if(typeof policy.automatic!=='boolean'||!Number.isInteger(policy.days)||policy.days<1||policy.days>365||!Number.isInteger(policy.maxMiB)||policy.maxMiB<64||policy.maxMiB>4096)throw new Error('Giữ 1–365 ngày và giới hạn 64–4096 MiB.');
 return policy;
}
async function filesIn(folder){
 const names=await fs.readdir(folder,{withFileTypes:true}),files=[];
 for(const item of names){
  if(!item.isFile()||!FILES.has(item.name))return null;
  const file=path.join(folder,item.name),stat=await fs.lstat(file);
  if(stat.isSymbolicLink()||!stat.isFile())return null;
  files.push({path:file,name:item.name,size:stat.size,mtimeMs:stat.mtimeMs});
 }
 return files;
}
const fingerprint=files=>JSON.stringify(files.map(file=>[file.name,file.size,file.mtimeMs]).sort((a,b)=>a[0].localeCompare(b[0])));
async function requestRecord(root,folder,now){
 if(!await safePath(root,folder))return null;
 const files=await filesIn(folder);if(!files)return null;
 const header=files.find(file=>file.name==='request.json');if(!header||header.size>65536)return null;
 let metadata;try{metadata=JSON.parse(await fs.readFile(header.path,'utf8'));}catch{return null;}
 if(metadata.schemaVersion!==1||!['GET','POST'].includes(metadata.method)||typeof metadata.requestId!=='string'||!Number.isFinite(Date.parse(metadata.requestStartedAt))||typeof metadata.backend!=='string')return null;
 let completed=metadata.producer==='codex-session-tracker'&&metadata.completed===true;
 const timeline=files.find(file=>file.name==='timeline.jsonl');
 if(!completed&&timeline){
  const handle=await fs.open(timeline.path,'r');
  try{
   const bytes=Buffer.alloc(Math.min(32768,timeline.size)),start=Math.max(0,timeline.size-bytes.length);
   const {bytesRead}=await handle.read(bytes,0,bytes.length,start);
   for(const line of bytes.subarray(0,bytesRead).toString('utf8').split(/\r?\n/)){
    try{if(TERMINAL.has(JSON.parse(line).stage))completed=true;}catch{}
   }
  }finally{await handle.close();}
 }
 const modified=Math.max(...files.map(file=>file.mtimeMs));
 return {kind:'traffic',root,path:folder,files,bytes:files.reduce((sum,file)=>sum+file.size,0),modified,protected:!completed||now-modified<60000,fingerprint:fingerprint(files)};
}
async function trafficRecords(root,now,warnings){
 if(!root||!await safePath(root,root))return [];
 const queue=[{folder:root,depth:0}],records=[];
 while(queue.length){
  const {folder,depth}=queue.shift();if(depth>9)continue;
  let entries;try{entries=await fs.readdir(folder,{withFileTypes:true});}catch(error){warnings.push(error.code||'READ_ERROR');continue;}
  if(entries.some(entry=>entry.name==='request.json')){
   try{const record=await requestRecord(root,folder,now);if(record)records.push(record);}catch(error){warnings.push(error.message);}
   continue;
  }
  for(const entry of entries){
   if(entry.isSymbolicLink()){warnings.push('Đã bỏ qua liên kết trong thư mục log.');continue;}
   if(!entry.isDirectory()||depth===0&&!/^\d{4}-\d{2}-\d{2}$/.test(entry.name))continue;
   queue.push({folder:path.join(folder,entry.name),depth:depth+1});
  }
 }
 return records;
}
async function treeBytes(root){
 if(!await safePath(root,root))return 0;
 let bytes=0;const queue=[root];
 while(queue.length){
  for(const entry of await fs.readdir(queue.shift(),{withFileTypes:true})){
   const parent=entry.parentPath||entry.path;
   const file=path.join(parent,entry.name),stat=await fs.lstat(file);
   if(stat.isSymbolicLink())continue;
   if(stat.isDirectory())queue.push(file);else if(stat.isFile())bytes+=stat.size;
  }
 }
 return bytes;
}
function cleanupPlan(records,policy,now){
 const selected=new Set(),expired=now-policy.days*DAY,cap=policy.maxMiB*MiB;
 const eligible=records.filter(record=>!record.protected).sort((a,b)=>a.modified-b.modified);
 let total=records.reduce((sum,record)=>sum+record.bytes,0);
 for(const record of eligible)if(record.modified<expired){selected.add(record);total-=record.bytes;}
 for(const record of eligible)if(total>cap&&!selected.has(record)){selected.add(record);total-=record.bytes;}
 return {records:[...selected],remainingBytes:total,overBudgetBytes:Math.max(0,total-cap)};
}
async function deleteRecord(record,now){
 if(!await safePath(record.root,record.path))return {files:0,bytes:0};
 if(record.kind==='traffic'){
  const current=await requestRecord(record.root,record.path,now);
  if(!current||current.protected||current.fingerprint!==record.fingerprint)return {files:0,bytes:0,changed:true};
  // Delete only the recognized files, never recurse into a user directory.
  const files=current.files.sort((a,b)=>(a.name==='request.json'?2:a.name==='timeline.jsonl'?1:0)-(b.name==='request.json'?2:b.name==='timeline.jsonl'?1:0));
  for(const file of files){await safePath(record.root,file.path);await fs.unlink(file.path);}
  let parent=record.path;
  while(canonical(parent)!==canonical(record.root)){
   try{await fs.rmdir(parent);}catch(error){if(['ENOTEMPTY','EEXIST','ENOENT'].includes(error.code))break;throw error;}
   parent=path.dirname(parent);await safePath(record.root,parent);
  }
  return {files:files.length,bytes:record.bytes};
 }
 const stat=await fs.lstat(record.path);
 if(stat.size!==record.bytes||stat.mtimeMs!==record.modified)return {files:0,bytes:0,changed:true};
 await fs.unlink(record.path);return {files:1,bytes:record.bytes};
}
function createStorageMaintenance(options){
 const store=options.store||createStateStore(path.join(options.directory,'storage-maintenance.json'),{policy:DEFAULT_POLICY});
 let policy={...DEFAULT_POLICY},view={policy,busy:false,groups:[],warnings:[],lastCleanup:null},running=null,timer,disposed=false;
 const publish=()=>options.changed?.();
 async function scan(){
  const saved=await store.read();policy=validatePolicy(saved.policy);const now=Date.now(),warnings=[];
  const records=await trafficRecords(options.trafficDirectory(),now,warnings);
  const gateway=path.join(options.directory,'gateway');
  for(const name of ['gateway-trace.jsonl','gateway-trace.previous.jsonl']){
   const file=path.join(gateway,name);
   if(!await safePath(gateway,file))continue;
   const stat=await fs.lstat(file);
   records.push({kind:'trace',root:gateway,path:file,files:[{path:file}],bytes:stat.size,modified:stat.mtimeMs,protected:name==='gateway-trace.jsonl'||now-stat.mtimeMs<60000});
  }
  const plan=cleanupPlan(records,policy,now);
  let imageBytes=0;
  for(const folder of ['attachments','retained-images'])imageBytes+=await treeBytes(path.join(options.directory,folder));
  let runtimeBytes=0;
  for(const folder of ['client-runtime','gateway/native-hook-python'])try{runtimeBytes+=await treeBytes(path.join(options.directory,folder));}catch(error){warnings.push('Không đo được runtime: '+(error.code||error.message));}
  let memory;try{memory=await options.memoryStats?.();}catch{}
  view={policy,busy:view.busy,groups:[
   {id:'trace',label:'Trace giao tiếp',bytes:records.filter(r=>r.kind==='trace').reduce((n,r)=>n+r.bytes,0),protected:false},
   {id:'traffic',label:'Log traffic',bytes:records.filter(r=>r.kind==='traffic').reduce((n,r)=>n+r.bytes,0),protected:false},
   {id:'images',label:'Ảnh đính kèm / ảnh trong chat',bytes:imageBytes,protected:true},
   {id:'runtime',label:'Runtime / công cụ hỗ trợ',bytes:runtimeBytes,protected:true},
   ...(memory?[{id:'memory',label:'Cache nội dung đọc (RAM)',bytes:memory.activityBytes,protected:false}]:[]),
   {id:'state',label:'Tài khoản, lịch sử và receipt',protected:true}
  ],warnings:[...new Set(warnings)].slice(0,5),plannedFiles:plan.records.reduce((n,r)=>n+r.files.length,0),plannedBytes:plan.records.reduce((n,r)=>n+r.bytes,0),
   totalLogBytes:records.reduce((n,r)=>n+r.bytes,0),overBudgetBytes:plan.overBudgetBytes,lastCleanup:saved.lastCleanup||null,checkedAt:now};
  publish();return {records,plan};
 }
 async function inspect(){if(running)return running;view.busy=true;publish();running=scan().then(()=>view).catch(error=>{view.error=error.message;return view;}).finally(()=>{view.busy=false;running=null;publish();});return running;}
 async function clean(manual=false){
  if(running)return running;view.busy=true;publish();
  running=(async()=>{
   const {plan}=await scan();if(!manual&&!policy.automatic)return view;
   const now=Date.now(),claimed=await store.transaction(s=>{if(s.lease&&s.lease.until>now)return false;s.lease={pid:process.pid,until:now+120000};return true;});
   if(!claimed)return view;
   const report={at:now,files:0,bytes:0,skipped:0,errors:[]};
   try{
    for(const record of plan.records){
     if(disposed)break;
     try{const result=await deleteRecord(record,Date.now());report.files+=result.files;report.bytes+=result.bytes;if(result.changed)report.skipped++;}
     catch(error){report.errors.push({path:record.path,reason:error.code||error.message});}
    }
   }finally{await store.transaction(s=>{s.lastCleanup=report;delete s.lease;});}
   await scan();return view;
  })().catch(error=>{view.error=error.message;return view;}).finally(()=>{
   view.busy=false;running=null;
   if(view.error)options.budget?.({traceCap:64*MiB,trafficBytes:0});
   else if(policy.automatic&&view.groups?.length){
    const trace=view.groups.find(g=>g.id==='trace')?.bytes||0;
    const traffic=view.groups.find(g=>g.id==='traffic')?.bytes||0;
    const traceCap=Math.min(64*MiB,policy.maxMiB*MiB/4);
    options.budget?.({traceCap,trafficBytes:Math.max(0,policy.maxMiB*MiB-Math.max(trace,traceCap*2)-traffic)});
   }else options.budget?.({traceCap:null,trafficBytes:Infinity});
   publish();
  });
  return running;
 }
 async function configure(value){const next=validatePolicy(value);await store.transaction(s=>{s.policy=next;});return clean(false);}
 function start(){if(timer)return;timer=setInterval(()=>clean(false),60000);timer.unref?.();const first=setTimeout(()=>{if(!disposed)clean(false);},1500);first.unref?.();}
 return {snapshot:()=>({...view,policy:{...policy}}),inspect,clean,configure,start,dispose(){disposed=true;clearInterval(timer);},clearMemory:()=>options.clearMemory?.()};
}
module.exports={DEFAULT_POLICY,validatePolicy,safePath,requestRecord,trafficRecords,cleanupPlan,deleteRecord,createStorageMaintenance};
