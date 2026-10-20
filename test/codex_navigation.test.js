'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createConversationNavigator, navigateSidebar, uriHandlerClass } = require('../codex_navigation');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function navigationHarness(options = {}) {
  const calls = [];
  const extension = {
    isActive: options.active !== false,
    extensionPath: 'fixture-extension',
    async activate() {
      calls.push('activate');
      await options.activation;
      extension.isActive = true;
    }
  };
  const vscode = {
    extensions: { getExtension: id => id === 'openai.chatgpt' && !options.missing ? extension : undefined },
    commands: {
      async executeCommand(command) {
        calls.push(command);
        await options.focus;
      }
    }
  };
  const open = createConversationNavigator(vscode, {
    async navigateSidebar(root, route, isCurrent) {
      assert.equal(root, extension.extensionPath);
      assert.equal(isCurrent(), true);
      calls.push(route);
      if (options.navigate) return options.navigate(route);
      return true;
    }
  });
  return { open, calls };
}

test('selection focuses Codex and opens the exact existing conversation each time', async () => {
  const h = navigationHarness();
  await h.open('first-thread');
  await h.open('second-thread');
  await h.open('second-thread');
  assert.deepEqual(h.calls, [
    'chatgpt.openSidebar', '/local/first-thread',
    'chatgpt.openSidebar', '/local/second-thread',
    'chatgpt.openSidebar', '/local/second-thread'
  ]);
});

test('inactive Codex activates once before navigation', async () => {
  const h = navigationHarness({ active: false });
  await h.open('target');
  await h.open('other');
  assert.deepEqual(h.calls, ['activate', 'chatgpt.openSidebar', '/local/target', 'chatgpt.openSidebar', '/local/other']);
});

test('invalid IDs and missing Codex fail clearly without focusing another UI', async () => {
  const h = navigationHarness();
  for (const id of ['', '../other', 'target?query', 'target/other', null]) {
    await assert.rejects(h.open(id), /ID cuộc trò chuyện/);
  }
  assert.deepEqual(h.calls, []);
  await assert.rejects(navigationHarness({ missing: true }).open('target'), /Chưa cài extension/);
});

test('rapid selections coalesce during activation and focus to the last selected thread', async () => {
  for (const phase of ['activation', 'focus']) {
    const gate = deferred();
    let current = 'first';
    const h = navigationHarness({ active: phase !== 'activation', [phase]: gate.promise });
    const first = h.open('first', () => current === 'first');
    await new Promise(resolve => setImmediate(resolve));
    current = 'second';
    const second = h.open('second', () => current === 'second');
    current = 'latest';
    const latest = h.open('latest', () => current === 'latest');
    gate.resolve();
    assert.deepEqual(await Promise.all([first, second, latest]), [false, false, true]);
    assert.deepEqual(h.calls.filter(call => call.startsWith('/local/')), ['/local/latest']);
  }
});

test('navigation errors do not poison future clicks and navigation never overlaps', async () => {
  const gate = deferred();
  const h = navigationHarness({ navigate: async route => {
    if (route === '/local/first') {
      await gate.promise;
      throw new Error('fixture navigation failure');
    }
    return true;
  } });
  const first = h.open('first');
  const failure = assert.rejects(first, /fixture navigation failure/);
  const next = h.open('next');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.includes('/local/next'), false);
  gate.resolve();
  await failure;
  assert.equal(await next, true);
});

function liveFixture(t, count = 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cst-navigation-'));
  const file = path.join(root, 'out', 'extension.js');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, `
    var RenamedUriHandler=class {
      constructor(provider){this.codexWebviewProvider=provider;}
      async handleUri(uri){this.codexWebviewProvider.navigateToRoute(uri.path);}
    };
    const routes=[];
    const provider={navigateToRoute:route=>routes.push(route)};
    module.exports={activate(){return RenamedUriHandler},routes,
      handlers:Array.from({length:${count}},()=>new RenamedUriHandler(provider))};
  `);
  const extension = require(file);
  t.after(() => {
    delete require.cache[file];
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, extension };
}

test('inspector routes through the existing renamed Codex handler in this host', async t => {
  const { root, extension } = liveFixture(t);
  assert.equal(await navigateSidebar(root, '/local/exact-thread', () => true), true);
  assert.deepEqual(extension.routes, ['/local/exact-thread']);
  assert.equal(await navigateSidebar(root, '/local/stale', () => false), false);
  assert.deepEqual(extension.routes, ['/local/exact-thread']);
});

test('unsupported Codex layouts and absent or ambiguous handlers fail without navigation', async t => {
  assert.throws(() => uriHandlerClass('unrelated extension'), /chưa hỗ trợ/);
  for (const count of [0, 2]) {
    const { root, extension } = liveFixture(t, count);
    await assert.rejects(navigateSidebar(root, '/local/target', () => true), /Không xác định/);
    assert.deepEqual(extension.routes, []);
  }
});

