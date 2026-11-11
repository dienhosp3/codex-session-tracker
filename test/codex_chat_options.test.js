'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { chatOptions, validateChatOptions, soundsForChat } = require('../codex_chat_options');
const { createContextWatch } = require('../codex_context_watch');
const { createCompletionSounds } = require('../codex_completion_sounds');
const { normalizeSoundSettings } = require('../codex_sound_settings');
const defaults = { handoffDelaySeconds: 10, intervalMs: 300, completionSound: true };
const custom = { handoffDelaySeconds: 2, intervalMs: 100, completionSound: false };

test('chat options include the current threshold and reject unrelated/global fields', () => {
  assert.deepEqual(chatOptions(), defaults);
  assert.deepEqual(chatOptions(undefined, { intervalMs: 100, handoffDelaySeconds: 20 }), { ...defaults, intervalMs: 100, handoffDelaySeconds: 20 });
  assert.deepEqual(validateChatOptions(custom), custom);
  for (const patch of [{ thresholdPercent: 100 }, { enabled: true }, { model: 'other' }, { completionSound: 'false' },
    { intervalMs: 99 }, { intervalMs: 60001 }, { intervalMs: 100.5 }, { handoffDelaySeconds: -1 }, { handoffDelaySeconds: 3601 }]) {
    assert.throws(() => validateChatOptions({ ...custom, ...patch }));
  }
});

test('options persist per chat, leave global defaults and monitoring alone, and restore after reload', async t => {
  let saved;
  const config = { save: async value => { saved = value; }, read: async () => ({ percent: null }) };
  const watch = createContextWatch(config); t.after(() => watch.dispose());
  await watch.setChatOptions('a', custom, { title: 'A', cwd: 'workspace' });
  assert.deepEqual(watch.getChatOptions('a'), { ...custom, thresholdPercent: 80 }); assert.deepEqual(watch.getChatOptions('b'), { ...defaults, thresholdPercent: 80 });
  assert.equal(watch.tracks('a'), false); assert.equal(watch.snapshot().intervalMs, 300);
  assert.equal(watch.snapshot().handoffDelaySeconds, 10);
  const restored = createContextWatch({ ...config, state: saved }); t.after(() => restored.dispose());
  assert.deepEqual(restored.getChatOptions('a'), { ...custom, thresholdPercent: 80 }); assert.deepEqual(restored.getChatOptions('b'), { ...defaults, thresholdPercent: 80 });
  await restored.setEntry('a', { enabled: true, thresholdPercent: 90 });
  assert.deepEqual(restored.getChatOptions('a'), { ...custom, thresholdPercent: 90 }); assert.equal(restored.snapshot().entries.a.thresholdPercent, 90);
});

test('changing one chat timing does not accelerate another chat; timer polling follows individual intervals', async t => {
  let now = 0; const reads = [];
  const watch = createContextWatch({ now: () => now, state: { entries: {
    fast: { enabled: true, chatOptions: custom }, slow: { enabled: true, chatOptions: { ...defaults, intervalMs: 500 } }
  } }, save: async () => {}, read: async entry => { reads.push(entry.threadId); return { percent: 0 }; } });
  t.after(() => watch.dispose());
  await watch.poll(false); assert.deepEqual(reads, ['fast', 'slow']);
  now = 99; await watch.poll(false); assert.equal(reads.length, 2);
  now = 100; await watch.poll(false); assert.deepEqual(reads, ['fast', 'slow', 'fast']);
  now = 300; await watch.poll(false); assert.equal(reads.filter(x => x === 'slow').length, 1);
  now = 500; await watch.poll(false); assert.equal(reads.filter(x => x === 'slow').length, 2);
});

test('current-chat threshold applies on the next check without changing Auto resume or another chat', async t => {
  const calls = []; let saved;
  const watch = createContextWatch({ state: { entries: {
    running: { enabled: true, thresholdPercent: 90 }, other: { enabled: true, thresholdPercent: 95 }, disabled: { enabled: false, thresholdPercent: 90 }
  } }, save: async value => { saved = value; }, read: async () => ({ percent: 85, running: true, turnId: 'turn' }),
    handoff: async entry => { calls.push(entry.threadId); return { phase: 'completed', nextThreadId: 'next' }; } });
  t.after(() => watch.dispose());
  await watch.poll(); assert.equal(calls.length, 0);
  await watch.setChatOptions('running', { ...custom, thresholdPercent: 80 });
  assert.equal(watch.tracks('running'), true); assert.equal(saved.entries.running.thresholdPercent, 80);
  assert.equal(watch.getChatOptions('other').thresholdPercent, 95);
  await watch.setChatOptions('disabled', { ...custom, thresholdPercent: 50 });
  assert.equal(watch.tracks('disabled'), false);
  await watch.poll();
  for (let i = 0; i < 100 && watch.snapshot().busy.length; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['running']); assert.equal(saved.entries.disabled.thresholdPercent, 50);
});

