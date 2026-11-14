'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { normalizeHandoffMode, validateGoalText, goalDraft, GOAL_TEMPLATE, GOAL_GUARDRAILS, goalContext } = require('../../src/codex_handoff_modes');
const { createLiveBackend } = require('../../src/codex_live_backend');
const { runContextHandoff } = require('../../src/codex_context_handoff');
const { createContextWatch } = require('../../src/codex_context_watch');
const objective = 'MỤC TIÊU:\nSửa Tracker.\n\nHOÀN TẤT KHI:\nTest đạt và đã cài bản mới.';
const permissions = { start: { approvalPolicy: 'never', sandbox: 'danger-full-access' }, turn: { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } } };
const attachedImage={name:'fixture.png',mimeType:'image/png',dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNoaGgAAAMEAYFL09IQAAAAAElFTkSuQmCC'};

test('Goal accepts a plain objective and rejects blank, placeholder or excessive text', () => {
  assert.equal(normalizeHandoffMode(), 'normal');
  for (const mode of ['normal', 'goal', 'plan']) assert.equal(normalizeHandoffMode(mode), mode);
  assert.throws(() => normalizeHandoffMode('goals'));
  assert.equal(goalDraft(), GOAL_TEMPLATE); assert.equal(goalDraft(objective), objective);
  assert.equal(goalDraft('Old task'), 'Old task');
  assert.equal(validateGoalText(objective.normalize('NFD'), true), objective);
  for (const value of ['', '   ', GOAL_TEMPLATE, '[Kết quả cần hoàn thành]', 'x'.repeat(4001)]) assert.throws(() => validateGoalText(value, true));
  assert.equal(validateGoalText('Native user-edited goal'), 'Native user-edited goal');
  assert.equal(validateGoalText('Do something', true), 'Do something');
  assert.equal(goalContext('Tiếp tục codex://threads/source'), 'Tiếp tục codex://threads/source\n\n' + GOAL_GUARDRAILS);
});

function native(t, options = {}) {
  const calls = [], providers = new Map(), goals = new Map(); let active = false;
  const connection = { initialized: true, proc: { pid: 1, stdin: { destroyed: false } },
    registerProvider(id, provider) { providers.set(id, provider); return { dispose: () => providers.delete(id) }; },
    sendRequest(provider, id, method, params) {
      calls.push({ method, params });
      let result = {};
      if (method === 'thread/read') result = { thread: { id: params.threadId, status: { type: active ? 'active' : 'idle' } } };
      if (method === 'collaborationMode/list') result = { data: [{ mode: 'default' }, { mode: 'plan' }] };
      if (method === 'thread/goal/get') result = { goal: goals.get(params.threadId) || null };
      if (method === 'thread/turns/list') result = { data: [{ id: 'old-turn', status: 'completed' }] };
      if (method === 'turn/start') result = { turn: { id: 'turn' } };
      if (method === 'thread/goal/set') {
        const goal = { threadId: params.threadId, tokenBudget: null, ...goals.get(params.threadId), ...params };
        goals.set(params.threadId, goal); result = { goal };
      }
      if (method === 'thread/goal/clear') { goals.delete(params.threadId); result = { cleared: true }; }
      queueMicrotask(() => {
        if (method === options.failMethod) { providers.get(provider).onResult({ id, error: { code: -32601, message: 'unsupported method' } }); return; }
        if (method === 'thread/goal/set' && params.status === 'active' && !options.noStart) {
          active = true;
          providers.get(provider).onNotification({ method: 'turn/started', params: { threadId: params.threadId, turn: { id: 'goal-first' } } });
          if (options.fastComplete) { active = false; providers.get(provider).onNotification({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id: 'goal-first', status: 'completed' } } }); }
        }
        providers.get(provider).onResult({ id, result });
      });
    } };
  const backend = createLiveBackend(connection, { timeoutMs: 70 }); t.after(() => backend.dispose());
  return { calls, backend, params: { threadId: 'next', model: 'chosen', effort: 'high', permissionSettings: permissions,
    message: '[TASK-0002] Tiếp tục codex://threads/source\n\nExtra', goalText: objective } };
}

