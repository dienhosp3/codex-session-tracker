'use strict';

const { randomUUID } = require('crypto');
const { normalizeImageAttachments } = require('./codex_steer');
const { readThreadPermissions, readThreadSettings, permissionSettings } = require('./codex_thread_permissions');
const { normalizeSpeed, speedFromSettings, requireSpeed, automaticSpeed } = require('./codex_speed');
const { validateContextConfig } = require('./codex_new_chat');
const { currentChatContextStore, installContextResumeHook } = require('./codex_chat_context_store');
const { planState } = require('./codex_plan_state');
const { normalizeHandoffMode, validateGoalText, goalContext } = require('./codex_handoff_modes');
const { observeCompactions } = require('./codex_compaction_events');
const { FULL_ACCESS, ASK_WORKSPACE, currentAutoAllowStore, installAutoAllow } = require('./codex_auto_allow');
const lifecycleListeners = new Set();
const newChatListeners = new Set();
const goalListeners = new Set();
function subscribeGoalUpdates(listener) {
  goalListeners.add(listener);
  return { dispose: () => goalListeners.delete(listener) };
}
const connectionNewThreads = new WeakMap();
function subscribeNewChats(listener) {
  newChatListeners.add(listener);
  return { dispose: () => newChatListeners.delete(listener) };
}
function subscribeTurnLifecycle(listener) {
  lifecycleListeners.add(listener);
  return { dispose: () => lifecycleListeners.delete(listener) };
}

