'use strict';

const fs = require('node:fs'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const ID = /^[A-Za-z0-9_-]{1,200}$/;
const FULL_ACCESS = Object.freeze({ approvalPolicy: 'never', approvalsReviewer: 'user', permissions: ':danger-full-access' });
const ASK_WORKSPACE = Object.freeze({
  start: { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write' },
  turn: { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy: { type: 'workspaceWrite',
    writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } }
});
let configuredStore;
const connections = new WeakMap();

function createAutoAllowStore(directory) {
  const listeners = new Set();
  function file(id) {
    if (!ID.test(id)) throw new Error('ID chat Auto Allow không hợp lệ.');
    return path.join(directory, id + '.json');
  }
  return {
    get(id) {
      if (!ID.test(id)) return undefined;
      let value;
      try { value = JSON.parse(fs.readFileSync(file(id), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
      if (value.threadId !== id || typeof value.enabled !== 'boolean' || !value.previous?.turn?.approvalPolicy || !value.previous?.start?.approvalPolicy) {
        throw new Error('Bản lưu quyền Auto Allow không hợp lệ.');
      }
      return value;
    },
    async remember(id, value) {
      if (typeof value?.enabled !== 'boolean' || !value.previous?.turn?.approvalPolicy || !value.previous?.start?.approvalPolicy) {
        throw new Error('Thiếu quyền trước khi bật Auto Allow.');
      }
      const target = file(id), temporary = target + '.' + randomUUID() + '.tmp';
      await fs.promises.mkdir(directory, { recursive: true });
      try {
        await fs.promises.writeFile(temporary, JSON.stringify({ schemaVersion: 1, threadId: id,
          enabled: value.enabled, previous: value.previous }) + '\n', { flag: 'wx' });
        await fs.promises.rename(temporary, target);
      } finally { await fs.promises.rm(temporary, { force: true }); }
      for (const listener of listeners) listener(id);
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  };
}
function configureAutoAllowStore(directory) { configuredStore = createAutoAllowStore(directory); }
function currentAutoAllowStore() { return configuredStore; }

// A native permission update applies on the NEXT turn. Existing-turn terminal
// and file-change approval requests use ordinary, one-request native accepts,
// only after the user has enabled this exact thread. Never answer user-input,
// MCP/app approval, permission-grant, policy amendment, or automatic review.
function installAutoAllow(connection, store) {
  if (!store) return { request() {}, notification() {}, dispose() {} };
  let state = connections.get(connection);
  if (!state) {
    const originalRequest = connection.sendRequest, originalResponse = connection.sendResponse;
    state = { count: 0, pending: new Map(), settled: new Set(), store };
    const settle = id => {
      state.pending.delete(id); state.settled.add(id);
      while (state.settled.size > 1024) state.settled.delete(state.settled.values().next().value);
    };
    const accept = request => {
      if (!state.pending.has(request.id) || !state.store.get(request.params.threadId)?.enabled || typeof connection.sendResponse !== 'function') return;
      const decisions = request.params.availableDecisions;
      if (Array.isArray(decisions) && !decisions.includes('accept')) return;
      // A reply sent by the native UI reaches the same wrapper and consumes it.
      connection.sendResponse(request.id, { decision: 'accept' });
    };
    state.request = request => {
      if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(request?.method) ||
          !ID.test(request.params?.threadId || '') || !request.params?.turnId || request.id == null || state.settled.has(request.id)) return;
      state.pending.set(request.id, request);
      while (state.pending.size > 512) state.pending.delete(state.pending.keys().next().value);
      // Let all native providers observe the request before its resolution.
      Promise.resolve().then(() => accept(request)).catch(error => console.warn('[Codex Tracker] Auto Allow: ' + error.message));
    };
    state.notification = event => {
      if (event?.method === 'serverRequest/resolved') settle(event.params?.requestId);
      if (event?.method === 'turn/completed' || event?.method === 'thread/deleted') {
        for (const [id, request] of state.pending) if (request.params.threadId === event.params?.threadId &&
            (event.method === 'thread/deleted' || request.params.turnId === event.params.turn?.id)) settle(id);
      }
    };
    state.wrappedRequest = function(provider, id, method, params, ...rest) {
      const record = ['thread/resume', 'turn/start'].includes(method) ? state.store.get(params?.threadId) : undefined;
      if (record) {
        params = { ...params }; delete params.sandbox; delete params.sandboxPolicy; delete params.permissions;
        params = { ...params, ...(record.enabled ? FULL_ACCESS : method === 'thread/resume' ? record.previous.start : record.previous.turn) };
      }
      return originalRequest.call(this, provider, id, method, params, ...rest);
    };
    state.wrappedResponse = function(id, result, ...rest) {
      settle(id);
      return originalResponse.call(this, id, result, ...rest);
    };
    state.unsubscribe = store.subscribe(id => {
      for (const request of state.pending.values()) if (request.params.threadId === id) {
        Promise.resolve().then(() => accept(request)).catch(error => console.warn('[Codex Tracker] Auto Allow: ' + error.message));
      }
    });
    connection.sendRequest = state.wrappedRequest;
    if (typeof originalResponse === 'function') connection.sendResponse = state.wrappedResponse;
    state.restore = () => {
      state.unsubscribe();
      if (connection.sendRequest === state.wrappedRequest) connection.sendRequest = originalRequest;
      if (connection.sendResponse === state.wrappedResponse) connection.sendResponse = originalResponse;
    };
    connections.set(connection, state);
  }
  state.count++;
  let released = false;
  return { request: state.request, notification: state.notification, dispose() {
    if (released) return;
    released = true;
    if (--state.count === 0) { state.restore(); connections.delete(connection); }
  } };
}

module.exports = { FULL_ACCESS, ASK_WORKSPACE, createAutoAllowStore, configureAutoAllowStore, currentAutoAllowStore, installAutoAllow };