test('Goal configures exact permissions and injects context before activation; native start is the only generation', async t => {
  const f = native(t, { fastComplete: true }); const phases = [];
  const modes = await f.backend.handoffModes('source'); assert.equal(modes.modes.plan.available, true); assert.equal(modes.modes.goal.available, true);
  f.calls.length = 0;
  const result = await f.backend.startSuccessor({ ...f.params, successorMode: 'goal', onProgress: phase => phases.push(phase) });
  assert.equal(result.turnId, 'goal-first'); assert.deepEqual(phases, ['configuring', 'injecting', 'activating']);
  assert.deepEqual(f.calls.map(c => c.method), ['thread/read', 'thread/settings/update', 'thread/inject_items', 'thread/goal/set']);
  assert.deepEqual(f.calls[1].params.sandboxPolicy, permissions.turn.sandboxPolicy);
  assert.equal(f.calls[1].params.collaborationMode.mode, 'default'); assert.equal(f.calls[1].params.effort, 'high');
  assert.equal(f.calls[2].params.items[0].content[0].text, goalContext(f.params.message));
  assert.deepEqual(f.calls[3].params, { threadId: 'next', objective, status: 'active' });
});

test('Plan starts with native planning instructions on its first and only turn', async t => {
  const f = native(t);
  await f.backend.startSuccessor({ ...f.params, successorMode: 'plan' });
  assert.deepEqual(f.calls.map(c => c.method), ['thread/read', 'turn/start']);
  assert.deepEqual(f.calls[1].params.collaborationMode, { mode: 'plan', settings: { model: 'chosen', reasoning_effort: 'high', developer_instructions: null } });
});

test('normal, Plan and Goal handoffs carry complete inline image bytes through their native input contracts',async t=>{
 for(const mode of ['normal','plan','goal']){
  const f=native(t);
  await f.backend.startSuccessor({...f.params,successorMode:mode,images:[attachedImage]});
  const call=f.calls.find(call=>call.method===(mode==='goal'?'thread/inject_items':'turn/start'));
  const content=mode==='goal'?call.params.items[0].content:call.params.input;
  assert.equal(content[1].type,mode==='goal'?'input_image':'image');
  assert.equal(content[1][mode==='goal'?'image_url':'url'],attachedImage.dataUrl);
 }
});

test('Goal verifies its paused copy before source cleanup, then activates the saved objective once', async t => {
  const f = native(t), phases = []; let cleanup = false;
  await f.backend.startSuccessor({ ...f.params, successorMode: 'goal', onProgress: phase => phases.push(phase),
    beforeStart: async () => {
      assert.equal((await f.backend.readGoal('next')).status, 'paused');
      assert.equal((await f.backend.readGoal('next')).objective, objective);
      assert.equal(f.calls.filter(c => c.method === 'thread/goal/set' && c.params.status === 'active').length, 0);
      cleanup = true;
    } });
  assert.equal(cleanup, true);
  assert.deepEqual(phases, ['configuring', 'injecting', 'preparing_goal', 'activating']);
  assert.deepEqual(f.calls.filter(c => c.method === 'thread/goal/set').map(c => c.params), [
    { threadId: 'next', objective, status: 'paused' }, { threadId: 'next', status: 'active' }
  ]);
  assert.equal(f.calls.some(c => c.method === 'turn/start'), false);
});

test('failed source cleanup leaves successor paused and never activates or starts a normal turn', async t => {
  const f = native(t);
  await assert.rejects(f.backend.startSuccessor({ ...f.params, successorMode: 'goal',
    beforeStart: async () => { throw new Error('Source clear failed'); } }), /Source clear failed/);
  assert.equal((await f.backend.readGoal('next')).status, 'paused');
  assert.equal((await f.backend.readGoal('next')).objective, objective);
  assert.equal(f.calls.some(c => c.method === 'turn/start' || (c.method === 'thread/goal/set' && c.params.status === 'active')), false);
});

test('failure preparing successor Goal never calls source cleanup', async t => {
  const f = native(t, { failMethod: 'thread/goal/set' }); let cleanup = 0;
  await assert.rejects(f.backend.startSuccessor({ ...f.params, successorMode: 'goal', beforeStart: async () => cleanup++ }), /unsupported/);
  assert.equal(cleanup, 0);
  assert.equal(f.calls.some(c => c.method === 'turn/start'), false);
});

