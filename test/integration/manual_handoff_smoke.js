'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path'), fs = require('node:fs/promises');
const { appServerFixture } = require('../fixtures/app_server_fixture');
const { createContextWatch } = require('../../src/codex_context_watch');
const { runContextHandoff } = require('../../src/codex_context_handoff');
const { readThreadPermissions } = require('../../src/codex_thread_permissions');
const { contextConfig } = require('../../src/codex_new_chat');

async function until(check) {
  for (let i = 0; i < 160; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('Timed out waiting for native handoff state.');
}

for (const running of [false, true]) test('installed app-server manual transfer from ' + (running ? 'running' : 'idle') + ' untracked chat', { timeout: 30000 }, async () => {
  let first = true, watch;
  const f = await appServerFixture({ respond: async (_request, res) => {
    if (!running || !first) return false;
    first = false;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ type: 'response.created', response: { id: 'hold-source' } }) + '\n\n');
    return true;
  } });
  try {
    const models = await f.backend.listModels();
    const chosenModel = models.find(model => model.id !== 'gpt-6-astra')?.id;
    assert.ok(chosenModel, 'installed runtime offers another model');
    const source = (await f.rpc('thread/start', { cwd: f.root, approvalPolicy: 'never', sandbox: 'danger-full-access' })).thread;
    await f.rpc('thread/name/set', { threadId: source.id, name: '[MANUAL-0001] Original' });
    const started = await f.rpc('turn/start', { threadId: source.id, input: [{ type: 'text', text: 'Source fixture task.' }], effort: 'high' });
    await until(() => f.requests.length === 1);
    if (!running) {
      await until(() => f.events.some(e => e.method === 'turn/completed' && e.params.turn.id === started.turn.id));
      await until(async () => (await f.rpc('thread/read', { threadId: source.id })).thread.status.type === 'idle');
    }
    let saved;
    watch = createContextWatch({ state: { handoffDelaySeconds: 0 }, save: async value => { saved = value; },
      read: async () => assert.fail('Manual transfer must not require a context percentage'),
      readManual: async entry => ({ ...await f.backend.readHandoffState(entry.threadId), reasoning: 'high' }),
      handoff: entry => runContextHandoff({ directory: path.join(f.root, 'handoffs'), backend: f.backend,
        entry: { ...entry, contextPreset: '600k', contextConfig: contextConfig('600k', { defaultWindow: 272000, maxWindow: 872000, effectivePercent: 95 }) } }) });
    const extra = 'Lập kế hoạch trước.\nChờ tôi xác nhận.', code = 'dựÁn'.repeat(7) + '01';
    const result = await watch.transferNow(source.id, { title: source.name, cwd: f.root, file: source.path }, {
      enabled: running, thresholdPercent: 99, successorModel: chosenModel, extraMessage: extra,
      series: { code, nextNumber: '42' }, contextPreset: '600k', handoffDelaySeconds: 0 });
    assert.equal(result.trigger, 'manual'); assert.equal(result.phase, 'completed');
    assert.equal(result.message, `[${code}-0042] Tiếp tục codex://threads/${source.id}\n\nMã ID và nhãn chỉ để nhận diện chat, không đưa vào repo.\n\n${extra}`);
    await until(() => f.requests.length === 2);
    await until(() => f.events.some(e => e.method === 'turn/completed' && e.params.turn.id === result.nextTurnId));
    await until(async () => (await f.rpc('thread/read', { threadId: result.nextThreadId })).thread.status.type === 'idle');
    const old = (await f.rpc('thread/read', { threadId: source.id, includeTurns: true })).thread;
    const next = (await f.rpc('thread/read', { threadId: result.nextThreadId, includeTurns: true })).thread;
    assert.equal(old.status.type, 'idle'); assert.equal(old.turns.at(-1).id, started.turn.id);
    assert.equal(old.turns.at(-1).status, running ? 'interrupted' : 'completed');
    assert.equal(next.name, `[${code}-0042] Tiếp tục`); assert.equal(next.cwd, f.root);
    assert.equal(f.requests[1].model, chosenModel);
    assert.equal(next.turns.length, 1);
    assert.ok(f.requests[1].input.flatMap(item => item.content || []).some(item => item.text?.includes(result.message)), 'multiline continuation reaches the model unchanged');
    const permissions = await readThreadPermissions(next.path, next.id);
    assert.equal(permissions.start.approvalPolicy, 'never');
    assert.deepEqual(permissions, await readThreadPermissions(old.path, old.id));
    assert.ok(permissions.start.sandbox === 'danger-full-access' || permissions.start.permissions === ':danger-full-access');
    const records = (await fs.readFile(next.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const capacity = records.find(r => r.type === 'event_msg' && r.payload.type === 'task_started')?.payload.model_context_window;
    assert.equal(capacity, 570000, 'effective context for selected model ' + chosenModel);
    console.log('Runtime provenance: ' + JSON.stringify({ cliVersion: records.find(r => r.type === 'session_meta')?.payload.cli_version,
      model: records.find(r => r.type === 'turn_context')?.payload.model }));
    assert.equal(watch.tracks(next.id), running); assert.equal(saved.entries[next.id].thresholdPercent, 99);
    assert.equal(saved.entries[source.id].handoff.phase, 'completed');
    await assert.rejects(watch.transferNow(source.id), /chuyển tiếp/);
    const replay = await runContextHandoff({ directory: path.join(f.root, 'handoffs'), backend: f.backend, entry: { threadId: source.id } });
    assert.equal(replay.nextThreadId, next.id); assert.equal(f.requests.length, 2);
    console.log('Native manual handoff passed; stopped=' + !running + '; permissions, exact continuation, no duplicates; external model calls=0.');
  } finally { watch?.dispose(); await f.close(); }
});
