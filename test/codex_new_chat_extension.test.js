'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { createRequire } = require('node:module');

async function fixture(t, settings = new Map()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'new-chat-extension-'));
  await fs.writeFile(path.join(root, 'models_cache.json'), JSON.stringify({ models: [
    { slug: 'model', context_window: 272000, max_context_window: 872000, effective_context_window_percent: 95 },
    { slug: 'model-small', context_window: 128000, max_context_window: 256000, effective_context_window_percent: 95 }
  ] }));
  const calls = [], replies = [], errors = [], opened = [];
  let gate, saveError = false, createError, navigateError;
  const backend = { readCreationConfig: async () => ({ model: 'model' }),
    listModels: async () => [{ id: 'model', label: 'Model', serviceTiers: [{ id: 'priority' }, { id: 'ultrafast' }] }, { id: 'model-small', label: 'Small' }],
    async createFreshChat(params) { calls.push(params); if (gate) await gate; if (createError) throw createError; return { id: 'fresh', cwd: root }; } };
  const vscode = {
    extensions: { getExtension: () => ({ isActive: true }) },
    Uri: { file: fsPath => ({ fsPath }) },
    workspace: { workspaceFolders: [{ name: 'workspace', uri: { fsPath: root } }], getConfiguration: () => ({ get: (key, fallback) => key === 'codexHome' ? root : fallback }) },
    window: {
      showQuickPick() { throw new Error('Fresh chat must use its dialog'); },
      showInputBox() { throw new Error('Fresh chat must use its dialog'); },
      createQuickPick() { throw new Error('Fresh chat must use its dialog'); },
      showOpenDialog: async () => [{ fsPath: root }],
      showErrorMessage: text => errors.push(text)
    }
  };
  const ctx = { globalState: { get: (key, fallback) => settings.get(key) ?? fallback, update: async (key, value) => {
    if (saveError) throw new Error('Cannot save selection'); settings.set(key, value);
  } } };
  const filename = path.join(__dirname, '../extension.js'), localRequire = createRequire(filename);
  const context = vm.createContext({ require: name => name === 'vscode' ? vscode : name === './codex_live_backend' ? { ...localRequire(name), newChatBackend: () => backend }
    : name === './codex_navigation' ? { createConversationNavigator: () => async id => { if (navigateError) throw navigateError; opened.push(id); } } : localRequire(name),
    __dirname: path.dirname(filename), process, module: { exports: {} }, console, setInterval, clearInterval, setTimeout, clearTimeout, ctx, root, replies });
  vm.runInContext(await fs.readFile(filename, 'utf8'), context, { filename });
  const run = source => vm.runInContext(source, context);
  run(`contextRef=ctx;postViewState=()=>{};prepareOwnerBridge=async()=>{};refreshActiveChats=async()=>{};openTracker=async()=>{};
    trackerView={webview:{postMessage:message=>replies.push(message)}};
    contextWatch=createContextWatch({save:async()=>{},read:async()=>({percent:null})});
    selected={threadId:'unrelated',cwd:'wrong-workspace'};activeChats=[{threadId:'source',cwd:root}];`);
  t.after(() => run('contextWatch.dispose()'));
  const form = run('getNewChatForm()');
  return { run, form, calls, replies, errors, opened, settings, root,
    submit: (patch = {}) => form.submit({ requestId: 'create-1', cwd: root, preset: '600k', message: 'Build a fresh task\nKeep Unicode: tiếng Việt', ...patch }),
    setGate: promise => { gate = promise; }, failSave: () => { saveError = true; },
    failCreate: error => { createError = error; }, failNavigate: () => { navigateError = new Error('Sidebar unavailable'); } };
}

test('dialog options show four K presets and saved context without creating or sending a task', async t => {
  const f = await fixture(t);
  await f.form.save({ requestId: 'save', preset: '900k' });
  await f.form.load({ requestId: 'options' });
  const result = f.replies.at(-1);
  assert.equal(result.preset, '900k'); assert.equal(result.cwd, f.root);
  assert.deepEqual(Array.from(result.choices, c => c.preset), ['default', '400k', '600k', '900k']);
  assert.equal(result.choices[0].capacity, '272K'); assert.equal(result.choices[3].detail, 'Dùng 828,4K');
  assert.deepEqual(Array.from(result.models, item => item.id), ['model', 'model-small']);
  assert.equal(f.calls.length, 0);
  const restored = await fixture(t, f.settings);
  await restored.form.load({ requestId: 'reload' }); assert.equal(restored.replies.at(-1).preset, '900k');
});

test('new-chat speed is remembered, validated against the model and passed to creation', async t => {
  const f = await fixture(t);
  await f.form.saveSpeed({ requestId: 'speed', serviceTier: 'ultrafast' });
  await f.form.load({ requestId: 'options' });
  assert.equal(f.replies.at(-1).serviceTier, 'ultrafast');
  assert.deepEqual(Array.from(f.replies.at(-1).speeds, speed => speed.available), [true, true, true]);
  await f.submit({ serviceTier: 'ultrafast' });
  assert.equal(f.calls[0].serviceTier, 'ultrafast');
  assert.equal(f.run('contextWatch.snapshot().entries.fresh.serviceTier'), 'ultrafast');
  const restored = await fixture(t, f.settings);
  await restored.form.load({ requestId: 'reload' }); assert.equal(restored.replies.at(-1).serviceTier, 'ultrafast');
  await restored.submit({ model: 'model-small', serviceTier: 'ultrafast' });
  assert.equal(restored.calls.length, 0); assert.match(restored.replies.at(-1).error, /chưa khả dụng/);
});

