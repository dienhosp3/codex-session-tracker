'use strict';

// Native contextCompaction items do not identify their trigger. Observe manual
// requests on the same connection so they never activate the automatic policy.
const connections = new WeakMap();
const listeners = new Set();
function subscribeCompactionStarted(listener) {
  listeners.add(listener);
  return { dispose: () => listeners.delete(listener) };
}
function observeCompactions(connection) {
  let state = connections.get(connection);
  if (!state) {
    const original = connection.sendRequest;
    state = { references: 0, pendingManual: new Map(), seen: new Set() };
    state.wrapped = function(provider, id, method, params, ...rest) {
      const threadId = params?.threadId;
      if (threadId && method === 'thread/compact/start') state.pendingManual.set(threadId, Date.now());
      else if (threadId && (method === 'turn/start' || method === 'thread/resume' ||
          (method === 'thread/goal/set' && params.status === 'active'))) state.pendingManual.delete(threadId);
      while (state.pendingManual.size > 256) state.pendingManual.delete(state.pendingManual.keys().next().value);
      try { return original.call(this, provider, id, method, params, ...rest); }
      catch (error) { if (method === 'thread/compact/start') state.pendingManual.delete(threadId); throw error; }
    };
    state.original = original;
    connection.sendRequest = state.wrapped;
    connections.set(connection, state);
  }
  state.references++;
  let released = false;
  return {
    notification(event) {
      const p = event?.params, threadId = p?.threadId;
      if (!threadId) return;
      if (event.method !== 'item/started' || p.item?.type !== 'contextCompaction' || !p.turnId || !p.item.id) return;
      const key = threadId + ':' + p.turnId + ':' + p.item.id;
      if (state.seen.has(key)) return;
      state.seen.add(key);
      while (state.seen.size > 512) state.seen.delete(state.seen.values().next().value);
      // Match the compaction item, not turn/started: notifications from the
      // previous turn may still be draining when an explicit request is sent.
      const requestedAt = state.pendingManual.get(threadId);
      state.pendingManual.delete(threadId);
      if (requestedAt && Date.now() - requestedAt < 30000) return;
      for (const listener of listeners) {
        Promise.resolve().then(() => listener({ threadId, turnId: p.turnId, itemId: p.item.id }))
          .catch(error => console.warn('[Codex Tracker] Auto compact: ' + error.message));
      }
    },
    dispose() {
      if (released) return;
      released = true;
      if (--state.references === 0) {
        if (connection.sendRequest === state.wrapped) connection.sendRequest = state.original;
        connections.delete(connection);
      }
    }
  };
}
module.exports = { subscribeCompactionStarted, observeCompactions };
