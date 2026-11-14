'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createContextWatch } = require('../../src/codex_context_watch');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function settled(watch) { for (let i = 0; i < 200 && watch.snapshot().busy.length; i++) await tick(); assert.equal(watch.snapshot().busy.length, 0); }

test('same rejected preflight at 85.6/85 does not cycle pending every 100ms or disappear on reload', async t => {
  let saved, attempts = 0, writes = 0, turnId = 'first';
  const options = { state: { intervalMs: 100, thresholdPercent: 85, entries: { source: { enabled: true, thresholdPercent: 85 } } },
    save: async state => { saved = state; writes++; },
    read: async () => ({ running: true, turnId, percent: 85.64509898599711, model: 'gpt-6-astra', serviceTier: 'ultrafast' }),
    readManual: async () => ({ running: true, turnId, model: 'gpt-6-astra', serviceTier: 'ultrafast' }),
    handoff: async () => { attempts++; throw Object.assign(new Error('Preflight unavailable'), { handoffSkipped: true }); } };
  const watch = createContextWatch(options); t.after(() => watch.dispose());
  await watch.poll(); await settled(watch); const initialWrites = writes;
  for (let i = 0; i < 100; i++) { await watch.poll(); await settled(watch); }
  assert.equal(attempts, 1); assert.equal(writes, initialWrites);
  assert.equal(watch.snapshot().readings.source.error, 'Preflight unavailable');
  assert.equal(watch.blocks('source'), false); watch.dispose();
  const restored = createContextWatch({ ...options, state: saved }); t.after(() => restored.dispose());
  await restored.poll(); await settled(restored); assert.equal(attempts, 1);
  turnId = 'second'; await restored.poll(); await settled(restored); assert.equal(attempts, 2);
  await assert.rejects(restored.transferNow('source'), /Preflight unavailable/); assert.equal(attempts, 3);
});

test('explicit Goal activation releases only an inactive-goal deferral, without replaying completed handoffs', async t => {
  let attempts = 0, active = false;
  const watch = createContextWatch({ state: { entries: { source: { enabled: true, continuationMode: 'goal' } } }, save: async () => {},
    read: async () => ({ running: true, turnId: 'same', percent: 90 }),
    handoff: async () => {
      attempts++;
      if (!active) throw Object.assign(new Error('Goal paused'), { handoffSkipped: true, handoffReason: 'goal-inactive' });
      return { phase: 'completed', nextThreadId: 'next', successorMode: 'goal' };
    } });
  t.after(() => watch.dispose());
  await watch.poll(); await settled(watch);
  await watch.goalUpdated({ threadId: 'source', status: 'paused' }); await watch.poll(); assert.equal(attempts, 1);
  active = true; await watch.goalUpdated({ threadId: 'source', status: 'active' }); await tick(); await settled(watch);
  assert.equal(attempts, 2); assert.equal(watch.snapshot().entries.source.handoff.phase, 'completed');
  await watch.goalUpdated({ threadId: 'source', status: 'active' }); assert.equal(attempts, 2);
});

test('changing transfer settings or explicitly re-enabling Auto resume permits one new preflight', async t => {
  let attempts = 0;
  const watch = createContextWatch({ state: { entries: { source: { enabled: true, thresholdPercent: 85 } } }, save: async () => {},
    read: async () => ({ running: true, turnId: 'same', percent: 90 }),
    handoff: async () => { attempts++; throw Object.assign(new Error('Unavailable'), { handoffSkipped: true }); } });
  t.after(() => watch.dispose());
  await watch.poll(); await settled(watch); assert.equal(attempts, 1);
  await watch.setChatOptions('source', { thresholdPercent: 86, intervalMs: 100, handoffDelaySeconds: 0, completionSound: true });
  await watch.poll(); await settled(watch); assert.equal(attempts, 2);
  await watch.setEntry('source', { enabled: true }); await tick(); await settled(watch); assert.equal(attempts, 3);
});
