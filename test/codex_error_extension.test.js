'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const alerts = require('../codex_error_alerts');
const soundModule = require('../codex_error_sound');

async function fixture(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-error-extension-test-'));
  const sessions = path.join(directory, 'sessions');
  await fsp.mkdir(sessions);
  const rollout = path.join(sessions, 'rollout-fixture.jsonl');
  await fsp.writeFile(rollout, JSON.stringify({ type: 'session_meta', payload: { id: 'fixture-thread', source: 'vscode' } }) + '\n');
  await fsp.writeFile(path.join(directory, 'session_index.jsonl'), JSON.stringify({ id: 'fixture-thread', thread_name: 'Hello. Reply OK' }) + '\n');
  const sounds = [];
  const saved = [];
  const opened = [];
  const shown = [];
  const errors = [];
  const previews = [];
  let selectedFile;
  const vscode = {
    Uri: { file: fsPath => ({ fsPath }) },
    workspace: {
      getConfiguration: () => ({ get: (name, fallback) => name === 'codexHome' ? directory : fallback }),
      openTextDocument: async uri => { opened.push(uri.fsPath); return { uri }; }
    },
    window: {
      showTextDocument: async (document, options) => { shown.push({ document, options }); },
      showErrorMessage: message => errors.push(message),
      showOpenDialog: async () => selectedFile ? [{ fsPath: selectedFile }] : undefined,
      setStatusBarMessage: () => {}
    }
  };
  const extensionContext = {
    extensionUri: { fsPath: path.join(__dirname, '..') },
    globalStorageUri: { fsPath: path.join(directory, 'storage') },
    globalState: {
      get: (_key, fallback) => fallback,
      update: async (key, value) => saved.push({ key, value: structuredClone(value) })
    },
    subscriptions: []
  };
  const filename = path.join(__dirname, '../extension.js');
  const localRequire = createRequire(filename);
  const context = vm.createContext({
    require: name => name === 'vscode' ? vscode : name === './codex_error_alerts' ? {
      ...alerts,
      createRetryLimitMonitor: options => alerts.createRetryLimitMonitor({ ...options, notify: async event => sounds.push(event) })
    } : name === './codex_error_sound' ? {
      ...soundModule,
      createErrorSoundController: options => soundModule.createErrorSoundController({ ...options, play: async settings => previews.push(settings.file) })
    } : localRequire(name),
    process, module: { exports: {} }, console, setInterval, clearInterval, setTimeout, clearTimeout,
    fixtureContext: extensionContext
  });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const run = expression => vm.runInContext(expression, context);
  t.after(async () => {
    run('errorMonitor?.dispose()');
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    await fsp.rm(directory, { recursive: true, force: true });
  });
  return { directory, rollout, sounds, saved, opened, shown, errors, previews, run, extensionContext, selectFile: value => { selectedFile = value; } };
}

test('extension monitors hidden panels and opens the saved conversation error history', async t => {
  const f = await fixture(t);
  await f.run('contextRef=fixtureContext;startErrorMonitoring(fixtureContext);errorMonitor.poll(config().sessionsDir)');
  assert.equal(f.extensionContext.subscriptions.length, 1);
  await fsp.appendFile(f.rollout, JSON.stringify({
    timestamp: new Date(Date.now() + 1000).toISOString(), type: 'event_msg',
    payload: { type: 'task_complete', turn_id: 'failed-turn', error: {
      message: 'exceeded retry limit, last status: 429 Too Many Requests',
      codex_error_info: { response_too_many_failed_attempts: { http_status_code: 429 } }
    } }
  }) + '\n');
  await f.run('trackerView={visible:false};refreshActiveChats=async()=>{};refreshTrackedStatus=async()=>{};postViewState=()=>{};refreshAll(false)');
  await f.run('errorMonitor.poll(config().sessionsDir)');
  assert.equal(f.sounds.length, 1);
  assert.equal(f.sounds[0].title, 'Hello. Reply OK');
  assert.ok(f.saved.some(item => item.key === 'codexSessionTracker.retryErrorMonitor.v1'));
  await f.run('openErrorHistory()');
  assert.equal(f.opened.length, 1);
  assert.equal(f.opened[0], path.join(f.directory, 'storage', 'codex-retry-errors.jsonl'));
  assert.equal(f.shown[0].options.preview, false);
  assert.match(await fsp.readFile(f.opened[0], 'utf8'), /Hello\. Reply OK/);
  assert.deepEqual(f.errors, []);
});

test('history view failures report an actionable error without clearing saved history', async t => {
  const f = await fixture(t);
  await f.run('contextRef=fixtureContext;startErrorMonitoring(fixtureContext);errorMonitor.poll(config().sessionsDir)');
  f.run('vscode.workspace.openTextDocument=async()=>{throw new Error("fixture editor unavailable")}');
  await f.run('openErrorHistory()');
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0], /fixture editor unavailable/);
  assert.equal(f.shown.length, 0);
  assert.equal(await fsp.readFile(path.join(f.directory, 'storage', 'codex-retry-errors.jsonl'), 'utf8'), '');
});

test('sound selection persists and previews once; cancelling preserves the selection', async t => {
  const f = await fixture(t);
  await f.run('contextRef=fixtureContext;startErrorMonitoring(fixtureContext);errorMonitor.poll(config().sessionsDir)');
  assert.equal(await f.run('configureErrorSound()'), false);
  const file = path.join(f.directory, 'error_429.mp3');
  await fsp.writeFile(file, 'ID3-fixture');
  f.selectFile(file);
  assert.equal(await f.run('configureErrorSound()'), true);
  assert.ok(f.saved.some(item => item.key === 'codexSessionTracker.errorSoundFile.v1' && item.value === file));
  await f.run('previewErrorSound()');
  assert.deepEqual(f.previews, [file]);
  f.selectFile(undefined);
  assert.equal(await f.run('configureErrorSound()'), false);
  assert.equal(f.run('errorSound.snapshot().file'), file);
  assert.deepEqual(f.errors, []);
});

test('release metadata includes the error monitor, MP3 module and commands', () => {
  const pkg = require('../package.json');
  assert.ok(pkg.files.includes('codex_error_alerts.js'));
  assert.ok(pkg.files.includes('codex_error_sound.js'));
  assert.ok(pkg.files.includes('codex_usage_history.js'));
  assert.ok(pkg.files.includes('codex_usage_voice.js'));
  assert.ok(pkg.files.includes('codex_context_compact.js'));
  assert.ok(pkg.contributes.commands.some(item => item.command === 'codexSessionTracker.configureErrorSound'));
  assert.ok(pkg.contributes.commands.some(item => item.command === 'codexSessionTracker.previewErrorSound'));
  assert.ok(pkg.contributes.commands.some(item => item.command === 'codexSessionTracker.openErrorHistory'));
  const builder = fs.readFileSync(path.join(__dirname, '../build-vsix.sh'), 'utf8');
  assert.match(builder, /cp "\$ROOT\/codex_error_alerts\.js" "\$STAGE\/extension\/codex_error_alerts\.js"/);
  assert.match(builder, /cp "\$ROOT\/codex_error_sound\.js" "\$STAGE\/extension\/codex_error_sound\.js"/);
  assert.match(builder, /cp "\$ROOT\/codex_usage_history\.js" "\$STAGE\/extension\/codex_usage_history\.js"/);
  assert.match(builder, /cp "\$ROOT\/codex_usage_voice\.js" "\$STAGE\/extension\/codex_usage_voice\.js"/);
  assert.match(builder, /cp "\$ROOT\/codex_context_compact\.js" "\$STAGE\/extension\/codex_context_compact\.js"/);
});
