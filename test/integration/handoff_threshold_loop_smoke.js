'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const { appServerFixture } = require('../fixtures/app_server_fixture');
const { createContextWatch } = require('../../src/codex_context_watch');
const { runContextHandoff } = require('../../src/codex_context_handoff');
const { createContextReader } = require('../../src/codex_context_reader');
const { readThreadSettings } = require('../../src/codex_thread_permissions');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) { for (let i = 0; i < 250; i++) { if (await check()) return; await sleep(40); } throw new Error('Timed out: ' + label); }

test('native 85.645%/85 Goal+Ultrafast hands off once using advertised Fast instead of looping', { timeout: 40000 }, async () => {
  let count = 0, watch;
  const f = await appServerFixture({ respond: async (_request, res) => {
    count++; res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ type: 'response.created', response: { id: 'threshold-' + count } }) + '\n\n');
    if (count === 1) {
      for (const event of [
        { type: 'response.output_item.done', item: { type: 'message', id: 'seed', role: 'assistant', content: [{ type: 'output_text', text: 'Seed usage.' }] } },
        { type: 'response.completed', response: { id: 'threshold-1', usage: { input_tokens: 709480, output_tokens: 4, total_tokens: 709484 } } }
      ]) res.write('data: ' + JSON.stringify(event) + '\n\n');
      res.end();
    }
    return true;
  } });
  try {
    const source = (await f.rpc('thread/start', { cwd: f.root, model: 'gpt-6-astra', serviceTier: 'ultrafast',
      approvalPolicy: 'never', permissions: ':danger-full-access', config: { model_context_window: 872000,
        model_auto_compact_token_limit: 745560, model_auto_compact_token_limit_scope: 'total' } })).thread;
    await f.rpc('thread/name/set', { threadId: source.id, name: '[LOOP-0001] Threshold regression' });
    const seed = (await f.rpc('turn/start', { threadId: source.id, input: [{ type: 'text', text: 'Seed context usage.' }], effort: 'ultra' })).turn;
    await until(() => f.events.some(e => e.method === 'turn/completed' && e.params.turn.id === seed.id), 'seed completion');
    const objective = 'MỤC TIÊU:\nSửa đúng lỗi vòng lặp.\n\nHOÀN TẤT KHI:\nChat kế tiếp chạy đúng một lần.';
    await f.rpc('thread/settings/update', { threadId: source.id, model: 'gpt-6-astra', effort: 'ultra' });
    await f.rpc('thread/goal/set', { threadId: source.id, objective, status: 'active' });
    await until(() => f.requests.length === 2, 'source Goal active');
    const read = createContextReader({ resolveFile: async () => source.path });
    let reading;
    await until(async () => { reading = await read({ threadId: source.id }); return reading.running && reading.percent > 85; }, 'real rollout threshold');
    assert.equal(reading.usedTokens, 709484); assert.equal(reading.windowTokens, 828400);
    assert.equal(reading.serviceTier, 'ultrafast');
    let attempts = 0, saved;
    watch = createContextWatch({ state: { intervalMs: 100, handoffDelaySeconds: 0, entries: { [source.id]: {
      enabled: true, thresholdPercent: 85, continuationMode: 'goal', serviceTier: 'ultrafast', cwd: f.root, file: source.path
    } } }, save: async state => { saved = state; }, read: entry => entry.threadId === source.id ? read(entry) : { running: true, percent: 0 },
      handoff: (entry, onProgress) => { attempts++; return runContextHandoff({ entry, backend: f.backend, directory: path.join(f.root, 'handoffs'), onProgress }); } });
    await watch.poll();
    await until(() => ['completed', 'failed'].includes(watch.snapshot().entries[source.id].handoff?.phase), 'handoff settles');
    await until(() => !watch.snapshot().busy.length, 'state saved');
    const result = saved.entries[source.id].handoff;
    assert.equal(result.phase, 'completed', JSON.stringify(result));
    assert.equal(result.serviceTier, 'priority'); assert.equal(result.requestedServiceTier, 'ultrafast');
    assert.match(result.speedNotice, /Ultrafast.*Fast/);
    assert.equal(saved.entries[result.nextThreadId].speedNotice, result.speedNotice);
    await until(() => f.requests.length === 3, 'successor model request');
    assert.equal(f.requests[2].service_tier, 'priority'); assert.equal(f.requests[2].model, 'gpt-6-astra');
    assert.equal(f.requests[2].reasoning.effort, f.requests[1].reasoning.effort, 'effective native effort is unchanged');
    const next = (await f.rpc('thread/read', { threadId: result.nextThreadId })).thread;
    assert.equal((await readThreadSettings(next.path, next.id)).effort, 'ultra', 'requested Ultra setting is preserved');
    assert.equal((await f.backend.readGoal(result.nextThreadId)).objective, objective);
    assert.equal(await f.backend.readGoal(source.id), null);
    for (let i = 0; i < 100; i++) await watch.poll();
    assert.equal(attempts, 1); assert.equal(f.requests.length, 3);
    console.log('Exact reported usage 709484/828400 (85.645%) at threshold 85: one Goal successor, Fast on wire, Ultra/model/goal preserved, no retry loop.');
  } finally { watch?.dispose(); await f.close(); }
});
