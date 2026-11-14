'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {createStateStore}=require('../../src/codex_state_store');
const {createAccountManager,recoveredAccountState}=require('../../src/codex_account_manager');

async function fixture(t,initial={count:0}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'state-store-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'state.json');
  return {dir,file,store:createStateStore(file,initial)};
}

test('NUL-filled state produces a bounded error without leaking raw contents',async t=>{
  const f=await fixture(t);await fs.writeFile(f.file,Buffer.alloc(716));
  await assert.rejects(f.store.read(),error=>error.code==='STATE_FILE_INVALID'&&!error.message.includes('\0')&&!error.message.includes('Unexpected token'));
  assert.equal((await fs.readFile(f.file)).length,716);
});
test('recovery retains corrupt bytes and restores the last valid backup with automation suspended',async t=>{
  const f=await fixture(t,{settings:{autoSwitch:true,autoResume:true},hosts:{old:{}},schedules:{a:{requestId:'already-sent'}},switchJob:{id:'switch',phase:'resuming',resume:[{state:'sending'}]}});
  await f.store.transaction(s=>{s.count=1;});
  await f.store.transaction(s=>{s.count=2;});
  await fs.writeFile(f.file,Buffer.alloc(716));
  const result=await f.store.recover(recoveredAccountState);
  assert.equal(result.source,'backup');assert.equal(result.state.count,1);
  assert.equal(result.state.settings.autoSwitch,false);assert.equal(result.state.settings.autoResume,false);
  assert.equal(result.state.recovery.automationPaused,true);assert.deepEqual(result.state.hosts,{});
  assert.equal(result.state.switchJob.phase,'failed');assert.equal(result.state.schedules.a.requestId,'already-sent');
  assert.deepEqual(await fs.readFile(f.file+'.corrupt'),Buffer.alloc(716));
  assert.equal((await f.store.read()).count,1);
  await f.store.transaction(s=>{s.count=3;});
  assert.equal((await f.store.read()).count,3);
  assert.equal((await fs.readdir(f.dir)).some(n=>n.includes('.tmp-')||n.endsWith('.lock')),false);
});
test('first-run corrupt state recovers defaults once, serializing competing windows',async t=>{
  const f=await fixture(t,{settings:{},hosts:{},schedules:{},switchJob:null});
  await fs.writeFile(f.file,Buffer.alloc(716));
  const other=createStateStore(f.file);
  const results=await Promise.all([f.store.recover(recoveredAccountState),other.recover(recoveredAccountState)]);
  assert.equal(results.filter(r=>r.recovered).length,1);
  assert.equal((await f.store.read()).settings.choiceSeconds,30);
  assert.equal((await fs.readdir(f.dir)).filter(n=>n.endsWith('.corrupt')).length,1);
});
test('flush failure preserves the committed primary and cleans temporary files',async t=>{
  const f=await fixture(t);await f.store.transaction(s=>{s.count=1;});
  let flushed=false;
  const io={...fs,open:async(name,...args)=>{
    const handle=await fs.open(name,...args);
    if(String(name).startsWith(f.file+'.tmp-'))return {writeFile:bytes=>handle.writeFile(bytes),close:()=>handle.close(),sync:async()=>{flushed=true;throw new Error('flush failure');}};
    return handle;
  }};
  const failing=createStateStore(f.file,{}, {fsImpl:io});
  await assert.rejects(failing.transaction(s=>{s.count=2;}),/flush failure/);
  assert.equal(flushed,true);assert.equal((await f.store.read()).count,1);
  assert.equal((await fs.readdir(f.dir)).some(n=>n.includes('.tmp-')||n.endsWith('.lock')),false);
});
test('multiple store instances serialize updates without torn reads',async t=>{
  const f=await fixture(t);
  const stores=Array.from({length:12},()=>createStateStore(f.file,{count:0}));
  await Promise.all(stores.map(s=>s.transaction(state=>{state.count++;})));
  assert.equal((await f.store.read()).count,12);
});
test('BOM is accepted; invalid roots and access failures cannot silently reset data',async t=>{
  const f=await fixture(t);
  await fs.writeFile(f.file,'\uFEFF{"count":7}');
  assert.equal((await f.store.read()).count,7);
  await fs.writeFile(f.file,'null');await assert.rejects(f.store.read(),{code:'STATE_FILE_INVALID'});
  const inaccessible=createStateStore(f.file,{}, {fsImpl:{...fs,readFile:async()=>{throw Object.assign(new Error('access denied'),{code:'EACCES'});}}});
  await assert.rejects(inaccessible.read(),{code:'EACCES'});
  assert.equal(await fs.readFile(f.file,'utf8'),'null');
});
test('account startup recovers a real NUL file; paused recovery cannot send or switch',async t=>{
  const f=await fixture(t,{settings:{},hosts:{},schedules:{},switchJob:null});
  await fs.writeFile(f.file,Buffer.alloc(716));
  const calls=[],core={ready:async()=>{},request:async action=>{
    calls.push(action);
    if(action==='account.list')return {accounts:[{id:'a',settings:{warmupEnabled:true}}]};
    if(action==='launcher.list')return {launchers:[{id:'bat'}]};
    return {};
  }};
  const manager=createAccountManager({}, {globalStorageUri:{fsPath:f.dir}}, {store:f.store,core,codexHome:()=>f.dir,describeHost:async()=>({account:null,busy:[]})});
  const result=await manager.action({action:'refresh'});
  assert.equal(result?.error,undefined);assert.equal(manager.snapshot().launchers.length,1);
  assert.equal(manager.snapshot().recovery.automationPaused,true);
  await manager.tick();
  assert.equal(calls.some(action=>action.startsWith('conversation.')||action.startsWith('turn.')||action==='account.activate'),false);
  await manager.action({action:'configure',settings:manager.snapshot().settings});
  assert.equal((await f.store.read()).recovery.automationPaused,false);
  await manager.dispose();
});
