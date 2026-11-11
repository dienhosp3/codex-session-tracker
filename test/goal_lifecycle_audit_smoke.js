'use strict';

// Audit only: exercises the installed native runtime against a loopback model.
// No user's CODEX_HOME, conversations, goals, or credentials are changed.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { appServerFixture } = require('./app_server_fixture');
const { runContextHandoff } = require('../codex_context_handoff');

const objective = 'MỤC TIÊU:\nKiểm chứng vòng đời Goal.\n\nHOÀN TẤT KHI:\nCác trường hợp kiểm tra đạt.';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await sleep(50); }
  throw new Error('Timed out: ' + label);
}

test('audit: paused source survives runtime restart; clearing ancestors preserves later native goals', { timeout: 90000 }, async () => {
  let holding = false;
  const f = await appServerFixture({ respond: async (_request, res) => {
    if (!holding) return false;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ type: 'response.created', response: { id: 'goal-audit-held' } }) + '\n\n');
    return true;
  } });
  const read = async id => (await f.rpc('thread/read', { threadId: id, includeTurns: true })).thread;
  const goal = id => f.backend.readGoal(id);
  const transfer = async id => runContextHandoff({ directory: path.join(f.root, 'handoffs'), backend: f.backend,
    entry: { threadId: id, ...await f.backend.readHandoffState(id), cwd: f.root, successorMode: 'goal',
      model: 'gpt-6-astra', manual: false, handoffDelaySeconds: 0 } });
  try {
    const a = (await f.rpc('thread/start', { cwd: f.root, approvalPolicy: 'never', sandbox: 'danger-full-access' })).thread;
    await f.rpc('thread/name/set', { threadId: a.id, name: '[LIFE-0001] Goal lifecycle audit' });
    const seed = (await f.rpc('turn/start', { threadId: a.id, input: [{ type: 'text', text: 'Fixture seed.' }] })).turn;
    await until(() => f.events.some(e => e.method === 'turn/completed' && e.params.turn.id === seed.id), 'seed terminal event');
    await until(async () => (await read(a.id)).status.type === 'idle', 'seed idle');
    assert.ok(f.events.some(e => e.method === 'turn/completed' && e.params.turn.id === seed.id));
    holding = true;
    await f.rpc('thread/goal/set', { threadId: a.id, objective, status: 'active' });
    await until(() => f.requests.length === 2, 'source goal request');
    await f.backend.stopForHandoff({ threadId: a.id, ...await f.backend.readHandoffState(a.id) });
    assert.equal((await goal(a.id)).status, 'paused');
    await f.restart();
    await f.rpc('thread/resume', { threadId: a.id });
    await f.rpc('thread/resume', { threadId: a.id });
    await sleep(1200);
    assert.equal((await goal(a.id)).status, 'paused');
    assert.equal(f.requests.length, 2, 'paused Goal does not revive after restart/open');
    await f.rpc('thread/goal/set', { threadId: a.id, status: 'active' });
    await until(() => f.requests.length === 3, 'explicit source resume');
    const first = await transfer(a.id);
    const b = first.nextThreadId;
    await until(() => f.requests.length === 4, 'successor goal request');
    assert.equal(await goal(a.id), null);
    assert.equal((await goal(b)).status, 'active');
    assert.equal((await goal(b)).objective, objective);
    const sourceTurns = (await read(a.id)).turns.length;
    console.log('Actual Tracker handoff: source cleared, successor active, objective copied.');

    const beforeRestart = f.requests.length;
    await f.restart();
    assert.equal(await goal(a.id), null);
    assert.equal((await goal(b)).status, 'active');
    await f.rpc('thread/resume', { threadId: a.id });
    await f.rpc('thread/resume', { threadId: a.id });
    await sleep(2000);
    assert.equal(await goal(a.id), null);
    assert.equal(f.requests.length, beforeRestart, 'reopening paused source must not generate');
    assert.equal((await read(a.id)).turns.length, sourceTurns);
    console.log('Hard restart + reopening cleared source twice: remains cleared, zero new model requests.');

    const clearEvents = f.events.length;
    await f.rpc('thread/goal/clear', { threadId: a.id });
    assert.equal(await goal(a.id), null);
    assert.equal((await goal(b)).status, 'active');
    assert.equal((await goal(b)).objective, objective);
    assert.equal(first.sourceGoalCleared, true);
    assert.ok(!(f.events.slice(clearEvents).some(e => e.method === 'thread/goal/cleared' && e.params.threadId === b)));
    console.log('Clear A while B is unloaded: only A cleared; B objective/status preserved.');

    await f.rpc('thread/resume', { threadId: b });
    await until(() => f.requests.length > beforeRestart, 'active successor resumes after restart');
    assert.equal((await goal(b)).status, 'active');
    console.log('Reopening ACTIVE successor after hard restart starts its goal automatically.');
    const second = await transfer(b);
    const c = second.nextThreadId;
    await until(async () => (await read(c)).status.type === 'active', 'second successor active');
    assert.equal((await goal(c)).objective, objective);
    assert.equal(await goal(b), null);
    const cGoal = await goal(c);
    const cTurn = (await read(c)).turns.at(-1).id;
    await f.rpc('thread/goal/clear', { threadId: b });
    await f.rpc('thread/goal/clear', { threadId: a.id });
    assert.equal(await goal(a.id), null);
    assert.equal(await goal(b), null);
    assert.deepEqual(await goal(c), cGoal);
    assert.equal((await read(c)).turns.at(-1).id, cTurn);
    console.log('A cleared -> B transfers to C -> B cleared: C goal and active turn unchanged.');

    await f.restart();
    const afterRestart = f.requests.length;
    for (const id of [a.id, b]) {
      assert.equal(await goal(id), null);
      await f.rpc('thread/resume', { threadId: id });
      assert.equal(await goal(id), null);
    }
    await sleep(1500);
    assert.equal(f.requests.length, afterRestart, 'cleared ancestors must not restart work');
    assert.equal((await goal(c)).objective, objective);
    assert.equal((await goal(c)).status, 'active');
    await f.rpc('thread/resume', { threadId: c });
    await until(() => f.requests.length > afterRestart, 'C resumes independently');
    assert.equal((await goal(c)).objective, objective);
    const sourceHistory = await read(a.id);
    assert.equal(sourceHistory.turns.length, sourceTurns, 'goal clear keeps source chat history');
    const rollout = (await fs.readFile(sourceHistory.path, 'utf8')).trim().split('\n').map(JSON.parse);
    const meta = rollout.find(r => r.type === 'session_meta')?.payload;
    console.log(JSON.stringify({ result: 'PASS', trackerVersion: require('../package.json').version,
      rolloutCliVersion: meta?.cli_version, model: 'gpt-6-astra', externalModelCalls: 0,
      clearedAncestorsAfterRestart: true, successorGoalPreserved: true, sourceHistoryPreserved: true }));
  } finally { await f.close(); }
});

