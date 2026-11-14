'use strict';

function intervalMinutes(value) {
  if (!Number.isInteger(value) || value < 0 || value > 1440) throw new Error('Chu kỳ phải từ 0 đến 1440 phút.');
  return value;
}

function usageIntervalError(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return 'Nhập số nguyên từ 0 đến 1440 phút.';
  try { intervalMinutes(Number(value.trim())); } catch (error) { return error.message; }
  return undefined;
}

function usageInterval(value = { value: 5, unit: 'm' }) {
  const units = { ms: 1, s: 1000, m: 60000, h: 3600000 };
  const amount = Number(value?.value), unit = value?.unit;
  const ms = amount * units[unit];
  if (value?.value === '' || value?.value == null || !Object.hasOwn(units, unit) || !Number.isFinite(ms) || ms < 0 || ms > 86400000 || (ms > 0 && ms < 1)) {
    throw new Error('Chu kỳ phải từ 1 ms đến 24 h; nhập 0 để kiểm tra thủ công.');
  }
  return { value: amount, unit, ms: Math.round(ms) };
}

const { normalizeUsage, normalizeAccountKey, accountKeyFromResult } = require('../chatgpt-sdk/src/quota.cjs');

function createUsageMonitor(options) {
  const now = options.now || Date.now;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  let interval = usageInterval(options.interval || { value: intervalMinutes(options.intervalMinutes ?? 5), unit: 'm' });
  let timer = null;
  let pending = null;
  let revision = 0;
  let disposed = false;
  let startupFailures = 0;
  const state = { groups: [], busy: false, error: '', waitingForCodex: true, checkedAt: 0, attemptedAt: 0, nextCheckAt: 0 };
  const snapshot = () => ({ ...state, intervalMinutes: interval.ms / 60000, intervalMs: interval.ms, interval: { ...interval } });
  const changed = () => { if (!disposed) options.onChange?.(snapshot()); };

  function schedule() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    state.nextCheckAt = 0;
    if (disposed || interval.ms === 0 && !state.waitingForCodex) return;
    const delay = state.waitingForCodex ? Math.min(30000,1500 * 2 ** Math.min(startupFailures,5)) : interval.ms;
    state.nextCheckAt = now() + delay;
    timer = setTimer(() => {
      timer = null;
      refresh();
    }, delay);
    timer?.unref?.();
  }

  function refresh() {
    if (disposed) return Promise.resolve();
    if (pending) return pending;
    const requestRevision = revision;
    state.busy = true;
    state.attemptedAt = now();
    changed();
    pending = Promise.resolve().then(() => options.read()).then(result => {
      if (disposed || revision !== requestRevision) return;
      if (result?.pending === true) {
        state.waitingForCodex = result.terminal !== true;
        state.error = '';
        return;
      }
      state.groups = normalizeUsage(result);
      state.waitingForCodex = false;
      startupFailures = 0;
      state.checkedAt = now();
      state.error = '';
    }).catch(error => {
      if (disposed || revision !== requestRevision) return;
      state.waitingForCodex = !state.checkedAt || error?.code === 'CODEX_NOT_READY';
      if(!state.checkedAt)startupFailures++;
      state.error = state.waitingForCodex ? '' : String(error?.message || 'Không kiểm tra được Usage.').slice(0, 300);
    }).finally(() => {
      pending = null;
      if (disposed) return;
      state.busy = false;
      schedule();
      changed();
    });
    return pending;
  }

  return {
    snapshot,
    refresh,
    refreshIfDue() {
      if (interval.ms === 0) return Promise.resolve();
      if (!state.attemptedAt || (state.waitingForCodex ? !state.nextCheckAt || now() >= state.nextCheckAt : now() - state.attemptedAt >= interval.ms)) return refresh();
      return Promise.resolve();
    },
    setInterval(value) {
      interval = usageInterval({ value: intervalMinutes(value), unit: 'm' });
      schedule();
      changed();
    },
    setIntervalConfig(value) {
      interval = usageInterval(value);
      schedule();
      changed();
    },
    reset() {
      revision += 1;
      state.groups = [];
      state.error = '';
      state.checkedAt = 0;
      state.attemptedAt = 0;
      state.waitingForCodex = true;
      startupFailures = 0;
      changed();
    },
    dispose() {
      disposed = true;
      revision += 1;
      if (timer !== null) clearTimer(timer);
      timer = null;
    }
  };
}

function usageStatus(state) {
  const groups = state.groups || [];
  const primary = groups.find(group => group.id === 'codex') || groups[0];
  const number = value => String(Math.round(value * 10) / 10);
  const duration = minutes => !minutes ? '' : minutes % 1440 === 0 ? minutes / 1440 + 'd' : minutes % 60 === 0 ? minutes / 60 + 'h' : minutes + 'm';
  const windows = (primary?.windows || []).map(window => ({
    label: duration(window.durationMinutes) || window.key,
    percent: number(100 - window.usedPercent) + '%',
    color: window.key === 'secondary' ? 'charts.green' : 'charts.yellow',
    tone: window.key === 'secondary' ? 'green' : 'yellow'
  }));
  const primaryWindow = primary?.windows.find(window => window.key === 'primary');
  const text = primaryWindow
    ? number(100 - primaryWindow.usedPercent) + '%'
    : state.waitingForCodex || !state.checkedAt && !state.error ? '---' : state.busy ? 'Usage…' : state.error ? 'Usage: lỗi' : '---';
  const lines = ['Usage Codex — hạn mức còn lại'];
  const valueText = windows.length
    ? windows.map(window => window.label + ' ' + window.percent).join(' - ')
    : state.waitingForCodex || !state.checkedAt && !state.error ? '---' : state.busy ? 'Đang kiểm tra…' : state.error ? 'Kiểm tra lỗi' : '---';
  if (state.waitingForCodex) lines.push('Đang chờ Codex và phiên đăng nhập sẵn sàng.');
  let maxUsed = 0;
  for (const group of groups) {
    lines.push(group.name || group.id);
    for (const window of group.windows) {
      maxUsed = Math.max(maxUsed, window.usedPercent);
      lines.push((duration(window.durationMinutes) || window.key) + ': còn ' + number(100 - window.usedPercent) + '% · đã dùng ' + number(window.usedPercent) + '%');
      if (window.resetsAt) lines.push('Đặt lại ' + new Date(window.resetsAt).toLocaleString('vi-VN'));
    }
  }
  if (state.error) lines.push('Kiểm tra lỗi: ' + state.error);
  if (state.checkedAt) lines.push('Dữ liệu cập nhật ' + new Date(state.checkedAt).toLocaleString('vi-VN'));
  lines.push(state.intervalMinutes ? 'Tự kiểm tra mỗi ' + (state.interval ? state.interval.value + ' ' + state.interval.unit : state.intervalMinutes + ' phút') : 'Kiểm tra thủ công');
  lines.push('Bấm để kiểm tra ngay. Đổi chu kỳ trong Codex Tracker.');
  return { text, valueText, windows, color: primaryWindow ? 'charts.yellow' : undefined, tooltip: lines.join('\n'), level: maxUsed >= 100 ? 'error' : maxUsed >= 80 || state.error ? 'warning' : '' };
}

module.exports = { normalizeUsage, normalizeAccountKey, accountKeyFromResult, intervalMinutes, usageIntervalError, usageInterval, createUsageMonitor, usageStatus };
