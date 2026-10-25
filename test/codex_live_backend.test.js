'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLiveBackend, installOwnerBridge, disposeOwnerBridges, readAccountInLocalBackend, readRateLimitsInLocalBackend } = require('../codex_live_backend');

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

test('account identity uses only the existing connection and read-only account metadata request', async () => {
  const f = fixture();
  const account = { type: 'chatgpt', email: 'owner@example.test', planType: 'plus' };
  f.connection.sendRequest = (provider, id, method, input, mutating) => {
    f.requests.push({ method, input, mutating });
    queueMicrotask(() => f.providers.get(provider).onResult({ id, result: { account, requiresOpenaiAuth: true } }));
  };
  const backend = createLiveBackend(f.connection);
  const nativeDiscovery = [() => true, () => ({})];
  const nativeSteer = [() => false, () => {}];
  const handlers = new Map([['thread-owner-discovery', nativeDiscovery], ['thread-follower-steer-turn', nativeSteer]]);
  try {
    assert.deepEqual((await backend.readAccount()).account, account);
    installOwnerBridge([f.connection], [{ ipcClient: { requestHandlers: handlers }, ownsThread: () => false }]);
    assert.deepEqual((await readAccountInLocalBackend()).account, account);
    assert.deepEqual(f.requests, [
      { method: 'account/read', input: { refreshToken: false }, mutating: false },
      { method: 'account/read', input: { refreshToken: false }, mutating: false }
    ]);
  } finally {
    backend.dispose();
    disposeOwnerBridges();
  }
  assert.equal(f.providers.size, 0);
  assert.equal(handlers.get('thread-owner-discovery'), nativeDiscovery);
  assert.equal(handlers.get('thread-follower-steer-turn'), nativeSteer);
  await assert.rejects(readAccountInLocalBackend(), /Không xác định được/);
});

test('usage uses the existing connection with only account/rateLimits/read', async () => {
  const f = fixture();
  const limits = { rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300 } } };
  f.connection.sendRequest = (provider, id, method, input, mutating) => {
    f.requests.push({ method, input, mutating });
    queueMicrotask(() => f.providers.get(provider).onResult({ id, result: limits }));
  };
  const handlers = new Map([['thread-owner-discovery', [() => true, () => ({})]], ['thread-follower-steer-turn', [() => false, () => {}]]]);
  try {
    installOwnerBridge([f.connection], [{ ipcClient: { requestHandlers: handlers }, ownsThread: () => false }]);
    assert.deepEqual(await readRateLimitsInLocalBackend(), limits);
    assert.deepEqual(f.requests, [{ method: 'account/rateLimits/read', input: {}, mutating: false }]);
  } finally {
    disposeOwnerBridges();
  }
  await assert.rejects(readRateLimitsInLocalBackend(), /Chưa kết nối/);
});

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

test('interrupt sends turn/interrupt to the existing live app-server turn', async () => {
  const f = fixture(), backend = createLiveBackend(f.connection);
  try {
    const result = await backend.interrupt({ conversationId: 'target', turnId: 'live-turn' });
    assert.equal(result.turnId, 'live-turn');
    assert.equal(result.transport, 'codex-existing-app-server');
    assert.deepEqual(f.requests.map(r => r.method), ['turn/interrupt']);
    assert.deepEqual(f.requests[0].params, { threadId: 'target', turnId: 'live-turn' });
  } finally { backend.dispose(); }
});

test('compact sends thread/compact/start for the selected thread', async () => {
  const f = fixture(), backend = createLiveBackend(f.connection);
  try {
    const result = await backend.compact({ conversationId: 'target' });
    assert.equal(result.threadId, 'target');
    assert.equal(result.transport, 'codex-existing-app-server');
    assert.deepEqual(f.requests.map(r => r.method), ['thread/compact/start']);
    assert.deepEqual(f.requests[0].params, { threadId: 'target' });
  } finally { backend.dispose(); }
});

test('compact and resume stops the active turn, compacts, then starts one new turn', async () => {
  const f = fixture();
  let threadStatus = 'active';
  let turnStatus = 'inProgress';
  f.connection.sendRequest = (provider, id, method, input) => {
    f.requests.push({ method, params: input });
    if (method === 'turn/interrupt') {
      threadStatus = 'idle';
      turnStatus = 'interrupted';
    }
    let result = { turn: { id: 'new-turn' } };
    if (method === 'thread/loaded/list') result = { data: ['target'], nextCursor: null };
    else if (method === 'thread/read') result = { thread: { id: 'target', status: { type: threadStatus } } };
    else if (method === 'thread/turns/list') result = { data: [{ id: turnStatus === 'interrupted' ? 'live-turn' : 'new-turn', status: turnStatus }] };
    queueMicrotask(() => f.providers.get(provider).onResult({ id, result }));
  };
  const backend = createLiveBackend(f.connection);
  try {
    const result = await backend.compactAndResume({
      conversationId: 'target', turnId: 'live-turn', resumeMessage: 'Tiếp tục sau compact.'
    });
    assert.equal(result.turnId, 'new-turn');
    assert.equal(result.previousTurnId, 'live-turn');
    assert.deepEqual(f.requests.map(request => request.method), [
      'turn/interrupt', 'thread/compact/start', 'thread/read', 'thread/turns/list',
      'thread/loaded/list', 'thread/read', 'thread/turns/list', 'turn/start'
    ]);
    assert.deepEqual(f.requests[0].params, { threadId: 'target', turnId: 'live-turn' });
    assert.deepEqual(f.requests[1].params, { threadId: 'target' });
    assert.deepEqual(f.requests.at(-1).params, {
      threadId: 'target', input: [{ type: 'text', text: 'Tiếp tục sau compact.', text_elements: [] }], clientUserMessageId: undefined
    });
  } finally { backend.dispose(); }
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
