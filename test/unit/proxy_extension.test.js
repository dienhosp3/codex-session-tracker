'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createLocalProxyController } = require('../../src/local_proxy');
const { createProxyWatchdog } = require('../../src/proxy_watchdog');
const { createProxyRecovery } = require('../../src/proxy_recovery');

function fixture(options = {}) {
  const file = path.join(__dirname, '../../extension.js');
  const localRequire = createRequire(file);
  const saved = [];
  const errors = [];
  const dialogs = [], replies = [];
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
    require: name => name === 'vscode' ? vscode : name === './src/tracker' && options.observation
      ? { ...localRequire(name), createSessionReader: undefined, scanConversationSessions: async () => options.observation() }
      : localRequire(name),
    process, module: { exports: {} }, setInterval, clearInterval, setTimeout, clearTimeout, console,
    fixtureProxy: proxy, fixtureWatchdog: watchdog, fixtureRecovery: options.recovery || null, fixtureReplies: replies
  });
  vm.runInContext(fs.readFileSync(file, 'utf8') + '\nlocalProxy=fixtureProxy;proxyWatchdog=fixtureWatchdog;proxyRecovery=fixtureRecovery;trackerView={webview:{postMessage:m=>fixtureReplies.push(m)}};postViewState=()=>{};', context, { filename: file });
  return { proxy, watchdog, saved, errors, dialogs, replies, starts: () => starts,
    setFilePicker: fn => { selectFile = fn; }, run: expression => vm.runInContext(expression, context) };
}

test('proxy dialog loads settings and saves enabled/threshold/path without restarting', async () => {
  const f = fixture();
  await f.run("handleProxyOptions({requestId:'load'},'load')");
  assert.equal(f.replies.at(-1).settings.minutes, 5);
  await f.run("handleProxyOptions({requestId:'browse'},'browse')");
  assert.equal(f.replies.at(-1).executablePath, 'C:\\fixture\\proxy.exe');
  assert.equal(f.proxy.snapshot().executablePath, '', 'browse alone must not save');
  await f.run("handleProxyOptions({requestId:'save',settings:{enabled:true,minutes:8,executablePath:'C:/fixture/proxy.exe'}},'save')");
  assert.equal(f.replies.at(-1).error, undefined);
  assert.equal(f.watchdog.snapshot().minutes, 8); assert.equal(f.watchdog.snapshot().enabled, true);
  assert.equal(f.proxy.snapshot().executablePath, 'C:/fixture/proxy.exe'); assert.equal(f.starts(), 0);
});

test('proxy dialog rejects invalid minutes and missing EXE before saving', async () => {
  const f = fixture();
  await f.run("handleProxyOptions({requestId:'bad',settings:{enabled:true,minutes:0,executablePath:'C:/proxy.exe'}},'save')");
  assert.ok(f.replies.at(-1).error); assert.equal(f.saved.length, 0);
  await f.run("handleProxyOptions({requestId:'missing',settings:{enabled:true,minutes:5,executablePath:''}},'save')");
  assert.ok(f.replies.at(-1).error); assert.equal(f.saved.length, 0);
  f.setFilePicker(() => undefined);
  await f.run("handleProxyOptions({requestId:'cancel'},'browse')");
  assert.equal(f.replies.at(-1).cancelled, true); assert.equal(f.starts(), 0);
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
