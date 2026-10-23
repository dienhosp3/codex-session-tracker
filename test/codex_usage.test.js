'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { normalizeUsage, accountKeyFromResult, createUsageMonitor, intervalMinutes, usageIntervalError, usageStatus } = require('../codex_usage');

const response = percent => ({ rateLimits: { limitId: 'codex', primary: { usedPercent: percent, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: { usedPercent: 80, windowDurationMins: 10080 } } });

function fixture(read, minutes = 5) {
  const timers = new Map();
  const changes = [];
  let clock = 1000;
  let serial = 0;
  const monitor = createUsageMonitor({
    read,
    intervalMinutes: minutes,
    now: () => clock,
    setTimer: (callback, delay) => { const id = ++serial; timers.set(id, { callback, delay }); return id; },
    clearTimer: id => timers.delete(id),
    onChange: state => changes.push(state)
  });
  return { monitor, timers, changes, async tick() {
    const [id, timer] = [...timers][0];
    timers.delete(id);
    clock += timer.delay;
    timer.callback();
    await monitor.refresh();
  } };
}

test('usage preserves all metered buckets, legacy compatibility and actual window durations', () => {
  const value = response(25);
  value.rateLimitsByLimitId = { other: { limitName: 'Other', primary: { usedPercent: 12, windowDurationMins: 60 } }, codex: value.rateLimits };
  const groups = normalizeUsage(value);
  assert.deepEqual(groups.map(group => group.id), ['codex', 'other']);
  assert.equal(groups[0].accountKey, 'account:unknown');
  assert.equal(groups[0].windows[0].resetsAt, 1800000000000);
  assert.equal(groups[0].windows[1].durationMinutes, 10080);
});

test('usage identity uses a safe account key and never uses API credentials', () => {
  assert.equal(accountKeyFromResult({ account: { type: 'chatgpt', email: 'User@Example.com' } }), 'chatgpt:user@example.com');
  assert.equal(accountKeyFromResult({ account: { type: 'chatgpt', id: 'acct-123' } }), 'chatgpt:acct-123');
  assert.equal(accountKeyFromResult({ account: { type: 'apiKey' } }), 'apikey');
  assert.equal(accountKeyFromResult({ account: { type: 'apiKey', apiKey: 'sk-secret' } }), 'apikey');
});

test('missing usage is an error rather than a fabricated zero percent', () => {
  for (const value of [null, {}, { rateLimits: null }, { rateLimits: { primary: { usedPercent: '0' } } }]) {
    assert.throws(() => normalizeUsage(value), /Usage|hạn mức/);
  }
  assert.equal(normalizeUsage(response(0))[0].windows[0].usedPercent, 0);
  assert.equal(normalizeUsage(response(105))[0].windows[0].usedPercent, 100);
});

test('periodic checks use the selected interval and do not overlap manual checks', async () => {
  let calls = 0;
  let complete;
  const f = fixture(() => { calls += 1; return new Promise(resolve => { complete = resolve; }); });
  const first = f.monitor.refresh();
  assert.equal(f.monitor.refresh(), first);
  await Promise.resolve();
  assert.equal(calls, 1);
  complete(response(25));
  await first;
  assert.equal([...f.timers.values()][0].delay, 300000);
  f.monitor.setInterval(2);
  assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.values()][0].delay, 120000);
  const tick = f.tick();
  await Promise.resolve();
  complete(response(30));
  await tick;
  assert.equal(calls, 2);
  assert.equal(f.monitor.snapshot().groups[0].windows[0].usedPercent, 30);
  f.monitor.dispose();
  assert.equal(f.timers.size, 0);
});

