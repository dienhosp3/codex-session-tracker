'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { createFailureRecovery } = require('../../src/codex_failure_recovery');
const { createStateStore } = require('../../src/codex_state_store');
const { classifyFailure } = require('../../src/codex_failures');
const EOF = 'stream disconnected before completion: stream closed before response.completed';
function memoryStore(initial = {entries:{},autoResume:false}) {
  let state=structuredClone(initial), queue=Promise.resolve();
  return {read:async()=>structuredClone(state),transaction:fn=>{const p=queue.then(()=>fn(state));queue=p.catch(()=>{});return p;}};
}
async function fixture(options={}) {
  let clock=1700000000000, live={turnId:'turn',status:'failed',active:false}, network={online:true,category:'stream'}, relay=null;
  const calls=[];
  const callbacks={store:options.store||memoryStore(),now:()=>clock,
    diagnose:async()=>({connection:{...network,checkedAt:clock},failure:relay}),readStatus:async()=>live,
    send:async task=>{calls.push(['send',task]);return {turnId:'next-'+calls.length};},
    compact:async()=>{calls.push(['compact']);live={turnId:'compact-turn',status:'completed',active:false};return {turnId:'compact-turn'};},
    restart:async()=>calls.push(['restart']),...options};
  const controller=createFailureRecovery(callbacks);await controller.ready;
  await controller.observe({threadId:'thread',turnId:'turn',error:EOF,occurredAt:clock});
  return {controller,callbacks,calls,clock:()=>clock,advance:ms=>{clock+=ms;},live:v=>{live=v;},network:v=>{network=v;},relay:v=>{relay=v;}};
}
test('failure classification preserves context, auth, quota, capacity, DNS and EOF distinctions',()=>{
  for(const [error,category] of [[{codexErrorInfo:'contextWindowExceeded'},'context'],['Your input exceeds the context window of this model.','context'],['context_length_exce','context'],['unauthorized','auth'],['HTTP 429','rate_limit'],['503 Service Unavailable','capacity'],['ENOTFOUND','dns'],[EOF,'stream']])assert.equal(classifyFailure(error).category,category);
});
test('diagnosis is read-only by default and correlated context blocks ordinary retries',async()=>{
  const h=await fixture();h.relay({...classifyFailure('Your input exceeds the context window'),confidence:'correlated'});
  h.advance(10000);await h.controller.tick();assert.deepEqual(h.calls,[]);
  await h.controller.diagnose('thread','turn');assert.equal(h.controller.snapshot().entries.thread.category,'context');
  await h.controller.act('thread','turn');assert.deepEqual(h.calls,[]);
  await h.controller.act('thread','turn','compact');assert.deepEqual(h.calls.map(c=>c[0]),['compact','send']);
  assert.equal(h.calls[1][1].expectedPreviousTurnId,'compact-turn');
});
for(const live of [{turnId:'turn',status:'inProgress',active:true},{turnId:'turn',status:'failed',waiting:true},{turnId:'turn',status:'failed',goalPaused:true},{turnId:'new',status:'failed'},{turnId:'turn',status:'completed'},{turnId:'turn',status:'interrupted'}])test('never sends over active, changed, completed, interrupted or waiting native state '+JSON.stringify(live),async()=>{
  const h=await fixture();h.live(live);await h.controller.act('thread','turn');assert.deepEqual(h.calls,[]);
});
test('unknown delivery persists across reload and connection checks cannot replay it',async()=>{
  let sends=0;const h=await fixture({send:async()=>{sends++;throw Object.assign(new Error('ACK lost'),{delivery:'unknown'});}});
  await h.controller.act('thread','turn');assert.equal(h.controller.snapshot().entries.thread.phase,'unknown');
  const reloaded=createFailureRecovery(h.callbacks);await reloaded.ready;
  await reloaded.diagnose('thread','turn');await reloaded.act('thread','turn');assert.equal(sends,1);
  h.live({turnId:'new-native-turn',status:'inProgress',active:true});await reloaded.diagnose('thread','turn');assert.equal(reloaded.snapshot().entries.thread.phase,'resolved');
});
test('automatic recovery waits for two online checks and caps a repeated failure chain at three sends',async()=>{
  const h=await fixture();await h.controller.setAutoResume(true);
  let turn='turn';
  for(let attempt=0;attempt<4;attempt++){
    h.live({turnId:turn,status:'failed'});h.advance(50000);await h.controller.tick();
    if(attempt<3){assert.equal(h.calls.length,attempt);h.advance(50000);await h.controller.tick();assert.equal(h.calls.length,attempt+1);
      turn=h.calls.at(-1)?'next-'+h.calls.length:turn;await h.controller.observe({threadId:'thread',turnId:turn,error:EOF,occurredAt:h.clock()});}
  }
  assert.equal(h.calls.length,3);
});
test('offline recovery waits without resetting proxy and historical errors cannot auto-start work',async()=>{
  const h=await fixture();await h.controller.setAutoResume(true);h.network({online:false,category:'offline'});
  h.advance(5000);await h.controller.tick();h.advance(15000);await h.controller.tick();assert.deepEqual(h.calls,[]);
  assert.equal(h.controller.snapshot().entries.thread.phase,'waiting_network');
  await h.controller.observe({threadId:'history',turnId:'old',error:EOF,occurredAt:h.clock(),historical:true});
  h.network({online:true,category:'stream'});h.advance(5000);await h.controller.tick();assert.deepEqual(h.calls,[]);
});
test('two hosts share a durable action reservation and a pending action after crash is not resent',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'recovery-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=createStateStore(path.join(dir,'state.json'),{entries:{},autoResume:false});let sends=0,release;
  const held=new Promise(r=>release=r);
  const h=await fixture({store,send:async()=>{sends++;await held;return {turnId:'new'};}});
  const other=createFailureRecovery({...h.callbacks,store:createStateStore(path.join(dir,'state.json'))});await other.ready;
  const first=h.controller.act('thread','turn');
  for(let i=0;i<100&&!sends;i++)await new Promise(r=>setTimeout(r,5));
  try{await other.act('thread','turn');assert.equal(sends,1);}finally{release();await first;}
  assert.equal((await store.read()).entries.thread.phase,'awaiting_result');
});
test('failed persistence prevents sending, and an uncertain compaction never falls through to continue',async()=>{
  const h=await fixture({compact:async()=>{throw new Error('compaction connection lost');}});
  h.relay({...classifyFailure('contextWindowExceeded'),confidence:'correlated'});await h.controller.diagnose('thread','turn');
  await h.controller.act('thread','turn','compact');assert.deepEqual(h.calls,[]);assert.equal(h.controller.snapshot().entries.thread.phase,'unknown');
  const s=await fixture();s.callbacks.store.transaction=async()=>{throw new Error('disk unavailable');};
  await assert.rejects(s.controller.act('thread','turn'),/disk unavailable/);assert.deepEqual(s.calls,[]);
});

test('a failure arriving before the start ACK keeps the same retry budget',async()=>{
  let controller;
  const h=await fixture({send:async()=>{await controller.observe({threadId:'thread',turnId:'fast-failure',error:EOF,occurredAt:h.clock()});return {turnId:'fast-failure'};}});
  controller=h.controller;await controller.act('thread','turn');
  const e=controller.snapshot().entries.thread;assert.equal(e.turnId,'fast-failure');assert.equal(e.phase,'detected');assert.equal(e.attempts,1);assert.equal(e.action.status,'done');
});
test('completion before the start ACK is reconciled without another continuation',async()=>{
  let controller;
  const h=await fixture({send:async()=>{await controller.settle({threadId:'thread',turn:{id:'fast-success',status:'completed'}});return {turnId:'fast-success'};}});
  controller=h.controller;await controller.act('thread','turn');assert.equal(controller.snapshot().entries.thread.phase,'resolved');
});
