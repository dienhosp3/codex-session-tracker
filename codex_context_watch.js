'use strict';

const { THREAD_ID, normalizeSeries } = require('./codex_context_handoff');
const { normalizeContextPreset } = require('./codex_new_chat');
const { chatOptions, validateChatOptions } = require('./codex_chat_options');
const { normalizeHandoffMode, validateGoalText } = require('./codex_handoff_modes');
const { normalizeSpeed } = require('./codex_speed');
const DEFAULT_INTERVAL_MS = 300;
const DEFAULT_THRESHOLD = 80;
const DEFAULT_HANDOFF_DELAY_SECONDS = 10;

function validateSettings(value = {}) {
  const intervalMs = Number(value.intervalMs ?? DEFAULT_INTERVAL_MS);
  const thresholdPercent = Number(value.thresholdPercent ?? DEFAULT_THRESHOLD);
  const handoffDelaySeconds = Number(value.handoffDelaySeconds ?? DEFAULT_HANDOFF_DELAY_SECONDS);
  if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 60000) throw new Error('Chu kỳ context phải là số nguyên từ 100 đến 60000 ms.');
  if (!Number.isInteger(thresholdPercent) || thresholdPercent < 1 || thresholdPercent > 99) throw new Error('Ngưỡng context phải là số nguyên từ 1 đến 99%.');
  if (!Number.isInteger(handoffDelaySeconds) || handoffDelaySeconds < 0 || handoffDelaySeconds > 3600) throw new Error('Thời gian chờ mở chat mới phải từ 0 đến 3600 giây.');
  return { intervalMs, thresholdPercent, handoffDelaySeconds };
}

