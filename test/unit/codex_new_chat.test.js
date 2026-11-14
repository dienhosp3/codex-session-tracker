'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { PRESETS, contextChoice, contextConfig, readModelContext, normalizeContextPreset } = require('../../src/codex_new_chat');
const { createChatContextStore, installContextResumeHook } = require('../../src/codex_chat_context_store');
const { createLiveBackend } = require('../../src/codex_live_backend');
const { createContextWatch } = require('../../src/codex_context_watch');
const metadata = { model: 'model', defaultTokens: 272000, maxTokens: 872000, effectivePercent: 95 };
const selectedConfig = contextConfig('600k', metadata);

async function scratch() { return fs.mkdtemp(path.join(os.tmpdir(), 'new-chat-')); }
function connectionFixture(fail) {
  const providers = new Map(), calls = [];
  const connection = { initialized: true, proc: { pid: 10, stdin: { destroyed: false } },
    registerProvider(name, provider) { providers.set(name, provider); return { dispose: () => providers.delete(name) }; },
    sendRequest(name, id, method, params) {
      calls.push({ method, params });
      const error = fail?.(method);
      const result = method === 'thread/start' ? { thread: { id: 'fresh', cwd: params.cwd } } : { turn: { id: 'first-turn' } };
      queueMicrotask(() => providers.get(name)?.onResult({ id, ...(error ? { error: { message: error } } : { result }) }));
    }
  };
  return { connection, calls };
}

test('six choices use model metadata, preserve legacy 600K and validate custom K', () => {
  assert.deepEqual(PRESETS, ['default', '400k', '550k', '700k', '900k','custom']);
  assert.equal(contextConfig('custom:650',metadata).model_context_window,650000);
  assert.equal(contextConfig('550k',metadata).model_context_window,550000);
  assert.equal(contextConfig('700k',metadata).model_context_window,700000);
  for(const value of ['custom','custom:0','custom:-1','custom:1.5'])assert.throws(()=>contextConfig(value,metadata));
  assert.equal(contextConfig('default', metadata).model_context_window, 272000);
  assert.equal(contextChoice('400k', metadata).effectiveTokens, 380000);
  assert.equal(contextChoice('600k', metadata).effectiveTokens, 570000);
  const capped = contextChoice('900k', metadata);
  assert.equal(capped.requestedTokens, 900000); assert.equal(capped.appliedTokens, 872000);
  assert.equal(capped.effectiveTokens, 828400); assert.equal(capped.limited, true);
  assert.equal(contextConfig('900k', metadata).model_auto_compact_token_limit, 745560);
  assert.equal(contextChoice('default', { ...metadata, defaultTokens: 500000 }).effectiveTokens, 475000);
  assert.throws(() => normalizeContextPreset('1200k'));
  assert.throws(() => contextConfig('default', { model: 'unknown' }), /metadata/);
  assert.equal(contextChoice('600k', { model: 'unknown' }).effectiveTokens, null);
});

test('catalog metadata is exact to the model and missing metadata never invents a default', async () => {
  const root = await scratch();
  await fs.writeFile(path.join(root, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'model', context_window: 272000, max_context_window: 872000, effective_context_window_percent: 95 }] }));
  assert.deepEqual(await readModelContext(root, 'model'), metadata);
  assert.equal((await readModelContext(root, 'model-other')).defaultTokens, null);
  await fs.writeFile(path.join(root, 'custom.json'), JSON.stringify({ models: [{ slug: 'model', context_window: 500000, effective_context_window_percent: 90 }] }));
  assert.equal((await readModelContext(root, 'model', path.join(root, 'custom.json'))).defaultTokens, 500000);
});

