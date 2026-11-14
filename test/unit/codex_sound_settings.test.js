'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { SOUND_TYPES, normalizeSoundSettings, createSoundSettings, filterAttentionSound, terminalSoundType } = require('../../src/codex_sound_settings');
const { createCompletionSounds } = require('../../src/codex_completion_sounds');

test('sound controls migrate legacy quota choices and independently mute every type', async () => {
  let saved;
  const settings = createSoundSettings({ legacy: { enabled: true, speakOnChange: false, speakOnLargeChange: true }, save: async s => { saved = s; } });
  assert.equal(settings.enabled('quota_change'), false); assert.equal(settings.enabled('quota_large_change'), true);
  let plays = 0;
  for (const { id } of SOUND_TYPES) {
    await settings.update({ types: { [id]: false } }); await settings.play(id, async () => { plays++; });
    assert.equal(settings.enabled(id), false);
  }
  assert.equal(plays, 0);
  await settings.update({ types: { chat_completed: true, chat_failed: true } });
  const restored = createSoundSettings({ value: saved, save: async () => {} });
  assert.equal(restored.enabled('chat_completed'), true); assert.equal(restored.enabled('approval_initial'), false);
  await restored.update({ enabled: false }); await restored.play('chat_completed', async () => { plays++; });
  assert.equal(plays, 0); await restored.play('chat_completed', async () => { plays++; }, true); assert.equal(plays, 1);
});

test('settings writes serialize and roll back failure; queued automatic sounds honor the latest mute', async () => {
  let fail = false;
  const settings = createSoundSettings({ save: async () => { if (fail) throw new Error('disk'); } });
  await Promise.all([settings.update({ types: { approval_initial: false } }), settings.update({ types: { input_initial: false } })]);
  assert.equal(settings.enabled('approval_initial'), false); assert.equal(settings.enabled('input_initial'), false);
  fail = true; await assert.rejects(settings.update({ enabled: false }), /disk/); assert.equal(settings.snapshot().enabled, true);
  fail = false; let release; const played = [];
  const first = settings.play('chat_completed', () => new Promise(resolve => { played.push('first'); release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const second = settings.play('chat_failed', async () => played.push('second'));
  await settings.update({ enabled: false }); release(); await Promise.all([first, second]); assert.deepEqual(played, ['first']);
  await assert.rejects(settings.update({ types: { unknown: true } }));
});

test('attention filters initial and reminder categories independently; specific terminal sounds take priority', () => {
  const settings = normalizeSoundSettings({ types: { approval_initial: false, input_reminder: false } });
  const both = ['waitingOnApproval', 'waitingOnUserInput'];
  assert.deepEqual(filterAttentionSound({ newFlags: both, isReminder: false }, settings).newFlags, ['waitingOnUserInput']);
  assert.deepEqual(filterAttentionSound({ waits: both.map(flag => ({ flag, elapsedMinutes: 5 })), isReminder: true }, settings).waits.map(w => w.flag), ['waitingOnApproval']);
  const capacity = { codexErrorInfo: 'serverOverloaded' }, retry = { codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } } };
  assert.equal(terminalSoundType('failed', capacity, settings), 'model_capacity');
  assert.equal(terminalSoundType('failed', retry, settings), 'retry_429');
  settings.types.retry_429 = false; assert.equal(terminalSoundType('failed', retry, settings), 'chat_failed');
  settings.types.chat_failed = false; assert.equal(terminalSoundType('failed', retry, settings), null);
  assert.equal(terminalSoundType('completed', null, settings), 'chat_completed');
  assert.equal(terminalSoundType('interrupted', null, settings), null);
});

test('completion monitor ignores tools, manual stop, compaction, children and ongoing chats; deduplicates and persists terminal events', async () => {
  const played = []; let saved;
  const options = { settings: () => normalizeSoundSettings(), save: async state => { saved = state; },
    describe: async event => ({ isRoot: event.threadId !== 'child', active: event.threadId === 'continuing' }), notify: async type => played.push(type) };
  const monitor = createCompletionSounds(options);
  const event = (threadId, id, status, extra = {}) => ({ threadId, turn: { id, status, ...extra } });
  await monitor.handle(event('root', 'tool', 'inProgress', { error: { message: 'tool failed' } }));
  await monitor.handle(event('root', 'stop', 'interrupted'));
  await monitor.handle(event('root', 'stop2', 'interrupted', { error: { message: 'Interrupted by user' } }));
  await monitor.handle(event('root', 'compact', 'completed', { items: [{ type: 'contextCompaction' }] }));
  await monitor.handle(event('child', 'child-turn', 'completed')); await monitor.handle(event('continuing', 'auto', 'completed'));
  assert.deepEqual(played, []);
  const done = event('root', 'done', 'completed'); await Promise.all([monitor.handle(done), monitor.handle(done)]);
  await monitor.handle(event('root', 'error', 'failed', { error: { message: 'fatal' } }));
  await monitor.handle(event('root', 'forced', 'interrupted', { error: { message: 'context failure' } }));
  const special = event('root', '429', 'failed', { error: { message: 'exceeded retry limit, last status: 429 Too Many Requests' } });
  await monitor.handle(special); await monitor.handle(special);
  assert.deepEqual(played, ['chat_completed', 'chat_failed', 'chat_failed', 'retry_429']);
  const restored = createCompletionSounds({ ...options, state: saved }); await restored.handle(done); await restored.handle(special);
  assert.equal(played.length, 4); monitor.dispose(); restored.dispose();
});

test('failed playback remains retryable without repeating a later successful notification', async () => {
  let fail = true, attempts = 0, saved;
  const monitor = createCompletionSounds({ settings: () => normalizeSoundSettings(), describe: async () => ({ isRoot: true }),
    save: async value => { saved = value; }, notify: async () => { attempts++; if (fail) throw new Error('audio missing'); } });
  const event = { threadId: 'root', turn: { id: 'error', status: 'failed', error: { message: 'server failed' } } };
  await assert.rejects(monitor.handle(event), /audio missing/); assert.deepEqual(saved.seen, []);
  fail = false; await monitor.handle(event); await monitor.handle(event); assert.equal(attempts, 2);
  monitor.dispose();
});

test('specific capacity sound retains its per-chat five-minute cooldown across reload', async () => {
  let at = 0, saved; const played = [];
  const options = { now: () => at, settings: () => normalizeSoundSettings(), describe: async () => ({ isRoot: true }),
    save: async value => { saved = value; }, notify: async type => played.push(type) };
  const monitor = createCompletionSounds(options);
  const event = id => ({ threadId: 'root', turn: { id, status: 'failed', error: { codexErrorInfo: 'serverOverloaded' } } });
  await monitor.handle(event('one')); at = 1000; await monitor.handle(event('two'));
  assert.deepEqual(played, ['model_capacity']);
  const restored = createCompletionSounds({ ...options, state: saved }); at = 2000; await restored.handle(event('three'));
  assert.equal(played.length, 1); at = 300000; await restored.handle(event('four')); assert.equal(played.length, 2);
  monitor.dispose(); restored.dispose();
});
