'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const { appServerFixture } = require('../fixtures/app_server_fixture');
const { createContextWatch } = require('../../src/codex_context_watch');
const { runContextHandoff } = require('../../src/codex_context_handoff');
const { subscribeCompactionStarted } = require('../../src/codex_compaction_events');
const { contextConfig } = require('../../src/codex_new_chat');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await sleep(50); }
  throw new Error('Timed out: ' + label);
}
const objective = 'MỤC TIÊU:\nKiểm chứng chuyển khi tự compact.\n\nHOÀN TẤT KHI:\nChat mới tiếp tục đúng mục tiêu.';

for (const goalMode of [false, true]) test('native auto compact transfers below threshold, mode=' + (goalMode ? 'Goal' : 'normal'), { timeout: 40000 }, async () => {
  let count = 0, watch, subscription;
  const f = await appServerFixture({ respond: async (_request, res) => {
    count++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ type: 'response.created', response: { id: 'compact-' + count } }) + '\n\n');
    if (count === 1) {
      for (const event of [
        { type: 'response.output_item.done', item: { id: 'seed-msg', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Seed ready.' }] } },
        { type: 'response.completed', response: { id: 'compact-1', usage: { input_tokens: 20000, output_tokens: 10, total_tokens: 20010 } } }
      ]) res.write('data: ' + JSON.stringify(event) + '\n\n');
      res.end();
    }
    return true;
  } });
  const read = async id => (await f.rpc('thread/read', { threadId: id, includeTurns: true })).thread;
  try {
    const source = (await f.rpc('thread/start', { cwd: f.root, config: { model_auto_compact_token_limit: 100 },
      serviceTier: 'priority', approvalPolicy: 'never', sandbox: 'danger-full-access' })).thread;
    await f.rpc('thread/name/set', { threadId: source.id, name: '[AUTO-0001] Native compact' });
    const seed = (await f.rpc('turn/start', { threadId: source.id, input: [{ type: 'text', text: 'Seed usage.' }], effort: 'high' })).turn;
    await until(() => f.events.some(e => e.method === 'turn/completed' && e.params.turn.id === seed.id), 'seed terminal event');
    await until(async () => (await read(source.id)).status.type === 'idle', 'seed completion');
    const progress = [], seen = [];
    watch = createContextWatch({ state: { handoffDelaySeconds: 0, entries: {
      [source.id]: { enabled: true, thresholdPercent: 99, cwd: f.root, file: source.path }
    } }, save: async () => {}, read: async () => ({ percent: 2, running: true, turnId: 'must-not-use-poll' }),
      handoff: (entry, onProgress) => runContextHandoff({ entry, backend: f.backend, directory: path.join(f.root, 'handoffs'),
        onProgress: state => { progress.push(state.phase); onProgress(state); }, prepareSuccessor: async stopped => {
          assert.notEqual(stopped.status.type, 'active', 'stop BEFORE reading successor metadata');
          return { model: 'gpt-6-astra', contextPreset: '600k',
            contextConfig: contextConfig('600k', { defaultTokens: 272000, maxTokens: 900000, effectivePercent: 95 }) };
        } }) });
    subscription = subscribeCompactionStarted(event => { seen.push(event); return watch.compactionStarted(event); });
    await watch.poll(); assert.equal(watch.snapshot().busy.length, 0, '2% is below 99% threshold');
    if (goalMode) await f.rpc('thread/goal/set', { threadId: source.id, objective, status: 'active' });
    else await f.rpc('turn/start', { threadId: source.id, input: [{ type: 'text', text: 'Continue fixture.' }] });
    await until(() => ['completed', 'failed'].includes(watch.snapshot().entries[source.id].handoff?.phase), 'automatic handoff');
    const result = watch.snapshot().entries[source.id].handoff;
    assert.equal(result.phase, 'completed', JSON.stringify(result));
    await until(() => watch.snapshot().busy.length === 0, 'watch persistence');
    await until(() => f.requests.some(request => JSON.stringify(request.input).includes(result.message)), 'successor request delivered');
    assert.equal(result.trigger, 'auto_compact'); assert.equal(seen.length, 1);
    assert.equal(result.sourceTurnId, seen[0].turnId);
    const old = await read(source.id), next = await read(result.nextThreadId);
    assert.equal(old.status.type, 'idle'); assert.equal(old.turns.at(-1).status, 'interrupted');
    assert.equal(next.status.type, 'active');
    assert.equal(watch.tracks(result.nextThreadId), true, 'Auto resume OR policy inherits');
    assert.equal(watch.snapshot().entries[result.nextThreadId].thresholdPercent, 99);
    assert.equal(watch.tracks(source.id), false); assert.equal(result.serviceTier, 'priority');
    assert.equal(await f.backend.readGoal(source.id), null);
    const nextGoal = await f.backend.readGoal(result.nextThreadId);
    if (goalMode) {
      assert.equal(nextGoal.status, 'active'); assert.equal(nextGoal.objective, objective);
      assert.equal(nextGoal.tokenBudget, null); assert.equal(result.sourceGoalCleared, true);
      assert.ok(progress.indexOf('preparing_goal') < progress.indexOf('clearing_source_goal'));
      assert.ok(progress.indexOf('source_goal_cleared') < progress.indexOf('activating'));
    } else assert.equal(nextGoal, null);
    assert.ok(!f.events.some(e => e.method === 'item/completed' && e.params.threadId === source.id && e.params.item?.type === 'contextCompaction'), 'compaction did not finish');
    const before = f.requests.length;
    await watch.compactionStarted(seen[0]); await watch.poll(); await sleep(100);
    assert.equal(f.requests.length, before, 'duplicate event/poll cannot create another successor');
    if (goalMode) {
      await f.restart();
      assert.equal(await f.backend.readGoal(source.id), null);
      assert.equal((await f.backend.readGoal(result.nextThreadId)).objective, objective);
      const beforeOpen = f.requests.length;
      await f.rpc('thread/resume', { threadId: source.id }); await sleep(700);
      assert.equal(f.requests.length, beforeOpen, 'old cleared goal cannot revive after reopening');
    }
    console.log('Native Auto resume: 2% < 99%, compaction interrupted, one successor, inherited Fast/context; mode=' + (goalMode ? 'Goal with source cleared' : 'normal') + '.');
  } finally { subscription?.dispose(); watch?.dispose(); await f.close(); }
});

