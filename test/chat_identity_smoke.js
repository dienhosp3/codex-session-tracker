'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const { appServerFixture } = require('./app_server_fixture');
const { createContextWatch } = require('../codex_context_watch');
const { prepareIdentityEdit } = require('../codex_chat_identity');
const { runContextHandoff, CHAT_ID_NOTE } = require('../codex_context_handoff');
const { GOAL_GUARDRAILS } = require('../codex_handoff_modes');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) { for (let i = 0; i < 250; i++) { if (await check()) return; await sleep(40); } throw new Error('Timed out: ' + label); }

test('live current-ID rename keeps the active turn, local label stays out of native name/prompt, plain Goal continues the right sequence', { timeout: 40000 }, async () => {
  let watch, saved;
  const f = await appServerFixture({ respond: async (_request, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ type: 'response.created', response: { id: 'identity-held' } }) + '\n\n');
    return true;
  } });
  try {
    const source = await f.backend.createFreshChat({ cwd: f.root, model: 'gpt-6-astra', message: 'Work on the original fixture task.',
      contextConfig: { model_context_window: 200000, model_auto_compact_token_limit: 180000, model_auto_compact_token_limit_scope: 'total' } });
    await f.backend.renameThread(source.id, '[AUTO-0001] Original task');
    await until(() => f.requests.length === 1, 'original request');
    const currentTurn = await f.backend.readHandoffState(source.id);
    const config = { state: { handoffDelaySeconds: 0 }, save: async state => { saved = state; },
      readManual: entry => f.backend.readHandoffState(entry.threadId),
      handoff: (entry, onProgress) => runContextHandoff({ entry: { ...entry, model: 'gpt-6-astra' }, backend: f.backend,
        directory: path.join(f.root, 'handoffs'), onProgress }) };
    watch = createContextWatch(config);
    const label = '[FAKE-8888] Nhãn dễ nhớ';
    const preferences = { handoffDelaySeconds: 0, intervalMs: 100, completionSound: true, thresholdPercent: 85 };
    await watch.setChatOptions(source.id, preferences, { title: '[AUTO-0001] Original task', cwd: f.root, file: source.path }, { prepare: async () => {
      const result = await prepareIdentityEdit(f.backend, source.id, { code: 'dựÁn2', number: '25' }, '', { code: 'AUTO', number: '0001' });
      result.patch.displayLabel = label; return result;
    } });
    assert.equal(await f.backend.readChatTitle(source.id), '[dựÁn2-0025] Original task');
    assert.equal((await f.backend.readHandoffState(source.id)).turnId, currentTurn.turnId);
    assert.equal((await f.backend.readHandoffState(source.id)).running, true);
    assert.equal(f.requests.length, 1); assert.equal(watch.tracks(source.id), false);
    assert.equal(watch.snapshot().entries[source.id].series.nextNumber, '0026');
    watch.dispose(); watch = createContextWatch({ ...config, state: saved });
    assert.equal(watch.snapshot().entries[source.id].displayLabel, label);
    const objective = 'Hoàn thành bản sửa Tracker.';
    const result = await watch.transferNow(source.id, {}, { successorMode: 'goal', goalText: objective, enabled: true });
    assert.equal(result.nextTitle, '[dựÁn2-0026] Tiếp tục');
    assert.equal(await f.backend.readChatTitle(source.id), '[dựÁn2-0025] Original task');
    assert.equal(await f.backend.readChatTitle(result.nextThreadId), '[dựÁn2-0026] Tiếp tục');
    assert.equal((await f.backend.readGoal(result.nextThreadId)).objective, objective);
    assert.equal(watch.snapshot().entries[result.nextThreadId].displayLabel, label);
    assert.equal(watch.snapshot().entries[result.nextThreadId].series.nextNumber, '0027');
    await until(() => f.requests.length === 2, 'successor Goal request');
    const text = f.requests[1].input.flatMap(item => item.content || []).map(item => item.text || '').join('\n');
    assert.ok(text.includes('codex://threads/' + source.id));
    assert.equal(text.split(CHAT_ID_NOTE).length, 2); assert.ok(text.includes(GOAL_GUARDRAILS));
    assert.equal(text.includes(label), false);
    const nextTurn = await f.backend.readHandoffState(result.nextThreadId);
    await watch.setChatOptions(result.nextThreadId, preferences, {}, { prepare: async () => ({ patch: { displayLabel: '' } }) });
    assert.equal(await f.backend.readChatTitle(result.nextThreadId), '[dựÁn2-0026] Tiếp tục');
    assert.equal((await f.backend.readHandoffState(result.nextThreadId)).turnId, nextTurn.turnId);
    assert.equal(f.requests.length, 2);
    console.log('Native rename during active turn, 0025 → 0026 → next 0027, label isolation/persistence, one plain Goal and exactly one ID explanation all passed.');
  } finally { watch?.dispose(); await f.close(); }
});
