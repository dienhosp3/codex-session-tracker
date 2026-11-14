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
  let assessment = { checkedAt: 0, taskCount: 0, latestActivityAt: 0, reason: 'not_checked' };
  let generation = 0;
  const clock = options.now || Date.now;
  const snapshot = () => ({ ...settings, lastAttemptAt, busy, notice, assessment: { ...assessment } });
  const notify = () => options.onChange?.();
  const hold = (reason, message) => {
    assessment.reason = reason;
    notice = message;
    return false;
  };

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
      assessment = { checkedAt: 0, taskCount: 0, latestActivityAt: 0, reason: 'not_checked' };
      notify();
    },
    async consider(observation) {
      if (busy) return false;
      const now = clock();
      assessment = { checkedAt: now, taskCount: 0, latestActivityAt: 0, reason: 'checking' };
      if (!settings.enabled) return hold('disabled', 'Tự khởi động lại đang tắt.');
      const proxy = options.proxySnapshot();
      if (proxy.busy) return hold('proxy_busy', 'Đang thao tác với proxy.');
      if (!proxy.executablePath) return hold('missing_executable', 'Chưa chọn file proxy .exe.');
      if (!observation?.complete || !Array.isArray(observation.tasks)) {
        return hold('incomplete_scan', 'Chưa đủ dữ liệu task để tự khởi động lại.');
      }
      const tasks = observation.tasks.filter(task => task.stateKind === 'running');
      assessment.taskCount = tasks.length;
      if (!tasks.length) return hold('no_running_tasks', 'Không có task đang chạy.');
      const interval = settings.minutes * 60000;
      const checkedAt = Number(observation.checkedAt);
      if (!Number.isFinite(checkedAt) || checkedAt > now || now - checkedAt > 30000) return hold('stale_scan', 'Dữ liệu quét đã cũ; chờ lần quét mới.');
      const timestamps = tasks.map(task => Number(task.lastActivity));
      if (timestamps.some(at => !Number.isFinite(at) || at <= 0 || at > now)) return hold('invalid_activity', 'Chưa xác định được thời gian hoạt động của task.');
      assessment.latestActivityAt = Math.max(...timestamps);
      if (observation.recoverySent) return hold('recovery_sent', 'Vừa thử gửi tin tiếp tục; chờ lần quét mới.');
      if (timestamps.some(at => now - at < interval)) {
        const remaining = Math.ceil((interval - (now - assessment.latestActivityAt)) / 1000);
        return hold('task_recently_active', 'Task mới nhất chưa im đủ ' + settings.minutes + ' phút (còn ' + remaining + ' giây).');
      }
      const previous = Math.max(lastAttemptAt, Number(proxy.lastRestartAt) || 0);
      if (previous && now - previous < interval) {
        assessment.cooldownUntil = previous + interval;
        return hold('cooldown', 'Đang chờ cooldown sau lượt reset/thử reset trước (còn ' + Math.ceil((previous + interval - now) / 1000) + ' giây).');
      }

      busy = true;
      const currentGeneration = generation;
      const executablePath = proxy.executablePath;
      lastAttemptAt = now;
      assessment.reason = 'restarting';
      notice = 'Tất cả task đang chạy đã im lặng ' + settings.minutes + ' phút; đang khởi động lại proxy.';
      notify();
      try {
        // Persist before launching so a window reload cannot cause immediate retries.
        await options.saveAttempt?.(lastAttemptAt);
        const current = options.proxySnapshot();
        if (!settings.enabled || generation !== currentGeneration || current.busy || current.executablePath !== executablePath) return hold('cancelled', 'Đã hủy lượt tự reset do cấu hình hoặc trạng thái proxy thay đổi.');
        const restarted = await options.restart();
        assessment.reason = restarted ? 'restarted' : 'restart_failed';
        notice = restarted ? 'Đã tự khởi động lại proxy.' : 'Tự khởi động lại proxy thất bại; chờ chu kỳ tiếp theo.';
        return restarted;
      } catch (error) {
        assessment.reason = 'restart_failed';
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