test('native explicit compact is ignored by Auto resume', { timeout: 30000 }, async () => {
  let hold = false, subscription, watch;
  const f = await appServerFixture({ respond: async (_request, res) => {
    if (!hold) return false;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ type: 'response.created', response: { id: 'manual-compact' } }) + '\n\n');
    return true;
  } });
  try {
    const source = (await f.rpc('thread/start', { cwd: f.root })).thread;
    const seed = (await f.rpc('turn/start', { threadId: source.id, input: [{ type: 'text', text: 'Seed manual test.' }] })).turn;
    await until(() => f.events.some(e => e.method === 'turn/completed' && e.params.turn.id === seed.id), 'manual seed terminal event');
    await until(async () => (await f.rpc('thread/read', { threadId: source.id })).thread.status.type === 'idle', 'manual seed idle');
    hold = true; const seen = [], transfers = [];
    watch = createContextWatch({ state: { entries: { [source.id]: { enabled: true } } }, save: async () => {},
      handoff: async entry => { transfers.push(entry); throw new Error('Manual compaction must not transfer'); } });
    subscription = subscribeCompactionStarted(event => { seen.push(event); return watch.compactionStarted(event); });
    await f.rpc('thread/compact/start', { threadId: source.id });
    await until(() => f.events.some(e => e.method === 'item/started' && e.params.item?.type === 'contextCompaction'), 'manual contextCompaction');
    await sleep(100); assert.equal(seen.length, 0, JSON.stringify(f.events.filter(e => ['turn/started', 'turn/completed', 'item/started'].includes(e.method)).map(e => ({ method: e.method, threadId: e.params.threadId, turnId: e.params.turnId || e.params.turn?.id, item: e.params.item?.type })))); assert.equal(transfers.length, 0);
    const thread = (await f.rpc('thread/read', { threadId: source.id, includeTurns: true })).thread;
    await f.rpc('turn/interrupt', { threadId: source.id, turnId: thread.turns.at(-1).id });
    console.log('Native /compact remains manual; Auto resume does not intercept it.');
  } finally { subscription?.dispose(); watch?.dispose(); await f.close(); }
});
