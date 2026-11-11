'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { observeCompactions, subscribeCompactionStarted } = require('../codex_compaction_events');
const { createContextWatch } = require('../codex_context_watch');
const tick = () => new Promise(resolve => setImmediate(resolve));
const event = (threadId = 'source', turnId = 'turn', itemId = 'compact') => ({ method: 'item/started',
  params: { threadId, turnId, item: { type: 'contextCompaction', id: itemId } } });

test('observes live automatic starts once per connection, leaves manual/other items alone and restores hook', async t => {
  const sent = [], seen = [], original = (...args) => sent.push(args), connection = { sendRequest: original };
  const subscription = subscribeCompactionStarted(e => seen.push(e)); t.after(() => subscription.dispose());
  const one = observeCompactions(connection), two = observeCompactions(connection);
  t.after(() => { one.dispose(); two.dispose(); });
  connection.sendRequest('native', 'request', 'thread/compact/start', { threadId: 'manual' });
  one.notification({ method: 'turn/started', params: { threadId: 'manual', turn: { id: 'previous' } } });
  one.notification({ method: 'turn/completed', params: { threadId: 'manual', turn: { id: 'previous' } } });
  one.notification(event('manual')); two.notification(event('manual'));
  one.notification({ ...event(), method: 'item/completed' });
  one.notification({ method: 'item/started', params: { threadId: 'source', turnId: 'turn', item: { type: 'agentMessage', id: 'msg' } } });
  one.notification(event()); two.notification(event());
  await tick(); assert.deepEqual(seen, [{ threadId: 'source', turnId: 'turn', itemId: 'compact' }]);
  assert.equal(sent.length, 1); assert.equal(sent[0][2], 'thread/compact/start');
  one.dispose(); assert.notEqual(connection.sendRequest, original);
  two.dispose(); assert.equal(connection.sendRequest, original);
});

test('explicit new input invalidates a pending manual marker and hooks are scoped to the connection', async t => {
  const seen = [], subscription = subscribeCompactionStarted(e => seen.push(e)); t.after(() => subscription.dispose());
  const a = { sendRequest() {} }, b = { sendRequest() {} }, one = observeCompactions(a), two = observeCompactions(b);
  t.after(() => { one.dispose(); two.dispose(); });
  a.sendRequest('native', 'one', 'thread/compact/start', { threadId: 'same' });
  two.notification(event('same', 'other', 'one'));
  a.sendRequest('native', 'two', 'turn/start', { threadId: 'same' });
  one.notification(event('same', 'new', 'two'));
  await tick(); assert.deepEqual(seen.map(e => e.turnId), ['other', 'new']);
});

test('Auto resume is threshold OR compaction, ignores disabled chats, deduplicates concurrent triggers and inherits', async t => {
  let release, saved; const calls = [];
  const watch = createContextWatch({ state: { entries: { source: { enabled: true, thresholdPercent: 99 }, off: { enabled: false } } },
    read: async () => ({ running: true, turnId: 'same-turn', percent: 100 }), save: async value => { saved = value; },
    handoff: entry => { calls.push(entry); return new Promise(resolve => { release = resolve; }); } });
  t.after(() => watch.dispose());
  await watch.compactionStarted({ threadId: 'off', turnId: 'off-turn' });
  await watch.compactionStarted({ threadId: 'missing', turnId: 'missing-turn' });
  assert.equal(calls.length, 0);
  const compacting = watch.compactionStarted({ threadId: 'source', turnId: 'same-turn' });
  await tick(); await watch.poll(); await watch.compactionStarted({ threadId: 'source', turnId: 'same-turn' });
  assert.equal(calls.length, 1); assert.equal(calls[0].trigger, 'auto_compact'); assert.equal(calls[0].manual, false);
  release({ phase: 'completed', trigger: 'auto_compact', nextThreadId: 'next', nextTitle: 'Next', successorMode: 'goal', goalText: 'Objective' });
  await compacting;
  assert.equal(saved.entries.source.enabled, false); assert.equal(saved.entries.next.enabled, true);
  assert.equal(saved.entries.next.thresholdPercent, 99); assert.equal(saved.entries.next.continuationMode, 'goal');
  const restored = createContextWatch({ state: saved, save: async () => {}, handoff: async entry => { calls.push(entry); return { nextThreadId: 'last' }; } });
  t.after(() => restored.dispose());
  await restored.compactionStarted({ threadId: 'next', turnId: 'next-turn' });
  assert.equal(calls.length, 2); assert.equal(calls[1].trigger, 'auto_compact');
});

test('threshold winning a race prevents a second compaction handoff; failed transfer is not replayed', async t => {
  const calls = [];
  const watch = createContextWatch({ state: { entries: { source: { enabled: true } } }, save: async () => {},
    read: async () => ({ running: true, turnId: 'turn', percent: 90 }),
    handoff: async entry => { calls.push(entry); throw new Error('Cannot create successor'); } });
  t.after(() => watch.dispose());
  await watch.poll(); await watch.compactionStarted({ threadId: 'source', turnId: 'turn' }); await tick();
  assert.equal(calls.length, 1); assert.equal(calls[0].trigger, 'threshold');
  assert.equal(watch.snapshot().entries.source.handoff.phase, 'failed');
  await watch.compactionStarted({ threadId: 'source', turnId: 'turn' }); assert.equal(calls.length, 1);
});