test('normal and Plan successor both wait for source cleanup before starting a turn', async t => {
  for (const successorMode of ['normal', 'plan']) {
    const f = native(t);
    await assert.rejects(f.backend.startSuccessor({ ...f.params, successorMode, beforeStart: async () => { throw new Error('Clear failed'); } }), /Clear failed/);
    assert.equal(f.calls.some(c => c.method === 'turn/start'), false);
  }
});

for (const method of ['thread/settings/update', 'thread/inject_items', 'thread/goal/set']) test('Goal failure at ' + method + ' never falls back to a normal turn', async t => {
  const f = native(t, { failMethod: method });
  await assert.rejects(f.backend.startSuccessor({ ...f.params, successorMode: 'goal' }), /unsupported/);
  assert.equal(f.calls.some(c => c.method === 'turn/start'), false);
  assert.equal(f.calls.filter(c => c.method === 'thread/goal/set').length, method === 'thread/goal/set' ? 1 : 0);
});

test('missing native Goal-start notification stays uncertain without a second activation', async t => {
  const f = native(t, { noStart: true });
  await assert.rejects(f.backend.startSuccessor({ ...f.params, successorMode: 'goal' }), e => e.delivery === 'unknown');
  assert.equal(f.calls.filter(c => c.method === 'thread/goal/set').length, 1);
});

test('clearing a paused source Goal during the delay prevents successor creation', async t => {
  const f = native(t);
  await assert.rejects(f.backend.confirmHandoffStopped({ threadId: 'source', turnId: 'old-turn', expectedGoal: { objective } }), /Goal cũ đã thay đổi/);
  assert.equal(f.calls.some(c => c.method === 'thread/start' || c.method === 'turn/start'), false);
});

test('automatic Goal uses current native objective; Goal persists across successors but Plan resets to normal', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'handoff-modes-'));
  const calls = []; let serial = 0, liveGoal = { status: 'active', objective }, saved;
  const backend = { readGoal: async () => liveGoal,
    stopForHandoff: async entry => ({ name: '[TASK-0001] Task', cwd: 'cwd', sourceGoal: liveGoal, permissionSettings: permissions }),
    renameThread: async () => {}, createSuccessor: async () => ({ id: 'next' + (++serial) }),
    startSuccessor: async entry => { calls.push(entry); return { turnId: 'turn' + serial }; } };
  const options = { state: { handoffDelaySeconds: 0 }, save: async value => { saved = value; },
    readManual: async () => ({ turnId: 't' }), read: async () => ({ turnId: 't', running: true, percent: 90 }),
    handoff: entry => runContextHandoff({ directory, backend, entry }) };
  const watch = createContextWatch(options); t.after(() => watch.dispose());
  await watch.transferNow('old', {}, { enabled: true, successorMode: 'goal', goalText: objective });
  assert.equal(watch.snapshot().entries.next1.continuationMode, 'goal');
  watch.dispose();
  const restored = createContextWatch({ ...options, state: saved }); t.after(() => restored.dispose());
  liveGoal = { status: 'active', objective: 'The user updated the native objective.' };
  await restored.poll();
  for (let i = 0; i < 100 && restored.snapshot().busy.length; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(calls[1].goalText, liveGoal.objective); assert.equal(calls[1].successorMode, 'goal');
  await restored.transferNow('next2', {}, { successorMode: 'plan' });
  assert.equal(restored.snapshot().entries.next3.continuationMode, 'normal');
  assert.equal(restored.snapshot().entries.next3.goalText, undefined);
});

test('paused, finished or cleared Goal is skipped before stopping or creating and can follow an explicit resume later', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'handoff-skip-')); let calls = 0;
  for (const goal of [null, { status: 'paused' }, { status: 'complete' }]) {
    const watch = createContextWatch({ state: { entries: { old: { enabled: true, continuationMode: 'goal', thresholdPercent: 80 } } },
      save: async () => {}, read: async () => ({ turnId: 't', running: true, percent: 90 }),
      handoff: entry => runContextHandoff({ directory, entry, backend: { readGoal: async () => goal, stopForHandoff: async () => calls++ } }) });
    t.after(() => watch.dispose()); await watch.poll();
    for (let i = 0; i < 50 && watch.snapshot().busy.length; i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(watch.blocks('old'), false); assert.equal(watch.snapshot().entries.old.handoff, undefined);
    assert.match(watch.snapshot().readings.old.error, /Goal đã dừng/); watch.dispose();
  }
  assert.equal(calls, 0); assert.deepEqual(await fs.readdir(directory), []);
});
