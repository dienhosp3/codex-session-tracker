'use strict';

const RESET_TOLERANCE_MS = 60_000;
const MAX_SAMPLE_GAP_MS = 15 * 60_000;
const identityKey = (group, window) => [group.accountKey || 'account:unknown', group.id || 'codex', window.key].join('|');
const validPercent = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
const resetTime = value => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

function sameCycle(previous, resetsAt, sampledAt, usedPercent) {
  const old = resetTime(previous?.resetsAt), next = resetTime(resetsAt);
  const previousAt = typeof previous?.checkedAt === 'number' ? previous.checkedAt : Date.parse(previous?.checkedAt || '');
  const previousUsed = previous?.usedPercent ?? (100 - previous?.remainingPercent);
  if (old && next > old && sampledAt >= old && previousAt < old && usedPercent < previousUsed) return false;
  return !old || !next || Math.abs(old - next) <= RESET_TOLERANCE_MS;
}

module.exports = { RESET_TOLERANCE_MS, MAX_SAMPLE_GAP_MS, identityKey, validPercent, resetTime, sameCycle };
