'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createPlanState, mergePlanAttention } = require('../codex_plan_state');
const { createAttentionMonitor } = require('../codex_attention');
const { createCompletionSounds } = require('../codex_completion_sounds');
const { attentionInitialText, attentionInitialVoiceClips, attentionReminderText } = require('../codex_attention_voice');
const { normalizeSoundSettings, filterAttentionSound } = require('../codex_sound_settings');

test('idle plan is complete but awaiting a decision: notify once, remind, then clear on a new turn', async () => {
  let at = 0; const plans = createPlanState(), events = [];
  const monitor = createAttentionMonitor({ now: () => at,
    read: async () => mergePlanAttention([{ id: 'root', name: 'Plan task', status: { type: 'idle' } }], plans.snapshot()),
    notify: async event => events.push(event) });
  try {
    plans.started('root', 'plan-one'); plans.ready('root', 'plan-one');
    await monitor.poll(); await monitor.poll();
    assert.deepEqual(monitor.snapshot().root.flags, ['waitingOnPlanImplementation']);
    assert.equal(events.length, 1); assert.equal(attentionInitialText(events[0]), 'Đã lập xong kế hoạch. Có triển khai luôn không?');
    assert.deepEqual(attentionInitialVoiceClips(events[0]), ['plan_ready']);
    at = 300000; await monitor.poll(); assert.equal(attentionReminderText(events[1]), 'Đã 5 phút chưa có câu trả lời.');
    const disabled = normalizeSoundSettings({ types: { input_initial: false } });
    assert.equal(filterAttentionSound(events[0], disabled), null);
    plans.started('root', 'implementation'); await monitor.poll(); assert.deepEqual(monitor.snapshot(), {});
    assert.equal(plans.ready('root', 'plan-one'), false, 'late UI report cannot revive an old plan');
  } finally { monitor.dispose(); }
});

test('explicit Skip/dismiss clears the exact plan and stale completion cannot re-open it', async () => {
  const plans = createPlanState(); plans.ready('root', 'one'); plans.resolved('root', 'one');
  assert.deepEqual(plans.snapshot(), []); assert.equal(plans.ready('root', 'one'), false);
  plans.started('root', 'two'); plans.ready('root', 'two'); plans.resolved('root', 'one');
  assert.equal(plans.snapshot()[0].turnId, 'two');
  assert.equal(plans.ready('../wrong', 'three'), false);
});

test('new plans on the same chat notify again even if polling never saw an empty gap', async () => {
  const plans = createPlanState(), events = [];
  const monitor = createAttentionMonitor({ read: async () => mergePlanAttention([], plans.snapshot()), notify: async e => events.push(e) });
  try {
    plans.ready('root', 'one'); await monitor.poll();
    plans.started('root', 'two'); plans.ready('root', 'two'); await monitor.poll();
    assert.equal(events.length, 2); assert.equal(events[1].isReminder, false); assert.equal(events[1].planTurnId, 'two');
  } finally { monitor.dispose(); }
});

test('planning completion becomes a decision wait even with an active goal, without whole-task completion audio', async () => {
  const ready = [], played = [];
  const monitor = createCompletionSounds({ describe: async () => ({ isRoot: true, active: true }),
    settings: () => normalizeSoundSettings(), save: async () => {}, onPlanReady: e => ready.push(e), notify: async type => played.push(type) });
  await monitor.handle({ threadId: 'root', planReady: true, turn: { id: 'plan', status: 'completed' } });
  assert.deepEqual(ready, [{ threadId: 'root', turnId: 'plan' }]); assert.deepEqual(played, []);
  monitor.dispose();
});