function selectionHarness(options = {}) {
  const file = path.join(__dirname, '../extension.js');
  const localRequire = createRequire(file);
  const opened = [];
  const errors = [];
  const tracker = {
    getCodexHome: () => os.tmpdir(),
    readThreadNames: options.names || (async () => new Map()),
    readStateThreadActivity: () => new Map(),
    findLatestRolloutForThread: async () => null,
    scanSessionTree: options.tree || (async (_directory, target) => [{ ...target, file: 'fixture-rollout' }]),
    buildSessionSnapshot: options.snapshot || (async (_directory, target) => ({ threadId: target.threadId, overallStatus: { kind: 'completed' } }))
  };
  const context = vm.createContext({
    require(name) {
      if (name === 'vscode') return {
        workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
        window: { showErrorMessage: message => errors.push(message) }
      };
      if (name === './tracker') return tracker;
      if (name === 'fs' && options.realRefresh) return {
        ...fs,
        promises: { ...fs.promises, access: async () => {} }
      };
      if (name === './codex_navigation') return {
        createConversationNavigator: () => async (id, isCurrent) => {
          if (options.open) await options.open(id, isCurrent);
          if (isCurrent()) opened.push(id);
        }
      };
      return localRequire(name);
    },
    process, module: { exports: {} }, setTimeout, clearTimeout, setInterval, clearInterval, console
  });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  vm.runInContext(`
    activeChats=[{threadId:'running',title:'Running'}];
    nonRunningChats=[{threadId:'stopped',title:'Stopped'}];
  `, context);
  if (!options.realRefresh) vm.runInContext('refreshTrackedStatus=async()=>{}', context);
  return { opened, errors, run: expression => vm.runInContext(expression, context) };
}

test('Tracker selections open running and stopped chats while keeping their details selected', async () => {
  const h = selectionHarness();
  for (const id of ['running', 'stopped', 'stopped']) {
    await h.run(`selectThread('${id}')`);
    assert.equal(h.run('selected.threadId'), id);
  }
  assert.deepEqual(h.opened, ['running', 'stopped', 'stopped']);
  assert.deepEqual(h.errors, []);
});

test('late metadata from a previous click cannot overwrite or open the newer selection', async () => {
  const gate = deferred();
  const h = selectionHarness({ names: async (_home, ids) => {
    if (ids.has('running')) await gate.promise;
    return new Map();
  } });
  const first = h.run("selectThread('running')");
  await h.run("selectThread('stopped')");
  gate.resolve();
  await first;
  assert.equal(h.run('selected.threadId'), 'stopped');
  assert.deepEqual(h.opened, ['stopped']);
});

test('clear cancels pending navigation and opening failures preserve the Tracker selection', async () => {
  const gate = deferred();
  const cleared = selectionHarness({ open: async () => gate.promise });
  const first = cleared.run("selectThread('running')");
  await new Promise(resolve => setImmediate(resolve));
  await cleared.run('clearSelection()');
  gate.resolve();
  await first;
  assert.equal(cleared.run('selected'), null);
  assert.deepEqual(cleared.opened, []);
  const failed = selectionHarness({ open: async () => { throw new Error('fixture Codex unavailable'); } });
  await failed.run("selectThread('stopped')");
  assert.equal(failed.run('selected.threadId'), 'stopped');
  assert.match(failed.errors[0], /Không mở được.*fixture Codex unavailable/);
  await failed.run("selectThread('missing')");
  assert.match(failed.errors[1], /Không tìm thấy/);
});

test('late snapshot success or failure cannot overwrite the new selected chat', async () => {
  for (const rejectOld of [false, true]) {
    const started = deferred();
    const gate = deferred();
    const h = selectionHarness({ realRefresh: true, snapshot: async (_directory, target) => {
      if (target.threadId === 'running') {
        started.resolve();
        await gate.promise;
        if (rejectOld) throw new Error('obsolete snapshot failed');
      }
      return { threadId: target.threadId, overallStatus: { kind: 'completed' } };
    } });
    const first = h.run("selectThread('running')");
    await started.promise;
    await h.run("selectThread('stopped')");
    gate.resolve();
    await first;
    assert.equal(h.run('selected.threadId'), 'stopped');
    assert.equal(h.run('latestSnapshot.threadId'), 'stopped');
    assert.equal(h.run('selectedTree[0].threadId'), 'stopped');
    assert.deepEqual(h.errors, []);
  }
});

test('clearing selection during a tree scan discards the old data without a null-selection error', async () => {
  const started = deferred();
  const gate = deferred();
  const h = selectionHarness({ realRefresh: true, tree: async (_directory, target) => {
    started.resolve();
    await gate.promise;
    return [{ ...target, file: 'fixture-rollout' }];
  } });
  const first = h.run("selectThread('running')");
  await started.promise;
  await h.run('clearSelection()');
  gate.resolve();
  await first;
  assert.equal(h.run('selected'), null);
  assert.equal(h.run('latestSnapshot'), null);
  assert.equal(h.run('selectedTree.length'), 0);
  assert.deepEqual(h.errors, []);
});
