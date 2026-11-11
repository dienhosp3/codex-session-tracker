'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createAttentionMonitor, attentionFromStatus } = require('../codex_attention');

test('live approval and input flags notify once, clear, and re-arm independently', async () => {
  const sounds = [], updates = [];
  let rows = [];
  const monitor = createAttentionMonitor({ read: async () => rows, notify: async e => sounds.push(e.threadId), onChange: e => updates.push(e) });
  const waiting = (id, flags) => ({ id, name: id, status: { type: 'active', activeFlags: flags } });
  try {
    rows = [waiting('approval', ['waitingOnApproval']), waiting('input', ['waitingOnUserInput'])];
    await monitor.poll(); await monitor.poll();
    assert.deepEqual(sounds, ['approval', 'input']);
    assert.equal(updates.length, 1);
    rows[0].status.activeFlags = [];
    await monitor.poll(); assert.equal(monitor.snapshot().approval, undefined);
    rows[0].status.activeFlags = ['waitingOnApproval'];
    await monitor.poll(); assert.deepEqual(sounds, ['approval', 'input', 'approval']);
    rows[0].status.activeFlags = ['waitingOnApproval', 'waitingOnUserInput'];
    await monitor.poll(); assert.equal(sounds.length, 4);
    rows[0].status.activeFlags = ['waitingOnUserInput'];
    await monitor.poll(); assert.equal(sounds.length, 4, 'resolving one of two pending kinds does not beep again');
    rows[1].status = { type: 'idle' };
    await monitor.poll(); assert.equal(monitor.snapshot().input, undefined);
    rows = []; await monitor.poll(); assert.deepEqual(monitor.snapshot(), {});
  } finally { monitor.dispose(); }
  assert.deepEqual(attentionFromStatus({ type: 'idle', activeFlags: ['waitingOnApproval'] }), []);
});

test('failed read preserves pending labels; a failed beep retries without duplicating successful beeps', async () => {
  let brokenRead = false, attempts = 0;
  const monitor = createAttentionMonitor({ read: async () => {
    if (brokenRead) throw new Error('disconnected');
    return [{ id: 'a', status: { type: 'active', activeFlags: ['waitingOnUserInput'] } }];
  }, notify: async () => { if (++attempts === 1) throw new Error('audio busy'); } });
  try {
    await monitor.poll(); assert.ok(monitor.snapshot().a);
    brokenRead = true; await monitor.poll(); assert.ok(monitor.snapshot().a);
    brokenRead = false; await monitor.poll(); await monitor.poll(); assert.equal(attempts, 2);
  } finally { monitor.dispose(); }
});

test('unresolved approval/input waits remind every five minutes per chat and stop after resolution', async () => {
  let at = 0, rows = [];
  const sounds = [];
  const waiting = (id, flag) => ({ id, status: { type: 'active', activeFlags: [flag] } });
  const monitor = createAttentionMonitor({ now: () => at, read: async () => rows, notify: async e => sounds.push([e.threadId, at]) });
  try {
    rows = [waiting('approval', 'waitingOnApproval')];
    await monitor.poll();
    at = 60000; rows.push(waiting('input', 'waitingOnUserInput')); await monitor.poll();
    at = 299999; await monitor.poll(); assert.equal(sounds.length, 2);
    at = 300000; await monitor.poll(); await monitor.poll();
    assert.deepEqual(sounds, [['approval', 0], ['input', 60000], ['approval', 300000]]);
    at = 360000; await monitor.poll(); assert.deepEqual(sounds.at(-1), ['input', 360000]);
    rows[0].status.activeFlags = []; await monitor.poll();
    at = 600000; await monitor.poll(); assert.equal(sounds.length, 4, 'resolved approval has no reminder');
    at = 660000; await monitor.poll(); assert.deepEqual(sounds.at(-1), ['input', 660000]);
    rows[1].status = { type: 'idle' }; await monitor.poll();
    at = 1260000; await monitor.poll(); assert.equal(sounds.length, 5, 'resolved input has no reminder');
    rows[0].status = { type: 'active', activeFlags: ['waitingOnApproval'] };
    await monitor.poll(); assert.deepEqual(sounds.at(-1), ['approval', 1260000]);
  } finally { monitor.dispose(); }
});
