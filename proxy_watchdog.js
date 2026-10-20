'use strict';

function thresholdError(value) {
  const text = String(value ?? '').trim();
  return /^\d+$/.test(text) && Number(text) >= 1 && Number(text) <= 1440
    ? undefined : 'Nhập số phút nguyên từ 1 đến 1440.';
}

function normalizeSettings(value = {}) {
  if (!value || typeof value !== 'object') value = {};
  return {
    enabled: value.enabled === true,
    minutes: thresholdError(value.minutes) ? 5 : Number(value.minutes)
  };
}

function createProxyWatchdog(options = {}) {
  let settings = normalizeSettings(options.settings);
  let lastAttemptAt = Number(options.lastAttemptAt) || 0;
  let busy = false;
  let notice = '';
  let generation = 0;
  const clock = options.now || Date.now;
  const snapshot = () => ({ ...settings, lastAttemptAt, busy, notice });
  const notify = () => options.onChange?.();

  return {
    snapshot,
    async recordAttempt() {
      lastAttemptAt = clock();
      await options.saveAttempt?.(lastAttemptAt);
      notify();
    },
    async configure(value) {
      if (thresholdError(value.minutes)) throw new Error(thresholdError(value.minutes));
      const next = normalizeSettings(value);
      await options.saveSettings?.(next);
      settings = next;
      generation += 1;
      notice = '';
      notify();
    },
    async consider(observation) {
      if (!settings.enabled || busy) return false;
      const proxy = options.proxySnapshot();
      if (proxy.busy || !proxy.executablePath) return false;
      if (!observation?.complete || !Array.isArray(observation.tasks)) {
        notice = 'Chưa đủ dữ liệu task để tự khởi động lại.';
        return false;
      }
      const tasks = observation.tasks.filter(task => task.stateKind === 'running');
      if (!tasks.length) { notice = ''; return false; }
      const now = clock();
      const interval = settings.minutes * 60000;
      const checkedAt = Number(observation.checkedAt);
      if (!Number.isFinite(checkedAt) || checkedAt > now || now - checkedAt > 30000) return false;
      const timestamps = tasks.map(task => Number(task.lastActivity));
      if (timestamps.some(at => !Number.isFinite(at) || at <= 0 || at > now)) return false;
      if (timestamps.some(at => now - at < interval)) { notice = ''; return false; }
      const previous = Math.max(lastAttemptAt, Number(proxy.lastRestartAt) || 0);
      if (previous && now - previous < interval) return false;

      busy = true;
      const currentGeneration = generation;
      const executablePath = proxy.executablePath;
      lastAttemptAt = now;
      notice = 'Tất cả task đang chạy đã im lặng ' + settings.minutes + ' phút; đang khởi động lại proxy.';
      notify();
      try {
        // Persist before launching so a window reload cannot cause immediate retries.
        await options.saveAttempt?.(lastAttemptAt);
        const current = options.proxySnapshot();
        if (!settings.enabled || generation !== currentGeneration || current.busy || current.executablePath !== executablePath) return false;
        const restarted = await options.restart();
        notice = restarted ? 'Đã tự khởi động lại proxy.' : 'Tự khởi động lại proxy thất bại; chờ chu kỳ tiếp theo.';
        return restarted;
      } catch (error) {
        notice = 'Không thể tự khởi động lại proxy: ' + error.message;
        return false;
      } finally {
        busy = false;
        notify();
      }
    }
  };
}

module.exports = { createProxyWatchdog, normalizeSettings, thresholdError };
