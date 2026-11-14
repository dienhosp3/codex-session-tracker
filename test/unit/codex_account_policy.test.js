'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {settings,warmupDecision,rankAccounts}=require('../../src/codex_account_policy');
const now=1800000000000;
function account(id,short,week,extra={}){return {id,status:'ready',planType:'plus',settings:{warmupEnabled:true,autoSwitchAllowed:true},quota:{checkedAt:now,groups:[{id:'codex',windows:[{durationMinutes:300,usedPercent:100-short,resetsAt:now+9000000},{durationMinutes:10080,usedPercent:100-week,resetsAt:now+86400000}]}]},...extra};}
test('weekly headroom limits an apparently full five-hour account',()=>{assert.equal(rankAccounts([account('a',90,3),account('b',50,40)],now)[0].id,'b');});
test('every quota below 100 percent suppresses warmup, including tiny fractional usage',()=>{for(const remaining of [99.999,50,0]){const a=account('a',remaining,50);assert.equal(warmupDecision(a,a.quota,{},now).action,'wait');}});
test('one accepted send is never replayed because quota stays at 100 or reset drifts one second',()=>{const a=account('a',100,70),reset=a.quota.groups[0].windows[0].resetsAt;assert.equal(warmupDecision(a,a.quota,{requestId:'sent',resetAt:reset-1000},now).action,'reconcile');});
test('a spent week blocks a full five-hour cycle; a genuinely new cycle permits a new attempt',()=>{const a=account('a',100,0);assert.equal(warmupDecision(a,a.quota,{},now).reason,'weekly_exhausted');const b=account('b',100,40);assert.equal(warmupDecision(b,b.quota,{requestId:'old',resetAt:now-120000},now).action,'send');});
test('stale and incomparable plans do not win an automatic switch',()=>{assert.equal(rankAccounts([account('a',100,100,{planType:'unknown'}),account('b',40,50)],now)[0].id,'b');assert.deepEqual(rankAccounts([account('a',100,100)],now+60001),[]);});
test('defaults preserve manual operation; invalid switch policies are rejected',()=>{assert.equal(settings().autoSwitch,false);assert.equal(settings().autoResume,false);assert.throws(()=>settings({busyPolicy:'kill'}));assert.equal(settings({choiceSeconds:null}).choiceSeconds,null);});

test('a fresh full quota after expiration can start the next cycle even when the service retains the old reset timestamp',()=>{
 const a=account('a',100,50);a.quota.groups[0].windows[0].resetsAt=now-120000;
 const decision=warmupDecision(a,a.quota,{requestId:'previous',resetAt:now-120000},now);
 assert.equal(decision.action,'send');assert.equal(decision.resetAt,null);
 assert.equal(warmupDecision(a,a.quota,{requestId:'new',resetAt:null},now).action,'reconcile');
});
