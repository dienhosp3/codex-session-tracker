'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { normalizeUsage, accountKeyFromResult, createUsageMonitor, intervalMinutes, usageIntervalError, usageStatus } = require('../../src/codex_usage');

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
  const filename = path.join(__dirname, '../../extension.js');
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
  assert.equal(usageStatus(weekly).text, '---');
  assert.match(usageStatus(weekly).tooltip, /7d: còn 93%/);
  for (const [used, expected] of [[0, '100%'], [54, '46%'], [100, '0%']]) {
    assert.equal(usageStatus({ groups: normalizeUsage(response(used)), intervalMinutes: 5 }).text, expected);
  }
});

test('the usage interval dialog validates integer minute input', () => {
  for (const value of ['', 'abc', '-1', '1.5', '1441', '1e2']) assert.ok(usageIntervalError(value));
  for (const value of ['0', '1', '5', '1440', ' 15 ']) assert.equal(usageIntervalError(value), undefined);
});

test('quota dialog saves precise units only after storage succeeds', async () => {
  const filename = path.join(__dirname, '../../extension.js');
  const localRequire = createRequire(filename);
  for (const scenario of [{ value: { value: 250, unit: 'ms' } }, { value: { value: 2.5, unit: 's' } }, { value: { value: -1, unit: 'h' } }, { value: { value: 9, unit: 'm' }, failSave: true }]) {
    const saved = [], scheduled = [], messages = [];
    const context = vm.createContext({
      require(name) { return name === 'vscode' ? { extensions: { getExtension: () => undefined } } : localRequire(name); },
      module: { exports: {} }, process, console, setInterval, clearInterval, setTimeout, clearTimeout,
      fixtureContext: { globalState: { async update(key, value) { if (scenario.failSave) throw new Error('storage failure'); saved.push({ key, value }); } } },
      fixtureMonitor: { setIntervalConfig: value => scheduled.push(value) },
      fixtureView: { webview: { postMessage: message => messages.push(message) } }, fixtureValue: scenario.value
    });
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    vm.runInContext('contextRef=fixtureContext;usageMonitor=fixtureMonitor;trackerView=fixtureView;', context);
    await vm.runInContext('saveUsageInterval(fixtureValue, "request")', context);
    const success = scenario.value.value >= 0 && !scenario.failSave;
    assert.equal(saved.length, success ? 1 : 0); assert.equal(scheduled.length, success ? 1 : 0);
    assert.equal(messages[0].type, 'usageIntervalSaved'); assert.equal(Boolean(messages[0].error), !success);
    if(success) { assert.equal(saved[0].key, 'codexSessionTracker.usageInterval.v2'); assert.equal(scheduled[0].ms, scenario.value.value * (scenario.value.unit === 'ms' ? 1 : 1000)); }
    vm.runInContext('openTracker=async()=>{};newChatDialogReady=true;',context);
    await vm.runInContext('configureUsageInterval()',context);
    assert.equal(messages.at(-1).type,'openUsageInterval');
    await vm.runInContext('configureUsageAlerts()',context);
    assert.equal(messages.at(-1).type,'openUsageAlerts');
  }
});

test('quota accepts ms, s, m, h and schedules without rounding to minutes', async () => {
  const { usageInterval } = require('../../src/codex_usage');
  for (const [value, unit, ms] of [[1,'ms',1],[250,'ms',250],[1.5,'s',1500],[5,'m',300000],[.5,'h',1800000],[0,'m',0]]) {
    assert.equal(usageInterval({value,unit}).ms,ms);
    const f=fixture(async()=>response(25));
    await f.monitor.refresh(); f.monitor.setIntervalConfig({value,unit});
    assert.equal(f.monitor.snapshot().intervalMs,ms);
    assert.equal(f.timers.size,ms?1:0);
    if(ms) assert.equal([...f.timers.values()][0].delay,ms);
    f.monitor.dispose();
  }
  for(const value of [{value:-1,unit:'s'},{value:.1,unit:'ms'},{value:25,unit:'h'},{value:1,unit:'days'},{value:'',unit:'m'}]) assert.throws(()=>usageInterval(value));
});

test('startup waits silently and first quota succeeds as soon as the connection is ready', async () => {
  let ready=false, reads=0;
  const f=fixture(async()=>{reads++;return ready?response(3):{pending:true}});
  await f.monitor.refresh();
  assert.equal(usageStatus(f.monitor.snapshot()).text,'---');
  assert.equal(f.monitor.snapshot().error,'');
  assert.equal(f.monitor.snapshot().checkedAt,0);
  assert.equal([...f.timers.values()][0].delay,1500);
  ready=true;await f.tick();
  assert.equal(f.monitor.snapshot().groups[0].windows[0].usedPercent,3);
  assert.equal(reads,2);
  f.monitor.dispose();
});
test('an initial unavailable quota endpoint stays as --- instead of Usage error and backs off',async()=>{
  const f=fixture(async()=>{throw new Error('native quota endpoint warming up');});
  await f.monitor.refresh();assert.equal(f.monitor.snapshot().error,'');assert.equal(usageStatus(f.monitor.snapshot()).text,'---');assert.equal([...f.timers.values()][0].delay,3000);f.monitor.dispose();
});
