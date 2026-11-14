'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const alerts = require('../../src/codex_error_alerts');
const soundModule = require('../../src/codex_error_sound');

async function fixture(t, options = {}) {
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
  const copied = [];
  const attentionSounds = [];
  const spokenReminders = [];
  const spokenInitials = [];
  const spokenCompletions = [];
  let attentionTime = 0;
  let liveThreads = [];
  let selectedFile;
  const vscode = {
    env: { clipboard: { writeText: async text => { if (options.clipboardError) throw new Error('Clipboard unavailable'); copied.push(text); } } },
    extensions: { getExtension: () => undefined, all: [] },
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
    extensionUri: { fsPath: path.join(__dirname, '../..') },
    globalStorageUri: { fsPath: path.join(directory, 'storage') },
    globalState: {
      get: (key, fallback) => saved.findLast(item => item.key === key)?.value ?? fallback,
      update: async (key, value) => saved.push({ key, value: structuredClone(value) })
    },
    subscriptions: []
  };
  const filename = path.join(__dirname, '../../extension.js');
  const localRequire = createRequire(filename);
  const context = vm.createContext({
    require: name => name === 'vscode' ? vscode : name === './src/codex_error_alerts' ? {
      ...alerts,
      createRetryLimitMonitor: options => alerts.createRetryLimitMonitor({ ...options, notify: async event => sounds.push(event) })
    } : name === './src/codex_error_sound' ? {
      ...soundModule,
      createErrorSoundController: options => soundModule.createErrorSoundController({ ...options, play: async settings => previews.push(settings.file) })
    } : name === './src/codex_live_backend' ? { ...localRequire(name), createSessionReader: undefined, readAttentionInLocalBackend: async () => liveThreads }
      : name === './src/codex_attention' ? { ...localRequire(name), createSessionReader: undefined,
        createAttentionMonitor: settings => localRequire(name).createAttentionMonitor({ ...settings, now: () => attentionTime,
          notify: options.useActualAttentionDispatch ? settings.notify : async event => attentionSounds.push(event.threadId) }) }
      : name === './src/codex_attention_voice' ? { ...localRequire(name), createSessionReader: undefined, speakAttentionReminder: async event => spokenReminders.push(event),
        speakAttentionInitial: async event => spokenInitials.push(event), speakCompletion: async type => spokenCompletions.push(type) }
      : name === './src/tracker' && options.runningDelete ? { ...localRequire(name), createSessionReader: undefined, scanConversationSessions: async () => ({ active: [{ threadId: 'busy' }], nonRunning: [] }) }
      : localRequire(name),
    process, module: { exports: {} }, console, setInterval, clearInterval, setTimeout, clearTimeout,
    fixtureContext: extensionContext
  });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const run = expression => vm.runInContext(expression, context);
  t.after(async () => {
    run('attentionMonitor?.dispose();errorMonitor?.dispose();completionSounds?.dispose();planState.clear()');
    for (const item of extensionContext.subscriptions) item.dispose?.();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    await fsp.rm(directory, { recursive: true, force: true });
  });
  return { directory, rollout, sounds, saved, opened, shown, errors, previews, copied, run, extensionContext, attentionSounds,
    spokenReminders, spokenInitials, spokenCompletions, setAttentionTime: value => { attentionTime = value; },
    setThreads: value => { liveThreads = value; }, selectFile: value => { selectedFile = value; } };
}

test('deeplink copy targets the options chat and reports clipboard failure without a success ACK', async t => {
  const f = await fixture(t);
  f.run('trackerView={webview:{postMessage:m=>(globalThis.copyReplies ||= []).push(m)}}');
  await f.run('copyChatDeeplink({threadId:"other-chat",requestId:"copy-1"})');
  assert.deepEqual(f.copied, ['codex://threads/other-chat']);
  assert.equal(f.run('copyReplies[0].requestId'), 'copy-1');
  assert.equal(f.run('copyReplies[0].error'), '');
  await f.run('copyChatDeeplink({threadId:"bad/path",requestId:"copy-2"})');
  assert.equal(f.copied.length, 1); assert.ok(f.run('copyReplies[1].error'));
  f.run('vscode.env.clipboard.writeText=async()=>{throw new Error("Clipboard unavailable")}');
  await f.run('copyChatDeeplink({threadId:"other-chat",requestId:"copy-3"})');
  assert.match(f.run('copyReplies[2].error'), /Clipboard unavailable/);
});