test('zero disables periodic checks while preserving the manual refresh button', async () => {
  const f = fixture(async () => response(10), 0);
  await f.monitor.refreshIfDue();
  assert.equal(f.monitor.snapshot().attemptedAt, 0);
  await f.monitor.refresh();
  assert.equal(f.timers.size, 0);
  f.monitor.setInterval(5);
  assert.equal(f.timers.size, 1);
  f.monitor.setInterval(0);
  assert.equal(f.timers.size, 0);
  await f.monitor.refresh();
  assert.equal(f.timers.size, 0);
  f.monitor.dispose();
});

test('a failed read preserves the previous timestamp and data and reports the error', async () => {
  let failed = false;
  const f = fixture(async () => { if (failed) throw new Error('offline'); return response(25); });
  await f.monitor.refresh();
  const checkedAt = f.monitor.snapshot().checkedAt;
  failed = true;
  await f.monitor.refresh();
  assert.equal(f.monitor.snapshot().checkedAt, checkedAt);
  assert.equal(f.monitor.snapshot().groups[0].windows[0].usedPercent, 25);
  assert.equal(f.monitor.snapshot().error, 'offline');
  f.monitor.dispose();
});

test('account reset and disposal discard late responses', async () => {
  let complete;
  const f = fixture(() => new Promise(resolve => { complete = resolve; }));
  const pending = f.monitor.refresh();
  await Promise.resolve();
  f.monitor.reset();
  complete(response(50));
  await pending;
  assert.equal(f.monitor.snapshot().groups.length, 0);
  const next = f.monitor.refresh();
  await Promise.resolve();
  const changes = f.changes.length;
  f.monitor.dispose();
  complete(response(75));
  await next;
  assert.equal(f.changes.length, changes);
  assert.equal(f.timers.size, 0);
});

test('interval values are validated before scheduling or saving', () => {
  for (const value of [-1, 1441, 1.5, '5', null, NaN]) assert.throws(() => intervalMinutes(value), /Chu kỳ/);
  for (const value of [0, 1, 5, 1440]) assert.equal(intervalMinutes(value), value);
});

test('status bar shows only the primary percentage and preserves all window details on hover', () => {
  const status = usageStatus({ groups: normalizeUsage(response(25)), intervalMinutes: 5, checkedAt: 1000 });
  assert.equal(status.text, '75%');
  assert.equal(status.valueText, '5h 75% - 7d 20%');
  assert.equal(status.color, 'charts.yellow');
  assert.match(status.tooltip, /5h: còn 75%/);
  assert.match(status.tooltip, /7d: còn 20%/);
  assert.match(status.tooltip, /đã dùng 25%/);
  assert.match(status.tooltip, /Đặt lại/);
  assert.match(status.tooltip, /5 phút/);
  assert.equal(status.level, 'warning');
  assert.match(usageStatus({ groups: [], error: 'offline', intervalMinutes: 0 }).text, /lỗi/);
});

test('status bar reuses one item for the primary quota across refreshes and errors', () => {
  const filename = path.join(__dirname, '../extension.js');
  const localRequire = createRequire(filename);
  const items = [];
  const data = response(54);
  data.rateLimits.secondary.usedPercent = 7;
  let state = { groups: normalizeUsage(data), intervalMinutes: 5 };
  const context = vm.createContext({
    require(name) {
      if (name !== 'vscode') return localRequire(name);
      return {
        extensions: { getExtension: () => undefined },
        StatusBarAlignment: { Right: 2 },
        ThemeColor: class ThemeColor { constructor(id) { this.id = id; } },
        window: { createStatusBarItem(id, alignment, priority) {
          const item = { id, alignment, priority, visible: false, show() { this.visible = true; }, hide() { this.visible = false; } };
          items.push(item);
          return item;
        } }
      };
    },
    module: { exports: {} },
    process, console, setInterval, clearInterval, setTimeout, clearTimeout,
    fixtureContext: { subscriptions: [] },
    fixtureMonitor: { snapshot: () => state }
  });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  vm.runInContext('contextRef=fixtureContext;usageMonitor=fixtureMonitor;renderUsageStatus();', context);
  assert.equal(items.length, 1);
  assert.equal(items[0].text, '46%');
  assert.equal(items[0].color.id, 'charts.yellow');
  assert.match(items[0].tooltip, /5h: còn 46%/);
  assert.match(items[0].tooltip, /7d: còn 93%/);
  assert.ok(items.every(item => item.command === 'codexSessionTracker.checkUsage' && item.visible && item.alignment === 2));
  assert.equal(context.fixtureContext.subscriptions.length, 1);
  state = { groups: [], error: 'offline', intervalMinutes: 0 };
  vm.runInContext('renderUsageStatus()', context);
  assert.equal(items.length, 1);
  assert.equal(items[0].text, 'Usage: lỗi');
  assert.equal(items[0].color, undefined);
  assert.equal(items[0].visible, true);
  state = { groups: normalizeUsage(data), intervalMinutes: 5, busy: true };
  vm.runInContext('renderUsageStatus()', context);
  assert.equal(items.length, 1);
  assert.ok(items.every(item => item.visible));
  assert.equal(items[0].text, '46%');
  assert.match(items[0].tooltip, /7d: còn 93%/);
});

