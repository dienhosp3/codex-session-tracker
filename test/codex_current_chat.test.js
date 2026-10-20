'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { createCurrentChatTracker, threadFromRoute, MESSAGE_TYPE } = require('../codex_current_chat');

function fixture() {
  const listeners = new Set();
  const disposed = new Set();
  const messages = [];
  let assigned = '';
  let writes = 0;
  const webview = {
    options: {},
    get html() { return assigned; },
    set html(value) { assigned = value; writes += 1; },
    asWebviewUri: uri => uri,
    onDidReceiveMessage(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    }
  };
  const nativeMessages = [];
  const provider = {
    initializeWebview(view) {
      view.options = { enableScripts: true, localResourceRoots: [{ toString: () => '/native' }] };
      view.onDidReceiveMessage(message => nativeMessages.push(message));
      view.html = '<head><meta http-equiv="Content-Security-Policy" content="fixture"><script type="module" src="native.js"></script></head>';
    }
  };
  const api = { window: { registerWebviewViewProvider: () => ({ dispose() {} }) } };
  const originalLoad = () => api;
  const loader = { _load: originalLoad };
  const tracker = createCurrentChatTracker({ Uri: { joinPath: (root, ...parts) => ({ toString: () => root.toString() + '/' + parts.join('/') }) } }, {
    extensionRoot: '/native',
    extensionUri: { toString: () => '/tracker' },
    moduleLoader: loader,
    onChange: value => messages.push(value)
  });
  function initialize(view = webview) {
    const scopedApi = loader._load('vscode', { filename: path.resolve('/native/out/extension.js') });
    scopedApi.window.registerWebviewViewProvider('chatgpt.sidebar', provider);
    provider.initializeWebview(view, 'sidebar', callback => {
      disposed.add(callback);
      return { dispose: () => disposed.delete(callback) };
    });
  }
  function send(route, focused = true, token = webview.html.match(/data-tracker-token="([a-f0-9]+)"/)[1]) {
    for (const listener of listeners) listener({ type: MESSAGE_TYPE, token, route, focused });
  }
  return { tracker, webview, provider, loader, api, originalLoad, initialize, send, messages, nativeMessages, listeners, disposed, writes: () => writes };
}

test('only exact local chat routes identify the current conversation', () => {
  assert.equal(threadFromRoute('/local/thread-123'), 'thread-123');
  assert.equal(threadFromRoute('/local/thread_123/?x=1'), 'thread_123');
  for (const route of ['/', '/new', '/settings', '/remote/id', '/local/', '/local/id/other', '/local/a%2Fb', null]) {
    assert.equal(threadFromRoute(route), '');
  }
});

test('API interception is scoped to the installed Codex module and restores on disposal', () => {
  const f = fixture();
  assert.equal(f.loader._load('vscode', { filename: '/another/extension.js' }), f.api);
  assert.equal(f.loader._load('fs', { filename: '/native/out/extension.js' }), f.api);
  const scoped = f.loader._load('vscode', { filename: path.resolve('/native/out/extension.js') });
  assert.notEqual(scoped, f.api);
  f.tracker.dispose();
  assert.equal(f.loader._load, f.originalLoad);
});

test('initial HTML gets an external observer before native scripts without resetting the view', () => {
  const f = fixture();
  f.initialize();
  assert.equal(f.writes(), 1);
  assert.match(f.webview.html, /<meta[^>]*><script src="\/tracker\/media\/codex_current_chat_observer.js"/);
  assert.equal(f.webview.options.localResourceRoots.length, 2);
  assert.equal(f.webview.options.enableScripts, true);
  f.tracker.dispose();
});

test('the scoped API preserves lazy getters and all namespace properties on a frozen API', () => {
  const f = fixture();
  let focused = false;
  Object.defineProperty(f.api.window, 'state', { enumerable: true, get: () => ({ focused }) });
  Object.defineProperty(f.api, 'unused', { enumerable: true, get() { throw new Error('This getter must stay lazy.'); } });
  f.api.commands = { marker: true };
  Object.freeze(f.api.window);
  Object.freeze(f.api);
  const scoped = f.loader._load('vscode', { filename: path.resolve('/native/out/extension.js') });
  assert.equal(scoped.commands, f.api.commands);
  assert.equal(scoped.window.state.focused, false);
  focused = true;
  assert.equal(scoped.window.state.focused, true);
  assert.deepEqual(Object.getOwnPropertyNames(scoped), Object.getOwnPropertyNames(f.api));
  f.tracker.dispose();
});