test('delete race failure is sent back to the list with the affected chat ID', async t => {
  const f = await fixture(t, { runningDelete: true });
  f.run(`postViewState=()=>{globalThis.lastDeletion=deleteNotice&&{...deleteNotice}};
    nonRunningChats=[{threadId:'busy',title:'Previously stopped'}];
    vscode.window.showWarningMessage=async()=> 'Xóa chat';`);
  await f.run('deleteChat("busy")');
  assert.equal(f.run('deleteBusy'), false);
  assert.equal(f.run('lastDeletion.kind'), 'error');
  assert.equal(f.run('lastDeletion.threadId'), 'busy');
  assert.match(f.run('lastDeletion.text'), /Không xoá được.*Chat đang chạy/);
});

test('installed alert dispatch handles real async rollout shape through answer without native wait flags', async t => {
  const f = await fixture(t, { useActualAttentionDispatch: true });
  f.setThreads([{ id: 'fixture-thread', name: 'MathType', path: f.rollout, status: { type: 'active', activeFlags: [] } }]);
  const callId = 'call-async';
  const records = [
    { type: 'event_msg', payload: { type: 'task_started' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'request_user_input_async', call_id: callId, arguments: JSON.stringify({questions:[{title:'Đóng MathType',options:['Đã đóng','Cài sau']}]}) } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output: '{"accepted":true}' } }
  ];
  await fsp.appendFile(f.rollout, records.map(r => JSON.stringify(r)+'\n').join(''));
  f.run('contextRef=fixtureContext;startErrorMonitoring(fixtureContext)');
  await f.run('attentionMonitor.poll()');
  assert.equal(f.spokenInitials.length, 1);
  assert.ok(f.run('attentionEntries["fixture-thread"].flags.includes("waitingOnUserInput")'));
  const reply = { type: 'response_item', payload: { type: 'message', role: 'user', content: [{type:'input_text',text:'<send_user_message_question_reply>\n'+JSON.stringify([{questionItemId:JSON.stringify(['request_user_input_async',callId,0]),answer:''}])+'\n</send_user_message_question_reply>'}] } };
  await fsp.appendFile(f.rollout, JSON.stringify(reply)+'\n'); await f.run('attentionMonitor.poll()');
  assert.equal(f.run('attentionEntries["fixture-thread"]'), undefined); assert.equal(f.spokenInitials.length, 1);
  await fsp.appendFile(f.rollout, records.map(r => JSON.stringify(r)+'\n').join(''));
  await f.run('attentionMonitor.poll()'); assert.equal(f.spokenInitials.length, 2);
  await f.run(`asyncInputs.resolve('fixture-thread', [JSON.stringify(['request_user_input_async', 'call-async', 0])])`);
  await f.run('attentionMonitor.poll()');
  assert.equal(f.run('attentionEntries["fixture-thread"]'), undefined);
  for (const at of [300000, 600000]) { f.setAttentionTime(at); await f.run('attentionMonitor.poll()'); }
  assert.equal(f.spokenReminders.length, 0);
  assert.ok(f.saved.some(entry => entry.key === 'codexSessionTracker.resolvedInputs.v1'));
});

test('extension saves a series for the requested chat and echoes the request without starting a chat', async t => {
  const f = await fixture(t);
  f.run(`
    const seriesMessages = [], seriesSaves = [];
    contextWatch = createContextWatch({ save: async value => seriesSaves.push(value), read: async () => ({ percent: null }) });
    activeChats = [{ threadId: 'target', title: 'Original target' }, { threadId: 'focused', title: 'Focused chat' }];
    selected = { threadId: 'focused' };
    trackerView = { webview: { postMessage: message => seriesMessages.push(message) } };
    postViewState = () => {};
  `);
  t.after(() => f.run('contextWatch.dispose()'));
  await f.run(`setContextSeries({threadId:'target',requestId:'save-1',series:{code:'duan',nextNumber:'25'}})`);
  const result = JSON.parse(f.run('JSON.stringify(seriesMessages.at(-1))'));
  assert.equal(result.type, 'contextSeriesSaved'); assert.equal(result.threadId, 'target'); assert.equal(result.requestId, 'save-1');
  assert.deepEqual(result.series, { code: 'duan', nextNumber: '0025' });
  assert.equal(result.data.entries.target.enabled, false); assert.equal(result.data.entries.target.title, 'Original target');
  assert.equal(result.data.entries.focused, undefined);
  await f.run(`setContextSeries({threadId:'target',requestId:'save-2',series:{code:'BAD-ID',nextNumber:'25'}})`);
  assert.match(f.run('seriesMessages.at(-1).error'), /ID/);
  assert.equal(f.run('seriesSaves.length'), 1);
  await f.run(`setContextSeries({threadId:'target',requestId:'save-3',series:null})`);
  assert.equal(f.run('seriesMessages.at(-1).series'), null);
});

