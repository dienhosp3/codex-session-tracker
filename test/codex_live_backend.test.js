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

test('model picker uses paginated read-only catalog, actual model identifiers and skips hidden entries', async t => {
  const f = fixture();
  f.connection.sendRequest = (provider, id, method, input, mutating) => {
    f.requests.push({ method, input, mutating });
    const result = input.cursor ? { data: [{ id: 'other', model: 'other-model', displayName: 'Other', isDefault: true }], nextCursor: null }
      : { data: [{ id: 'display-id', model: 'actual-model', displayName: 'Actual' }, { id: 'hidden', hidden: true }], nextCursor: 'next' };
    queueMicrotask(() => f.providers.get(provider).onResult({ id, result }));
  };
  const backend = createLiveBackend(f.connection); t.after(() => backend.dispose());
  assert.deepEqual(await backend.listModels(), [
    { id: 'actual-model', label: 'Actual', isDefault: false }, { id: 'other-model', label: 'Other', isDefault: true }
  ]);
  assert.equal(f.requests.length, 2);
  assert.ok(f.requests.every(call => call.method === 'model/list' && call.mutating === false && call.input.includeHidden === false));
});

test('model catalog repeated cursors fail without looping or creating a task', async t => {
  const f = fixture();
  f.connection.sendRequest = (provider, id, method) => {
    f.requests.push({ method });
    queueMicrotask(() => f.providers.get(provider).onResult({ id, result: { data: [], nextCursor: 'same' } }));
  };
  const backend = createLiveBackend(f.connection); t.after(() => backend.dispose());
  await assert.rejects(backend.listModels(), /lặp trang/); assert.equal(f.requests.length, 2);
});

test('lifecycle bridge forwards only terminal turns and reports runtime failure for a tracked active turn', () => {
  const f = fixture(), events = [];
  const backend = createLiveBackend(f.connection, { onTurnCompleted: event => events.push(event) });
  const provider = [...f.providers.values()][0];
  try {
    provider.onNotification({ method: 'error', params: { threadId: 'target', error: { message: 'temporary retry' } } });
    assert.equal(events.length, 0);
    provider.onNotification({ method: 'turn/started', params: { threadId: 'target', turn: { id: 'one', status: 'inProgress' } } });
    provider.onNotification({ method: 'turn/completed', params: { threadId: 'target', turn: { id: 'one', status: 'completed' } } });
    assert.equal(events.length, 1); assert.equal(events[0].turn.status, 'completed');
    provider.onFatalError(new Error('process exited')); assert.equal(events.length, 1, 'completed turn is not failed again');
    provider.onNotification({ method: 'turn/started', params: { threadId: 'target', turn: { id: 'two', status: 'inProgress' } } });
    provider.onFatalError(new Error('process crashed'));
    assert.equal(events.length, 2); assert.equal(events[1].turn.status, 'failed'); assert.equal(events[1].turn.id, 'two');
  } finally { backend.dispose(); }
});

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

test('handoff rejects a changed turn before any mutation', async () => {
  const f = fixture(), backend = createLiveBackend(f.connection);
  try { await assert.rejects(backend.stopForHandoff({ threadId: 'target', turnId: 'old-turn' }), /lượt khác/); }
  finally { backend.dispose(); }
  assert.equal(f.requests.some(r => ['turn/interrupt', 'thread/start', 'thread/goal/set'].includes(r.method)), false);
});

test('manual preflight accepts loaded running and stopped chats but does not resume or mutate them', async t => {
  for (const options of [{}, { idle: true, completed: true }]) {
    const f = fixture(options), backend = createLiveBackend(f.connection); t.after(() => backend.dispose());
    const state = await backend.readHandoffState('target');
    assert.equal(state.turnId, 'live-turn'); assert.equal(state.running, !options.idle);
    assert.deepEqual(f.requests.map(r => r.method), ['thread/loaded/list', 'thread/read', 'thread/turns/list']);
  }
  for (const options of [{ loaded: false }, { idle: true }, { completed: true }]) {
    const f = fixture(options), backend = createLiveBackend(f.connection); t.after(() => backend.dispose());
    await assert.rejects(backend.readHandoffState('target'), e => e.delivery === 'not_sent');
    assert.ok(f.requests.every(r => r.method.endsWith('/list') || r.method === 'thread/read'));
  }
});

