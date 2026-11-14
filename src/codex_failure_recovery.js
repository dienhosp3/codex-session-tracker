'use strict';

const { randomUUID } = require('node:crypto');
const { createStateStore } = require('./codex_state_store');
const { classifyFailure, LABELS, GUIDANCE } = require('./codex_failures');
const BACKOFF = [5000, 15000, 45000];
const TRANSIENT = new Set(['stream', 'offline', 'dns', 'proxy', 'upstream', 'capacity']);

function createFailureRecovery(options) {
  const now = options.now || Date.now;
  const store = options.store || createStateStore(options.file, { schemaVersion: 1, autoResume: false, entries: {} });
  let cache = { autoResume: false, entries: {} }, disposed = false, ticking = false;
  const pending = new Set();
  function publish(state) { cache = state; if (!disposed) options.onChange?.(); }
  async function update(fn) {
    const outcome = await store.transaction(state => {
      state.entries ||= {}; state.schemaVersion = 1;
      const result = fn(state);
      return { result, state: structuredClone(state) };
    });
    publish(outcome.state); return outcome.result;
  }
  const ready = store.read().then(publish).catch(error => options.onError?.(error));
  function snapshot() {
    const state = structuredClone(cache);
    for (const entry of Object.values(state.entries || {})) {
      entry.busy = pending.has(entry.threadId);
      if (entry.action?.status === 'pending' && !entry.busy) {
        entry.phase = 'unknown'; entry.notice = 'Thao tác trước chưa có xác nhận. Kiểm tra trạng thái chat; không tự gửi lại.';
      }
    }
    return state;
  }
  async function observe(event) {
    if (disposed || !event?.threadId || !event.turnId || !event.error) return;
    const occurredAt = typeof event.occurredAt === 'number' ? event.occurredAt : Date.parse(event.occurredAt || '') || now();
    const diagnosis = classifyFailure(event.error);
    // Frequent selection refreshes must not persist or schedule the same error again.
    if (cache.entries?.[event.threadId]?.turnId === event.turnId) return;
    await update(state => {
      const previous = state.entries[event.threadId];
      if (previous?.turnId === event.turnId || previous?.occurredAt > occurredAt) return;
      const pendingAction = previous?.action?.status === 'pending' ? previous.action : null;
      const continuing = previous?.lastStartedTurnId === event.turnId || Boolean(pendingAction);
      state.entries[event.threadId] = { threadId: event.threadId, turnId: event.turnId, occurredAt,
        originAt: continuing ? previous.originAt : occurredAt, attempts: continuing ? previous.attempts : 0,
        ...diagnosis, failureCategory: diagnosis.category, phase: 'detected', notice: '', nextAttemptAt: now() + BACKOFF[0],
        historical: Boolean(event.historical), onlineStreak: 0, ...(pendingAction ? { action: pendingAction } : {}) };
      const keys = Object.keys(state.entries).sort((a, b) => state.entries[b].occurredAt - state.entries[a].occurredAt);
      for (const key of keys.slice(50)) delete state.entries[key];
    });
  }
  async function settle(event) {
    if (event?.turn?.status !== 'completed') return;
    const entry = cache.entries?.[event.threadId];
    if (!entry || (!['pending'].includes(entry.action?.status) && ![entry.turnId, entry.lastStartedTurnId].includes(event.turn.id))) return;
    await update(state => {
      const current = state.entries[event.threadId];
      if (current?.action?.status === 'pending') current.completedTurnId = event.turn.id;
      else if (current && [current.turnId, current.lastStartedTurnId].includes(event.turn.id)) { current.phase = 'resolved'; current.notice = 'Lượt chat đã hoàn thành.'; }
    });
  }
  async function diagnose(threadId, turnId) {
    await ready;
    if (disposed || pending.has(threadId)) return;
    const entry = (await store.read()).entries?.[threadId];
    if (!entry || entry.turnId !== turnId || ['dismissed', 'resolved'].includes(entry.phase)) return;
    pending.add(threadId); options.onChange?.();
    try {
      const result = await options.diagnose(entry);
      let reconciled = false;
      if (['pending', 'unknown'].includes(entry.action?.status)) {
        try { const live = await options.readStatus(threadId); reconciled = live.turnId !== turnId || live.status === 'completed'; }
        catch { /* A missing ACK remains unknown until native state is readable. */ }
      }
      await update(state => {
        const current = state.entries[threadId];
        if (!current || current.turnId !== turnId || ['dismissed', 'resolved'].includes(current.phase)) return;
        if (result.failure && current.failureCategory === 'stream') Object.assign(current, result.failure, { failureCategory: result.failure.category });
        current.connection = result.connection;
        current.onlineStreak = result.connection?.online ? (current.onlineStreak || 0) + 1 : 0;
        current.failedChecks = result.connection?.online ? 0 : (current.failedChecks || 0) + 1;
        if (['stream', 'offline', 'dns'].includes(current.failureCategory) && result.connection?.category) {
          current.category = result.connection.category; current.label = LABELS[current.category]; current.guidance = GUIDANCE[current.category];
        }
        if (reconciled) { current.phase = 'resolved'; current.notice = 'Chat đã có lượt mới hoặc đã hoàn thành; không gửi lại.'; }
        else if (!['pending', 'unknown'].includes(current.action?.status) && !['unknown', 'awaiting_result'].includes(current.phase)) current.phase = result.connection?.online ? 'ready' : 'waiting_network';
        current.nextAttemptAt = now() + BACKOFF[Math.min(Math.max(current.attempts, current.failedChecks), 2)];
      });
    } catch (error) {
      await update(state => { const e = state.entries[threadId]; if (e?.turnId === turnId) { e.notice = 'Chưa chẩn đoán được: ' + error.message; e.nextAttemptAt = now() + 15000; } });
    } finally { pending.delete(threadId); options.onChange?.(); }
  }
  async function act(threadId, turnId, kind = 'retry', automatic = false) {
    await ready;
    if (disposed || pending.has(threadId) || !['retry', 'compact', 'restart'].includes(kind)) return;
    pending.add(threadId); options.onChange?.();
    let reservation;
    try {
      const state = await store.read(), entry = state.entries?.[threadId];
      if (!entry || entry.turnId !== turnId || ['pending', 'unknown'].includes(entry.action?.status) || ['unknown', 'dismissed', 'resolved', 'awaiting_result'].includes(entry.phase)) return;
      if (automatic && (!state.autoResume || entry.historical || entry.attempts >= 3 || now() - entry.originAt > 600000 ||
          !TRANSIENT.has(entry.category) || ['proxy', 'capacity'].includes(entry.category) || entry.onlineStreak < 2)) return;
      if (kind === 'retry' && ['context', 'auth', 'quota'].includes(entry.category)) throw new Error(entry.guidance);
      if (kind === 'compact' && entry.category !== 'context') throw new Error('Chỉ compact từ nhánh lỗi context.');
      if (kind === 'restart' && entry.category !== 'proxy') throw new Error('Chưa xác định lỗi proxy cục bộ.');
      if (options.blocked?.(threadId)) throw new Error('Chat đang chờ duyệt, chuyển tiếp hoặc có thao tác khác.');
      const live = await options.readStatus(threadId);
      if (live.turnId !== turnId || live.status === 'completed') {
        await update(s => { const e = s.entries[threadId]; if (e?.turnId === turnId) { e.phase = 'resolved'; e.notice = 'Chat đã hoàn thành hoặc chuyển sang lượt khác; không gửi lại.'; } }); return;
      }
      if (live.goalPaused) throw new Error('Goal đang tạm dừng. Tiếp tục Goal từ Codex trước khi khôi phục tự động.');
      if (live.active || live.waiting || live.status !== 'failed') throw new Error('Lượt chưa kết thúc với lỗi; chờ Codex tự kết nối lại.');
      if (kind === 'retry') {
        const connection = await options.diagnose(entry);
        if (connection.failure && ['context', 'auth', 'quota'].includes(connection.failure.category)) {
          await update(s => { const e = s.entries[threadId]; if (e?.turnId === turnId) Object.assign(e, connection.failure, { phase: 'blocked' }); }); return;
        }
        if (!connection.connection?.online) throw new Error('Kết nối chưa sẵn sàng. Bấm Kiểm tra kết nối hoặc chờ mạng phục hồi.');
      }
      reservation = await update(s => {
        const e = s.entries[threadId];
        if (!e || e.turnId !== turnId || e.action?.status === 'pending' || ['unknown', 'dismissed', 'resolved', 'awaiting_result'].includes(e.phase) || (automatic && !s.autoResume)) return null;
        const id = randomUUID(); e.action = { id, kind, status: 'pending', at: now() }; e.phase = 'working'; e.attempts++;
        return id;
      });
      if (!reservation) return;
      if (disposed) throw Object.assign(new Error('Tracker đã dừng trước khi gửi.'), { delivery: 'not_sent' });
      let previousTurnId = turnId, result;
      if (kind === 'restart') result = await options.restart();
      else {
        if (kind === 'compact') {
          const compacted = await options.compact(threadId, turnId);
          const after = await options.readStatus(threadId);
          if (!compacted?.turnId || after.turnId !== compacted.turnId || after.active || after.status !== 'completed') {
            throw Object.assign(new Error('Chưa xác nhận compact hoàn thành; không gửi tiếp.'), { delivery: 'unknown' });
          }
          previousTurnId = compacted.turnId;
        }
        result = await options.send({ threadId, expectedPreviousTurnId: previousTurnId, clientUserMessageId: reservation,
          message: 'Tiếp tục công việc còn dang dở từ trạng thái đã lưu. Kiểm tra kết quả thao tác trước khi thực hiện lại.' });
        if (!result?.turnId || result.turnId === previousTurnId) throw Object.assign(new Error('Chưa có xác nhận lượt mới.'), { delivery: 'unknown' });
      }
      await update(s => {
        const e = s.entries[threadId]; if (e?.action?.id !== reservation) return;
        e.action.status = 'done'; e.phase = kind === 'restart' ? 'detected' : 'awaiting_result';
        e.lastStartedTurnId = result?.turnId || ''; e.onlineStreak = 0; e.nextAttemptAt = now() + 5000;
        e.notice = kind === 'restart' ? 'Đã restart proxy; kiểm tra kết nối trước khi tiếp tục.' : 'Codex đã xác nhận lượt tiếp tục.';
        if (result?.turnId && e.turnId === result.turnId) { e.phase = 'detected'; e.notice = 'Lượt tiếp tục cũng gặp lỗi; giữ giới hạn thử lại của chuỗi này.'; }
        if (result?.turnId && e.completedTurnId === result.turnId) { e.phase = 'resolved'; e.notice = 'Lượt tiếp tục đã hoàn thành.'; }
      });
    } catch (error) {
      await update(s => {
        const e = s.entries[threadId]; if (!e || (reservation ? e.action?.id !== reservation : e.turnId !== turnId)) return;
        const uncertain = reservation && !['not_sent', 'rejected'].includes(error.delivery);
        e.phase = uncertain ? 'unknown' : 'blocked';
        if (reservation) e.action.status = uncertain ? 'unknown' : 'failed';
        e.notice = String(error.message).slice(0, 600); e.nextAttemptAt = now() + BACKOFF[Math.min(e.attempts, 2)];
      });
    } finally { pending.delete(threadId); options.onChange?.(); }
  }
  async function tick() {
    await ready;
    if (disposed || ticking) return;
    ticking = true;
    try {
      publish(await store.read());
      if (!cache.autoResume) return;
      for (const entry of Object.values(cache.entries || {})) {
        if (disposed || entry.historical || entry.attempts >= 3 || now() - entry.originAt > 600000 || now() < entry.nextAttemptAt ||
            !TRANSIENT.has(entry.category) || !['detected', 'waiting_network', 'ready', 'blocked'].includes(entry.phase) || entry.action?.status === 'pending') continue;
        await diagnose(entry.threadId, entry.turnId);
        if (cache.entries[entry.threadId]?.onlineStreak >= 2) await act(entry.threadId, entry.turnId, 'retry', true);
      }
    } catch (error) { options.onError?.(error); }
    finally { ticking = false; }
  }
  return { ready, snapshot, observe, settle, diagnose, act, tick,
    setAutoResume: enabled => update(state => { state.autoResume = enabled === true; }),
    dismiss: (threadId, turnId) => update(state => { const e = state.entries[threadId]; if (e?.turnId === turnId && e.action?.status !== 'pending') e.phase = 'dismissed'; }),
    dispose() { disposed = true; }
  };
}

module.exports = { createFailureRecovery, BACKOFF };
