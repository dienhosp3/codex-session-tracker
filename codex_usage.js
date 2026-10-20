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

function normalizeUsage(result) {
  if (!result || typeof result !== 'object') throw new Error('Codex chưa trả dữ liệu Usage.');
  const buckets = result.rateLimitsByLimitId && typeof result.rateLimitsByLimitId === 'object'
    ? Object.entries(result.rateLimitsByLimitId)
    : [];
  const legacy = result.rateLimits;
  if (legacy && typeof legacy === 'object' && !buckets.some(([id]) => id === (legacy.limitId || 'codex'))) {
    buckets.unshift([legacy.limitId || 'codex', legacy]);
  }
  if (!buckets.length) throw new Error('Tài khoản này chưa có dữ liệu hạn mức Codex.');
  const groups = [];
  for (const [id, bucket] of buckets) {
    if (!bucket || typeof bucket !== 'object') continue;
    const windows = [];
    for (const key of ['primary', 'secondary']) {
      const value = bucket[key];
      if (!value || typeof value.usedPercent !== 'number' || !Number.isFinite(value.usedPercent)) continue;
      windows.push({
        key,
        usedPercent: Math.max(0, Math.min(100, value.usedPercent)),
        durationMinutes: typeof value.windowDurationMins === 'number' && Number.isFinite(value.windowDurationMins) && value.windowDurationMins > 0 ? value.windowDurationMins : null,
        resetsAt: typeof value.resetsAt === 'number' && Number.isFinite(value.resetsAt) && value.resetsAt > 0 ? value.resetsAt * 1000 : null
      });
    }
    if (windows.length) groups.push({ id, name: typeof bucket.limitName === 'string' ? bucket.limitName : '', windows });
  }
  if (!groups.length) throw new Error('Codex chưa trả các cửa sổ hạn mức Usage.');
  return groups.sort((a, b) => Number(b.id === 'codex') - Number(a.id === 'codex'));
}

function createUsageMonitor(options) {
  const now = options.now || Date.now;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  let minutes = intervalMinutes(options.intervalMinutes ?? 5);
  let timer = null;
  let pending = null;
  let revision = 0;
  let disposed = false;
  const state = { groups: [], busy: false, error: '', checkedAt: 0, attemptedAt: 0, nextCheckAt: 0 };
  const snapshot = () => ({ ...state, intervalMinutes: minutes });
  const changed = () => { if (!disposed) options.onChange?.(snapshot()); };

  function schedule() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    state.nextCheckAt = 0;
    if (disposed || minutes === 0) return;
    state.nextCheckAt = now() + minutes * 60000;
    timer = setTimer(() => {
      timer = null;
      refresh();
    }, minutes * 60000);
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
      state.groups = normalizeUsage(result);
      state.checkedAt = now();
      state.error = '';
    }).catch(error => {
      if (disposed || revision !== requestRevision) return;
      state.error = String(error?.message || 'Không kiểm tra được Usage.').slice(0, 300);
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
      if (minutes === 0) return Promise.resolve();
      if (!state.attemptedAt || (minutes > 0 && now() - state.attemptedAt >= minutes * 60000)) return refresh();
      return Promise.resolve();
    },
    setInterval(value) {
      minutes = intervalMinutes(value);
      schedule();
      changed();
    },
    reset() {
      revision += 1;
      state.groups = [];
      state.error = '';
      state.checkedAt = 0;
      state.attemptedAt = 0;
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
    : state.busy ? 'Usage…' : state.error ? 'Usage: lỗi' : 'Usage';
  const lines = ['Usage Codex — hạn mức còn lại'];
  const valueText = windows.length
    ? windows.map(window => window.label + ' ' + window.percent).join(' - ')
    : state.busy ? 'Đang kiểm tra…' : state.error ? 'Kiểm tra lỗi' : 'Chưa có dữ liệu';
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
  lines.push(state.intervalMinutes ? 'Tự kiểm tra mỗi ' + state.intervalMinutes + ' phút' : 'Kiểm tra thủ công');
  lines.push('Bấm để kiểm tra ngay. Đổi chu kỳ trong Codex Tracker.');
  return { text, valueText, windows, color: primaryWindow ? 'charts.yellow' : undefined, tooltip: lines.join('\n'), level: maxUsed >= 100 ? 'error' : maxUsed >= 80 || state.error ? 'warning' : '' };
}

module.exports = { normalizeUsage, intervalMinutes, usageIntervalError, createUsageMonitor, usageStatus };