test('manual stopped handoff pauses an active goal, preserves permissions and never interrupts or resumes', async t => {
  const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manual-stopped-'));
  const file = path.join(root, 'rollout.jsonl');
  await fs.writeFile(file, [
    { type: 'session_meta', payload: { id: 'target' } },
    { type: 'turn_context', payload: { approval_policy: 'never', sandbox_policy: { type: 'danger-full-access' } } }
  ].map(JSON.stringify).join('\n') + '\n');
  const f = fixture({ idle: true, completed: true }), send = f.connection.sendRequest;
  f.connection.sendRequest = (name, id, method, params) => {
    if (!['thread/goal/get', 'thread/goal/set'].includes(method)) return send(name, id, method, params);
    f.requests.push({ method, params });
    queueMicrotask(() => f.providers.get(name).onResult({ id, result: { goal: { status: method.endsWith('/get') ? 'active' : 'paused' } } }));
  };
  const backend = createLiveBackend(f.connection); t.after(() => backend.dispose());
  const result = await backend.stopForHandoff({ threadId: 'target', turnId: 'live-turn', manual: true, file });
  assert.equal(result.permissionSettings.start.sandbox, 'danger-full-access');
  assert.equal(f.requests.filter(r => r.method === 'thread/goal/set').length, 1);
  assert.equal(f.requests.some(r => ['turn/interrupt', 'turn/start', 'thread/resume'].includes(r.method)), false);
  await assert.rejects(backend.stopForHandoff({ threadId: 'target', turnId: 'earlier', manual: true, file }), /lượt khác/);
  assert.equal(f.requests.filter(r => r.method === 'thread/goal/set').length, 1);
});

test('handoff interrupts even if goal pause fails, then refuses to create a successor', async () => {
  const f = fixture();
  const send = f.connection.sendRequest;
  f.connection.sendRequest = (name, id, method, params) => {
    if (method === 'thread/goal/get') {
      f.requests.push({ method, params });
      queueMicrotask(() => f.providers.get(name).onResult({ id, error: { code: -32000, message: 'goal unavailable' } }));
    } else send(name, id, method, params);
  };
  const backend = createLiveBackend(f.connection);
  try { await assert.rejects(backend.stopForHandoff({ threadId: 'target', turnId: 'live-turn' }), /goal unavailable/); }
  finally { backend.dispose(); }
  assert.equal(f.requests.at(-1).method, 'turn/interrupt');
  assert.equal(f.requests.some(r => r.method === 'thread/start'), false);
});

test('compact and resume stops the active turn, compacts, then starts one new turn', async () => {
  const f = fixture();
  let threadStatus = 'active';
  let turnStatus = 'inProgress';
  let compactionStatus = '';
  let compactionReads = 0;
  f.connection.sendRequest = (provider, id, method, input) => {
    f.requests.push({ method, params: input });
    if (method === 'turn/interrupt') {
      threadStatus = 'idle';
      turnStatus = 'interrupted';
    }
    if (method === 'thread/compact/start') {
      compactionStatus = 'inProgress';
      compactionReads = 0;
    }
    let result = { turn: { id: 'new-turn' } };
    if (method === 'thread/loaded/list') result = { data: ['target'], nextCursor: null };
    else if (method === 'thread/read') {
      const turns = [{ id: 'live-turn', status: turnStatus, items: [] }];
      if (compactionStatus) {
        compactionReads += 1;
        if (compactionReads > 1) compactionStatus = 'completed';
        turns.push({ id: 'compact-turn', status: compactionStatus, items: [{ type: 'contextCompaction', id: 'compact-item' }] });
      }
      result = { thread: { id: 'target', status: { type: threadStatus }, turns } };
    }
    else if (method === 'thread/turns/list') result = { data: [{ id: compactionStatus ? 'compact-turn' : 'live-turn', status: compactionStatus || turnStatus }] };
    queueMicrotask(() => f.providers.get(provider).onResult({ id, result }));
  };
  const backend = createLiveBackend(f.connection);
  try {
    const result = await backend.compactAndResume({
      conversationId: 'target', turnId: 'live-turn', resumeMessage: 'Tiếp tục sau compact.'
    });
    assert.equal(result.turnId, 'new-turn');
    assert.equal(result.previousTurnId, 'compact-turn');
    assert.deepEqual(f.requests.map(request => request.method), [
      'turn/interrupt', 'thread/read', 'thread/read', 'thread/compact/start', 'thread/read', 'thread/read',
      'thread/read', 'thread/turns/list', 'thread/loaded/list', 'thread/read', 'thread/turns/list', 'turn/start'
    ]);
    assert.deepEqual(f.requests[0].params, { threadId: 'target', turnId: 'live-turn' });
    assert.deepEqual(f.requests[1].params, { threadId: 'target', includeTurns: true });
    assert.deepEqual(f.requests[3].params, { threadId: 'target' });
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
