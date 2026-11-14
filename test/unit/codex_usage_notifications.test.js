'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { evaluateUsageVoice, normalizeUsageVoiceState, createUsageVoiceController } = require('../../src/codex_usage_voice');
const { evaluateUsageAlerts } = require('../../src/codex_usage_alerts');
const { createUsageNotifications } = require('../../src/codex_usage_notifications');
const settings = { enabled: true, largeChangePercent: 8 };
const snap = (remaining, at, resets = 2000000000000, account = 'test') => ({ checkedAt: at, groups: [{ id: 'codex', accountKey: account,
  windows: [{ key: 'primary', usedPercent: 100 - remaining, resetsAt: resets, durationMinutes: 300 }] }] });

test('one-second reset jitter cannot replay a drop minutes or hours later', () => {
  let state;
  const events = [];
  for (const [remaining, at, reset] of [[100,1000,0],[100,2000,1000],[90,3000,0],[90,4000,1000],[90,3600000,1000],[90,3601000,0],[82,3602000,0],[82,3662000,1000]]) {
    const r = evaluateUsageVoice(snap(remaining,at,2000000000000+reset),state,settings,at);state=r.state;events.push(...r.events);
  }
  assert.deepEqual(events.map(e=>e.remainingPercent),[90,82]);
  assert.deepEqual(events.map(e=>e.changePercent),[10,8]);
});
test('migrates jittered legacy baselines to the latest sample and ignores late responses', () => {
  const legacy = { samples: {
    'test|codex|primary|2000000000000': { remainingPercent: 82, checkedAt: 3000 },
    'test|codex|primary|2000000001000': { remainingPercent: 100, checkedAt: 1000 }
  } };
  let r = evaluateUsageVoice(snap(82,4000,2000000001000),legacy,settings,4000);
  assert.deepEqual(r.events,[]);assert.equal(Object.keys(r.state.samples).length,1);
  r = evaluateUsageVoice(snap(100,2000),r.state,settings,2000);
  assert.equal(r.state.samples['test|codex|primary'].remainingPercent,82);
});
test('real reset, account switches, invalid percentages and stale gaps establish silent baselines', () => {
  let r = evaluateUsageVoice(snap(80,1000),undefined,settings,1000);
  for (const s of [snap(100,2000,2000018000000),snap(60,3000,2000018000000,'another'),snap(60,4000,2000018000000),snap(30,1000000,2000018000000)]) {
    r=evaluateUsageVoice(s,r.state,settings,s.checkedAt);assert.deepEqual(r.events,[]);
  }
  const invalid=snap(20,1001000,2000018000000);invalid.groups[0].windows[0].usedPercent=null;
  assert.deepEqual(evaluateUsageVoice(invalid,r.state,settings,invalid.checkedAt).state,r.state);
});
test('threshold alerts use one cycle across jitter and ignore late data', () => {
  let r=evaluateUsageAlerts(snap(40,1000).groups,{},undefined,()=>1000);
  r=evaluateUsageAlerts(snap(20,2000).groups,{},r.state,()=>2000);assert.equal(r.events.length,1);
  r=evaluateUsageAlerts(snap(40,1500,2000000001000).groups,{},r.state,()=>1500);assert.deepEqual(r.events,[]);
  r=evaluateUsageAlerts(snap(20,3000,2000000001000).groups,{},r.state,()=>3000);assert.deepEqual(r.events,[]);
});
test('two extension hosts claim one announcement, persist across reload and discard obsolete queued audio', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'quota-shared-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  let clock=1000;const file=path.join(dir,'state.json'), a=createUsageNotifications(file,{},()=>clock), b=createUsageNotifications(file,{},()=>clock);
  const opts={voice:settings,alerts:{}};
  await a.process(snap(100,1000),opts);clock=2000;
  const results=await Promise.all([a.process(snap(90,2000),opts),b.process(snap(90,2001,2000000001000),opts)]);
  const events=results.flatMap(r=>r.voice.events);assert.equal(events.length,1);
  clock=3000;assert.equal(await a.isCurrent(events[0]),true);
  await b.process(snap(82,3000),opts);assert.equal(await a.isCurrent(events[0]),false);
  assert.equal((await createUsageNotifications(file).process(snap(82,4000,2000000001000),opts)).voice.events.length,0);
});
test('voice queue checks freshness at playback time', async () => {
  let release;const first=new Promise(r=>release=r), spoken=[];let valid=true;
  const voice=createUsageVoiceController({speak:async ({event})=>{spoken.push(event.remainingPercent);if(event.remainingPercent===90)await first;}});
  const a=voice.speak({remainingPercent:90}),b=voice.speak({remainingPercent:82,isCurrent:()=>valid});
  await Promise.resolve();valid=false;release();await Promise.all([a,b]);assert.deepEqual(spoken,[90]);
});
