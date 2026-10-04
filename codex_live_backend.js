'use strict';

const { randomUUID } = require('crypto');

// An extra provider on the existing Extension connection. Steer never resumes
// or starts a turn. Only the explicit continue action may resume/start a chat.
function createLiveBackend(connection, options = {}) {
  const name = 'CodexSessionTrackerSteer-' + randomUUID();
  const pending = new Map();
  let disposed = false;
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
    return Boolean(!disposed && connection.initialized && proc && !proc.killed && proc.exitCode == null && proc.signalCode == null && !proc.stdin?.destroyed);
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
  async function isLoaded(threadId) {
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
    return found;
  }
  async function activeTurn(threadId) {
    if (!await isLoaded(threadId)) throw failure('Chat is not loaded in this existing app-server. Tracker did not resume it.', 'not_sent');
    const read = await request('thread/read', { threadId, includeTurns: false });
    if (read?.thread?.id !== threadId || read.thread.status?.type !== 'active') {
      throw failure('Chat has no active task in the existing app-server.', 'not_sent');
    }
    const turn = await latestTurn(threadId);
    if (!turn?.id || turn.status !== 'inProgress') throw failure('Chat has no in-progress turn. Tracker did not start a new turn.', 'not_sent');
    return turn.id;
  }
  async function latestTurn(threadId) {
    try {
      const page = await request('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc' });
      return page?.data?.[0];
    } catch (error) {
      // 0.160.0 advertises paging but some fresh thread stores do not implement
      // list_turns yet. Fall back only for this explicit unsupported operation.
      if (!/list_turns is not supported|thread\/turns\/list.*not supported/i.test(error.message)) throw error;
      const read = await request('thread/read', { threadId, includeTurns: true });
      if (read?.thread?.id !== threadId) throw failure('App-server returned a different chat.', 'not_sent');
      return read.thread.turns?.at(-1);
    }
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
  async function continueConversation(params, onReady = () => {}) {
    const threadId = params.conversationId;
    if (!threadId || !Array.isArray(params.input) || !params.input.length) throw failure('Invalid continuation input.', 'not_sent');
    async function requireStopped() {
      const read = await request('thread/read', { threadId, includeTurns: false });
      if (read?.thread?.id !== threadId) throw failure('App-server returned a different chat.', 'not_sent');
      if (read.thread.status?.type === 'active') throw failure('Chat đang chạy. Dùng Steer ngay hoặc Gửi sau.', 'not_sent');
      const turn = await latestTurn(threadId);
      if (!turn?.id || !['completed', 'interrupted', 'failed'].includes(turn.status)) throw failure('Chưa xác nhận được turn trước đã kết thúc.', 'not_sent');
      return turn.id;
    }
    await requireStopped();
    let resumed = false;
    if (!await isLoaded(threadId)) {
      const result = await request('thread/resume', { threadId, excludeTurns: true });
      if (result?.thread?.id !== threadId) throw failure('Resume returned a different chat. No message was sent.', 'not_sent');
      resumed = true;
    }
    const previousTurnId = await requireStopped();
    await onReady();
    const result = await request('turn/start', {
      threadId, input: params.input, clientUserMessageId: params.clientUserMessageId
    }, true);
    const turnId = result?.turn?.id;
    if (!turnId || turnId === previousTurnId) throw failure('App-server did not acknowledge a new conversation turn.', 'unknown');
    return { turnId, previousTurnId, resumed, transport: 'codex-existing-app-server', ownerPid: connection.proc?.pid };
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const [id, item] of pending) settle(id, failure('Tracker bridge disposed.', item.mutating ? 'unknown' : 'not_sent'));
    registration.dispose();
  }
  return { available, isLoaded, activeTurn, steer, continueConversation, dispose };
}

