'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { appServerFixture } = require('./app_server_fixture');
const { subscribeTurnLifecycle } = require('../codex_live_backend');
const { planState, mergePlanAttention } = require('../codex_plan_state');
const { createCompletionSounds } = require('../codex_completion_sounds');
const { createAttentionMonitor } = require('../codex_attention');
const { normalizeSoundSettings } = require('../codex_sound_settings');
const { attentionInitialVoiceClips } = require('../codex_attention_voice');

test('installed Codex proposed plan finishes as an idle decision wait, clears on Skip or implementation', { timeout: 45000 }, async () => {
  let makePlan = true; const completed = [], initial = [];
  planState.clear();
  const f = await appServerFixture({ respond: async (_request, res) => {
    const text = makePlan ? '<proposed_plan>\n# Fixture plan\nInspect the files, implement and test.\n</proposed_plan>' : 'Implementation finished.';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [
      { type: 'response.created', response: { id: 'plan-response' } },
      { type: 'response.output_item.added', output_index: 0, item: { id: 'plan-message', type: 'message', role: 'assistant', content: [] } },
      { type: 'response.output_text.delta', item_id: 'plan-message', output_index: 0, content_index: 0, delta: text },
      { type: 'response.output_item.done', output_index: 0, item: { id: 'plan-message', type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } },
      { type: 'response.completed', response: { id: 'plan-response', usage: { input_tokens: 12, output_tokens: 30, total_tokens: 42 } } }
    ]) res.write('data: ' + JSON.stringify(event) + '\n\n');
    res.end(); return true;
  } });
  const completion = createCompletionSounds({ describe: async () => ({ isRoot: true }), settings: () => normalizeSoundSettings(),
    save: async () => {}, onPlanReady: e => planState.ready(e.threadId, e.turnId), notify: async type => completed.push(type) });
  const subscription = subscribeTurnLifecycle(e => completion.handle(e));
  const monitor = createAttentionMonitor({ read: async () => mergePlanAttention(await f.backend.readAttentionThreads(), planState.snapshot()),
    notify: async e => initial.push(attentionInitialVoiceClips(e)) });
  const until = async check => { for (let i = 0; i < 150; i++) { if (check()) return; await new Promise(r => setTimeout(r, 30)); } throw new Error('Plan event missing; item types: ' + f.events.filter(e => e.method === 'item/completed').map(e => e.params.item.type).join(',')); };
  try {
    const thread = (await f.rpc('thread/start', { cwd: f.root })).thread;
    const start = () => f.rpc('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Make a plan.' }],
      collaborationMode: { mode: makePlan ? 'plan' : 'default', settings: { model: 'gpt-6-astra', reasoning_effort: 'low', developer_instructions: null } } });
    const first = (await start()).turn;
    await until(() => planState.snapshot().some(e => e.turnId === first.id));
    assert.equal((await f.rpc('thread/read', { threadId: thread.id, includeTurns: false })).thread.status.type, 'idle');
    await monitor.poll(); await monitor.poll(); assert.deepEqual(initial, [['plan_ready']]); assert.deepEqual(completed, []);
    planState.resolved(thread.id, first.id); await monitor.poll(); assert.deepEqual(monitor.snapshot(), {});
    const second = (await start()).turn; await until(() => planState.snapshot().some(e => e.turnId === second.id));
    await monitor.poll(); assert.equal(initial.length, 2);
    makePlan = false; await start(); await until(() => completed.length === 1);
    await monitor.poll(); assert.deepEqual(planState.snapshot(), []); assert.deepEqual(monitor.snapshot(), {});
    assert.deepEqual(completed, ['chat_completed']);
    console.log('Native plan item + completed turn + idle decision wait verified; no generic completion for the plan; implementation clears waiting. External model calls: 0.');
  } finally { subscription.dispose(); completion.dispose(); monitor.dispose(); await f.close(); planState.clear(); }
});