function createContextWatch(options) {
  let settings;
  try { settings = validateSettings(options.state); } catch { settings = validateSettings(); }
  let entries = Object.fromEntries(Object.entries(options.state?.entries || {}).filter(([id, e]) => THREAD_ID.test(id) && e && typeof e === 'object').map(([id, entry]) => {
    let thresholdPercent;
    try { thresholdPercent = validateSettings({ thresholdPercent: entry.thresholdPercent }).thresholdPercent; } catch { thresholdPercent = settings.thresholdPercent; }
    return [id, { ...entry, threadId: id, thresholdPercent }];
  }));
  const readings = new Map(), busy = new Set(), savingSeries = new Set(), lastPollAt = new Map();
  const now = options.now || Date.now;
  const getChatOptions = id => ({ ...chatOptions(entries[id]?.chatOptions, settings),
    thresholdPercent: entries[id]?.thresholdPercent ?? settings.thresholdPercent });
  let timer = null, polling = false, disposed = false, saving = Promise.resolve(), optionsSaving = Promise.resolve();
  let notice = '';
  const snapshot = () => ({ ...settings, entries: structuredClone(entries), readings: Object.fromEntries(readings), busy: [...busy], notice });
  const changed = () => options.onChange?.(snapshot());
  const save = () => {
    const value = { schemaVersion: 1, ...settings, entries: structuredClone(entries) };
    const next = saving.catch(() => {}).then(() => options.save(value));
    saving = next;
    return next;
  };
  const tracks = id => entries[id]?.enabled === true;
  const blocks = id => busy.has(id) || Boolean(entries[id]?.handoff);
  const attemptKey = (entry, reading) => JSON.stringify([reading.turnId, reading.model, reading.serviceTier || entry.serviceTier,
    entry.continuationMode, entry.thresholdPercent, entry.contextPreset, entry.series]);
  const schedule = () => {
    if (timer) clearInterval(timer);
    timer = null;
    if (!disposed && Object.values(entries).some(e => e.enabled)) {
      const interval = Math.min(...Object.entries(entries).filter(([, e]) => e.enabled).map(([id]) => getChatOptions(id).intervalMs));
      timer = setInterval(() => poll(false), interval);
      timer.unref?.();
    }
  };
  async function transfer(id, entry, reading, manual = false, overrides = {}) {
    if (busy.has(id) || savingSeries.has(id) || disposed || entry.handoff || (!manual && !tracks(id))) {
      if (manual) throw new Error('Chat đang lưu hoặc đã chuyển tiếp; hãy kiểm tra chat kế tiếp.');
      return;
    }
    if (manual && options.isBusy?.(id)) throw new Error('Codex đang có thao tác khác hoặc chat chưa mở trong cửa sổ này. Hãy thử lại sau.');
    busy.add(id);
    changed();
    try {
      // Claim before the live read, so polling and double clicks cannot race it.
      // Manual transfer does not depend on context usage or enable monitoring.
      if (manual) {
        reading = await (options.readManual || options.read)({ ...entry, threadId: id });
        if (!reading?.turnId) throw new Error('Chưa xác nhận được lượt của chat gốc.');
        if (options.isBusy?.(id)) throw new Error('Codex đang có thao tác khác; hãy thử lại sau.');
      }
      if (disposed) return;
      if (manual) {
        for (const key of ['enabled', 'thresholdPercent', 'contextPreset', 'series']) {
          if (Object.hasOwn(overrides, key)) entry[key] = overrides[key];
        }
      }
      const trigger = manual ? 'manual' : overrides.trigger || 'threshold';
      delete entry.deferred;
      entry.handoff = { phase: 'pending', sourceTurnId: reading.turnId, trigger };
      changed();
      await save();
      if (disposed || (!manual && !tracks(id))) { delete entry.handoff; await save(); return; }
      const result = await options.handoff({ ...entry, threadId: id, turnId: reading.turnId,
        model: reading.model, reasoning: reading.reasoning, manual, trigger,
        successorModel: overrides.successorModel, extraMessage: overrides.extraMessage,
        serviceTier: manual ? overrides.serviceTier : reading.serviceTier || entry.serviceTier,
        successorMode: manual ? normalizeHandoffMode(overrides.successorMode) : entry.continuationMode === 'goal' ? 'goal' : 'normal',
        goalText: overrides.goalText,
        handoffDelaySeconds: overrides.handoffDelaySeconds ?? getChatOptions(id).handoffDelaySeconds }, progress => {
        entry.handoff = progress;
        changed();
      });
      entry.handoff = result;
      const inheritEnabled = entry.enabled === true && entry.cancelAfterTransfer !== true;
      entry.enabled = false;
      // Disabling during an in-flight stop prevents future chaining; the
      // already dispatched transfer is allowed to settle exactly once.
      if (!entries[result.nextThreadId]) entries[result.nextThreadId] = {
        threadId: result.nextThreadId, title: result.nextTitle, cwd: result.cwd,
        file: result.nextFile, enabled: inheritEnabled,
        thresholdPercent: entry.thresholdPercent, previousThreadId: id,
        continuationMode: result.successorMode === 'goal' ? 'goal' : 'normal',
        serviceTier: result.serviceTier || 'default',
        ...(result.speedNotice ? { speedNotice: result.speedNotice } : {}),
        ...(result.successorMode === 'goal' ? { goalText: result.goalText } : {}),
        series: result.successorSeries || null,
        ...(entry.displayLabel ? { displayLabel: entry.displayLabel } : {}),
        ...(result.contextPreset || entry.contextPreset ? { contextPreset: result.contextPreset || entry.contextPreset } : {})
      };
      await save();
      notice = `${result.nextTitle}: đã gửi câu tiếp tục; chat cũ đã dừng.` + (result.speedNotice ? ' ' + result.speedNotice : '');
      try { await options.onTransferred?.(result); }
      catch (error) { notice += ' Không mở được giao diện: ' + error.message; }
      return result;
    } catch (error) {
      if (error.handoffSkipped && !error.handoff) {
        delete entry.handoff;
        entry.deferred = { key: attemptKey(entry, reading), reason: error.handoffReason || 'preflight', error: error.message };
        readings.set(id, { ...readings.get(id), error: error.message });
        await save();
        if (manual) throw error;
        return;
      }
      // A failed live read has made no mutation; it remains retryable.
      if (entry.handoff || error.handoff) entry.handoff = error.handoff || { phase: 'failed', error: error.message };
      notice = 'Chuyển tiếp thất bại: ' + error.message;
      await save().catch(failure => { notice += ' Không lưu được trạng thái: ' + failure.message; });
      if (manual) throw error;
    } finally { busy.delete(id); schedule(); changed(); }
  }
  async function poll(force = true) {
    if (polling || disposed) return;
    polling = true;
    try {
      await Promise.all(Object.entries(entries).filter(([, e]) => e.enabled).map(async ([id, entry]) => {
        if (busy.has(id) || savingSeries.has(id)) return;
        const at = now();
        if (!force && lastPollAt.has(id) && at - lastPollAt.get(id) < getChatOptions(id).intervalMs) return;
        lastPollAt.set(id, at);
        try {
          const reading = await options.read({ ...entry, threadId: id });
          if (disposed || entries[id] !== entry || !tracks(id)) return;
          readings.set(id, reading);
          if (entry.deferred?.key === attemptKey(entry, reading)) {
            readings.set(id, { ...reading, error: reading.error || entry.deferred.error });
            return;
          }
          if (!entry.handoff && reading.running && reading.turnId && Number.isFinite(reading.percent)
              && reading.percent >= entry.thresholdPercent && !options.isBusy?.(id)) {
            // Don't hold up other watched chats during a slow stop/start.
            void transfer(id, entry, reading);
          }
        } catch (error) { readings.set(id, { percent: null, error: error.message }); }
      }));
    } finally { polling = false; changed(); }
  }
  return {
    snapshot, tracks, blocks, poll, getChatOptions,
    async goalUpdated(event) {
      const entry = entries[event?.threadId];
      if (event?.status !== 'active' || entry?.deferred?.reason !== 'goal-inactive' || disposed) return;
      delete entry.deferred;
      await save(); void poll();
    },
    async compactionStarted(event) {
      const id = event?.threadId, entry = entries[id];
      if (!entry || !tracks(id) || !event.turnId || blocks(id) || disposed) return;
      // Both live compaction and percentage polling use the same claim.
      return transfer(id, entry, { turnId: event.turnId, running: true }, false, { trigger: 'auto_compact' });
    },
    async setChatOptions(threadId, value, session = {}, edit = {}) {
      if (!THREAD_ID.test(threadId)) throw new Error('ID chat không hợp lệ.');
      if (busy.has(threadId) || savingSeries.has(threadId)) throw new Error('Chat đang lưu hoặc chuyển tiếp; chờ hoàn tất.');
      const { thresholdPercent, ...nextOptions } = validateChatOptions(value);
      savingSeries.add(threadId);
      // Serialize the edit as well as the write: a failed edit for one chat
      // must not be captured by another chat's successful persistence snapshot.
      const operation = optionsSaving.catch(() => {}).then(async () => {
        const previous = entries[threadId];
        let prepared, committed = false;
        try {
          if (disposed) throw new Error('Tracker đã đóng.');
          prepared = await edit.prepare?.(previous) || {};
          entries[threadId] = { title: session.title, cwd: session.cwd, file: session.file, ...previous, threadId,
            enabled: previous?.enabled === true, thresholdPercent: thresholdPercent ?? previous?.thresholdPercent ?? settings.thresholdPercent,
            chatOptions: nextOptions, ...prepared.patch };
          await save(); committed = true;
          await edit.afterSave?.();
          lastPollAt.delete(threadId);
          return getChatOptions(threadId);
        } catch (error) {
          if (previous) entries[threadId] = previous; else delete entries[threadId];
          if (committed) {
            try { await save(); } catch (rollback) { error.message += ' Không khôi phục được tuỳ chọn: ' + rollback.message; }
          }
          try { await prepared?.rollback?.(); } catch (rollback) { error.message += ' Không khôi phục được tên gốc: ' + rollback.message; }
          throw error;
        }
        finally { savingSeries.delete(threadId); schedule(); changed(); }
      });
      optionsSaving = operation;
      return operation;
    },
    async transferNow(threadId, session = {}, overrides = {}) {
      if (!THREAD_ID.test(threadId)) throw new Error('ID chat không hợp lệ.');
      validateSettings({ ...settings, ...overrides });
      const mode = normalizeHandoffMode(overrides.successorMode);
      if (overrides.serviceTier !== undefined) normalizeSpeed(overrides.serviceTier);
      if (mode === 'goal') validateGoalText(overrides.goalText);
      if (Object.hasOwn(overrides, 'contextPreset')) normalizeContextPreset(overrides.contextPreset);
      if (Object.hasOwn(overrides, 'series')) overrides = { ...overrides, series: normalizeSeries(overrides.series) };
      if (Object.hasOwn(overrides, 'enabled') && typeof overrides.enabled !== 'boolean') throw new Error('Thiết lập tự chuyển không hợp lệ.');
      const entry = entries[threadId] || (entries[threadId] = {
        threadId, title: session.title, cwd: session.cwd, file: session.file,
        enabled: false, thresholdPercent: settings.thresholdPercent
      });
      return transfer(threadId, entry, null, true, overrides);
    },
    start() { schedule(); void poll(); },
    async configure(value) {
      const next = validateSettings({ ...settings, ...value });
      if (Object.hasOwn(value, 'thresholdPercent')) {
        for (const entry of Object.values(entries)) {
          if (entry.enabled) entry.thresholdPercent = next.thresholdPercent;
        }
      }
      settings = next;
      await save(); schedule(); changed();
    },
    async setEntry(threadId, value) {
      if (!THREAD_ID.test(threadId)) throw new Error('ID chat không hợp lệ.');
      if (savingSeries.has(threadId)) throw new Error('Đang lưu mã chuỗi; chờ hoàn tất.');
      const threshold = validateSettings({ ...settings, thresholdPercent: value.thresholdPercent ?? entries[threadId]?.thresholdPercent ?? settings.thresholdPercent }).thresholdPercent;
      const existing = entries[threadId];
      if (busy.has(threadId)) {
        if (value.enabled !== false) throw new Error('Chat đang chuyển tiếp; chờ hoàn tất.');
        existing.enabled = false;
        existing.cancelAfterTransfer = true;
      } else {
        entries[threadId] = { ...existing, ...value, threadId, enabled: value.enabled === true, thresholdPercent: threshold };
        delete entries[threadId].deferred;
      }
      await save(); schedule(); changed();
      void poll();
    },
    async setContextPreset(threadId, value, session = {}) {
      if (!THREAD_ID.test(threadId)) throw new Error('ID chat không hợp lệ.');
      if (savingSeries.has(threadId) || busy.has(threadId) || entries[threadId]?.handoff) throw new Error('Chat đang lưu hoặc chuyển tiếp; hãy chỉnh ở chat kế tiếp.');
      const contextPreset = normalizeContextPreset(value);
      const previous = entries[threadId];
      entries[threadId] = { title: session.title, cwd: session.cwd, file: session.file, ...previous, threadId,
        enabled: previous?.enabled === true, thresholdPercent: previous?.thresholdPercent ?? settings.thresholdPercent, contextPreset };
      savingSeries.add(threadId);
      try { await save(); }
      catch (error) { if (previous) entries[threadId] = previous; else delete entries[threadId]; throw error; }
      finally { savingSeries.delete(threadId); changed(); }
    },
    async setSeries(threadId, value, session = {}) {
      if (!THREAD_ID.test(threadId)) throw new Error('ID chat không hợp lệ.');
      if (savingSeries.has(threadId)) throw new Error('Đang lưu mã chuỗi; chờ hoàn tất.');
      const previous = entries[threadId];
      if (busy.has(threadId) || previous?.handoff) throw new Error('Chat đã bắt đầu chuyển tiếp; hãy chỉnh mã ở chat kế tiếp.');
      const series = normalizeSeries(value);
      const next = { title: session.title, cwd: session.cwd, file: session.file, ...previous,
        threadId, enabled: previous?.enabled === true,
        thresholdPercent: previous?.thresholdPercent ?? settings.thresholdPercent, series };
      savingSeries.add(threadId);
      entries[threadId] = next;
      try { await save(); }
      catch (error) {
        if (previous) entries[threadId] = previous; else delete entries[threadId];
        throw error;
      } finally { savingSeries.delete(threadId); changed(); }
    },
    dispose() { disposed = true; if (timer) clearInterval(timer); timer = null; }
  };
}

module.exports = { DEFAULT_INTERVAL_MS, DEFAULT_THRESHOLD, DEFAULT_HANDOFF_DELAY_SECONDS, validateSettings, createContextWatch };