const BRIDGE_KEY = Symbol.for('codexSessionTracker.ownerBridge.v2');
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
    if (client[BRIDGE_KEY]?.revision === 3) {
      installedBridges.add(client[BRIDGE_KEY]);
      results.push(client[BRIDGE_KEY].info);
      continue;
    }
    client[BRIDGE_KEY]?.dispose();
    client[Symbol.for('codexSessionTracker.ownerBridge.v1')]?.dispose();
    const discovery = handlers.get('thread-owner-discovery');
    const steer = handlers.get('thread-follower-steer-turn');
    if (!Array.isArray(discovery) || !Array.isArray(steer)) continue;
    const backend = createLiveBackend(connection, options);
    const info = { installed: true, ownerPid: connection.proc.pid, transport: 'codex-existing-app-server' };
    const ours = (params, envelope) => params?.trackerDirectSteer === 1 && (!envelope?.hostId || envelope.hostId === 'local');
    const newDiscovery = [
      async (p, e) => await discovery[0](p, e) || (p?.trackerContinueDiscovery === 1 && p.hostId === 'local' && backend.available() && await backend.isLoaded(p.conversationId)),
      async envelope => ({ ...(await discovery[1](envelope)), supportsTrackerDirectSteer: backend.available(), supportsTrackerContinue: backend.available() && handlers.has('thread-follower-start-turn') })
    ];
    async function continueHere(params) {
      // The existing local app-server now holds this explicitly resumed chat.
      // Advertise the owner so subsequent Tracker steers reach this host.
      return backend.continueConversation(params, () => stream.setThreadOwnership?.({ hostId: 'local', conversationId: params.conversationId, ownsThread: true }));
    }
    function tagged(error) {
      const tag = error.delivery === 'unknown' ? '[CST_DELIVERY_UNKNOWN]' : error.delivery === 'not_sent' ? '[CST_NOT_SENT]' : '[CST_REJECTED]';
      return new Error(tag + ' ' + error.message);
    }
    const newSteer = [
      (params, envelope) => ours(params, envelope)
        ? stream.ownsThread('local', params.conversationId) && backend.available()
        : steer[0](params, envelope),
      async envelope => {
        if (!ours(envelope.params, envelope)) return steer[1](envelope);
        if (!stream.ownsThread('local', envelope.params.conversationId)) throw new Error('[CST_NOT_SENT] Cached Extension ownership changed.');
        try { return await backend.steer(envelope.params); }
        catch (error) {
          throw tagged(error);
        }
      }
    ];
    const start = handlers.get('thread-follower-start-turn');
    const directContinue = (p, e) => p?.trackerContinue === 1 && (!e?.hostId || e.hostId === 'local');
    const newStart = start && [
      async (p, e) => directContinue(p, e) ? backend.available() && (stream.ownsThread('local', p.conversationId) || await backend.isLoaded(p.conversationId)) : start[0](p, e),
      async e => {
        if (!directContinue(e.params, e)) return start[1](e);
        if (!stream.ownsThread('local', e.params.conversationId) && !await backend.isLoaded(e.params.conversationId)) throw new Error('[CST_NOT_SENT] Existing Extension no longer holds this chat.');
        try { return await continueHere(e.params); } catch (error) { throw tagged(error); }
      }
    ];
    handlers.set('thread-owner-discovery', newDiscovery);
    handlers.set('thread-follower-steer-turn', newSteer);
    if (newStart) handlers.set('thread-follower-start-turn', newStart);
    client[BRIDGE_KEY] = { revision: 3, info, available: backend.available, ownsThread: id => stream.ownsThread('local', id), continueConversation: continueHere, dispose() {
      if (handlers.get('thread-owner-discovery') === newDiscovery) handlers.set('thread-owner-discovery', discovery);
      if (handlers.get('thread-follower-steer-turn') === newSteer) handlers.set('thread-follower-steer-turn', steer);
      if (newStart && handlers.get('thread-follower-start-turn') === newStart) handlers.set('thread-follower-start-turn', start);
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
  installedBridges.clear();
}
async function continueInLocalBackend(params) {
  const candidates = [...installedBridges].filter(b => b.available());
  const owned = candidates.filter(b => b.ownsThread(params.conversationId));
  const choices = owned.length ? owned : candidates;
  if (choices.length !== 1) {
    const error = new Error('Chưa có kết nối Codex local duy nhất để tiếp tục chat.');
    error.delivery = 'not_sent';
    throw error;
  }
  return choices[0].continueConversation(params);
}
module.exports = { createLiveBackend, installOwnerBridge, installedBridgeInfo, disposeOwnerBridges, continueInLocalBackend, BRIDGE_KEY };
