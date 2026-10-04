'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLiveBackend, installOwnerBridge, disposeOwnerBridges } = require('../codex_live_backend');

function fixture(options = {}) {
  const providers = new Map();
  const requests = [];
  const connection = {
    initialized: true, proc: { pid: 42, stdin: { destroyed: false } },
    registerProvider(name, provider) { providers.set(name, provider); return { dispose() { providers.delete(name); } }; },
    sendRequest(name, id, method, params) {
      requests.push({ method, params });
      const provider = providers.get(name);
      const result = method === 'thread/loaded/list'
        ? { data: options.loaded === false ? [] : ['target'], nextCursor: null }
        : method === 'thread/read'
          ? { thread: { id: 'target', status: { type: options.idle ? 'idle' : 'active' } } }
          : method === 'thread/turns/list'
            ? { data: [{ id: 'live-turn', status: options.completed ? 'completed' : 'inProgress' }] }
            : { turnId: options.wrongAck ? 'wrong-turn' : 'live-turn' };
      if (method === 'turn/steer' && options.timeout) return;
      queueMicrotask(() => provider.onResult({ id, ...(method === 'turn/steer' && options.race ? { error: { code: -32000, message: 'Expected turn does not match active turn' } } : { result }) }));
    }
  };
  return { connection, providers, requests };
}
const params = { conversationId: 'target', clientUserMessageId: 'uuid', input: [{ type: 'text', text: 'Kiểm tra màn xám', text_elements: [] }] };

test('steer uses the existing live root turn, UUID and Unicode without resume/start', async () => {
  const f = fixture(), backend = createLiveBackend(f.connection);
  try {
    const result = await backend.steer(params);
    assert.equal(result.turnId, 'live-turn');
    assert.equal(result.transport, 'codex-existing-app-server');
    assert.deepEqual(f.requests.map(r => r.method), ['thread/loaded/list', 'thread/read', 'thread/turns/list', 'turn/steer']);
    assert.deepEqual(f.requests[3].params, { threadId: 'target', expectedTurnId: 'live-turn', clientUserMessageId: 'uuid', input: params.input });
  } finally { backend.dispose(); }
  assert.equal(f.providers.size, 0);
});

for (const [name, options] of [['unloaded', { loaded: false }], ['idle', { idle: true }], ['completed', { completed: true }]]) {
  test(name + ' thread never receives steer or gets resumed', async () => {
    const f = fixture(options), backend = createLiveBackend(f.connection);
    try { await assert.rejects(backend.steer(params), e => e.delivery === 'not_sent'); }
    finally { backend.dispose(); }
    assert.equal(f.requests.some(r => ['turn/steer', 'turn/start', 'thread/resume'].includes(r.method)), false);
  });
}

test('turn changing between read and steer is rejected once, without retry', async () => {
  const f = fixture({ race: true }), backend = createLiveBackend(f.connection);
  try { await assert.rejects(backend.steer(params), e => e.delivery === 'rejected' && /Expected turn/.test(e.message)); }
  finally { backend.dispose(); }
  assert.equal(f.requests.filter(r => r.method === 'turn/steer').length, 1);
});

test('missing acknowledgement stays unknown, and does not resend', async () => {
  const f = fixture({ timeout: true }), backend = createLiveBackend(f.connection, { timeoutMs: 20 });
  try { await assert.rejects(backend.steer(params), e => e.delivery === 'unknown'); }
  finally { backend.dispose(); }
  assert.equal(f.requests.filter(r => r.method === 'turn/steer').length, 1);
});

test('wrong turn acknowledgement cannot be reported as success', async () => {
  const f = fixture({ wrongAck: true }), backend = createLiveBackend(f.connection);
  try { await assert.rejects(backend.steer(params), e => e.delivery === 'unknown'); }
  finally { backend.dispose(); }
});

test('tracker opt-in bypasses the gray webview, preserves native handlers, and restores them on dispose', async () => {
  const f = fixture(); let originalCalls = 0;
  const nativeSteer = [() => { originalCalls++; return false; }, () => { originalCalls++; throw new Error('gray webview'); }];
  const nativeDiscovery = [() => true, () => ({ supportsUntrustedAppInput: true })];
  const handlers = new Map([['thread-owner-discovery', nativeDiscovery], ['thread-follower-steer-turn', nativeSteer]]);
  const stream = { ipcClient: { requestHandlers: handlers }, ownsThread: (host, id) => host === 'local' && id === 'target' };
  try {
    installOwnerBridge([f.connection], [stream]);
    installOwnerBridge([f.connection], [stream]);
    assert.equal(f.providers.size, 1);
    const discovery = await handlers.get('thread-owner-discovery')[1]({ params });
    assert.equal(discovery.supportsTrackerDirectSteer, true);
    const direct = { ...params, trackerDirectSteer: 1 };
    const [canHandle, handle] = handlers.get('thread-follower-steer-turn');
    assert.equal(canHandle(direct, {}), true);
    assert.equal(canHandle({ ...direct, conversationId: 'wrong-root' }, {}), false);
    assert.equal((await handle({ params: direct })).turnId, 'live-turn');
    assert.equal(originalCalls, 0);
    assert.equal(canHandle(params, {}), false);
    assert.equal(originalCalls, 1);
    await assert.rejects(handle({ params }), /gray webview/);
    assert.equal(originalCalls, 2);
  } finally { disposeOwnerBridges(); }
  assert.equal(handlers.get('thread-follower-steer-turn'), nativeSteer);
  assert.equal(handlers.get('thread-owner-discovery'), nativeDiscovery);
  assert.equal(f.providers.size, 0);
});
