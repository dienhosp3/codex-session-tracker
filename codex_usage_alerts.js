'use strict';

const DEFAULT_USAGE_ALERT_SETTINGS = Object.freeze({
  enabled: true,
  primary: {
    enabled: true,
    thresholds: [
      { usedPercent: 50, notify: false, soundKey: '' },
      { usedPercent: 70, notify: true, soundKey: '' },
      { usedPercent: 85, notify: true, soundKey: '' },
      { usedPercent: 95, notify: true, soundKey: '' }
    ],
    rateThresholds: [
      { percentPerHour: 10, notify: false, soundKey: '' },
      { percentPerHour: 20, notify: true, soundKey: '' },
      { percentPerHour: 30, notify: true, soundKey: '' }
    ]
  },
  secondary: {
    enabled: false,
    thresholds: [
      { usedPercent: 70, notify: true, soundKey: '' },
      { usedPercent: 90, notify: true, soundKey: '' }
    ],
    rateThresholds: []
  }
});

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(1, Math.min(99, Math.round(number * 10) / 10));
}

function clampRate(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0.1, Math.min(1000, Math.round(number * 10) / 10));
}

function normalizeThresholds(value, fallback) {
  const source = Array.isArray(value) ? value : fallback;
  const thresholds = source.map(item => {
    if (typeof item === 'number') return { usedPercent: clampPercent(item), notify: true, soundKey: '' };
    return {
      usedPercent: clampPercent(item?.usedPercent),
      notify: item?.notify !== false,
      soundKey: typeof item?.soundKey === 'string' ? item.soundKey : ''
    };
  }).filter(item => item.usedPercent !== null);
  const unique = new Map(thresholds.map(item => [item.usedPercent, item]));
  return [...unique.values()].sort((a, b) => a.usedPercent - b.usedPercent);
}

function normalizeRateThresholds(value, fallback) {
  const source = Array.isArray(value) ? value : fallback;
  const thresholds = source.map(item => ({
    percentPerHour: clampRate(item?.percentPerHour ?? item),
    notify: item?.notify !== false,
    soundKey: typeof item?.soundKey === 'string' ? item.soundKey : ''
  })).filter(item => item.percentPerHour !== null);
  const unique = new Map(thresholds.map(item => [item.percentPerHour, item]));
  return [...unique.values()].sort((a, b) => a.percentPerHour - b.percentPerHour);
}

function normalizeUsageAlertSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  const defaults = DEFAULT_USAGE_ALERT_SETTINGS;
  const windowSettings = key => {
    const input = source[key] && typeof source[key] === 'object' ? source[key] : {};
    return {
      enabled: input.enabled === true,
      thresholds: normalizeThresholds(input.thresholds, defaults[key].thresholds),
      rateThresholds: normalizeRateThresholds(input.rateThresholds, defaults[key].rateThresholds)
    };
  };
  return {
    schemaVersion: 1,
    enabled: source.enabled !== false,
    baselineSilent: source.baselineSilent !== false,
    primary: { ...windowSettings('primary'), enabled: source.primary?.enabled !== false },
    secondary: windowSettings('secondary')
  };
}

function cycleKey(group, window) {
  return [group.accountKey || 'account:unknown', group.id, window.key, window.resetsAt || 'session'].join(':');
}

