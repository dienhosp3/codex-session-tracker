'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { createAutoAllowStore, installAutoAllow, ASK_WORKSPACE, FULL_ACCESS } = require('../codex_auto_allow');
const { createLiveBackend } = require('../codex_live_backend');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-allow-'));
  const store = createAutoAllowStore(root), calls = [], replies = [];
  const connection = { sendRequest(...args) { calls.push(args); }, sendResponse(...args) { replies.push(args); } };
  const observer = installAutoAllow(connection, store); t.after(() => observer.dispose());
  return { root, store, connection, observer, calls, replies };
}
const approval = (id, threadId = 'target', method = 'item/commandExecution/requestApproval') => ({ id, method,
  params: { threadId, turnId: 'turn', availableDecisions: ['accept', 'decline'] } });

test('Auto Allow records are scoped, durable, validated and retain the previous permissions', async t => {
  const f = await fixture(t);
  await f.store.remember('target', { enabled: true, previous: ASK_WORKSPACE });
  assert.equal(f.store.get('other'), undefined);
  assert.deepEqual(createAutoAllowStore(f.root).get('target').previous, ASK_WORKSPACE);
  assert.equal(createAutoAllowStore(f.root).get('target').enabled, true);
  await assert.rejects(f.store.remember('../escape', { enabled: true, previous: ASK_WORKSPACE }));
  await assert.rejects(f.store.remember('bad', { enabled: true }));
  await f.store.remember('target', { enabled: false, previous: ASK_WORKSPACE });
  assert.equal(createAutoAllowStore(f.root).get('target').enabled, false);
});

test('only explicitly enabled chat command/file approvals get one-request accepts, including already pending', async t => {
  const f = await fixture(t);
  f.observer.request(approval(1)); f.observer.request(approval(2, 'other'));
  await tick(); assert.equal(f.replies.length, 0);
  await f.store.remember('target', { enabled: true, previous: ASK_WORKSPACE }); await tick();
  assert.deepEqual(f.replies, [[1, { decision: 'accept' }]]);
  f.observer.request(approval(1)); f.observer.request(approval(3, 'target', 'item/fileChange/requestApproval'));
  f.observer.request(approval(4, 'target', 'item/tool/requestUserInput'));
  f.observer.request(approval(5, 'target', 'item/permissions/requestApproval'));
  f.observer.request(approval(6, 'target', 'mcpServer/elicitation/request'));
  f.observer.request(approval(7, 'target', 'item/autoApprovalReview/started'));
  const restricted = approval(8); restricted.params.availableDecisions = ['decline']; f.observer.request(restricted);
  await tick(); assert.deepEqual(f.replies.map(r => r[0]), [1, 3]);
  await f.store.remember('target', { enabled: false, previous: ASK_WORKSPACE });
  f.observer.request(approval(9)); await tick(); assert.equal(f.replies.length, 2);
});

test('manual responses, resolved requests and terminal turns cannot be approved again', async t => {
  const f = await fixture(t);
  f.observer.request(approval(1)); f.connection.sendResponse(1, { decision: 'decline' });
  f.observer.request(approval(2)); f.observer.notification({ method: 'serverRequest/resolved', params: { requestId: 2 } });
  f.observer.request(approval(3)); f.observer.notification({ method: 'turn/completed', params: { threadId: 'target', turn: { id: 'turn' } } });
  await f.store.remember('target', { enabled: true, previous: ASK_WORKSPACE }); await tick();
  assert.deepEqual(f.replies, [[1, { decision: 'decline' }]]);
});

