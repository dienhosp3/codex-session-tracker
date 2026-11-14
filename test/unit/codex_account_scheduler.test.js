'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createAccountScheduler}=require('../../src/codex_account_scheduler');
function memory(){let state={schedules:{}},queue=Promise.resolve();return {read:async()=>structuredClone(state),transaction:fn=>{const result=queue.then(()=>fn(state));queue=result.catch(()=>{});return result;}};}
const now=1800000000000;
const account={id:'a',launcherId:'bat',settings:{warmupEnabled:true}};
const q=used=>({checkedAt:now,groups:[{id:'codex',windows:[{durationMinutes:300,usedPercent:used,resetsAt:now+18000000},{durationMinutes:10080,usedPercent:10,resetsAt:now+86400000}]}]});
test('two windows send only one Work message and wait for completion',async()=>{
 const store=memory(),calls=[];const core={request:async(action,args)=>{calls.push(action);if(action==='quota.read')return q(0);if(action==='conversation.create')return {id:'chat'};if(action==='turn.send')return {turnRef:'turn'};if(action==='turn.wait')return {completed:true};return {};}};
 const a=createAccountScheduler({store,core,owner:'one',now:()=>now}),b=createAccountScheduler({store,core,owner:'two',now:()=>now});
 await Promise.all([a.run(account),b.run(account)]);assert.equal(calls.filter(c=>c==='turn.send').length,1);assert.equal((await store.read()).schedules.a.phase,'completed');
 await a.run(account);assert.equal(calls.filter(c=>c==='turn.send').length,1);a.dispose();b.dispose();
});
test('already-active quota schedules its reset without opening a browser or sending',async()=>{
 const store=memory(),calls=[];const s=createAccountScheduler({store,owner:'one',now:()=>now,core:{request:async action=>{calls.push(action);return q(0.001);}}});
 await s.run(account);assert.deepEqual(calls,['quota.read']);assert.equal((await store.read()).schedules.a.nextCheckAt,now+18060000);s.dispose();
});
test('uncertain Send survives restart and reconciles instead of resending',async()=>{
 const store=memory(),calls=[];const core={request:async action=>{calls.push(action);if(action==='quota.read')return q(0);if(action==='conversation.create')return {id:'chat'};if(action==='turn.send')throw new Error('lost ACK');if(action==='request.inspect')return {found:true,turnRef:'confirmed'};if(action==='turn.wait')return {completed:true};return {};}};
 const a=createAccountScheduler({store,core,owner:'one',now:()=>now});await a.run(account);a.dispose();assert.equal((await store.read()).schedules.a.phase,'unknown');
 const b=createAccountScheduler({store,core,owner:'two',now:()=>now});await b.run(account);assert.equal(calls.filter(c=>c==='turn.send').length,1);assert.equal((await store.read()).schedules.a.phase,'completed');b.dispose();
});
