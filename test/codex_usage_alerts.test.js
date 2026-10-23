'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_USAGE_ALERT_SETTINGS, normalizeUsageAlertSettings, evaluateUsageAlerts, usageAlertSummary } = require('../codex_usage_alerts');

function groups(usedPercent, resetsAt = 2000000000000, accountKey = 'chatgpt:user_example.com') {
  return [{ id: 'codex', accountKey, windows: [
    { key: 'primary', usedPercent, durationMinutes: 300, resetsAt },
    { key: 'secondary', usedPercent: 20, durationMinutes: 10080, resetsAt: resetsAt + 1000 }
  ] }];
}

test('separate accounts keep independent quota sessions even when reset times match', () => {
  const settings = normalizeUsageAlertSettings();
  const first = evaluateUsageAlerts(groups(60, 2000000000000, 'chatgpt:a_example.com'), settings, undefined, () => 1000);
  const other = evaluateUsageAlerts(groups(60, 2000000000000, 'chatgpt:b_example.com'), settings, first.state, () => 2000);
  assert.deepEqual(other.events, []);
  const later = evaluateUsageAlerts(groups(72, 2000000000000, 'chatgpt:a_example.com'), settings, other.state, () => 3000);
  assert.equal(later.events.length, 1);
  assert.equal(later.events[0].thresholdPercent, 70);
});

test('default quota alert levels are explicit and 5h is enabled while 7d is opt-in', () => {
  const settings = normalizeUsageAlertSettings();
  assert.deepEqual(settings.primary.thresholds.map(item => item.usedPercent), [50, 70, 85, 95]);
  assert.equal(settings.primary.enabled, true);
  assert.equal(settings.secondary.enabled, false);
  assert.equal(settings.baselineSilent, true);
  assert.deepEqual(DEFAULT_USAGE_ALERT_SETTINGS.primary.thresholds.map(item => item.usedPercent), [50, 70, 85, 95]);
});

test('first Usage read establishes a silent baseline and later crossing emits only the highest new level', () => {
  const settings = normalizeUsageAlertSettings();
  const first = evaluateUsageAlerts(groups(60), settings, undefined, () => 1000);
  assert.deepEqual(first.events, []);
  const second = evaluateUsageAlerts(groups(90), settings, first.state, () => 2000);
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].thresholdPercent, 85);
  assert.equal(second.events[0].usedPercent, 90);
  assert.equal(second.events[0].remainingPercent, 10);
  const repeated = evaluateUsageAlerts(groups(92), settings, second.state, () => 3000);
  assert.deepEqual(repeated.events, []);
});

test('a quota reset creates a new cycle and clears triggered levels without a startup alarm', () => {
  const settings = normalizeUsageAlertSettings();
  const first = evaluateUsageAlerts(groups(90, 2000000000000), settings, undefined, () => 1999999900000);
  const reset = evaluateUsageAlerts(groups(10, 2000000010000), settings, first.state, () => 2000000001000);
  assert.deepEqual(reset.events, []);
  const later = evaluateUsageAlerts(groups(72, 2000000010000), settings, reset.state, () => 2000000100000);
  assert.equal(later.events.length, 2);
  assert.deepEqual(later.events.map(event => event.alertType).sort(), ['usage_rate', 'usage_threshold']);
  assert.equal(later.events.find(event => event.alertType === 'usage_threshold').thresholdPercent, 70);
});

test('7d remains silent until explicitly enabled and can use its own thresholds', () => {
  const settings = normalizeUsageAlertSettings({ secondary: { enabled: true, thresholds: [{ usedPercent: 40, notify: false, soundKey: 'weekly' }] } });
  const first = evaluateUsageAlerts(groups(10), settings, undefined, () => 1000);
  const secondGroups = groups(10);
  secondGroups[0].windows[1].usedPercent = 45;
  const second = evaluateUsageAlerts(secondGroups, settings, first.state, () => 2000);
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].window, 'secondary');
  assert.equal(second.events[0].thresholdPercent, 40);
  assert.equal(second.events[0].notify, false);
  assert.equal(second.events[0].soundKey, 'weekly');
});

test('summary exposes the primary remaining percentage and configured levels', () => {
  const settings = normalizeUsageAlertSettings();
  const result = evaluateUsageAlerts(groups(54), settings, undefined, () => 1000);
  const summary = usageAlertSummary(result.state, settings);
  assert.equal(summary.enabled, true);
  assert.equal(summary.remainingPercent, 46);
  assert.deepEqual(summary.thresholds, [50, 70, 85, 95]);
});