test('extension speaks the approved initial phrase and retains cumulative 5/10/15-minute reminders', async t => {
  const f = await fixture(t, { useActualAttentionDispatch: true });
  f.run('contextRef=fixtureContext;startErrorMonitoring(fixtureContext)');
  await f.run('attentionMonitor.poll()');
  f.setThreads([{ id: 'pending', status: { type: 'active', activeFlags: ['waitingOnApproval'] } }]);
  await f.run('attentionMonitor.poll()');
  assert.deepEqual(Array.from(f.spokenInitials[0].newFlags), ['waitingOnApproval']);
  assert.equal(f.previews.length, 0);
  for (const minute of [5, 10, 15]) {
    f.setAttentionTime(minute * 60000); await f.run('attentionMonitor.poll()');
  }
  assert.deepEqual(f.spokenReminders.map(e => e.waits[0].elapsedMinutes), [5, 10, 15]);
  assert.equal(f.spokenInitials.length, 1);
  f.setThreads([]); await f.run('attentionMonitor.poll()');
  f.setAttentionTime(20 * 60000); await f.run('attentionMonitor.poll()');
  assert.equal(f.spokenReminders.length, 3);
});

test('default preview plays both approved phrases; explicit custom MP3 still overrides initial alerts only', async t => {
  const f = await fixture(t, { useActualAttentionDispatch: true });
  f.run('contextRef=fixtureContext;startErrorMonitoring(fixtureContext)');
  await f.run('previewUserInputSound()');
  assert.deepEqual(Array.from(f.spokenInitials[0].flags), ['waitingOnApproval', 'waitingOnUserInput']);
  const custom = path.join(f.directory, 'custom.mp3'); await fsp.writeFile(custom, 'fixture');
  f.selectFile(custom); await f.run('configureUserInputSound()');
  f.setThreads([{ id: 'pending', status: { type: 'active', activeFlags: ['waitingOnUserInput'] } }]);
  await f.run('attentionMonitor.poll()');
  assert.equal(f.previews.at(-1), custom); assert.equal(f.spokenInitials.length, 1);
  f.setAttentionTime(5 * 60000); await f.run('attentionMonitor.poll()');
  assert.equal(f.spokenReminders.length, 1);
});

test('sound settings gate initial prompts and terminal speech without muting unrelated enabled categories', async t => {
  const f = await fixture(t, { useActualAttentionDispatch: true });
  f.run('contextRef=fixtureContext;startErrorMonitoring(fixtureContext)');
  await f.run('soundSettings.update({types:{approval_initial:false,chat_failed:false}})');
  f.setThreads([{ id: 'pending', status: { type: 'active', activeFlags: ['waitingOnApproval', 'waitingOnUserInput'] } }]);
  await f.run('attentionMonitor.poll()');
  assert.equal(f.spokenInitials.length, 1); assert.deepEqual(Array.from(f.spokenInitials[0].newFlags), ['waitingOnUserInput']);
  await f.run("playSoundType('chat_completed')"); await f.run("playSoundType('chat_failed')");
  assert.deepEqual(f.spokenCompletions, ['chat_completed']);
  await f.run('soundSettings.update({enabled:false})');
  await f.run("playSoundType('chat_completed')"); assert.equal(f.spokenCompletions.length, 1);
  await f.run("playSoundType('chat_failed',undefined,true)"); assert.equal(f.spokenCompletions.at(-1), 'chat_failed');
});

test('failure panel actions use the explicit thread and reject stale turns before routing', async t => {
  const f = await fixture(t);
  f.run(`globalThis.failureCalls=[];postViewState=()=>{};selected={threadId:'other'};
    failureRecovery={snapshot:()=>({entries:{failed:{turnId:'turn'}}}),
      act:async(...args)=>failureCalls.push(args),diagnose:async(...args)=>failureCalls.push(['diagnose',...args]),
      dismiss:async(...args)=>failureCalls.push(['dismiss',...args]),setAutoResume:async value=>failureCalls.push(['auto',value])};
    openHandoffDialog=async id=>failureCalls.push(['transfer',id]);`);
  await f.run("handleFailureAction({threadId:'failed',turnId:'stale',action:'retry'})");assert.equal(f.run('failureCalls.length'),0);
  await f.run("handleFailureAction({threadId:'failed',turnId:'turn',action:'retry'})");
  await f.run("handleFailureAction({threadId:'failed',turnId:'turn',action:'transfer'})");
  await f.run("handleFailureAction({action:'auto',enabled:true})");
  assert.deepEqual(JSON.parse(f.run('JSON.stringify(failureCalls)')),[['failed','turn','retry'],['transfer','failed'],['auto',true]]);
  assert.equal(f.run('selected.threadId'),'other');
});

