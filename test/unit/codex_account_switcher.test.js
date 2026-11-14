'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createAccountSwitcher}=require('../../src/codex_account_switcher');
const {settings}=require('../../src/codex_account_policy');
function memory(state){let queue=Promise.resolve();return {read:async()=>structuredClone(state),transaction:fn=>{const result=queue.then(()=>fn(state));queue=result.catch(()=>{});return result;}};}
function fixture(policy='wait'){
 let now=1800000000000;const state={settings:settings({autoResume:true,busyPolicy:policy}),hosts:{one:{id:'one',pid:process.pid,home:'home',currentRef:'a',ready:true,busy:[],quotaFailures:[{threadId:'thread',turnId:'turn'}],at:now}},switchJob:null};
 const store=memory(state),calls=[],account={id:'b',email:'b@test',status:'ready',planType:'plus',settings:{},quota:{checkedAt:now,groups:[{id:'codex',windows:[{durationMinutes:300,usedPercent:20,resetsAt:now+18000000}]}]}};
 const switcher=createAccountSwitcher({store,owner:'one',now:()=>now,core:{request:async action=>{calls.push(action);return {}; }},codexHome:()=>'/fixture',refreshCandidates:async()=>[account],checkTarget:async()=>true,interrupt:async()=>calls.push('interrupt'),persist:async()=>{},reload:async()=>calls.push('reload'),readStatus:async()=>({turnId:'turn',status:'failed'}),resume:async()=>{calls.push('resume');return {turnId:'new'};}});
 return {state,store,calls,switcher,advance:()=>{now+=31000;state.hosts.one.at=now;state.hosts.one.barrier=state.switchJob.id;}};
}
test('countdown and all-host dispatch barriers precede activation; resume happens only after native confirmation',async()=>{
 const h=fixture();await h.switcher.propose({threadId:'thread'});await h.switcher.tick();assert.deepEqual(h.calls,[]);
 h.advance();await h.switcher.tick();assert.deepEqual(h.calls,['account.activate']);await h.switcher.tick();assert.deepEqual(h.calls,['account.activate','reload']);
 h.state.hosts.one.currentRef='b';await h.switcher.tick();assert.equal(h.calls.filter(c=>c==='resume').length,1);await h.switcher.tick();assert.equal(h.calls.filter(c=>c==='resume').length,1);
});
test('busy wait and ask do not interrupt; explicit interrupt policy stops without activating over running turns',async()=>{
 for(const policy of ['wait','ask','interrupt']){const h=fixture(policy);await h.switcher.propose();h.advance();h.state.hosts.one.busy=[{threadId:'busy'}];await h.switcher.tick();assert.equal(h.calls.includes('account.activate'),false);assert.equal(h.calls.includes('interrupt'),policy==='interrupt');}
});
test('cancelling the chooser prevents activation',async()=>{const h=fixture();await h.switcher.propose();await h.switcher.cancel(h.state.switchJob.id);h.advance();await h.switcher.tick();assert.deepEqual(h.calls,[]);});

test('a cancellation received while quota is checked cannot be overwritten by activation',async()=>{
 let state={settings:settings(),hosts:{one:{id:'one',pid:process.pid,home:'home',currentRef:'a',ready:true,busy:[],at:1800000000000,barrier:'job'}},switchJob:{id:'job',phase:'choosing',owner:'one',home:'home',from:'a',target:'b',deadline:0,resume:[]}};
 const store=memory(state),calls=[];
 const s=createAccountSwitcher({store,owner:'one',now:()=>1800000000000,core:{request:async()=>calls.push('activate')},checkTarget:async()=>{state.switchJob.phase='cancelled';return true;},codexHome:()=>'/fixture'});
 await s.tick();assert.deepEqual(calls,[]);assert.equal(state.switchJob.phase,'cancelled');
});