function evaluateUsageAlerts(groups, settingsValue, stateValue, now = Date.now) {
  const settings = normalizeUsageAlertSettings(settingsValue);
  const state = stateValue && typeof stateValue === 'object' ? structuredClone(stateValue) : { schemaVersion: 1, initialized: false, windows: {} };
  state.schemaVersion = 1;
  state.windows = state.windows && typeof state.windows === 'object' ? state.windows : {};
  const events = [];
  const primaryGroup = (groups || []).find(group => group.id === 'codex') || (groups || [])[0];
  if (!settings.enabled || !primaryGroup) return { events, state, settings };
  const timestamp = new Date(now()).toISOString();
  for (const window of primaryGroup.windows || []) {
    const config = settings[window.key];
    if (!config?.enabled || typeof window.usedPercent !== 'number') continue;
    const key = cycleKey(primaryGroup, window);
    const previous = state.windows[key];
    const triggered = new Set(Array.isArray(previous?.triggered) ? previous.triggered : []);
    const previousUsed = typeof previous?.usedPercent === 'number' ? previous.usedPercent : null;
    const crossed = previous && previousUsed !== null && window.usedPercent > previousUsed
      ? config.thresholds.filter(item => item.usedPercent > previousUsed && item.usedPercent <= window.usedPercent && !triggered.has(String(item.usedPercent)))
      : [];
    if (!previous) {
      for (const item of config.thresholds) {
        if (item.usedPercent <= window.usedPercent) triggered.add(String(item.usedPercent));
      }
    }
    for (const item of crossed) triggered.add(String(item.usedPercent));
    const rateTriggered = new Set(Array.isArray(previous?.rateTriggered) ? previous.rateTriggered : []);
    const startAt = window.resetsAt && window.durationMinutes
      ? window.resetsAt - window.durationMinutes * 60000
      : null;
    const elapsedHours = startAt && now() > startAt ? (now() - startAt) / 3600000 : null;
    const ratePerHour = elapsedHours ? window.usedPercent / elapsedHours : null;
    const previousRate = typeof previous?.ratePerHour === 'number' ? previous.ratePerHour : null;
    const crossedRates = previous && previousRate !== null && ratePerHour !== null && ratePerHour > previousRate
      ? config.rateThresholds.filter(item => item.percentPerHour > previousRate && item.percentPerHour <= ratePerHour && !rateTriggered.has(String(item.percentPerHour)))
      : [];
    if (!previous) {
      for (const item of config.rateThresholds) {
        if (ratePerHour !== null && item.percentPerHour <= ratePerHour) rateTriggered.add(String(item.percentPerHour));
      }
    }
    for (const item of crossedRates) rateTriggered.add(String(item.percentPerHour));
    state.windows[key] = {
      usedPercent: window.usedPercent,
      remainingPercent: Math.max(0, 100 - window.usedPercent),
      resetsAt: window.resetsAt || null,
      triggered: [...triggered].sort((a, b) => Number(a) - Number(b)),
      ratePerHour,
      rateTriggered: [...rateTriggered].sort((a, b) => Number(a) - Number(b)),
      checkedAt: timestamp
    };
    if (settings.baselineSilent && !previous) continue;
    const highest = crossed[crossed.length - 1];
    const highestRate = crossedRates[crossedRates.length - 1];
    if (highest) {
      events.push({
        id: `usage:${key}:threshold:${highest.usedPercent}`,
        source: 'usage',
        alertType: 'usage_threshold',
        soundKey: highest.soundKey,
        window: window.key,
        windowLabel: window.windowDurationMins || window.durationMinutes || window.key,
        usedPercent: window.usedPercent,
        remainingPercent: Math.max(0, 100 - window.usedPercent),
        thresholdPercent: highest.usedPercent,
        occurredAt: timestamp,
        notify: highest.notify,
        message: `Codex đã dùng ${Math.round(window.usedPercent * 10) / 10}% hạn mức ${window.key}. Còn ${Math.round((100 - window.usedPercent) * 10) / 10}%.`
      });
    }
    if (highestRate) {
      events.push({
        id: `usage:${key}:rate:${highestRate.percentPerHour}`,
        source: 'usage',
        alertType: 'usage_rate',
        soundKey: highestRate.soundKey,
        window: window.key,
        windowLabel: window.windowDurationMins || window.durationMinutes || window.key,
        usedPercent: window.usedPercent,
        remainingPercent: Math.max(0, 100 - window.usedPercent),
        ratePerHour,
        thresholdRatePerHour: highestRate.percentPerHour,
        occurredAt: timestamp,
        notify: highestRate.notify,
        message: `Quota ${window.key} đang tụt trung bình ${Math.round(ratePerHour * 10) / 10}% mỗi giờ.`
      });
    }
  }
  state.initialized = true;
  return { events, state, settings };
}

function usageAlertSummary(state, settingsValue) {
  const settings = normalizeUsageAlertSettings(settingsValue);
  const windows = state?.windows && typeof state.windows === 'object' ? state.windows : {};
  const primary = Object.entries(windows).find(([key]) => key.includes(':primary:'));
  const remaining = primary ? windows[primary[0]].remainingPercent : null;
  const enabled = settings.enabled && settings.primary.enabled;
  return {
    enabled,
    remainingPercent: remaining,
    thresholds: settings.primary.thresholds.map(item => item.usedPercent),
    rateThresholds: settings.primary.rateThresholds.map(item => item.percentPerHour)
  };
}

module.exports = { DEFAULT_USAGE_ALERT_SETTINGS, normalizeUsageAlertSettings, evaluateUsageAlerts, usageAlertSummary };