test('module initialization attaches the observer before a provider first writes HTML', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-observer-fixture-'));
  const filename = path.join(root, 'out', 'extension.js');
  fs.mkdirSync(path.dirname(filename));
  fs.writeFileSync(filename, `var FixtureProvider=class{async initializeWebview(view){view.options={localResourceRoots:[]};view.html='<script src="native.js"></script>';}};exports.activate=()=>new FixtureProvider();exports.original=FixtureProvider.prototype.initializeWebview;`);
  const errors = [];
  const stages = [];
  const originalCompile = Module.prototype._compile;
  const f = fixture();
  const tracker = createCurrentChatTracker({ Uri: { joinPath: (uri, ...parts) => ({ toString: () => uri.toString() + '/' + parts.join('/') }) } }, {
    extensionUri: { toString: () => '/tracker' },
    extensionRoot: root,
    onError: error => errors.push(error.message),
    onDebug: stage => stages.push(stage)
  });
  t.after(() => {
    tracker.dispose();
    f.tracker.dispose();
    delete require.cache[filename];
    fs.rmSync(root, { recursive: true, force: true });
  });
  const native = require(filename);
  const provider = native.activate();
  await provider.initializeWebview(f.webview, 'sidebar');
  assert.deepEqual(errors, []);
  assert.deepEqual(stages, ['compiled', 'prototype-attached']);
  assert.match(f.webview.html, /codex_current_chat_observer\.js/);
  assert.equal(f.writes(), 1);
  tracker.dispose();
  assert.equal(provider.initializeWebview, native.original);
  assert.equal(Module.prototype._compile, originalCompile);
});

test('route reports update inactive threads, reject invalid tokens and leave native events intact', () => {
  const f = fixture();
  f.initialize();
  f.send('/local/a');
  f.send('/local/a');
  f.send('/local/b', true, 'invalid');
  assert.deepEqual(f.messages, ['a']);
  f.send('/local/b');
  f.send('/settings');
  assert.deepEqual(f.messages, ['a', 'b', '']);
  assert.equal(f.nativeMessages.length, 0);
  for (const listener of f.listeners) listener({ type: 'ready' });
  assert.deepEqual(f.nativeMessages, [{ type: 'ready' }]);
  f.tracker.dispose();
});

test('disposing a view clears the active ID and removes the observer listener', () => {
  const f = fixture();
  f.initialize();
  f.send('/local/a');
  for (const callback of [...f.disposed]) callback();
  assert.deepEqual(f.messages, ['a', '']);
  f.tracker.dispose();
});

test('renderer observes the committed router context and preserves the original Codex API', () => {
  const sent = [];
  const timers = [];
  const events = {};
  const api = { postMessage: value => sent.push(value) };
  let acquisitions = 0;
  const route = { memoizedProps: { value: { location: { pathname: '/local/a' }, navigationType: 'POP' } } };
  const stale = { child: { memoizedProps: { value: { location: { pathname: '/local/stale' }, navigationType: 'POP' } } } };
  const container = { '__reactContainer$fixture': { ...stale, stateNode: { current: { child: route } } } };
  let mutated;
  let disconnected = false;
  const window = {
    acquireVsCodeApi: () => { acquisitions += 1; return api; },
    setTimeout: callback => { timers.push(callback); return timers.length; },
    clearTimeout() {},
    addEventListener: (name, callback) => { events[name] = callback; }
  };
  const context = vm.createContext({
    window,
    document: { currentScript: { dataset: { trackerToken: 'fixture' } }, hasFocus: () => true, getElementById: () => container, documentElement: {} },
    MutationObserver: class { constructor(callback) { mutated = callback; } observe() {} disconnect() { disconnected = true; } }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../media/codex_current_chat_observer.js'), 'utf8'), context);
  assert.equal(window.acquireVsCodeApi(), api);
  assert.equal(acquisitions, 1);
  timers.shift()();
  assert.equal(sent[0].route, '/local/a');
  route.memoizedProps.value.location.pathname = '/local/b';
  mutated();
  mutated();
  assert.equal(timers.length, 1);
  timers.shift()();
  assert.equal(sent.at(-1).route, '/local/b');
  events.blur();
  route.memoizedProps.value.location.pathname = '/';
  mutated();
  timers.shift()();
  assert.equal(sent.at(-1).focused, false);
  events.focus();
  assert.equal(sent.at(-1).focused, true);
  events.pagehide();
  assert.equal(disconnected, true);
});