test('a weekly window alone never substitutes for missing primary quota and zero remains valid', () => {
  const weekly = { groups: [{ id: 'codex', windows: [{ key: 'secondary', usedPercent: 7, durationMinutes: 10080 }] }], intervalMinutes: 5 };
  assert.equal(usageStatus(weekly).text, 'Usage');
  assert.match(usageStatus(weekly).tooltip, /7d: còn 93%/);
  for (const [used, expected] of [[0, '100%'], [54, '46%'], [100, '0%']]) {
    assert.equal(usageStatus({ groups: normalizeUsage(response(used)), intervalMinutes: 5 }).text, expected);
  }
});

test('the usage interval dialog validates integer minute input', () => {
  for (const value of ['', 'abc', '-1', '1.5', '1441', '1e2']) assert.ok(usageIntervalError(value));
  for (const value of ['0', '1', '5', '1440', ' 15 ']) assert.equal(usageIntervalError(value), undefined);
});

test('the settings dialog persists valid intervals and preserves settings on cancel or storage failure', async () => {
  const filename = path.join(__dirname, '../extension.js');
  const localRequire = createRequire(filename);
  for (const scenario of [{ answer: '7' }, { answer: undefined }, { answer: 'abc' }, { answer: '9', failSave: true }]) {
    const saved = [];
    const scheduled = [];
    const errors = [];
    let inputOptions;
    const context = vm.createContext({
      require(name) {
        if (name !== 'vscode') return localRequire(name);
        return {
          extensions: { getExtension: () => undefined },
          window: {
            async showInputBox(options) { inputOptions = options; return scenario.answer; },
            showErrorMessage: error => errors.push(error)
          }
        };
      },
      module: { exports: {} },
      process, console, setInterval, clearInterval, setTimeout, clearTimeout,
      fixtureContext: { globalState: { async update(key, value) {
        if (scenario.failSave) throw new Error('fixture storage failure');
        saved.push({ key, value });
      } } },
      fixtureMonitor: { snapshot: () => ({ intervalMinutes: 5 }), setInterval: value => scheduled.push(value) }
    });
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    vm.runInContext('contextRef=fixtureContext;usageMonitor=fixtureMonitor;', context);
    await vm.runInContext('configureUsageInterval()', context);
    assert.equal(inputOptions.value, '5');
    assert.ok(inputOptions.validateInput('1.5'));
    if (scenario.answer === '7') {
      assert.deepEqual(saved, [{ key: 'codexSessionTracker.usageIntervalMinutes.v1', value: 7 }]);
      assert.deepEqual(scheduled, [7]);
    } else {
      assert.deepEqual(saved, []);
      assert.deepEqual(scheduled, []);
    }
    assert.equal(errors.length, scenario.answer === 'abc' || scenario.failSave ? 1 : 0);
  }
});