test('audit: save a paused successor before clearing source; recover after crash without losing objective', { timeout: 50000 }, async () => {
  const f = await appServerFixture({ respond: async (_request, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ type: 'response.created', response: { id: 'goal-audit-staged' } }) + '\n\n');
    return true;
  } });
  const read = async id => (await f.rpc('thread/read', { threadId: id, includeTurns: true })).thread;
  try {
    const a = (await f.rpc('thread/start', { cwd: f.root, approvalPolicy: 'never', sandbox: 'danger-full-access' })).thread;
    await f.rpc('thread/goal/set', { threadId: a.id, objective, status: 'active' });
    await until(() => f.requests.length === 1, 'active original');
    const oldTurn = (await read(a.id)).turns.at(-1).id;
    await f.rpc('thread/goal/set', { threadId: a.id, status: 'paused' });
    await f.rpc('turn/interrupt', { threadId: a.id, turnId: oldTurn });
    await until(async () => (await read(a.id)).status.type === 'idle', 'original stopped');
    const b = (await f.rpc('thread/start', { cwd: f.root, approvalPolicy: 'never', sandbox: 'danger-full-access' })).thread;
    await f.rpc('thread/inject_items', { threadId: b.id, items: [{ type: 'message', role: 'user',
      content: [{ type: 'input_text', text: 'Continue only the remaining fixture work. codex://threads/' + a.id }] }] });
    const prepared = await f.rpc('thread/goal/set', { threadId: b.id, objective, status: 'paused' });
    assert.equal(prepared.goal.objective, objective);
    assert.equal(prepared.goal.status, 'paused');
    assert.equal(prepared.goal.tokenBudget, null);
    assert.equal(f.requests.length, 1, 'preparing a paused successor does not run it');
    await f.rpc('thread/goal/clear', { threadId: a.id });
    assert.equal(await f.backend.readGoal(a.id), null);
    await f.restart(); // Crash after clear, before activating successor.
    assert.equal(await f.backend.readGoal(a.id), null);
    assert.equal((await f.backend.readGoal(b.id)).objective, objective);
    assert.equal((await f.backend.readGoal(b.id)).status, 'paused');
    await f.rpc('thread/resume', { threadId: a.id });
    await f.rpc('thread/resume', { threadId: b.id });
    await sleep(1200);
    assert.equal(f.requests.length, 1);
    await f.rpc('thread/goal/set', { threadId: b.id, status: 'active' });
    await until(() => f.requests.length === 2, 'activation of recovered staged goal');
    assert.equal((await f.backend.readGoal(b.id)).objective, objective);
    console.log('Prepare paused B -> verify -> clear A -> hard restart: B objective survives; activation resumes once.');

    const activeTurn = (await read(b.id)).turns.at(-1).id;
    await f.rpc('thread/goal/clear', { threadId: b.id });
    await sleep(500);
    assert.equal(await f.backend.readGoal(b.id), null);
    const afterClear = await read(b.id);
    assert.equal(afterClear.status.type, 'active');
    assert.equal(afterClear.turns.at(-1).id, activeTurn);
    assert.equal(afterClear.turns.at(-1).status, 'inProgress');
    console.log('Clear alone removes goal but does NOT interrupt the active turn; explicit interrupt is required.');
    await f.rpc('turn/interrupt', { threadId: b.id, turnId: activeTurn });
    await until(async () => (await read(b.id)).status.type === 'idle', 'cleared goal turn interrupted');
  } finally { await f.close(); }
});

