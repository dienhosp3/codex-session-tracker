'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path'), fs = require('node:fs/promises');
const { appServerFixture } = require('../fixtures/app_server_fixture');
const { createContextWatch } = require('../../src/codex_context_watch');
const { runContextHandoff } = require('../../src/codex_context_handoff');
const { contextConfig } = require('../../src/codex_new_chat');
const { readThreadPermissions } = require('../../src/codex_thread_permissions');
const { GOAL_GUARDRAILS } = require('../../src/codex_handoff_modes');
const { planState } = require('../../src/codex_plan_state');

async function until(check) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('Native mode transition timed out.');
}
const initialGoal = 'MỤC TIÊU:\nSửa lỗi fixture.\n\nHOÀN TẤT KHI:\nFixture đạt kiểm tra.';
const editedGoal = 'MỤC TIÊU:\nSửa lỗi đã được người dùng cập nhật.\n\nHOÀN TẤT KHI:\nKiểm tra mới đạt.';

test('native Goal starts first with context/no budget, carries live edits, respects pause; Plan is one-hop', { timeout: 50000 }, async () => {
  let phase = 'source', autoTarget = '', watch;
  const f = await appServerFixture({ respond: async (_request, res) => {
    if (phase === 'source') return false;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ type: 'response.created', response: { id: 'mode-probe' } }) + '\n\n');
    if (phase === 'hold') return true;
    const text = '<proposed_plan>\n# Kế hoạch fixture\nThực hiện đúng yêu cầu và kiểm chứng.\n</proposed_plan>';
    for (const event of [
      { type: 'response.output_item.added', output_index: 0, item: { id: 'mode-msg', type: 'message', role: 'assistant', content: [] } },
      { type: 'response.output_text.delta', item_id: 'mode-msg', output_index: 0, content_index: 0, delta: text },
      { type: 'response.output_item.done', item: { id: 'mode-msg', type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } },
      { type: 'response.completed', response: { id: 'mode-probe', usage: { input_tokens: 12, output_tokens: 30, total_tokens: 42 } } }
    ]) res.write('data: ' + JSON.stringify(event) + '\n\n');
    res.end(); return true;
  } });
  try {
    const source = (await f.rpc('thread/start', { cwd: f.root, approvalPolicy: 'never', sandbox: 'danger-full-access' })).thread;
    await f.rpc('thread/name/set', { threadId: source.id, name: '[MODE-0001] Original' });
    const sourceTurn = (await f.rpc('turn/start', { threadId: source.id, input: [{ type: 'text', text: 'Source task.' }], effort: 'high' })).turn;
    await until(() => f.events.some(e => e.method === 'turn/completed' && e.params.turn.id === sourceTurn.id));
    await until(async () => (await f.rpc('thread/read', { threadId: source.id, includeTurns: false })).thread.status.type === 'idle');
    const capability = await f.backend.handoffModes(source.id);
    assert.equal(capability.modes.goal.available, true, JSON.stringify(capability));
    assert.equal(capability.modes.plan.available, true, JSON.stringify(capability));
    let saved;
    const directory = path.join(f.root, 'handoffs');
    watch = createContextWatch({ state: { handoffDelaySeconds: 0 }, save: async state => { saved = state; },
      read: async entry => entry.threadId === autoTarget ? { ...await f.backend.readHandoffState(entry.threadId), model: 'gpt-6-astra', reasoning: 'high', percent: 99 } : { percent: 0 },
      readManual: async entry => ({ ...await f.backend.readHandoffState(entry.threadId), model: 'gpt-6-astra', reasoning: 'high' }),
      handoff: entry => runContextHandoff({ directory, backend: f.backend, entry: { ...entry, contextPreset: '600k',
        contextConfig: contextConfig('600k', { defaultTokens: 272000, maxTokens: 872000, effectivePercent: 95 }) } }) });
    phase = 'hold';
    const first = await watch.transferNow(source.id, { title: source.name, cwd: f.root, file: source.path }, {
      successorMode: 'goal', goalText: initialGoal, enabled: true, thresholdPercent: 85, serviceTier: 'priority', extraMessage: 'Chỉ làm phần còn thiếu.' });
    await until(() => f.requests.length === 2);
    const goal1 = await f.backend.readGoal(first.nextThreadId);
    assert.equal(goal1.objective, initialGoal); assert.equal(goal1.status, 'active'); assert.equal(goal1.tokenBudget, null);
    const context = f.requests[1].input.flatMap(item => item.content || []).map(item => item.text || '').join('\n');
    assert.ok(context.includes(first.message)); assert.ok(context.includes(GOAL_GUARDRAILS)); assert.ok(context.includes(initialGoal));
    assert.equal(f.requests[1].reasoning.effort, 'high');
    assert.equal(f.requests[1].service_tier, 'priority', 'Goal first request uses selected speed');
    const target = (await f.rpc('thread/read', { threadId: first.nextThreadId, includeTurns: true })).thread;
    assert.equal(target.turns.length, 1); assert.equal(target.turns[0].id, first.nextTurnId);
    const permissions = await readThreadPermissions(target.path, target.id);
    assert.equal(permissions.start.approvalPolicy, 'never');
    assert.ok(permissions.start.sandbox === 'danger-full-access' || permissions.start.permissions === ':danger-full-access');
    const records = (await fs.readFile(target.path, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(records.some(r => r.type === 'event_msg' && r.payload.type === 'task_started' && r.payload.model_context_window === 570000));
    const replay = await runContextHandoff({ directory, backend: f.backend, entry: { threadId: source.id } });
    assert.equal(replay.nextThreadId, first.nextThreadId); assert.equal(f.requests.length, 2);
    await f.rpc('thread/goal/set', { threadId: first.nextThreadId, objective: editedGoal, status: 'active', tokenBudget: 12000 });
    await f.rpc('thread/settings/update', { threadId: first.nextThreadId, serviceTier: 'default' });
    autoTarget = first.nextThreadId; await watch.poll(); autoTarget = '';
    await until(() => !watch.snapshot().busy.length);
    const second = saved.entries[first.nextThreadId].handoff;
    assert.equal(second.phase, 'completed', JSON.stringify(second)); assert.equal(second.successorMode, 'goal');
    await until(() => f.requests.length === 3);
    assert.equal(f.requests[2].service_tier ?? 'default', 'default', 'auto resume reads updated native speed');
    const goal2 = await f.backend.readGoal(second.nextThreadId);
    assert.equal(goal2.objective, editedGoal); assert.equal(goal2.tokenBudget, null);
    assert.equal(await f.backend.readGoal(first.nextThreadId), null);
    const secondReplay = await runContextHandoff({ directory, backend: f.backend,
      entry: { threadId: first.nextThreadId, successorMode: 'goal', manual: false } });
    assert.equal(secondReplay.nextThreadId, second.nextThreadId, 'cleared source uses completed journal without reactivation');
    assert.equal(saved.entries[second.nextThreadId].continuationMode, 'goal');
    await f.rpc('thread/goal/set', { threadId: second.nextThreadId, status: 'paused' });
    autoTarget = second.nextThreadId; await watch.poll(); autoTarget = '';
    await until(() => !watch.snapshot().busy.length);
    assert.equal(watch.snapshot().entries[second.nextThreadId].handoff, undefined); assert.equal(f.requests.length, 3);
    phase = 'plan';
    const planned = await watch.transferNow(second.nextThreadId, {}, { successorMode: 'plan', enabled: true, serviceTier: 'priority' });
    await until(() => f.events.some(e => e.method === 'turn/completed' && e.params.turn.id === planned.nextTurnId));
    await until(async () => (await f.rpc('thread/read', { threadId: planned.nextThreadId, includeTurns: false })).thread.status.type === 'idle');
    assert.equal((await f.backend.readGoal(planned.nextThreadId)), null);
    assert.equal(watch.snapshot().entries[planned.nextThreadId].continuationMode, 'normal');
    const planThread = (await f.rpc('thread/read', { threadId: planned.nextThreadId, includeTurns: true })).thread;
    assert.equal(planThread.turns.length, 1); assert.equal(planThread.status.type, 'idle');
    assert.equal(f.requests[3].service_tier, 'priority', 'Plan first request uses selected speed');
    assert.ok(planThread.turns[0].items.some(item => item.type === 'plan'));
    const planRecords = (await fs.readFile(planThread.path, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(planRecords.find(r => r.type === 'turn_context')?.payload.collaboration_mode.mode, 'plan');
    phase = 'hold';
    await f.rpc('turn/start', { threadId: planned.nextThreadId, input: [{ type: 'text', text: 'Next source work.' }] });
    await until(() => f.requests.length === 5);
    autoTarget = planned.nextThreadId; await watch.poll(); autoTarget = '';
    await until(() => !watch.snapshot().busy.length);
    const normal = watch.snapshot().entries[planned.nextThreadId].handoff;
    assert.equal(normal.phase, 'completed', JSON.stringify(normal)); assert.equal(normal.successorMode, 'normal');
    await until(() => f.requests.length === 6);
    assert.equal(f.requests[5].service_tier, 'priority', 'normal automatic successor inherits Fast');
    assert.equal(await f.backend.readGoal(normal.nextThreadId), null);
    console.log('Native normal → Goal → Goal → Plan → normal passed; current objective, no budget, exact context/permissions, first-turn modes and no duplicates. External model calls: 0.');
  } finally { watch?.dispose(); await f.close(); planState.clear(); }
});
