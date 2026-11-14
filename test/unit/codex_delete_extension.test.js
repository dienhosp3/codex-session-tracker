'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');

for (const outcome of ['delete', 'cancel', 'error']) test('deletion keeps stopped tab after confirmation, visibility and selection clear: ' + outcome, async () => {
  const filename = path.join(__dirname, '../../extension.js'), localRequire = createRequire(filename), calls = [], messages = [];
  let visibility, receive, run;
  const source = { threadId: 'stopped', title: 'Stopped', cwd: 'workspace' };
  const vscode = { extensions: { all: [] }, workspace: { getConfiguration: () => ({ get: (_key, value) => value }) },
    window: { showWarningMessage: async () => {
      assert.equal(run('deleteBusy'), true);
      visibility();
      assert.equal(run('showNonRunning'), true, 'revealing after confirmation must keep the chosen tab');
      return outcome === 'cancel' ? undefined : 'Xóa chat';
    } } };
  const view = { visible: true, webview: { postMessage: m => messages.push(m), onDidReceiveMessage: handler => { receive = handler; } },
    onDidChangeVisibility: handler => { visibility = handler; } };
  const context = vm.createContext({ require: name => name === 'vscode' ? vscode
    : name === './src/tracker' ? { ...localRequire(name), createSessionReader: undefined, scanConversationSessions: async () => ({ nonRunning: [source], active: [] }),
      scanSessionTree: async () => [source], buildSessionSnapshot: async () => ({ overallStatus: { kind: 'completed' } }) }
    : name === './src/codex_queue' ? { ...localRequire(name), createSessionReader: undefined, resolveCodexExecutable: async () => ({ executable: 'fixture' }) }
    : name === './src/codex_delete' ? { deleteThread: async ({ threadId }) => { calls.push(threadId); if (outcome === 'error') throw new Error('fixture delete failed'); } }
    : localRequire(name), __dirname: path.dirname(filename), process, module: { exports: {} }, console, setInterval, clearInterval, setTimeout, clearTimeout, view, messages });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  run = code => vm.runInContext(code, context);
  run(`contextRef={subscriptions:[],globalState:{get:(_key,value)=>value},workspaceState:{update:async()=>{}}};dashboardHtml=()=>'';renderStatus=()=>{};persistSelection=async()=>{};
    postViewState=()=>messages.push({type:'state',data:{showNonRunning}});refreshAll=async()=>postViewState();
    new TrackerViewProvider().resolveWebviewView(view);
    showNonRunning=true;nonRunningChats=[{threadId:'stopped',title:'Stopped',cwd:'workspace'}];selected={threadId:'stopped'};`);
  await receive({ command: 'deleteChat', threadId: 'stopped' });
  assert.equal(run('showNonRunning'), true); assert.equal(run('deleteBusy'), false);
  assert.equal(messages.some(m => m.type === 'trackerShown'), false);
  if (outcome === 'cancel') assert.deepEqual(calls, []);
  else assert.deepEqual(calls, ['stopped'], run('JSON.stringify(deleteNotice)'));
  if (outcome === 'delete') { assert.equal(run('selected'), null); assert.equal(run('deleteNotice.kind'), 'success'); }
  if (outcome === 'error') assert.equal(run('deleteNotice.kind'), 'error');
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function deletionHarness(options = {}) {
  const filename = path.join(__dirname, '../../extension.js'), localRequire = createRequire(filename);
  const source = { threadId: 'stopped', title: 'Stopped', cwd: 'workspace' };
  const events = [], deleted = [], confirmations = [];
  let receive;
  const vscode = {
    extensions: { all: [] },
    workspace: { getConfiguration: () => ({ get: (_key, value) => value }) },
    window: { showWarningMessage: (...args) => {
      events.push('confirm');
      confirmations.push(args);
      return options.confirm ? options.confirm(...args) : Promise.resolve('Xóa chat');
    } }
  };
  const view = { visible: true, webview: { postMessage() {}, onDidReceiveMessage: handler => { receive = handler; } }, onDidChangeVisibility() {} };
  const context = vm.createContext({ require: name => name === 'vscode' ? vscode
    : name === './src/tracker' ? { ...localRequire(name), createSessionReader: undefined,
      scanConversationSessions: async () => {
        events.push('scan');
        return options.scan ? options.scan(source) : { nonRunning: [source], active: [] };
      },
      scanSessionTree: async (_directory, session) => { events.push('tree'); return [session]; },
      buildSessionSnapshot: async () => {
        events.push('snapshot');
        return options.snapshot ? options.snapshot() : { overallStatus: { kind: 'completed' } };
      } }
    : name === './src/codex_queue' ? { ...localRequire(name), createSessionReader: undefined, resolveCodexExecutable: async () => {
      events.push('cli'); return { executable: 'fixture' };
    } }
    : name === './src/codex_delete' ? { deleteThread: async ({ threadId }) => {
      events.push('delete'); deleted.push(threadId);
      if (options.remove) await options.remove();
    } }
    : localRequire(name), __dirname: path.dirname(filename), process, module: { exports: {} }, console,
    setInterval, clearInterval, setTimeout, clearTimeout, view, source });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const run = code => vm.runInContext(code, context);
  run(`contextRef={subscriptions:[],globalState:{get:(_key,value)=>value},workspaceState:{update:async()=>{}}};
    dashboardHtml=()=>'';renderStatus=()=>{};persistSelection=async()=>{};postViewState=()=>{};refreshAll=async()=>{};
    new TrackerViewProvider().resolveWebviewView(view);
    showNonRunning=true;nonRunningChats=[source];selected={...source};`);
  return { run, events, deleted, confirmations, click: (threadId = 'stopped') => receive({ command: 'deleteChat', threadId }) };
}

test('delete confirmation opens synchronously and Cancel does no history or CLI work', async () => {
  const confirmation = deferred();
  const h = deletionHarness({ confirm: () => confirmation.promise });
  const pending = h.click();
  const immediateEvents = h.events.slice();
  await Promise.resolve();
  const whileOpenEvents = h.events.slice();
  confirmation.resolve(undefined);
  await pending;
  assert.deepEqual(immediateEvents, ['confirm'], 'confirmation must not wait for a history scan');
  assert.deepEqual(whileOpenEvents, ['confirm'], 'no deletion preparation while confirmation is open');
  assert.deepEqual(h.events, ['confirm'], 'Cancel must not scan history or launch a CLI');
  assert.match(h.confirmations[0][0], /Stopped/);
  assert.equal(h.confirmations[0][1].modal, true);
  assert.equal(h.confirmations[0][2], 'Xóa chat');
  assert.equal(h.run('deleteBusy'), false);
  assert.equal(h.run('selected.threadId'), 'stopped');
});

test('a stalled history scan only starts after confirmation and cannot delete early', async () => {
  const scan = deferred();
  const h = deletionHarness({ scan: () => scan.promise });
  const pending = h.click();
  const immediateEvents = h.events.slice();
  await new Promise(resolve => setImmediate(resolve));
  const waitingEvents = h.events.slice();
  const waitingDeletions = h.deleted.slice();
  scan.resolve({ nonRunning: [{ threadId: 'stopped', title: 'Stopped' }], active: [] });
  await pending;
  assert.deepEqual(immediateEvents, ['confirm']);
  assert.deepEqual(waitingEvents, ['confirm', 'scan']);
  assert.deepEqual(waitingDeletions, []);
  assert.deepEqual(h.events, ['confirm', 'scan', 'tree', 'snapshot', 'cli', 'delete']);
  assert.deepEqual(h.deleted, ['stopped']);
});

for (const state of ['running', 'missing', 'running-child']) test('rechecks ' + state + ' after confirmation before deleting', async () => {
  const confirmation = deferred();
  const h = deletionHarness({
    confirm: () => confirmation.promise,
    scan: source => state === 'running' ? { active: [source], nonRunning: [] }
      : state === 'missing' ? { active: [], nonRunning: [] } : { active: [], nonRunning: [source] },
    snapshot: () => ({ overallStatus: { kind: 'running', runningChildren: 1 } })
  });
  const pending = h.click();
  confirmation.resolve('Xóa chat');
  await pending;
  assert.equal(h.events[0], 'confirm');
  assert.ok(h.events.includes('scan'));
  assert.equal(h.events.includes('cli'), false);
  assert.deepEqual(h.deleted, []);
  assert.equal(h.run('deleteNotice.kind'), 'error');
  assert.match(h.run('deleteNotice.text'), state === 'missing' ? /Không tìm thấy/ : /chạy/);
  assert.equal(h.run('selected.threadId'), 'stopped');
  assert.equal(h.run('deleteBusy'), false);
});

for (const state of ['running', 'missing']) test('rejects cached ' + state + ' row without scanning history', async () => {
  const h = deletionHarness();
  h.run(`nonRunningChats=[];activeChats=${state === 'running' ? '[source]' : '[]'};`);
  await h.click();
  assert.deepEqual(h.events, []);
  assert.equal(h.run('deleteNotice.kind'), 'error');
  assert.equal(h.run('deleteBusy'), false);
});

test('scan failure is reported after confirmation and releases the lock for retry', async () => {
  let fail = true;
  const h = deletionHarness({ scan: source => {
    if (fail) throw new Error('fixture history unavailable');
    return { active: [], nonRunning: [source] };
  } });
  await h.click();
  assert.deepEqual(h.events, ['confirm', 'scan']);
  assert.match(h.run('deleteNotice.text'), /fixture history unavailable/);
  assert.equal(h.run('deleteBusy'), false);
  fail = false;
  await h.click();
  assert.deepEqual(h.deleted, ['stopped']);
  assert.equal(h.run('deleteNotice.kind'), 'success');
});

test('duplicate clicks are ignored through confirmation and deletion, preserving a changed selection', async () => {
  const confirmation = deferred(), removal = deferred();
  const h = deletionHarness({ confirm: () => confirmation.promise, remove: () => removal.promise });
  const pending = h.click();
  await h.click();
  h.run("selected={threadId:'other'};");
  confirmation.resolve('Xóa chat');
  await new Promise(resolve => setImmediate(resolve));
  const busyDuringDeletion = h.run('deleteBusy');
  await h.click();
  removal.resolve();
  await pending;
  assert.equal(busyDuringDeletion, true);
  assert.equal(h.confirmations.length, 1);
  assert.deepEqual(h.deleted, ['stopped']);
  assert.equal(h.run('selected.threadId'), 'other');
  assert.equal(h.run('showNonRunning'), true);
  assert.equal(h.run('deleteBusy'), false);
});