for (const fault of ['clear', 'activate']) test('actual handoff preserves staged Goal on failure at ' + fault, { timeout: 30000 }, async () => {
  const f = await appServerFixture({ respond: async (_request, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ type: 'response.created', response: { id: 'handoff-fault' } }) + '\n\n');
    return true;
  } });
  try {
    const source = (await f.rpc('thread/start', { cwd: f.root, approvalPolicy: 'never', sandbox: 'danger-full-access' })).thread;
    await f.rpc('thread/goal/set', { threadId: source.id, objective, status: 'active' });
    await until(() => f.requests.length === 1, 'fault source started');
    const backend = { ...f.backend,
      clearHandoffGoal: fault === 'clear' ? async () => { throw new Error('Injected clear failure'); } : f.backend.clearHandoffGoal,
      startSuccessor: params => f.backend.startSuccessor({ ...params, onProgress: async phase => {
        await params.onProgress?.(phase);
        if (fault === 'activate' && phase === 'activating') throw new Error('Injected stop before activation');
      } }) };
    let failed;
    await assert.rejects(runContextHandoff({ backend, directory: path.join(f.root, 'handoffs'), entry: {
      threadId: source.id, ...await f.backend.readHandoffState(source.id), model: 'gpt-6-astra', cwd: f.root,
      successorMode: 'goal', handoffDelaySeconds: 0
    } }), error => { failed = error.handoff; return /Injected/.test(error.message); });
    assert.equal(failed.phase, 'failed'); assert.ok(failed.nextThreadId);
    assert.equal(failed.goalText, objective); assert.equal(failed.sourceGoal.objective, objective);
    assert.equal(f.requests.length, 1, 'staged successor has not generated');
    await f.restart();
    const sourceGoal = await f.backend.readGoal(source.id), nextGoal = await f.backend.readGoal(failed.nextThreadId);
    assert.equal(sourceGoal?.status || null, fault === 'clear' ? 'paused' : null);
    assert.equal(nextGoal.status, 'paused'); assert.equal(nextGoal.objective, objective);
    await f.rpc('thread/resume', { threadId: failed.nextThreadId }); await sleep(300);
    assert.equal(f.requests.length, 1);
    assert.equal((await f.backend.readGoal(failed.nextThreadId)).objective, objective);
    console.log('Handoff failure at ' + fault + ': paused successor and objective survive hard restart; no duplicate activation.');
  } finally { await f.close(); }
});