test('dialog submit preserves multiline Unicode, resolves trusted config and creates independently of selection', async t => {
  const f = await fixture(t);
  await f.submit({ model: 'model', contextConfig: { model_context_window: 1 } });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].cwd, f.root);
  assert.equal(f.calls[0].model, 'model'); assert.equal(f.calls[0].contextConfig.model_context_window, 600000);
  assert.equal(f.calls[0].message, 'Build a fresh task\nKeep Unicode: tiếng Việt'); assert.equal(f.calls[0].threadId, undefined);
  assert.deepEqual(f.opened, ['fresh']); assert.equal(f.run('newChatDefault()'), '600k');
  assert.equal(f.run('contextWatch.snapshot().entries.fresh.contextPreset'), '600k');
  assert.equal(f.replies.at(-1).success, true); assert.equal(f.run('newChatBusy'), false);
});

test('model selection persists, updates context metadata and reaches thread creation unchanged', async t => {
  const f = await fixture(t);
  await f.form.load({ requestId: 'small', model: 'model-small' });
  assert.equal(f.replies.at(-1).model, 'model-small');
  assert.equal(f.replies.at(-1).choices[0].capacity, '128K');
  assert.equal(f.replies.at(-1).choices[0].detail, 'Dùng 121,6K');
  const restored = await fixture(t, f.settings);
  await restored.form.load({ requestId: 'reopen' }); assert.equal(restored.replies.at(-1).model, 'model-small');
  await restored.submit({ model: 'model-small', preset: 'default' });
  assert.equal(restored.calls[0].model, 'model-small'); assert.equal(restored.calls[0].contextConfig.model_context_window, 128000);
});

test('Tracker new-chat creation applies the saved automatic threshold before inheriting context selection', async t => {
  const f = await fixture(t);
  await f.run("getNewChatContextRule().update({enabled:true,scope:'tracker',thresholdPercent:85})");
  await f.form.load({ requestId: 'unavailable', cwd: path.join(f.root, 'missing') });
  assert.ok(f.replies.at(-1).error); assert.equal(f.replies.at(-1).autoContext.enabled, true);
  assert.equal(f.replies.at(-1).autoContext.thresholdPercent, 85);
  await f.submit();
  assert.equal(f.run('contextWatch.snapshot().entries.fresh.enabled'), true);
  assert.equal(f.run('contextWatch.snapshot().entries.fresh.thresholdPercent'), 85);
  assert.equal(f.run('contextWatch.snapshot().entries.fresh.contextPreset'), '600k');
});

test('browse returns the chosen directory to the same dialog and load failures stay inline', async t => {
  const f = await fixture(t);
  await f.form.load({ requestId: 'browse' }, true);
  assert.equal(f.replies.at(-1).cwd, f.root); assert.equal(f.calls.length, 0);
  await f.form.load({ requestId: 'missing', cwd: path.join(f.root, 'missing') });
  assert.equal(f.replies.at(-1).requestId, 'missing'); assert.ok(f.replies.at(-1).error);
  assert.equal(f.errors.length, 0);
});

test('duplicate submits replay the acknowledgement and concurrent different submits cannot create twice', async t => {
  const f = await fixture(t); let release;
  f.setGate(new Promise(resolve => { release = resolve; }));
  const first = f.submit();
  for (let i = 0; i < 100 && !f.calls.length; i++) await new Promise(r => setTimeout(r, 5));
  const duplicate = f.submit();
  await f.submit({ requestId: 'other' }); assert.equal(f.replies.at(-1).delivery, 'not_sent');
  release(); await Promise.all([first, duplicate]);
  await f.submit(); assert.equal(f.calls.length, 1); assert.equal(f.replies.at(-1).success, true);
});

test('invalid fields and storage errors appear inline before any task is sent', async t => {
  const f = await fixture(t);
  for (const [i, patch] of [{ message: '  ' }, { cwd: 'relative' }, { preset: 'bad' }, { model: 'untrusted-model' }].entries()) {
    await f.submit({ requestId: 'invalid-' + i, ...patch }); assert.equal(f.replies.at(-1).delivery, 'not_sent');
  }
  f.failSave(); await f.submit();
  assert.match(f.replies.at(-1).error, /Cannot save selection/); assert.equal(f.calls.length, 0);
  assert.equal(f.errors.length, 0); assert.equal(f.run('newChatBusy'), false);
});

test('uncertain delivery and created-chat navigation errors retain recovery identity without resending', async t => {
  const f = await fixture(t); f.failCreate(Object.assign(new Error('Timeout'), { delivery: 'unknown' }));
  await f.submit(); await f.submit();
  assert.equal(f.calls.length, 1); assert.equal(f.replies.at(-1).delivery, 'unknown');
  const second = await fixture(t); second.failNavigate(); await second.submit();
  assert.equal(second.replies.at(-1).delivery, 'created'); assert.equal(second.replies.at(-1).threadId, 'fresh');
  await second.submit(); assert.equal(second.calls.length, 1);
});

test('palette opens the dialog after the ready handshake and packaged HTML includes its complete UI', async t => {
  const f = await fixture(t);
  await f.run('openNewChatDialog()'); assert.equal(f.replies.length, 0);
  f.run('newChatDialogReady=true;showPendingNewChatDialog()');
  assert.equal(f.replies.at(-1).type, 'openNewChatDialog');
  await f.run('configureNewChatContext()'); assert.equal(f.replies.at(-1).settingsOnly, true);
  const html = f.run('dashboardHtml()');
  assert.ok(html.includes('id="newChatDialog"')); assert.ok(html.includes('textarea id="ncPrompt"'));
  assert.ok(!html.includes('__NEW_CHAT_DIALOG')); assert.ok(html.includes("command: 'submitNewChat'"));
});