test('fresh task uses full access on creation and first turn, without a source or global writes', async t => {
  const store = createChatContextStore(await scratch()), f = connectionFixture();
  const backend = createLiveBackend(f.connection, { contextStore: store }); t.after(() => backend.dispose());
  await backend.createFreshChat({ cwd: 'workspace', model: 'model', contextConfig: selectedConfig, message: ' New independent task ' });
  assert.deepEqual(f.calls.map(c => c.method), ['thread/start', 'turn/start']);
  assert.deepEqual(f.calls[0].params, { cwd: 'workspace', model: 'model', config: selectedConfig, ephemeral: false,
    approvalPolicy: 'never', approvalsReviewer: 'user', permissions: ':danger-full-access' });
  assert.equal(f.calls[1].params.approvalPolicy, 'never'); assert.equal(f.calls[1].params.permissions, ':danger-full-access');
  assert.equal(f.calls[1].params.threadId, 'fresh'); assert.equal(f.calls[1].params.input[0].text, 'New independent task');
  assert.deepEqual(store.get('fresh'), selectedConfig);
});

test('invalid config fails before creation and partial send failure retains the created ID', async t => {
  const f = connectionFixture(method => method === 'turn/start' && 'no ACK');
  const backend = createLiveBackend(f.connection); t.after(() => backend.dispose());
  await assert.rejects(backend.createFreshChat({ cwd: 'cwd', model: 'model', contextConfig: { model_context_window: -1 } }));
  assert.equal(f.calls.length, 0);
  await assert.rejects(backend.createFreshChat({ cwd: 'cwd', model: 'model', contextConfig: selectedConfig, message: 'task' }), error => error.createdThread.id === 'fresh');
  assert.equal(f.calls.filter(c => c.method === 'thread/start').length, 1);
});

test('resume hook survives store reload, scopes to recorded IDs, retains other config and restores the native method', async () => {
  const root = await scratch(), store = createChatContextStore(root);
  await store.remember('target', selectedConfig);
  const calls = [], connection = { sendRequest(...args) { calls.push(args); return 'native-result'; } };
  const original = connection.sendRequest;
  const dispose = installContextResumeHook(connection, createChatContextStore(root));
  const disposeSecond = installContextResumeHook(connection, store);
  const params = { threadId: 'target', config: { model_context_window: 123, unrelated: true } };
  assert.equal(connection.sendRequest('native', 'id', 'thread/resume', params, false), 'native-result');
  assert.deepEqual(calls[0][3].config, { unrelated: true, ...selectedConfig });
  assert.equal(params.config.model_context_window, 123, 'caller object unchanged');
  connection.sendRequest('native', 'other', 'thread/resume', { threadId: 'unrelated' });
  assert.deepEqual(calls[1][3], { threadId: 'unrelated' });
  connection.sendRequest('native', 'start', 'thread/start', params);
  assert.equal(calls[2][3], params);
  dispose(); assert.notEqual(connection.sendRequest, original);
  disposeSecond(); assert.equal(connection.sendRequest, original);
  await assert.rejects(store.remember('../escape', selectedConfig));
});

test('successor context is saved per chain, survives reload, propagates, and rolls back failed saves', async t => {
  let saved, fail = false;
  const options = { save: async s => { if (fail) throw new Error('disk'); saved = s; },
    read: async () => ({ running: true, turnId: 't', percent: 90 }), handoff: async entry => ({ nextThreadId: 'next', contextPreset: entry.contextPreset, phase: 'completed' }) };
  const first = createContextWatch(options); t.after(() => first.dispose());
  await first.setContextPreset('source', '600k', { title: 'Source' });
  assert.equal(saved.entries.source.enabled, false);
  fail = true; await assert.rejects(first.setContextPreset('source', '400k'), /disk/);
  assert.equal(first.snapshot().entries.source.contextPreset, '600k'); fail = false;
  const second = createContextWatch({ ...options, state: saved }); t.after(() => second.dispose());
  await second.setEntry('source', { enabled: true });
  for (let i = 0; i < 100 && !second.snapshot().entries.next; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(second.snapshot().entries.next.contextPreset, '600k');
  await assert.rejects(second.setContextPreset('source', '400k'), /chuyển tiếp/);
});
