'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createLocalProxyController } = require('../local_proxy');
const { createProxyWatchdog } = require('../proxy_watchdog');
const { createProxyRecovery } = require('../proxy_recovery');

function fixture(options = {}) {
  const file = path.join(__dirname, '../extension.js');
  const localRequire = createRequire(file);
  const saved = [];
  const errors = [];
  const dialogs = [];
  let starts = 0;
  const proxy = createLocalProxyController({
    executablePath: options.executablePath || '', validate: async value => value,
    save: async value => saved.push({ path: value }),
    restart: async () => { starts += 1; return { processId: 9, stoppedCount: 1 }; }
  });
  const watchdog = createProxyWatchdog({
    settings: options.watchdogSettings,
    now: options.now,
    lastAttemptAt: options.lastAttemptAt,
    proxySnapshot: proxy.snapshot,
    saveSettings: async settings => saved.push({ ...settings }),
    restart: () => proxy.restart('auto')
  });
  let selectFile = options.selectFile || (() => [{ fsPath: 'C:\\fixture\\proxy.exe' }]);
  const vscode = {
    Uri: { file: fsPath => ({ fsPath }) },
    workspace: { getConfiguration: () => ({ get: (_name, fallback) => fallback }) },
    window: {
      async showQuickPick() { return options.action ? { action: options.action } : undefined; },
      async showInputBox(input) { dialogs.push(input); return options.minutes; },
      showOpenDialog(input) { dialogs.push(input); return selectFile(); },
      showErrorMessage(message) { errors.push(message); },
      setStatusBarMessage() {}
    }
  };
  const context = vm.createContext({
    require: name => name === 'vscode' ? vscode : name === './tracker' && options.observation
      ? { ...localRequire(name), scanConversationSessions: async () => options.observation() }
      : localRequire(name),
    process, module: { exports: {} }, setInterval, clearInterval, setTimeout, clearTimeout, console,
    fixtureProxy: proxy, fixtureWatchdog: watchdog, fixtureRecovery: options.recovery || null
  });
  vm.runInContext(fs.readFileSync(file, 'utf8') + '\nlocalProxy=fixtureProxy;proxyWatchdog=fixtureWatchdog;proxyRecovery=fixtureRecovery;', context, { filename: file });
  return { proxy, watchdog, saved, errors, dialogs, starts: () => starts,
    setFilePicker: fn => { selectFile = fn; }, run: expression => vm.runInContext(expression, context) };
}

test('right click settings uses five minute default and persists a changed threshold', async () => {
  const f = fixture({ action: 'minutes', minutes: '8' });
  await f.run('configureProxyWatchdog()');
  assert.equal(f.dialogs[0].value, '5');
  assert.deepEqual(f.saved, [{ enabled: false, minutes: 8 }]);
  assert.equal(f.watchdog.snapshot().minutes, 8);
});

test('right click enabling chooses and saves EXE without restarting it', async () => {
  const f = fixture({ action: 'toggle' });
  await f.run('configureProxyWatchdog()');
  assert.equal(f.proxy.snapshot().executablePath, 'C:\\fixture\\proxy.exe');
  assert.equal(f.watchdog.snapshot().enabled, true);
  assert.equal(f.watchdog.snapshot().minutes, 5);
  assert.equal(f.starts(), 0);
});

test('invalid threshold and cancelled selection do not enable automation or restart', async () => {
  const invalid = fixture({ action: 'minutes', minutes: '0' });
  await invalid.run('configureProxyWatchdog()');
  assert.equal(invalid.errors.length, 1);
  assert.equal(invalid.saved.length, 0);
  const cancelled = fixture({ action: 'toggle', selectFile: () => undefined });
  await cancelled.run('configureProxyWatchdog()');
  assert.equal(cancelled.watchdog.snapshot().enabled, false);
  assert.equal(cancelled.starts(), 0);
});

test('manual restart selects EXE once and later restarts using the saved path', async () => {
  const f = fixture();
  await f.run('restartLocalProxy()');
  assert.equal(f.starts(), 1);
  await f.run('restartLocalProxy()');
  assert.equal(f.starts(), 2);
  assert.equal(f.dialogs.length, 1);
});

test('synchronous picker failure clears the pending picker so a later selection succeeds', async () => {
  const f = fixture({ selectFile: () => { throw new Error('fixture picker unavailable'); } });
  assert.equal(await f.run('configureLocalProxy()'), false);
  f.setFilePicker(() => [{ fsPath: 'C:\\fixture\\proxy.exe' }]);
  assert.equal(await f.run('configureLocalProxy()'), true);
  assert.equal(f.errors.length, 1);
});

function pendingRecovery(now, send) {
  return createProxyRecovery({
    now: () => now,
    save: async () => {},
    send,
    plan: {
      schemaVersion: 1,
      phase: 'watching',
      startedAt: now - 360000,
      tasks: [{ threadId: 'stalled', turnId: 'turn-stalled', state: 'pending',
        capturedAt: now - 360000, nextAttemptAt: now - 350000, attempts: 0 }]
    }
  });
}

test('one running task idle for five minutes can restart while old recovery is still pending', async () => {
  const now = Date.now();
  const task = { threadId: 'stalled', turnId: 'turn-stalled', stateKind: 'running', lastActivity: now - 300001 };
  const recovery = pendingRecovery(now, async () => { throw new Error('A running chat must not be continued'); });
  const f = fixture({
    executablePath: 'fixture.exe', watchdogSettings: { enabled: true, minutes: 5 },
    now: () => now, lastAttemptAt: now - 360000, recovery,
    observation: () => ({ active: [], nonRunning: [], monitor: { complete: true, checkedAt: now, tasks: [task], roots: [task] } })
  });
  await f.run('refreshActiveChats(true)');
  assert.equal(recovery.snapshot().pendingCount, 1);
  assert.equal(f.starts(), 1);
});

test('a recovery send requires a fresh scan before considering another automatic reset', async () => {
  const now = Date.now();
  let sends = 0;
  const recovery = pendingRecovery(now, async () => { sends += 1; return { turnId: 'continued-turn' }; });
  const oldTask = { threadId: 'another-stalled', stateKind: 'running', lastActivity: now - 300001 };
  const stopped = { threadId: 'stalled', turnId: 'turn-stalled', stateKind: 'aborted', lastActivity: now - 1000 };
  const f = fixture({
    executablePath: 'fixture.exe', watchdogSettings: { enabled: true, minutes: 5 },
    now: () => now, lastAttemptAt: now - 360000, recovery,
    observation: () => ({ active: [], nonRunning: [], monitor: { complete: true, checkedAt: now, tasks: [oldTask], roots: [stopped, oldTask] } })
  });
  await f.run('refreshActiveChats(true)');
  assert.equal(sends, 1);
  assert.equal(f.starts(), 0);
});
