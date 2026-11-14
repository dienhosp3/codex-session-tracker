'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createAttentionDismissals,attentionKey}=require('../../src/codex_attention_dismissals');
const {createAttentionMonitor}=require('../../src/codex_attention');

test('X persists only presentation; reminder sounds and native wait remain active',async()=>{
  let time=0,saved=[],sounds=0;
  const dismissals=createAttentionDismissals({save:async value=>{saved=value;}});
  const monitor=createAttentionMonitor({now:()=>time,read:async()=>[{id:'a',status:{type:'active',activeFlags:['waitingOnApproval']}}],notify:async()=>{sounds++;}});
  await monitor.poll();const entries=monitor.snapshot();
  await dismissals.dismiss('a',entries.a,attentionKey('a',entries.a));
  assert.equal(dismissals.snapshot(entries).a.hidden,true);
  assert.equal(createAttentionDismissals({initial:saved}).snapshot(entries).a.hidden,true);
  time=300001;await monitor.poll();assert.equal(sounds,2);assert.equal(monitor.snapshot().a.flags.length,1);
  dismissals.observe({});assert.equal(dismissals.snapshot(entries).a.hidden,false);
  monitor.dispose();
});
test('stale X cannot hide a newer plan or user question',async()=>{
  const d=createAttentionDismissals(),old={flags:['waitingOnPlanImplementation'],planTurnId:'old'},next={...old,planTurnId:'new'};
  assert.equal(await d.dismiss('a',next,attentionKey('a',old)),false);
  assert.equal(d.snapshot({a:next}).a.hidden,false);
});
