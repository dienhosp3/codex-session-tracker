'use strict';

const fs = require('fs').promises;
const path = require('path');

const HISTORY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PRIMARY_WINDOW_MS = 5 * 60 * 60 * 1000;
const MAX_SAMPLES = 720;

function finiteTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

function normalizePercent(value) {
  const percent = Number(value);
  return Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
}

function normalizeSample(value) {
  if (!value || typeof value !== 'object') return null;
  const checkedAt = finiteTimestamp(value.checkedAt);
  const usedPercent = normalizePercent(value.usedPercent);
  if (!checkedAt || usedPercent === null) return null;
  const durationMinutes = Number(value.durationMinutes);
  return {
    accountKey: String(value.accountKey || 'account:unknown').trim() || 'account:unknown',
    groupId: String(value.groupId || 'codex').trim() || 'codex',
    windowKey: 'primary',
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    checkedAt,
    resetsAt: finiteTimestamp(value.resetsAt),
    durationMinutes: Number.isFinite(durationMinutes) && durationMinutes > 0 ? durationMinutes : 300
  };
}

function normalizeUsageHistory(value) {
  const samples = Array.isArray(value?.samples)
    ? value.samples.map(normalizeSample).filter(Boolean)
    : [];
  const unique = new Map();
  for (const sample of samples) {
    const key = [sample.accountKey, sample.groupId, sample.resetsAt || 'session', sample.checkedAt].join('|');
    unique.set(key, sample);
  }
  return { samples: [...unique.values()].sort((a, b) => a.checkedAt - b.checkedAt).slice(-MAX_SAMPLES) };
}

function primaryWindow(snapshot) {
  const groups = Array.isArray(snapshot?.groups) ? snapshot.groups : [];
  const group = groups.find(item => item?.id === 'codex') || groups[0];
  const window = group?.windows?.find(item => item?.key === 'primary');
  if (!group || !window || typeof window.usedPercent !== 'number') return null;
  return { group, window };
}

function sampleFromSnapshot(snapshot, checkedAt = Date.now()) {
  const source = primaryWindow(snapshot);
  const timestamp = finiteTimestamp(checkedAt);
  if (!source || !timestamp) return null;
  return normalizeSample({
    accountKey: source.group.accountKey,
    groupId: source.group.id,
    usedPercent: source.window.usedPercent,
    checkedAt: timestamp,
    resetsAt: source.window.resetsAt,
    durationMinutes: source.window.durationMinutes
  });
}

function recordUsageSample(snapshot, historyValue, checkedAt = Date.now()) {
  const history = normalizeUsageHistory(historyValue);
  const sample = sampleFromSnapshot(snapshot, checkedAt);
  if (!sample) return history;
  const cutoff = sample.checkedAt - HISTORY_MAX_AGE_MS;
  const key = [sample.accountKey, sample.groupId, sample.resetsAt || 'session', sample.checkedAt].join('|');
  const samples = history.samples.filter(item => item.checkedAt >= cutoff);
  const existing = samples.findIndex(item => [item.accountKey, item.groupId, item.resetsAt || 'session', item.checkedAt].join('|') === key);
  if (existing >= 0) samples[existing] = sample;
  else samples.push(sample);
  samples.sort((a, b) => a.checkedAt - b.checkedAt);
  return { samples: samples.slice(-MAX_SAMPLES) };
}

function dayFileName(timestamp) {
  return 'usage-' + new Date(timestamp).toISOString().slice(0, 10) + '.jsonl';
}

function createUsageHistoryStore(directory, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const pathImpl = options.pathImpl || path;
  const fileFor = timestamp => pathImpl.join(directory, dayFileName(timestamp));

  async function readFile(file) {
    try {
      const text = await fsImpl.readFile(file, 'utf8');
      return text.split(/\r?\n/).filter(Boolean).map(line => {
        try { return normalizeSample(JSON.parse(line)); } catch { return null; }
      }).filter(Boolean);
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }

  return {
    async load(now = Date.now()) {
      const current = finiteTimestamp(now) || Date.now();
      const files = [fileFor(current), fileFor(current - HISTORY_MAX_AGE_MS)];
      const samples = (await Promise.all(files.map(readFile))).flat();
      return normalizeUsageHistory({ samples }).samples.filter(sample => sample.checkedAt >= current - HISTORY_MAX_AGE_MS && sample.checkedAt <= current);
    },
    async append(snapshot, checkedAt = Date.now()) {
      const sample = sampleFromSnapshot(snapshot, checkedAt);
      if (!sample) return null;
      await fsImpl.mkdir(directory, { recursive: true });
      await fsImpl.appendFile(fileFor(sample.checkedAt), JSON.stringify(sample) + '\n', 'utf8');
      return sample;
    },
    fileFor
  };
}

function usageHistoryChart(historyValue, now = Date.now(), options = {}) {
  const currentTime = finiteTimestamp(now) || Date.now();
  const history = normalizeUsageHistory(historyValue);
  const recent = history.samples.filter(sample => sample.checkedAt >= currentTime - HISTORY_MAX_AGE_MS && sample.checkedAt <= currentTime);
  if (!recent.length) return { available: false, points: [], sampleCount: 0, rangeStart: 0, rangeEnd: 0, session: null };
  const latest = recent[recent.length - 1];
  const rangeMinutes = Number(options?.rangeMinutes);
  const rangeMs = Number.isFinite(rangeMinutes) && rangeMinutes > 0
    ? Math.min(HISTORY_MAX_AGE_MS, rangeMinutes * 60000)
    : HISTORY_MAX_AGE_MS;
  const accountSamples = recent.filter(sample => sample.accountKey === latest.accountKey && sample.groupId === latest.groupId);
  const rangeStart = Math.max(currentTime - HISTORY_MAX_AGE_MS, currentTime - rangeMs);
  const rangeEnd = currentTime;
  const points = accountSamples.filter(sample => sample.checkedAt >= rangeStart && sample.checkedAt <= rangeEnd)
    .sort((a, b) => a.checkedAt - b.checkedAt)
    .map(sample => ({ at: sample.checkedAt, usedPercent: sample.usedPercent, remainingPercent: sample.remainingPercent, resetsAt: sample.resetsAt }));
  return {
    available: points.length > 0,
    points,
    sampleCount: points.length,
    rangeStart,
    rangeEnd,
    session: { accountKey: latest.accountKey, groupId: latest.groupId, resetsAt: latest.resetsAt, durationMinutes: latest.durationMinutes || 300 }
  };
}

module.exports = { HISTORY_MAX_AGE_MS, MAX_SAMPLES, dayFileName, normalizeUsageHistory, sampleFromSnapshot, recordUsageSample, createUsageHistoryStore, usageHistoryChart };