test('per-chat delay reaches automatic and manual handoffs without leaking preferences to a different chat', async t => {
  const calls = []; let saved;
  const watch = createContextWatch({ state: { entries: { auto: { enabled: true, thresholdPercent: 80, chatOptions: custom } } },
    save: async value => { saved = value; }, read: async () => ({ running: true, turnId: 't', percent: 90 }),
    readManual: async () => ({ turnId: 't' }), handoff: async entry => { calls.push(entry); return { phase: 'completed', nextThreadId: entry.threadId + '-next' }; } });
  t.after(() => watch.dispose());
  await watch.poll();
  for (let i = 0; i < 50 && watch.snapshot().busy.length; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[0].handoffDelaySeconds, 2);
  await watch.setChatOptions('manual', { ...custom, handoffDelaySeconds: 4 });
  await watch.transferNow('manual'); assert.equal(calls[1].handoffDelaySeconds, 4);
  assert.deepEqual(watch.getChatOptions('manual-next'), { ...defaults, thresholdPercent: 80 });
  assert.equal(saved.entries.manual.chatOptions.completionSound, false);
});

test('failed saves roll back local preferences and a pending handoff cannot be reconfigured', async t => {
  let fail = false, release;
  const watch = createContextWatch({ save: async () => { if (fail) throw new Error('storage'); },
    readManual: () => new Promise(resolve => { release = resolve; }), handoff: async () => ({ nextThreadId: 'next' }) });
  t.after(() => watch.dispose());
  await watch.setChatOptions('a', custom); fail = true;
  await assert.rejects(watch.setChatOptions('a', defaults), /storage/); assert.deepEqual(watch.getChatOptions('a'), { ...custom, thresholdPercent: 80 });
  await assert.rejects(watch.setChatOptions('b', custom), /storage/); assert.equal(watch.snapshot().entries.b, undefined);
  fail = false; const moving = watch.transferNow('a');
  await assert.rejects(watch.setChatOptions('a', defaults), /chuyển tiếp/);
  release({ turnId: 't' }); await moving;
});

test('only completion is muted for one chat; errors and other chats still notify, and muted events never replay', async () => {
  const global = normalizeSoundSettings(), played = []; let muted = true, saved;
  const monitor = createCompletionSounds({ settings: threadId => soundsForChat(global, { completionSound: threadId === 'quiet' ? !muted : true }),
    save: async value => { saved = value; }, describe: async () => ({ isRoot: true }), notify: async (type, event) => played.push([type, event.threadId]) });
  const event = (threadId, id, status) => ({ threadId, turn: { id, status } });
  await monitor.handle(event('quiet', 'one', 'completed')); await monitor.handle(event('loud', 'one', 'completed'));
  await monitor.handle(event('quiet', 'two', 'failed'));
  assert.deepEqual(played, [['chat_completed', 'loud'], ['chat_failed', 'quiet']]);
  muted = false; await monitor.handle(event('quiet', 'one', 'completed'));
  assert.equal(played.length, 2); assert.ok(saved.seen.includes('quiet:one'));
  global.enabled = false; await monitor.handle(event('quiet', 'three', 'completed')); assert.equal(played.length, 2);
  monitor.dispose();
});

test('a failed options save for one chat cannot leak into a concurrent successful save for another', async t => {
  let release, saved, first = true;
  const watch = createContextWatch({ save: async value => {
    if (first) { first = false; await new Promise(resolve => { release = resolve; }); throw new Error('first write failed'); }
    saved = value;
  } });
  t.after(() => watch.dispose());
  const a = watch.setChatOptions('a', custom);
  const rejected = assert.rejects(a, /first write failed/);
  const b = watch.setChatOptions('b', { ...custom, handoffDelaySeconds: 6 });
  for (let i = 0; i < 50 && !release; i++) await new Promise(resolve => setImmediate(resolve));
  release(); await Promise.all([rejected, b]);
  assert.equal(saved.entries.a, undefined); assert.equal(saved.entries.b.chatOptions.handoffDelaySeconds, 6);
});
