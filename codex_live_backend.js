'use strict';

const { randomUUID } = require('crypto');

// An extra provider on the existing Extension connection. No new app-server,
// resume, turn/start, interruption, or raw stdio reader is created here.
function createLiveBackend(connection, options = {}) {
  const name = 'CodexSessionTrackerSteer-' + randomUUID();
  const pending = new Map();
  const timeoutMs = options.timeoutMs || 15000;
  function failure(message, delivery, code) {
    const error = new Error(message);
    error.delivery = delivery;
    if (code !== undefined) error.code = code;
    return error;
  }
  function settle(id, error, value) {
    const item = pending.get(String(id));
    if (!item) return;
    pending.delete(String(id));
    clearTimeout(item.timer);
    if (error) item.reject(error); else item.resolve(value);
  }
  const registration = connection.registerProvider(name, {
    onResult(reply) {
      if (reply.error) settle(reply.id, failure(reply.error.message || 'App-server rejected request.', 'rejected', reply.error.code));
      else settle(reply.id, null, reply.result);
    },
    onRequestDelivery(event) {
      if (event.type === 'failed' && event.delivery?.stage === 'not-sent') {
        settle(event.delivery.requestId, failure(event.message || 'App-server is unavailable.', 'not_sent'));
      }
    },
    onFatalError(error) {
      for (const [id, item] of pending) settle(id, failure(error?.message || 'App-server connection closed.', item.mutating ? 'unknown' : 'not_sent'));
    }
  });
  function available() {
    const proc = connection.proc;
    return Boolean(connection.initialized && proc && !proc.killed && proc.exitCode == null && proc.signalCode == null && !proc.stdin?.destroyed);
  }
  function request(method, params, mutating = false) {
    if (!available()) return Promise.reject(failure('Existing Codex app-server is unavailable.', 'not_sent'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const item = { resolve, reject, mutating, timer: null };
      item.timer = setTimeout(() => {
        connection.abandonRequest?.(name, id);
        settle(id, failure('Existing Codex app-server timed out during ' + method + '.', mutating ? 'unknown' : 'not_sent', 'ETIMEDOUT'));
      }, timeoutMs);
      pending.set(id, item);
      try { connection.sendRequest(name, id, method, params, mutating); }
      catch (error) { settle(id, failure(error.message, mutating ? 'unknown' : 'not_sent')); }
    });
  }
  async function activeTurn(threadId) {
    let cursor;
    let found = false;
    const seen = new Set();
    do {
      const page = await request('thread/loaded/list', { limit: 100, ...(cursor ? { cursor } : {}) });
      found = Array.isArray(page?.data) && page.data.includes(threadId);
      cursor = page?.nextCursor;
      if (cursor && seen.has(cursor)) throw failure('App-server returned a repeated loaded-thread cursor.', 'not_sent');
      if (cursor) seen.add(cursor);
    } while (!found && cursor);
    if (!found) throw failure('Chat is not loaded in this existing app-server. Tracker did not resume it.', 'not_sent');
    const read = await request('thread/read', { threadId, includeTurns: false });
    if (read?.thread?.id !== threadId || read.thread.status?.type !== 'active') {
      throw failure('Chat has no active task in the existing app-server.', 'not_sent');
    }
    const turns = await request('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc' });
    const turn = turns?.data?.[0];
    if (!turn?.id || turn.status !== 'inProgress') throw failure('Chat has no in-progress turn. Tracker did not start a new turn.', 'not_sent');
    return turn.id;
  }
  async function steer(params) {
    const threadId = params.conversationId;
    if (!threadId || !Array.isArray(params.input) || !params.input.length) throw failure('Invalid direct steer input.', 'not_sent');
    const expectedTurnId = await activeTurn(threadId);
    const result = await request('turn/steer', {
      threadId, expectedTurnId, input: params.input,
      clientUserMessageId: params.clientUserMessageId,
      ...(params.additionalContext !== undefined ? { additionalContext: params.additionalContext } : {})
    }, true);
    if (!result?.turnId || result.turnId !== expectedTurnId) throw failure('App-server did not acknowledge the expected steer turn.', 'unknown');
    return { ...result, transport: 'codex-existing-app-server', ownerPid: connection.proc?.pid };
  }
  function dispose() {
    for (const [id, item] of pending) settle(id, failure('Tracker bridge disposed.', item.mutating ? 'unknown' : 'not_sent'));
    registration.dispose();
  }
  return { available, activeTurn, steer, dispose };
}

