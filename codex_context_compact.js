'use strict';

const DEFAULT_CONTEXT_COMPACT_SETTINGS = Object.freeze({
  enabled: false,
  thresholdPercent: 80,
  resumeAfterCompact: true
});

function integerPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function normalizeContextCompactSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  const threshold = integerPercent(source.thresholdPercent);
  return {
    schemaVersion: 1,
    enabled: source.enabled === true,
    thresholdPercent: threshold && threshold >= 1 && threshold <= 99 ? threshold : DEFAULT_CONTEXT_COMPACT_SETTINGS.thresholdPercent,
    resumeAfterCompact: source.resumeAfterCompact !== false
  };
}

function contextPercent(runtime) {
  const value = Number(runtime?.contextPercent);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value * 100) / 100));
}

function shouldAutoCompact(runtime, settingsValue, stateValue = {}) {
  const settings = normalizeContextCompactSettings(settingsValue);
  const percent = contextPercent(runtime);
  const key = String(stateValue.key || '');
  const currentKey = String(stateValue.currentKey || '');
  return {
    settings,
    percent,
    should: settings.enabled && percent >= settings.thresholdPercent && currentKey !== key,
    key
  };
}

module.exports = { DEFAULT_CONTEXT_COMPACT_SETTINGS, integerPercent, normalizeContextCompactSettings, contextPercent, shouldAutoCompact };