test('resume/next turn replace stale permission fields for recorded chat only, restoring its original mode when off', async t => {
  const f = await fixture(t);
  await f.store.remember('target', { enabled: true, previous: ASK_WORKSPACE });
  const stale = { threadId: 'target', model: 'chosen', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' }, approvalPolicy: 'on-request', permissions: ':read-only' };
  f.connection.sendRequest('native', '1', 'thread/resume', stale);
  f.connection.sendRequest('native', '2', 'turn/start', stale);
  f.connection.sendRequest('native', '3', 'turn/start', { ...stale, threadId: 'other' });
  assert.equal(stale.permissions, ':read-only');
  for (const call of f.calls.slice(0, 2)) {
    assert.equal(call[3].permissions, FULL_ACCESS.permissions); assert.equal(call[3].approvalPolicy, 'never');
    assert.equal(call[3].sandbox, undefined); assert.equal(call[3].sandboxPolicy, undefined); assert.equal(call[3].model, 'chosen');
  }
  assert.equal(f.calls[2][3].permissions, ':read-only');
  await f.store.remember('target', { enabled: false, previous: ASK_WORKSPACE });
  f.connection.sendRequest('native', '4', 'thread/resume', { threadId: 'target', ...FULL_ACCESS });
  f.connection.sendRequest('native', '5', 'turn/start', { threadId: 'target', ...FULL_ACCESS });
  assert.equal(f.calls[3][3].sandbox, 'workspace-write'); assert.equal(f.calls[3][3].permissions, undefined);
  assert.deepEqual(f.calls[4][3].sandboxPolicy, ASK_WORKSPACE.turn.sandboxPolicy);
  assert.equal(f.calls[4][3].approvalPolicy, 'on-request');
});

test('shared connection controller avoids duplicate accepts and restores native methods after the last disposal', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-allow-shared-')), store = createAutoAllowStore(root), replies = [];
  const sendRequest = () => {}, sendResponse = (...args) => replies.push(args), connection = { sendRequest, sendResponse };
  const a = installAutoAllow(connection, store), b = installAutoAllow(connection, store);
  t.after(() => { a.dispose(); b.dispose(); });
  await store.remember('target', { enabled: true, previous: ASK_WORKSPACE });
  a.request(approval(1)); b.request(approval(1)); await tick(); assert.equal(replies.length, 1);
  a.dispose(); assert.notEqual(connection.sendRequest, sendRequest);
  b.dispose(); assert.equal(connection.sendRequest, sendRequest); assert.equal(connection.sendResponse, sendResponse);
});

test('permission persistence failure restores native permissions and never enables approval automation', async t => {
  const f = await fixture(t), file = path.join(f.root, 'rollout.jsonl');
  await fs.writeFile(file, [{ type: 'session_meta', payload: { id: 'target' } },
    { type: 'turn_context', payload: { approval_policy: 'on-request', active_permission_profile: { id: ':read-only' } } }
  ].map(JSON.stringify).join('\n') + '\n');
  const calls = [], providers = new Map();
  const connection = { initialized: true, proc: { pid: 1, stdin: { destroyed: false } },
    registerProvider(id, provider) { providers.set(id, provider); return { dispose: () => providers.delete(id) }; },
    sendRequest(provider, id, method, params) {
      calls.push({ method, params });
      const result = method === 'thread/read' ? { thread: { id: 'target', path: file, status: { type: 'idle' } } }
        : method === 'thread/loaded/list' ? { data: ['target'] } : {};
      queueMicrotask(() => providers.get(provider).onResult({ id, result }));
    } };
  const store = { ...f.store, remember: async () => { throw new Error('Storage failure'); } };
  const backend = createLiveBackend(connection, { autoAllowStore: store }); t.after(() => backend.dispose());
  await assert.rejects(backend.setAutoAllow({ threadId: 'target', enabled: true }), /Storage failure/);
  const changes = calls.filter(c => c.method === 'thread/settings/update').map(c => c.params);
  assert.equal(changes.length, 2);
  assert.equal(changes[0].permissions, ':danger-full-access'); assert.equal(changes[0].approvalPolicy, 'never');
  assert.equal(changes[1].permissions, ':read-only'); assert.equal(changes[1].approvalPolicy, 'on-request');
  assert.equal(f.store.get('target'), undefined);
});