test('quota speech uses the central switches while preserving sampling and the large-change threshold', async t => {
  const f = await fixture(t);
  f.run('contextRef=fixtureContext;startErrorMonitoring(fixtureContext);globalThis.quotaSpoken=[];usageVoice={speak:async event=>quotaSpoken.push(event)};usageVoiceSettings=normalizeUsageVoiceSettings({largeChangePercent:8})');
  await f.run('soundSettings.update({types:{quota_change:true,quota_large_change:false}})');
  const sample = (at, used) => f.run(`processUsageVoice({checkedAt:${at},groups:[{id:'codex',accountKey:'fixture',windows:[{key:'primary',usedPercent:${used},resetsAt:999999}]}]})`);
  await sample(1000, 60); await sample(2000, 65); await sample(3000, 75);
  assert.equal(f.run('quotaSpoken.length'), 2); assert.equal(f.run('quotaSpoken[1].largeChange'), false);
  await f.run('soundSettings.update({types:{quota_change:false,quota_large_change:true}})');
  await sample(4000, 77); assert.equal(f.run('quotaSpoken.length'), 2);
  await sample(5000, 86); assert.equal(f.run('quotaSpoken.length'), 3); assert.equal(f.run('quotaSpoken[2].largeChange'), true);
  await f.run('soundSettings.update({enabled:false})'); await sample(6000, 96); assert.equal(f.run('quotaSpoken.length'), 3);
});

test('live waiting states reach the Tracker webview and clear without repeating the beep', async t => {
  const f = await fixture(t);
  f.run('contextRef=fixtureContext;globalThis.viewMessages=[];trackerView={webview:{postMessage:m=>viewMessages.push(m)}};startErrorMonitoring(fixtureContext)');
  await f.run('attentionMonitor.poll()');
  f.setThreads([{ id: 'pending', name: 'Pending chat', status: { type: 'active', activeFlags: ['waitingOnApproval'] } }]);
  await f.run('attentionMonitor.poll()');
  f.run('postViewState()');
  assert.equal(f.run('viewMessages.filter(m=>m.type==="state").at(-1).data.attention.pending.flags[0]'), 'waitingOnApproval');
  await f.run('attentionMonitor.poll()');
  assert.deepEqual(f.attentionSounds, ['pending']);
  f.setThreads([]); await f.run('attentionMonitor.poll()');
  assert.equal(f.run('Object.keys(viewMessages.filter(m=>m.type==="state").at(-1).data.attention).length'), 0);
});

test('completed plan remains actionable while native thread is idle and clears after the UI decision', async t => {
  const f = await fixture(t, { useActualAttentionDispatch: true });
  f.run('contextRef=fixtureContext;startErrorMonitoring(fixtureContext)');
  await f.run('attentionMonitor.poll()');
  f.setThreads([{ id: 'plan-chat', name: 'Planning task', status: { type: 'idle' } }]);
  f.run("planState.started('plan-chat','plan-turn');planState.ready('plan-chat','plan-turn')");
  await f.run('attentionMonitor.poll()'); await f.run('attentionMonitor.poll()');
  assert.equal(f.spokenInitials.length, 1);
  assert.deepEqual(Array.from(f.spokenInitials[0].newFlags), ['waitingOnPlanImplementation']);
  assert.equal(f.run("attentionMonitor.snapshot()['plan-chat'].planTurnId"), 'plan-turn');
  f.run("planState.resolved('plan-chat','plan-turn')"); await f.run('attentionMonitor.poll()');
  assert.equal(f.run('Object.keys(attentionMonitor.snapshot()).length'), 0);
});

test('extension monitors hidden panels and opens the saved conversation error history', async t => {
  const f = await fixture(t);
  await f.run('contextRef=fixtureContext;startErrorMonitoring(fixtureContext);errorMonitor.poll(config().sessionsDir)');
  assert.equal(f.extensionContext.subscriptions.length, 7);
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
  const pkg = require('../../package.json');
  assert.ok(pkg.files.includes('src/codex_error_alerts.js'));
  assert.ok(pkg.files.includes('src/codex_error_sound.js'));
  assert.ok(pkg.files.includes('src/codex_usage_history.js'));
  assert.ok(pkg.files.includes('src/codex_usage_voice.js'));
  assert.ok(pkg.files.includes('src/codex_context_compact.js'));
  assert.ok(pkg.contributes.commands.some(item => item.command === 'codexSessionTracker.configureErrorSound'));
  assert.ok(pkg.contributes.commands.some(item => item.command === 'codexSessionTracker.previewErrorSound'));
  assert.ok(pkg.contributes.commands.some(item => item.command === 'codexSessionTracker.openErrorHistory'));
  const builder = fs.readFileSync(path.join(__dirname, '../../scripts/package.ps1'), 'utf8');
  assert.ok(builder.includes('$package.files'), 'one package manifest drives the release payload');
});