// An extra provider on the existing Extension connection. Steer never resumes
// or starts a turn. Only the explicit continue action may resume/start a chat.
function createLiveBackend(connection, options = {}) {
  require('./codex_account_barrier').installAccountBarrier(connection);
  const name = 'CodexSessionTrackerSteer-' + randomUUID();
  const pending = new Map();
  const activeTurns = new Map();
  const startedTurns = new Map();
  const planTurns = new Set();
  const newThreads = connectionNewThreads.get(connection) || new Map();
  connectionNewThreads.set(connection, newThreads);
  let lifecycleRevision = 0;
  let disposed = false;
  const timeoutMs = options.timeoutMs || 15000;
  const contextStore = options.contextStore || currentChatContextStore();
  const removeContextHook = installContextResumeHook(connection, contextStore);
  const compactions = observeCompactions(connection);
  const autoAllowStore = options.autoAllowStore || currentAutoAllowStore();
  const autoAllow = installAutoAllow(connection, autoAllowStore);
  const permissionChanges = new Set();
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
    onRequest: request => autoAllow.request(request),
    onNotification(notification) {
      autoAllow.notification(notification);
      compactions.notification(notification);
      const params = notification?.params;
      if (notification?.method === 'thread/goal/updated' && params?.threadId) {
        for (const listener of goalListeners) Promise.resolve().then(() => listener({ threadId: params.threadId, status: params.goal?.status }))
          .catch(error => console.warn('[Codex Tracker] Goal update: ' + error.message));
      }
      if (notification?.method === 'item/completed' && params?.item?.type === 'plan' && typeof params.item.text === 'string' && params.item.text.trim()) {
        planTurns.add(params.threadId + ':' + params.turnId);
        while (planTurns.size > 512) planTurns.delete(planTurns.values().next().value);
      }
      if (notification?.method === 'thread/started' && params?.thread?.id) {
        newThreads.set(params.thread.id, { thread: params.thread, origin: newThreads.get(params.thread.id)?.origin || 'native' });
        if (newThreads.size > 256) newThreads.delete(newThreads.keys().next().value);
      }
      if (['turn/started', 'turn/completed'].includes(notification?.method)) lifecycleRevision++;
      if (notification?.method === 'turn/started' && params?.threadId && params.turn?.id) {
        activeTurns.set(params.threadId, params.turn.id);
        startedTurns.set(params.threadId, params.turn.id);
        while (startedTurns.size > 512) startedTurns.delete(startedTurns.keys().next().value);
        planState.started(params.threadId, params.turn.id);
      }
      if (notification?.method === 'turn/started' && newThreads.has(params?.threadId)) {
        const candidate = newThreads.get(params.threadId); newThreads.delete(params.threadId);
        const event = { ...candidate, threadId: params.threadId, readThread: () => readThread(params.threadId, false) };
        for (const listener of newChatListeners) Promise.resolve().then(() => listener(event)).catch(error => console.warn('[Codex Tracker] New context: ' + error.message));
        options.onNewChat?.(event);
      }
      if (notification?.method !== 'turn/completed' || !params?.threadId || !params.turn?.id) return;
      activeTurns.delete(params.threadId);
      const planKey = params.threadId + ':' + params.turn.id;
      const planReady = params.turn.status === 'completed' && !params.turn.error &&
        (planTurns.has(planKey) || params.turn.items?.some(item => item.type === 'plan' && typeof item.text === 'string' && item.text.trim()));
      planTurns.delete(planKey);
      if (params.turn.status !== 'completed') planState.resolved(params.threadId, params.turn.id);
      const event = { threadId: params.threadId, turn: params.turn, planReady: Boolean(planReady),
        readThread: async () => {
          if (params.turn.status === 'completed') await new Promise(resolve => setTimeout(resolve, 250));
          const thread = await readThread(params.threadId, false);
          let goalActive = false;
          try { goalActive = (await request('thread/goal/get', { threadId: params.threadId }))?.goal?.status === 'active'; }
          catch (error) { if (!unsupported(error)) throw error; }
          return { ...thread, goalActive };
        } };
      for (const listener of lifecycleListeners) Promise.resolve().then(() => listener(event)).catch(error => console.warn('[Codex Tracker] Completion: ' + error.message));
      options.onTurnCompleted?.(event);
    },
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
      for (const [threadId, turnId] of activeTurns) {
        const event = { threadId, turn: { id: turnId, status: 'failed', error: { message: error?.message || 'Codex disconnected' } } };
        for (const listener of lifecycleListeners) Promise.resolve().then(() => listener(event)).catch(() => {});
        options.onTurnCompleted?.(event);
      }
      activeTurns.clear();
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
  const wait = delayMs => new Promise(resolve => setTimeout(resolve, Math.max(0, Number(delayMs) || 0)));
  async function readThread(threadId, includeTurns = true) {
    const result = await request('thread/read', { threadId, includeTurns });
    if (result?.thread?.id !== threadId) throw failure('App-server returned a different chat while tracking compaction.', 'unknown');
    return result.thread;
  }
  async function waitForTurnSettled(threadId, expectedTurnId, options = {}) {
    const deadline = Date.now() + Math.max(1000, Number(options.timeoutMs) || 120000);
    while (Date.now() < deadline) {
      const thread = await readThread(threadId, true);
      const turn = (thread.turns || []).find(item => item.id === expectedTurnId);
      if (turn && ['completed', 'interrupted', 'failed'].includes(turn.status)) return turn;
      if (thread.status?.type !== 'active' && !turn) return null;
      await wait(250);
    }
    throw failure('Timed out waiting for the active turn to stop before compaction.', 'unknown', 'ETIMEDOUT');
  }
  async function waitForCompaction(threadId, options = {}) {
    const deadline = Date.now() + Math.max(1000, Number(options.timeoutMs) || 120000);
    const ignoredTurnIds = new Set(Array.isArray(options.ignoreTurnIds) ? options.ignoreTurnIds.map(String) : []);
    while (Date.now() < deadline) {
      const thread = await readThread(threadId, true);
      const turns = Array.isArray(thread.turns) ? thread.turns : [];
      const candidates = turns.filter(turn => !ignoredTurnIds.has(String(turn.id)) && Array.isArray(turn.items) && turn.items.some(item => item?.type === 'contextCompaction'));
      const latest = candidates.at(-1);
      if (latest) {
        if (latest.status === 'completed') return { threadId, turnId: latest.id, status: latest.status };
        if (latest.status === 'failed' || latest.status === 'interrupted') {
          const detail = latest.error?.message || latest.error || `Compaction ${latest.status}.`;
          throw failure(String(detail), 'rejected', 'COMPACTION_' + String(latest.status).toUpperCase());
        }
      }
      await wait(250);
    }
    throw failure('Timed out waiting for Codex compaction to finish.', 'unknown', 'ETIMEDOUT');
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
  async function interrupt(params) {
    const threadId = params.conversationId || params.threadId;
    if (!threadId) throw failure('Invalid interrupt input.', 'not_sent');
    const turnId = params.turnId || await activeTurn(threadId);
    const result = await request('turn/interrupt', { threadId, turnId }, true);
    return { ...(result || {}), turnId, transport: 'codex-existing-app-server', ownerPid: connection.proc?.pid };
  }
  async function compact(params) {
    const threadId = params.conversationId || params.threadId;
    if (!threadId) throw failure('Invalid compact input.', 'not_sent');
    const result = await request('thread/compact/start', { threadId }, true);
    return { ...(result || {}), threadId, transport: 'codex-existing-app-server', ownerPid: connection.proc?.pid };
  }
  async function compactAndWait(params) {
    const threadId = params.conversationId || params.threadId;
    if (!threadId) throw failure('Invalid compact input.', 'not_sent');
    if (params.expectedPreviousTurnId) {
      const status = await readRecoveryState(threadId);
      if (status.active || status.waiting || status.status !== 'failed' || status.turnId !== params.expectedPreviousTurnId) throw failure('Lượt chat đã đổi; không compact tự động.', 'not_sent');
    }
    const before = await readThread(threadId, true);
    const existingCompactions = (before.turns || [])
      .filter(turn => Array.isArray(turn.items) && turn.items.some(item => item?.type === 'contextCompaction'))
    const running = existingCompactions.find(turn => turn.status === 'inProgress');
    if (running) return waitForCompaction(threadId, params);
    const ignoreTurnIds = existingCompactions.map(turn => turn.id);
    const accepted = await compact(params);
    const completed = await waitForCompaction(threadId, { ...params, ignoreTurnIds });
    return { ...accepted, ...completed };
  }
  async function compactAndResume(params) {
    const threadId = params.conversationId || params.threadId;
    const turnId = params.turnId || await activeTurn(threadId);
    const interrupted = await interrupt({ conversationId: threadId, turnId });
    const stopped = await waitForTurnSettled(threadId, turnId, params);
    const compacted = await compactAndWait(params);
    const resumed = await continueConversation({
      conversationId: threadId,
      input: [{ type: 'text', text: String(params.resumeMessage || 'Tiếp tục tác vụ đang làm dở sau khi compact context.'), text_elements: [] }]
    });
    return { ...resumed, interrupted, stopped, compacted, transport: 'codex-existing-app-server', ownerPid: connection.proc?.pid };
  }
  function unsupported(error) {
    return error.code === -32601 || /unknown (?:variant|method)|method not found|unsupported method/i.test(error.message);
  }
  async function readGoal(threadId) {
    return (await request('thread/goal/get', { threadId }))?.goal || null;
  }
  async function handoffModes(threadId) {
    const [goal, plan] = await Promise.allSettled([
      readGoal(threadId), request('collaborationMode/list', {})
    ]);
    const planAvailable = plan.status === 'fulfilled' && Array.isArray(plan.value?.data) && plan.value.data.some(mode => mode.mode === 'plan');
    return { sourceGoal: goal.status === 'fulfilled' ? goal.value : null,
      modes: { normal: { available: true },
        goal: { available: goal.status === 'fulfilled', reason: goal.status === 'rejected' ? goal.reason.message : '' },
        plan: { available: planAvailable, reason: plan.status === 'rejected' ? plan.reason.message : planAvailable ? '' : 'Codex chưa cung cấp chế độ Plan.' } } };
  }
  async function readHandoffState(threadId) {
    if (!await isLoaded(threadId)) throw failure('Mở chat gốc trong Codex ở cửa sổ này trước khi chuyển.', 'not_sent');
    const source = await readThread(threadId, false);
    const last = await latestTurn(threadId);
    const running = source.status?.type === 'active' && last?.status === 'inProgress';
    const stopped = ['idle', 'systemError'].includes(source.status?.type) && ['completed', 'interrupted', 'failed'].includes(last?.status);
    if (!last?.id || (!running && !stopped)) throw failure('Chưa xác nhận được trạng thái chat gốc; hãy thử lại sau.', 'not_sent');
    return { turnId: last.id, running, model: source.model, reasoning: source.reasoningEffort };
  }
  async function stopForHandoff(params) {
    const threadId = params.threadId;
    // Never resume an unloaded chat just to stop it, or stop a later turn.
    const current = params.manual === true || params.trigger === 'auto_compact' ? await readHandoffState(threadId) : { turnId: await activeTurn(threadId), running: true };
    const turnId = current.turnId;
    if (turnId !== params.turnId) throw failure('Chat đã sang lượt khác; không chuyển tiếp lượt cũ.', 'not_sent');
    let pauseError, sourceGoal = null, pausedGoal;
    try {
      const { goal } = await request('thread/goal/get', { threadId });
      sourceGoal = goal;
      if (params.successorMode === 'goal' && !params.manual && goal?.status !== 'active') throw failure('Goal đã dừng hoặc đã kết thúc; hủy chuyển tiếp.', 'not_sent');
      if (goal?.status === 'active') {
        const paused = await request('thread/goal/set', { threadId, status: 'paused' }, true);
        if (paused?.goal?.status !== 'paused') throw failure('Chưa xác nhận goal đã dừng.', 'unknown');
        pausedGoal = paused.goal;
      }
      else if (goal) pausedGoal = goal;
    } catch (error) {
      if (params.successorMode === 'goal' && !params.manual && error.delivery === 'not_sent') throw error;
      if (!unsupported(error) || params.successorMode === 'goal') pauseError = error;
    }
    // Stop the turn even if pausing its goal failed; then fail closed before
    // creating a successor. Never spend quota in two conversations at once.
    if (current.running) await interrupt({ threadId, turnId });
    if (pauseError) throw pauseError;
    const deadline = Date.now() + Math.max(1000, Number(params.timeoutMs) || 30000);
    let source;
    do {
      source = await readThread(threadId, false);
      const last = await latestTurn(threadId);
      if (last?.id !== turnId) throw failure('Chat cũ đã chạy lượt khác sau khi dừng; hủy chuyển tiếp.', 'unknown');
      if (source.status?.type !== 'active' && ['completed', 'interrupted', 'failed'].includes(last.status)) break;
      if (Date.now() >= deadline) throw failure('Chưa xác nhận chat cũ đã dừng hẳn.', 'unknown', 'ETIMEDOUT');
      await wait(100);
    } while (true);
    // Each descendant is resolved from this root's session tree by Tracker.
    for (const child of params.children || []) {
      if (child.threadId === threadId) continue;
      const current = await readThread(child.threadId, false);
      const latest = await latestTurn(child.threadId);
      if (current.status?.type !== 'active' && ['completed', 'interrupted', 'failed'].includes(latest?.status)) continue;
      await stopForHandoff({ ...child, children: [] });
    }
    const settings = await readThreadSettings(source.path || params.file, threadId);
    return { ...source, sourceGoal, pausedGoal, serviceTier: speedFromSettings(settings), permissionSettings: permissionSettings(settings) };
  }
  const renameThread = (threadId, name) => request('thread/name/set', { threadId, name }, true);
  async function readChatTitle(threadId, fallback = '') {
    const thread = await readThread(threadId, false);
    return thread.name || fallback || thread.preview || 'Hội thoại';
  }
  async function confirmHandoffStopped(params) {
    const source = await readThread(params.threadId, false);
    const last = await latestTurn(params.threadId);
    if (source.status?.type === 'active' || last?.id !== params.turnId || !['completed', 'interrupted', 'failed'].includes(last?.status)) {
      throw failure('Chat cũ đã chạy lại trong thời gian chờ; hủy mở chat mới.', 'not_sent');
    }
    if (params.expectedGoal) {
      const goal = await readGoal(params.threadId);
      if (goal?.status !== (params.expectedGoal.status || 'paused') || goal.objective !== params.expectedGoal.objective ||
          (params.expectedGoal.createdAt != null && goal.createdAt !== params.expectedGoal.createdAt)) {
        throw failure('Goal cũ đã thay đổi trong thời gian chờ; hủy mở Goal mới.', 'not_sent');
      }
    }
    const settings = await readThreadSettings(source.path || params.file, params.threadId);
    return { ...source, serviceTier: speedFromSettings(settings), permissionSettings: permissionSettings(settings) };
  }
  async function clearHandoffGoal(params) {
    if (!params.expectedGoal) throw failure('Thiếu bản xác nhận Goal cũ; không xoá.', 'not_sent');
    await confirmHandoffStopped(params);
    await request('thread/goal/clear', { threadId: params.threadId }, true);
    if (await readGoal(params.threadId)) throw failure('Chưa xác nhận Goal cũ đã được xoá; không chạy chat mới.', 'unknown');
    return { cleared: true };
  }
  async function createSuccessor(params) {
    if (!params.permissionSettings?.start) throw failure('Thiếu quyền kế thừa của chat gốc.', 'not_sent');
    if (!params.cwd) throw failure('Thiếu workspace của chat gốc.', 'not_sent');
    await verifySpeed(params.model, params.serviceTier);
    const sourceAllow = params.sourceThreadId && autoAllowStore?.get(params.sourceThreadId);
    const result = await request('thread/start', {
      cwd: params.cwd, ...(params.model ? { model: params.model } : {}), ephemeral: false,
      ...(params.serviceTier !== undefined ? { serviceTier: normalizeSpeed(params.serviceTier) } : {}),
      ...(params.contextConfig ? { config: validateContextConfig(params.contextConfig) } : {}),
      ...(sourceAllow?.enabled ? FULL_ACCESS : params.permissionSettings.start)
    }, true);
    if (!result?.thread?.id) throw failure('Chưa xác nhận chat kế tiếp đã được tạo.', 'unknown');
    newThreads.set(result.thread.id, { thread: result.thread, origin: 'successor' });
    if (sourceAllow?.enabled) {
      try { await autoAllowStore.remember(result.thread.id, sourceAllow); }
      catch (error) { throw Object.assign(error, { createdThread: result.thread }); }
    }
    if (params.contextConfig) {
      try { await contextStore?.remember(result.thread.id, params.contextConfig); }
      catch (error) { throw Object.assign(error, { createdThread: result.thread }); }
    }
    return result.thread;
  }
  async function readCreationConfig(cwd) {
    const { config } = await request('config/read', { cwd, includeLayers: false });
    return { model: config?.model || '', catalogFile: config?.model_catalog_json || '', serviceTier: speedFromSettings(config) || 'default' };
  }
  async function listModels() {
    const models = new Map(), seen = new Set();
    let cursor;
    do {
      const page = await request('model/list', { includeHidden: false, limit: 100, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(page?.data)) throw failure('Không đọc được danh sách model.', 'not_sent');
      for (const item of page.data) {
        const id = item.model || item.id;
        if (typeof id === 'string' && id && item.hidden !== true) {
          models.set(id, { id, label: item.displayName || id, isDefault: item.isDefault === true,
            ...(Array.isArray(item.serviceTiers) ? { serviceTiers: item.serviceTiers } : {}),
            ...(Array.isArray(item.additionalSpeedTiers) ? { additionalSpeedTiers: item.additionalSpeedTiers } : {}) });
        }
      }
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw failure('Danh sách model bị lặp trang.', 'not_sent');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return [...models.values()];
  }
  async function verifySpeed(model, value) {
    if (value === undefined || normalizeSpeed(value) === 'default') return;
    requireSpeed(value, (await listModels()).find(item => item.id === model));
  }
  async function resolveSuccessorSpeed(params) {
    if (normalizeSpeed(params.serviceTier) === 'default') return { serviceTier: 'default' };
    const model = (await listModels()).find(item => item.id === params.model);
    if (!model) throw failure('Không tìm thấy model chat gốc trong catalog Codex.', 'not_sent');
    return automaticSpeed(params.serviceTier, model);
  }
  async function createFreshChat(params) {
    const images = normalizeImageAttachments(params.images);
    if (!params.cwd || !params.model) throw failure('Thiếu workspace hoặc model cho chat mới.', 'not_sent');
    const config = validateContextConfig(params.contextConfig);
    if (!config) throw failure('Thiếu cấu hình context cho chat mới.', 'not_sent');
    await verifySpeed(params.model, params.serviceTier);
    // Tracker-created independent chats start with the user's requested full
    // access. This does not modify Codex config or permissions of other chats.
    const speed = params.serviceTier !== undefined ? { serviceTier: normalizeSpeed(params.serviceTier) } : {};
    const result = await request('thread/start', { cwd: params.cwd, model: params.model, config, ephemeral: false, ...speed, ...FULL_ACCESS }, true);
    if (!result?.thread?.id) throw failure('Chưa xác nhận chat mới đã được tạo. Kiểm tra danh sách chat trước khi thử lại.', 'unknown');
    newThreads.set(result.thread.id, { thread: result.thread, origin: 'tracker' });
    try {
      await contextStore?.remember(result.thread.id, config);
      await autoAllowStore?.remember(result.thread.id, { enabled: true, previous: ASK_WORKSPACE });
      if (params.message?.trim() || images.length) {
        const started = await request('turn/start', { threadId: result.thread.id, ...speed, ...FULL_ACCESS,
          input: [...(params.message?.trim()?[{ type: 'text', text: params.message.trim(), text_elements: [] }]:[]),...images.map(image=>({type:'image',url:image.dataUrl}))], clientUserMessageId: randomUUID() }, true);
        if (!started?.turn?.id) throw failure('Chưa xác nhận yêu cầu đầu tiên đã gửi. Kiểm tra chat trước khi gửi lại.', 'unknown');
      }
    } catch (error) { throw Object.assign(error, { createdThread: result.thread }); }
    return result.thread;
  }
  async function setAutoAllow(params) {
    const threadId = params.threadId;
    if (typeof params.enabled !== 'boolean' || !autoAllowStore) throw failure('Không lưu được Auto Allow cho chat.', 'not_sent');
    if (permissionChanges.has(threadId)) throw failure('Đang đổi quyền chat; chờ hoàn tất.', 'not_sent');
    permissionChanges.add(threadId);
    try {
      const previousRecord = autoAllowStore.get(threadId);
      if (previousRecord?.enabled === params.enabled) return { enabled: params.enabled };
      const source = await readThread(threadId, false);
      const current = permissionSettings(await readThreadSettings(source.path || params.file, threadId));
      const previous = previousRecord?.previous || current;
      const next = params.enabled ? FULL_ACCESS : previousRecord?.previous?.turn || current.turn;
      const loaded = await isLoaded(threadId);
      if (loaded) await request('thread/settings/update', { threadId, ...next }, true);
      try { await autoAllowStore.remember(threadId, { enabled: params.enabled, previous }); }
      catch (error) {
        if (loaded) {
          try { await request('thread/settings/update', { threadId, ...(previousRecord?.enabled ? FULL_ACCESS : current.turn) }, true); }
          catch (rollback) { error.message += ' Không khôi phục được quyền native: ' + rollback.message; }
        }
        throw error;
      }
      return { enabled: params.enabled, loaded };
    } finally { permissionChanges.delete(threadId); }
  }
  async function startSuccessor(params) {
    const images = normalizeImageAttachments(params.images);
    const mode = normalizeHandoffMode(params.successorMode);
    if (mode !== 'normal' && !params.model) throw failure('Thiếu model cho chế độ chat mới.', 'not_sent');
    const objective = mode === 'goal' ? validateGoalText(params.goalText) : undefined;
    await verifySpeed(params.model, params.serviceTier);
    const speed = params.serviceTier !== undefined ? { serviceTier: normalizeSpeed(params.serviceTier) } : {};
    if (!params.permissionSettings?.turn) throw failure('Thiếu quyền kế thừa của chat gốc.', 'not_sent');
    const turnPermissions = autoAllowStore?.get(params.threadId)?.enabled ? FULL_ACCESS : params.permissionSettings.turn;
    const thread = await readThread(params.threadId, false);
    if (thread.status?.type === 'active') throw failure('Chat kế tiếp đã chạy; không gửi trùng.', 'not_sent');
    const collaborationMode = mode === 'normal' ? undefined : { mode: mode === 'plan' ? 'plan' : 'default',
      settings: { model: params.model, reasoning_effort: params.effort || null, developer_instructions: null } };
    if (mode === 'goal') {
      await params.onProgress?.('configuring');
      await request('thread/settings/update', { threadId: params.threadId, model: params.model,
        ...(params.effort ? { effort: params.effort } : {}), collaborationMode, ...turnPermissions, ...speed }, true);
      await params.onProgress?.('injecting');
      await request('thread/inject_items', { threadId: params.threadId, items: [{ type: 'message', role: 'user',
        content: [{ type: 'input_text', text: goalContext(params.message) },...images.map(image=>({type:'input_image',image_url:image.dataUrl}))] }] }, true);
      // Native Goal activation starts generation itself. Never send turn/start.
      const before = startedTurns.get(params.threadId);
      if (params.beforeStart) {
        await params.onProgress?.('preparing_goal');
        await request('thread/goal/set', { threadId: params.threadId, objective, status: 'paused' }, true);
        const savedGoal = await readGoal(params.threadId);
        if (savedGoal?.objective !== objective || savedGoal.status !== 'paused' || savedGoal.tokenBudget != null) {
          throw failure('Chưa lưu được Goal mới; giữ Goal cũ và không khởi chạy.', 'unknown');
        }
        await params.beforeStart();
      }
      await params.onProgress?.('activating');
      const result = await request('thread/goal/set', { threadId: params.threadId,
        ...(params.beforeStart ? {} : { objective }), status: 'active' }, true);
      if (result?.goal?.objective !== objective || result.goal.status !== 'active' || result.goal.tokenBudget != null) {
        throw failure('Chưa xác nhận Goal mới đúng mục tiêu và không giới hạn budget.', 'unknown');
      }
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const turnId = startedTurns.get(params.threadId);
        if (turnId && turnId !== before) return { turnId, goal: result.goal };
        await wait(50);
      }
      throw failure('Goal đã được đặt nhưng chưa xác nhận lượt khởi chạy; kiểm tra chat mới.', 'unknown');
    }
    await params.beforeStart?.();
    const result = await request('turn/start', {
      threadId: params.threadId,
      input: [{ type: 'text', text: params.message, text_elements: [] },...images.map(image=>({type:'image',url:image.dataUrl}))],
      clientUserMessageId: params.clientUserMessageId,
      ...(params.effort ? { effort: params.effort } : {}),
      ...(collaborationMode ? { collaborationMode } : {}),
      ...speed,
      ...turnPermissions
    }, true);
    if (!result?.turn?.id) throw failure('Chưa xác nhận tin tiếp tục đã được gửi.', 'unknown');
    return { turnId: result.turn.id };
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
    if (params.expectedPreviousTurnId && previousTurnId !== params.expectedPreviousTurnId) {
      throw failure('Chat đã chuyển sang lượt khác; không gửi tự động vào lượt mới.', 'not_sent');
    }
    await onReady();
    if(params.model && !(await listModels()).some(m=>m.id===params.model))throw failure('Model đã chọn không khả dụng.', 'not_sent');
    const result = await request('turn/start', {
      threadId, input: params.input, clientUserMessageId: params.clientUserMessageId, ...(params.model?{model:params.model}:{})
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
    autoAllow.dispose();
    compactions.dispose();
    removeContextHook();
  }
  const readAccount = () => request('account/read', { refreshToken: false });
  const readRateLimits = () => request('account/rateLimits/read', {});
  async function readRecoveryState(threadId) {
    const thread = await readThread(threadId, false);
    const turn = await latestTurn(threadId);
    let goal;
    try { goal = await readGoal(threadId); } catch (error) { if (!unsupported(error)) throw error; }
    return { threadId, turnId: turn?.id || '', status: turn?.status || 'unknown',
      active: thread.status?.type === 'active' || turn?.status === 'inProgress',
      goalPaused: goal?.status === 'paused',
      waiting: (thread.status?.activeFlags || []).some(flag => /waiting|approval/i.test(flag)) };
  }
  async function readAttentionThreads() {
    const ids = new Set(), cursors = new Set();
    let cursor;
    do {
      const page = await request('thread/loaded/list', { limit: 100, ...(cursor ? { cursor } : {}) });
      for (const id of page.data || []) ids.add(id);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw failure('Repeated loaded-thread cursor.', 'not_sent');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    const revision = lifecycleRevision;
    const threads = await Promise.all([...ids].map(id => readThread(id, false)));
    // Seed turns already running when Tracker attaches, for runtime-crash alerts.
    for (const thread of threads) if (thread.status?.type === 'active' && !activeTurns.has(thread.id)) {
      try {
        const turn = await latestTurn(thread.id);
        if (revision === lifecycleRevision && turn?.status === 'inProgress') activeTurns.set(thread.id, turn.id);
      } catch { /* Waiting-state polling can still proceed if paging is unavailable. */ }
    }
    return threads;
  }
  return { available, isLoaded, activeTurn, steer, interrupt, compact, compactAndWait, compactAndResume, readRecoveryState, readGoal, handoffModes, readHandoffState, setAutoAllow, stopForHandoff, confirmHandoffStopped, clearHandoffGoal, renameThread, readChatTitle, createSuccessor, startSuccessor, readCreationConfig, listModels, resolveSuccessorSpeed, createFreshChat, continueConversation, readAccount, readRateLimits, readAttentionThreads, dispose };
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
    if (client[BRIDGE_KEY]?.revision === 25) {
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
    client[BRIDGE_KEY] = { revision: 25, info, available: backend.available, readRecoveryState: backend.readRecoveryState, readAttentionThreads: backend.readAttentionThreads, readAccount: backend.readAccount, readRateLimits: backend.readRateLimits, interrupt: backend.interrupt, compact: backend.compact, compactAndWait: backend.compactAndWait, compactAndResume: backend.compactAndResume,
      handoffBackend: {
        readGoal: backend.readGoal, handoffModes: backend.handoffModes,
        listModels: backend.listModels, resolveSuccessorSpeed: backend.resolveSuccessorSpeed,
        readHandoffState: backend.readHandoffState, setAutoAllow: backend.setAutoAllow,
        readCreationConfig: backend.readCreationConfig,
        stopForHandoff: backend.stopForHandoff, confirmHandoffStopped: backend.confirmHandoffStopped, clearHandoffGoal: backend.clearHandoffGoal, renameThread: backend.renameThread, readChatTitle: backend.readChatTitle,
        async createSuccessor(params) {
          const next = await backend.createSuccessor(params);
          stream.setThreadOwnership?.({ hostId: 'local', conversationId: next.id, ownsThread: true });
          return next;
        }, startSuccessor: backend.startSuccessor
      }, newChatBackend: {
        readCreationConfig: backend.readCreationConfig,
        listModels: backend.listModels, resolveSuccessorSpeed: backend.resolveSuccessorSpeed,
        async createFreshChat(params) {
          const next = await backend.createFreshChat(params);
          stream.setThreadOwnership?.({ hostId: 'local', conversationId: next.id, ownsThread: true });
          return next;
        }
      }, ownsThread: id => stream.ownsThread('local', id), continueConversation: continueHere, dispose() {
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
async function readAccountInLocalBackend() {
  const candidates = [...installedBridges].filter(bridge => bridge.available());
  const unique = new Map(candidates.map(bridge => [bridge.info.ownerPid, bridge]));
  if (unique.size !== 1) throw new Error('Không xác định được phiên Codex đang chạy trong cửa sổ này.');
  return unique.values().next().value.readAccount();
}
async function readRateLimitsInLocalBackend() {
  const candidates = [...installedBridges].filter(bridge => bridge.available());
  const unique = new Map(candidates.map(bridge => [bridge.info.ownerPid, bridge]));
  if (unique.size !== 1) throw new Error('Chưa kết nối được Codex trong cửa sổ này.');
  return unique.values().next().value.readRateLimits();
}
async function interruptInLocalBackend(params) {
  const candidates = [...installedBridges].filter(bridge => bridge.available() && typeof bridge.interrupt === 'function');
  const owned = candidates.filter(bridge => bridge.ownsThread(params.conversationId || params.threadId));
  const choices = owned.length ? owned : candidates;
  if (choices.length !== 1) {
    const error = new Error('Chưa có kết nối Codex local duy nhất để dừng lượt chat.');
    error.delivery = 'not_sent';
    throw error;
  }
  return choices[0].interrupt(params);
}
async function compactAndResumeInLocalBackend(params) {
  const candidates = [...installedBridges].filter(bridge => bridge.available() && typeof bridge.compactAndResume === 'function');
  const owned = candidates.filter(bridge => bridge.ownsThread(params.conversationId || params.threadId));
  const choices = owned.length ? owned : candidates;
  if (choices.length !== 1) {
    const error = new Error('Chưa có kết nối Codex local duy nhất để compact và tiếp tục chat.');
    error.delivery = 'not_sent';
    throw error;
  }
  return choices[0].compactAndResume(params);
}
async function compactInLocalBackend(params) {
  const candidates = [...installedBridges].filter(bridge => bridge.available() && typeof (bridge.compactAndWait || bridge.compact) === 'function');
  const owned = candidates.filter(bridge => bridge.ownsThread(params.conversationId || params.threadId));
  const choices = owned.length ? owned : candidates;
  if (choices.length !== 1) {
    const error = new Error('Chưa có kết nối Codex local duy nhất để compact context.');
    error.delivery = 'not_sent';
    throw error;
  }
  return typeof choices[0].compactAndWait === 'function' ? choices[0].compactAndWait(params) : choices[0].compact(params);
}
function newChatBackend() {
  const unique = new Map([...installedBridges].filter(b => b.available() && b.newChatBackend).map(b => [b.info.ownerPid, b]));
  if (unique.size !== 1) throw new Error('Mở Codex trong cửa sổ này để tạo chat mới.');
  return unique.values().next().value.newChatBackend;
}
function contextHandoffBackend(threadId) {
  const owned = [...installedBridges].filter(b => b.available() && b.ownsThread(threadId) && b.handoffBackend);
  const unique = new Map(owned.map(b => [b.info.ownerPid, b]));
  if (unique.size !== 1) throw Object.assign(new Error('Chat được theo dõi phải thuộc kết nối Codex trong cửa sổ này.'), { delivery: 'not_sent' });
  return unique.values().next().value.handoffBackend;
}
function chatPermissionsBackend(threadId) {
  const candidates = [...installedBridges].filter(b => b.available() && b.handoffBackend?.setAutoAllow);
  const owned = candidates.filter(b => b.ownsThread(threadId));
  const unique = new Map((owned.length ? owned : candidates).map(b => [b.info.ownerPid, b]));
  if (unique.size !== 1) throw new Error('Mở Codex trong cửa sổ này để đổi quyền chat.');
  return unique.values().next().value.handoffBackend;
}
async function readAttentionInLocalBackend() {
  const unique = new Map([...installedBridges].filter(b => b.available()).map(b => [b.info.ownerPid, b]));
  return (await Promise.all([...unique.values()].map(b => b.readAttentionThreads()))).flat();
}
async function readRecoveryInLocalBackend(threadId) {
  const candidates = [...installedBridges].filter(b => b.available() && b.readRecoveryState);
  const owned = candidates.filter(b => b.ownsThread(threadId));
  const unique = new Map((owned.length ? owned : candidates).map(b => [b.info.ownerPid, b]));
  if (unique.size !== 1) throw new Error('Chưa xác định được kết nối Codex để kiểm tra lượt lỗi.');
  return unique.values().next().value.readRecoveryState(threadId);
}
module.exports = { readRecoveryInLocalBackend, subscribeGoalUpdates, subscribeNewChats, subscribeTurnLifecycle, createLiveBackend, installOwnerBridge, installedBridgeInfo, disposeOwnerBridges, continueInLocalBackend, readAccountInLocalBackend, readRateLimitsInLocalBackend, interruptInLocalBackend, compactInLocalBackend, compactAndResumeInLocalBackend, contextHandoffBackend, chatPermissionsBackend, newChatBackend, readAttentionInLocalBackend, BRIDGE_KEY };
