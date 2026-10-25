'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { usageHistoryChart } = require('../codex_usage_history');

test('usage chart keeps samples across quota resets and supports a wider range', () => {
  const now = 1800000000000;
  const samples = Array.from({ length: 120 }, (_, index) => ({
    accountKey: 'account:fixture', groupId: 'codex', checkedAt: now - (119 - index) * 120000,
    usedPercent: index % 100, resetsAt: now + 3600000, durationMinutes: 300
  }));
  const chart = usageHistoryChart({ samples }, now, { rangeMinutes: 1440 });
  assert.equal(chart.sampleCount, 120);
  assert.equal(chart.rangeEnd, now);
  assert.equal(chart.rangeStart, now - 24 * 60 * 60 * 1000);
  assert.equal(chart.points[0].at, now - 119 * 120000);
});

test('usage chart range limits samples without changing stored history', () => {
  const now = 1800000000000;
  const samples = Array.from({ length: 200 }, (_, index) => ({
    accountKey: 'account:fixture', groupId: 'codex', checkedAt: now - (199 - index) * 120000,
    usedPercent: 20 + (index % 70), resetsAt: now + 3600000
  }));
  const chart = usageHistoryChart({ samples }, now, { rangeMinutes: 180 });
  assert.equal(chart.sampleCount, 91);
  assert.equal(chart.points[0].at, now - 90 * 120000);
  assert.equal(chart.points.at(-1).at, now);
});
