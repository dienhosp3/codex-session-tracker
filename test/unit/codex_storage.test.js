'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {TrafficLogs}=require('../../gateway/traffic_logs');
const {createStorageMaintenance,trafficRecords,cleanupPlan,deleteRecord,safePath}=require('../../src/codex_storage');
const DAY=86400000,MiB=1024*1024;
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'storage-maintenance-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const directory=path.join(root,'app'),traffic=path.join(root,'logs');await fs.mkdir(directory);await fs.mkdir(traffic);
 return {root,directory,traffic};
}
async function record(folder,id,days,complete=true){
 const time=Date.now()-days*DAY,logs=new TrafficLogs({directory:folder,sessionStartedAt:time});
 const base={requestId:id,method:'POST',path:'/backend-api/codex/responses',targetHost:'fixture.test',at:time,protocol:'http'};
 await logs.append({...base,type:'client_request',stage:'CLIENT_JSON_PREPARED'},{bytes:Buffer.from('payload')});
 if(complete)await logs.append({...base,type:'client_response',stage:'CLIENT_RESPONSE_FINISHED'});
 await logs.flush();
 const row=logs.requests.get(id);
 for(const file of await fs.readdir(row.folder))await fs.utimes(path.join(row.folder,file),time/1000,time/1000);
 return row.folder;
}
test('seven-day cleanup removes only completed owned logs and preserves current trace, images and receipts',async t=>{
 const f=await fixture(t),old=await record(f.traffic,'old',8),recent=await record(f.traffic,'recent',1),active=await record(f.traffic,'active',9,false);
 await fs.mkdir(path.join(f.directory,'gateway'));await fs.writeFile(path.join(f.directory,'gateway/gateway-trace.jsonl'),'active trace');
 await fs.mkdir(path.join(f.directory,'attachments'));await fs.writeFile(path.join(f.directory,'attachments/keep.png'),'retained image');
 await fs.writeFile(path.join(f.directory,'account-automation.v1.json'),'account state');
 await fs.writeFile(path.join(f.directory,'image-queue.json'),'queue receipts');
 const cleaner=createStorageMaintenance({directory:f.directory,trafficDirectory:()=>f.traffic});
 const preview=await cleaner.inspect();assert.ok(preview.plannedFiles>0);assert.equal(preview.groups.find(g=>g.id==='images').protected,true);
 const result=await cleaner.clean(false);assert.ok(result.lastCleanup.files>0);assert.equal(result.lastCleanup.errors.length,0);
 await assert.rejects(fs.stat(old),{code:'ENOENT'});
 for(const file of [recent,active,path.join(f.directory,'gateway/gateway-trace.jsonl'),path.join(f.directory,'attachments/keep.png'),path.join(f.directory,'account-automation.v1.json'),path.join(f.directory,'image-queue.json')])await fs.stat(file);
 cleaner.dispose();
});
test('budget evicts oldest completed records, never a protected in-progress record',()=>{
 const now=Date.now(),records=[
  {bytes:40*MiB,modified:now-2*DAY,protected:false},
  {bytes:40*MiB,modified:now-DAY,protected:false},
  {bytes:50*MiB,modified:now-10*DAY,protected:true}
 ];
 const plan=cleanupPlan(records,{days:7,maxMiB:64},now);
 assert.deepEqual(plan.records,records.slice(0,2));assert.equal(plan.remainingBytes,50*MiB);
});
test('new writes after preview invalidate deletion and unknown neighboring files remain untouched',async t=>{
 const f=await fixture(t),old=await record(f.traffic,'old',8),mixed=await record(f.traffic,'mixed',9);
 const scanned=await trafficRecords(f.traffic,Date.now(),[]);
 await fs.appendFile(path.join(old,'response.body'),'new write');
 assert.equal((await deleteRecord(scanned.find(r=>r.path===old),Date.now())).changed,true);
 await fs.writeFile(path.join(mixed,'personal-notes.txt'),'keep');
 const cleaner=createStorageMaintenance({directory:f.directory,trafficDirectory:()=>f.traffic});
 await cleaner.clean(true);
 assert.equal(await fs.readFile(path.join(mixed,'personal-notes.txt'),'utf8'),'keep');cleaner.dispose();
});
test('junction paths are rejected without following them',async t=>{
 const f=await fixture(t),outside=path.join(f.root,'outside'),link=path.join(f.traffic,'linked');
 await fs.mkdir(outside);await fs.writeFile(path.join(outside,'keep'),'keep');await fs.symlink(outside,link,'junction');
 try{await assert.rejects(safePath(f.traffic,link),/junction|symlink/);assert.equal(await fs.readFile(path.join(outside,'keep'),'utf8'),'keep');}
 finally{await fs.unlink(link);}
});
test('budget pause stops body logging while preserving a terminal gap marker',async t=>{
 const f=await fixture(t),logs=new TrafficLogs({directory:f.traffic});
 const base={requestId:'budget',method:'POST',path:'/responses',targetHost:'fixture.test',at:Date.now()};
 await logs.append({...base,type:'client_request',stage:'CLIENT_JSON_PREPARED'},{bytes:Buffer.from('before')});
 logs.setMaintenanceBudget(0);
 await logs.append({...base,type:'client_response',stage:'CLIENT_RESPONSE_CHUNK'},{bytes:Buffer.from('not logged')});
 await logs.append({...base,type:'client_response',stage:'CLIENT_RESPONSE_FINISHED'});
 await logs.flush();const folder=logs.requests.get('budget').folder;
 await assert.rejects(fs.stat(path.join(folder,'response.body')),{code:'ENOENT'});
 assert.ok((await fs.readFile(path.join(folder,'gaps.jsonl'),'utf8')).length>0);
 assert.equal(logs.snapshot().trafficLogsMaintenancePaused,true);
});