const BRIDGE_KEY = Symbol.for('codexSessionTracker.ownerBridge.v1');
const installedBridges = new Set();
function installOwnerBridge(connections, streams, options = {}) {
  const candidates = connections.filter(c => c?.initialized && c.proc && !c.proc.killed && c.proc.exitCode == null);
  if (candidates.length !== 1) throw new Error('Cannot select a unique existing app-server connection in this Extension host.');
  const connection = candidates[0];
  const results = [];
  for (const stream of streams) {
    const client = stream?.ipcClient;
    const handlers = client?.requestHandlers;
    if (!(handlers instanceof Map) || typeof stream.ownsThread !== 'function') continue;
    if (client[BRIDGE_KEY]) { results.push(client[BRIDGE_KEY].info); continue; }
    const discovery = handlers.get('thread-owner-discovery');
    const steer = handlers.get('thread-follower-steer-turn');
    if (!Array.isArray(discovery) || !Array.isArray(steer)) continue;
    const backend = createLiveBackend(connection, options);
    const info = { installed: true, ownerPid: connection.proc.pid, transport: 'codex-existing-app-server' };
    const ours = (params, envelope) => params?.trackerDirectSteer === 1 && (!envelope?.hostId || envelope.hostId === 'local');
    const newDiscovery = [discovery[0], async envelope => ({ ...(await discovery[1](envelope)), supportsTrackerDirectSteer: backend.available() })];
    const newSteer = [
      (params, envelope) => ours(params, envelope)
        ? stream.ownsThread('local', params.conversationId) && backend.available()
        : steer[0](params, envelope),
      async envelope => {
        if (!ours(envelope.params, envelope)) return steer[1](envelope);
        if (!stream.ownsThread('local', envelope.params.conversationId)) throw new Error('[CST_NOT_SENT] Cached Extension ownership changed.');
        try { return await backend.steer(envelope.params); }
        catch (error) {
          const tag = error.delivery === 'unknown' ? '[CST_DELIVERY_UNKNOWN]' : error.delivery === 'not_sent' ? '[CST_NOT_SENT]' : '[CST_REJECTED]';
          throw new Error(tag + ' ' + error.message);
        }
      }
    ];
    handlers.set('thread-owner-discovery', newDiscovery);
    handlers.set('thread-follower-steer-turn', newSteer);
    client[BRIDGE_KEY] = { info, available: backend.available, dispose() {
      if (handlers.get('thread-owner-discovery') === newDiscovery) handlers.set('thread-owner-discovery', discovery);
      if (handlers.get('thread-follower-steer-turn') === newSteer) handlers.set('thread-follower-steer-turn', steer);
      backend.dispose();
      delete client[BRIDGE_KEY];
      installedBridges.delete(this);
    } };
    installedBridges.add(client[BRIDGE_KEY]);
    results.push(info);
  }
  if (!results.length) throw new Error('The running Codex Extension IPC handlers are unavailable.');
  return results;
}

function installedBridgeInfo() {
  return [...installedBridges].filter(b => b.available()).map(b => b.info);
}
function disposeOwnerBridges() {
  for (const bridge of [...installedBridges]) bridge.dispose();
}
module.exports = { createLiveBackend, installOwnerBridge, installedBridgeInfo, disposeOwnerBridges, BRIDGE_KEY };
