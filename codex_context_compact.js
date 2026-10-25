'use strict';

const DEFAULT_CONTEXT_COMPACT_SETTINGS = Object.freeze({
  enabled: false,
  thresholdPercent: 80,
  resumeAfterCompact: true
});
const DEFAULT_CONTEXT_COMPACT_STATE = Object.freeze({
  schemaVersion: 2,
  currentKey: '',
  phase: 'idle',
  attempts: 0,
  lastAttemptAt: 0,
  retryAt: 0
});
const MAX_CONTEXT_COMPACT_ATTEMPTS = 3;
const CONTEXT_COMPACT_RETRY_DELAYS_MS = Object.freeze([2000, 10000, 60000]);

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

function normalizeContextCompactState(value) {
  const source = value && typeof value === 'object' ? value : {};
  const phase = ['idle', 'running', 'succeeded', 'failed'].includes(source.phase) ? source.phase : 'idle';
  const attempts = Number.isInteger(Number(source.attempts)) ? Math.max(0, Math.min(MAX_CONTEXT_COMPACT_ATTEMPTS, Number(source.attempts))) : 0;
  return {
    schemaVersion: 2,
    currentKey: String(source.currentKey || ''),
    phase,
    attempts,
    lastAttemptAt: Number.isFinite(Number(source.lastAttemptAt)) ? Math.max(0, Number(source.lastAttemptAt)) : 0,
    retryAt: Number.isFinite(Number(source.retryAt)) ? Math.max(0, Number(source.retryAt)) : 0
  };
}

function contextCompactDecision(runtime, settingsValue, stateValue = {}, now = Date.now()) {
  const settings = normalizeContextCompactSettings(settingsValue);
  const state = normalizeContextCompactState(stateValue);
  const percent = contextPercent(runtime);
  const key = String(stateValue.key || state.currentKey || '');
  if (!settings.enabled || !key || percent < settings.thresholdPercent) return { settings, state, percent, key, should: false };
  if (state.phase === 'running' || state.phase === 'succeeded') return { settings, state, percent, key, should: false };
  if (state.currentKey !== key) return { settings, state, percent, key, should: true, reason: 'new-context-key' };
  if (state.phase === 'failed' && state.attempts < MAX_CONTEXT_COMPACT_ATTEMPTS && now >= state.retryAt) return { settings, state, percent, key, should: true, reason: 'retry-after-result' };
  return { settings, state, percent, key, should: false };
}

function markContextCompactStarted(stateValue, key, now = Date.now()) {
  const state = normalizeContextCompactState(stateValue);
  const sameKey = state.currentKey === String(key || '');
  return { ...state, currentKey: String(key || ''), phase: 'running', attempts: sameKey ? Math.min(MAX_CONTEXT_COMPACT_ATTEMPTS, state.attempts + 1) : 1, lastAttemptAt: now, retryAt: 0 };
}

function markContextCompactSucceeded(stateValue, key, now = Date.now()) {
  const state = normalizeContextCompactState(stateValue);
  return { ...state, currentKey: String(key || state.currentKey), phase: 'succeeded', lastAttemptAt: state.lastAttemptAt || now, retryAt: 0 };
}

function markContextCompactFailed(stateValue, key, now = Date.now()) {
  const state = normalizeContextCompactState(stateValue);
  const delay = CONTEXT_COMPACT_RETRY_DELAYS_MS[Math.max(0, Math.min(CONTEXT_COMPACT_RETRY_DELAYS_MS.length - 1, state.attempts - 1))] || CONTEXT_COMPACT_RETRY_DELAYS_MS.at(-1);
  return { ...state, currentKey: String(key || state.currentKey), phase: 'failed', retryAt: now + delay };
}

module.exports = { DEFAULT_CONTEXT_COMPACT_SETTINGS, DEFAULT_CONTEXT_COMPACT_STATE, MAX_CONTEXT_COMPACT_ATTEMPTS, integerPercent, normalizeContextCompactSettings, normalizeContextCompactState, contextPercent, shouldAutoCompact, contextCompactDecision, markContextCompactStarted, markContextCompactSucceeded, markContextCompactFailed };
