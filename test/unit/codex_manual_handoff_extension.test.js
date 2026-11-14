'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { createRequire } = require('node:module');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manual-extension-'));
  await fs.writeFile(path.join(root, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'source-model', context_window: 272000 }, { slug: 'chosen-model', context_window: 128000 }] }));
  const calls = [], replies = [], errors = [], opened = [], settings = new Map();
  const source = { threadId: 'source', title: '[TASK-0001] Work', cwd: root, file: path.join(root, 'source.jsonl') };
  let gate, reading = { running: false, percent: 0 };
  const backend = {
    readChatTitle: async (id, fallback) => id === 'source' ? source.title : fallback,
    readGoal: async () => null,
    async setAutoAllow(params) {
      calls.push(['autoAllow', params]);
      const { currentAutoAllowStore, ASK_WORKSPACE } = require('../../src/codex_auto_allow');
      await currentAutoAllowStore().remember(params.threadId, { enabled: params.enabled, previous: ASK_WORKSPACE });
    },
    async readHandoffState(id) { calls.push(['read', id]); if (gate) await gate; return { turnId: 'live', running: false }; },
    readCreationConfig: async () => ({ model: 'default-model' }),
    listModels: async () => [{ id: 'source-model', label: 'Source', serviceTiers: [{ id: 'priority' }, { id: 'ultrafast' }] }, { id: 'chosen-model', label: 'Chosen' }],
    handoffModes: async () => ({ modes: { normal: { available: true }, goal: { available: true }, plan: { available: true } }, sourceGoal: null }),
    async stopForHandoff(entry) { calls.push(['stop', entry]); return { name: source.title, cwd: root, permissionSettings: { start: { sandbox: 'read-only' }, turn: {} } }; },
    confirmHandoffStopped: async () => ({ cwd: root, permissionSettings: { start: { sandbox: 'read-only' }, turn: {} } }),
    async createSuccessor(params) { calls.push(['create', params]); return { id: 'next', cwd: root }; },
    async renameThread(id, title) { calls.push(['rename', id, title]); if (id === 'source') source.title = title; },
    async startSuccessor(params) { calls.push(['send', params]); return { turnId: 'next-turn' }; }
  };
  const filename = path.join(__dirname, '../../extension.js'), localRequire = createRequire(filename);
  const vscode = { window: { showErrorMessage: message => errors.push(message) },
    workspace: { getConfiguration: () => ({ get: (key, fallback) => key === 'codexHome' ? root : fallback }) } };
  const ctx = { workspaceState: { get: () => ({ handoffDelaySeconds: 0 }), update: async (key, value) => settings.set(key, value) },
    globalState: { get: (key, fallback) => fallback }, globalStorageUri: { fsPath: root }, subscriptions: [] };
  const context = vm.createContext({ require: name => name === 'vscode' ? vscode
    : name === './src/codex_live_backend' ? { ...localRequire(name), createSessionReader: undefined, contextHandoffBackend: () => backend, chatPermissionsBackend: () => backend }
    : name === './src/codex_context_reader' ? { createContextReader: () => async entry => entry.threadId === 'source' ? reading : { running: false, percent: 0 } }
    : name === './src/tracker' ? { ...localRequire(name), createSessionReader: undefined, findLatestRolloutForThread: async () => source,
      readSessionRuntimeProfile: async () => ({ model: 'source-model', reasoning: 'high' }), scanSessionTree: async () => [source] }
    : localRequire(name), __dirname: path.dirname(filename), process, module: { exports: {} }, console,
    setInterval, clearInterval, setTimeout, clearTimeout, ctx, source, replies, opened });
  vm.runInContext(await fs.readFile(filename, 'utf8'), context, { filename });
  const run = code => vm.runInContext(code, context);
  run(`contextRef=ctx;configureAutoAllowStore(path.join(ctx.globalStorageUri.fsPath,'chat-permissions'));postViewState=()=>{};prepareOwnerBridge=async()=>{};refreshActiveChats=async()=>{};
    selectThread=async id=>opened.push(id);trackerView={webview:{postMessage:m=>replies.push(m)}};
    selected={threadId:'unrelated',cwd:'wrong'};activeChats=[source];startContextWatching(ctx);`);
  t.after(() => { for (const disposable of ctx.subscriptions) disposable.dispose(); });
  const form = run('getHandoffForm()');
  const submit = (patch = {}) => form.submit({ threadId: 'source', requestId: 'one', model: 'source-model', settings: {
    enabled: false, thresholdPercent: 85, handoffDelaySeconds: 0, preset: '600k', series: null, extraMessage: '' }, ...patch });
  return { run, form, submit, calls, replies, errors, opened, backend, setReading: value => { reading = value; }, setGate: value => { gate = value; } };
}

test('manual command routes the explicit source through real watch and journal despite another selected chat', async t => {
  const f = await fixture(t);
  await f.submit();
  assert.deepEqual(f.errors, []); assert.deepEqual(f.opened, ['next']);
  const stopped = f.calls.find(c => c[0] === 'stop')[1];
  assert.equal(stopped.threadId, 'source'); assert.equal(stopped.turnId, 'live'); assert.equal(stopped.manual, true);
  assert.equal(f.calls.find(c => c[0] === 'create')[1].model, 'source-model');
  const sent = f.calls.find(c => c[0] === 'send')[1];
  assert.equal(sent.message, '[TASK-0002] Tiếp tục codex://threads/source\n\nMã ID và nhãn chỉ để nhận diện chat, không đưa vào repo.'); assert.equal(sent.effort, 'high');
  assert.equal(f.run('contextWatch.tracks("next")'), false);
  assert.equal(f.replies.at(-1).requestId, 'one'); assert.equal(f.replies.at(-1).success, true);
  await f.submit({ requestId: 'duplicate' });
  assert.match(f.replies.at(-1).error, /chuyển tiếp/);
  assert.equal(f.calls.filter(c => c[0] === 'create').length, 1);
});

test('selection changes during live preflight cannot retarget the transfer; other sends stay blocked', async t => {
  const f = await fixture(t); let release;
  f.setGate(new Promise(resolve => { release = resolve; }));
  const pending = f.submit();
  for (let i = 0; i < 100 && !f.calls.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  f.run("selected={threadId:'other'}");
  await f.submit({ requestId: 'two' });
  assert.match(f.replies.at(-1).error, /chuyển tiếp/);
  release(); await pending;
  assert.equal(f.replies.at(-1).success, true);
  assert.equal(f.calls.filter(c => c[0] === 'create').length, 1);
  assert.equal(f.calls.find(c => c[0] === 'send')[1].threadId, 'next');
  assert.deepEqual(f.opened, ['next']);
});

test('missing target and concurrent actions report errors without stopping or creating a chat', async t => {
  const f = await fixture(t);
  await f.submit({ threadId: '' }); assert.match(f.replies.at(-1).error, /Chọn/);
  await f.submit({ threadId: 'missing' }); assert.match(f.replies.at(-1).error, /Không tìm thấy/);
  f.run('continueBusy=true'); await f.submit();
  assert.match(f.replies.at(-1).error, /thao tác khác/); assert.equal(f.calls.length, 0);
});

test('host auto-compaction stops the explicit source before resolving creation settings and inherits its model', async t => {
  const f = await fixture(t);
  f.run('newChatContextRule={apply:async()=>{}}');
  await f.run("contextWatch.setEntry('source',{enabled:true,thresholdPercent:99,title:source.title,file:source.file,cwd:source.cwd})");
  await f.run("contextWatch.compactionStarted({threadId:'source',turnId:'compact-turn'})");
  const handoff = f.run('contextWatch.snapshot().entries.source.handoff');
  assert.equal(handoff.phase, 'completed', JSON.stringify(handoff));
  assert.equal(handoff.trigger, 'auto_compact');
  assert.equal(f.calls[0][0], 'stop');
  assert.equal(f.calls[0][1].threadId, 'source'); assert.equal(f.calls[0][1].turnId, 'compact-turn');
  assert.equal(f.calls.find(c => c[0] === 'create')[1].model, 'source-model');
  assert.equal(f.calls.find(c => c[0] === 'send')[1].effort, 'high');
  assert.equal(f.run('contextWatch.tracks("next")'), true);
  assert.deepEqual(f.opened, ['next']);
});

test('Auto Allow options target the specified chat and can turn off independently of another selection', async t => {
  const f = await fixture(t);
  await f.run("handleChatOptions({threadId:'source',requestId:'on',options:{handoffDelaySeconds:0,intervalMs:300,completionSound:true,thresholdPercent:88,autoAllow:true}},true)");
  assert.equal(f.replies.at(-1).error, undefined); assert.equal(f.replies.at(-1).options.autoAllow, true);
  assert.equal(f.calls.find(c => c[0] === 'autoAllow')[1].threadId, 'source');
  assert.equal(f.run('currentAutoAllowStore().get("unrelated")'), undefined);
  await f.run("handleChatOptions({threadId:'source',requestId:'off',options:{handoffDelaySeconds:0,intervalMs:300,completionSound:true,thresholdPercent:88,autoAllow:false}},true)");
  assert.equal(f.replies.at(-1).options.autoAllow, false);
  assert.equal(f.run('contextWatch.getChatOptions("source").thresholdPercent'), 88);
});

test('a rejected native permission change reports failure and rolls back the other chat options', async t => {
  const f = await fixture(t);
  f.backend.setAutoAllow = async () => { throw new Error('Permission policy rejected full access'); };
  await f.run("handleChatOptions({threadId:'source',requestId:'fail',options:{handoffDelaySeconds:7,intervalMs:100,completionSound:false,thresholdPercent:90,autoAllow:true}},true)");
  assert.match(f.replies.at(-1).error, /Permission policy rejected/);
  assert.equal(f.run('currentAutoAllowStore().get("source")'), undefined);
  assert.equal(f.run('contextWatch.getChatOptions("source").thresholdPercent'), 80);
  assert.equal(f.run('contextWatch.getChatOptions("source").completionSound'), true);
});

test('dialog-selected model, context, prompt and threshold reach native creation without global defaults overriding them', async t => {
  const f = await fixture(t);
  // Saved global rule is deliberately enabled at a different threshold.
  f.run("newChatContextRule=createNewChatContextRule({value:{enabled:true,scope:'all',thresholdPercent:70},save:async()=>{},watch:()=>contextWatch})");
  await f.form.load({ threadId: 'source', requestId: 'options', model: 'chosen-model' });
  assert.equal(f.calls.length, 0); assert.equal(f.replies.at(-1).model, 'chosen-model');
  const code = 'dựÁn'.repeat(7) + '01';
  await f.submit({ model: 'chosen-model', settings: { enabled: true, thresholdPercent: 99, handoffDelaySeconds: 0,
    preset: '400k', series: { code, nextNumber: '25' }, extraMessage: 'Lập plan.\nChờ xác nhận.' } });
  assert.equal(f.replies.at(-1).success, true, f.replies.at(-1).error);
  const creation = f.calls.find(c => c[0] === 'create')[1];
  assert.equal(creation.model, 'chosen-model'); assert.equal(creation.contextConfig.model_context_window, 400000);
  assert.equal(f.calls.find(c => c[0] === 'send')[1].message, `[${code}-0025] Tiếp tục codex://threads/source\n\nMã ID và nhãn chỉ để nhận diện chat, không đưa vào repo.\n\nLập plan.\nChờ xác nhận.`);
  assert.equal(f.run('contextWatch.snapshot().entries.next.thresholdPercent'), 99);
  assert.equal(f.run('contextWatch.tracks("next")'), true);
});

test('chat options host targets the requested chat and persists the current threshold independently', async t => {
  const f = await fixture(t);
  await f.run("handleChatOptions({threadId:'source',requestId:'load'},false)");
  assert.equal(f.replies.at(-1).type, 'chatOptionsLoaded');
  assert.equal(f.replies.at(-1).options.handoffDelaySeconds, 0);
  await f.run("handleChatOptions({threadId:'source',requestId:'save',options:{handoffDelaySeconds:3,intervalMs:100,completionSound:false}},true)");
  assert.equal(f.replies.at(-1).type, 'chatOptionsSaved'); assert.equal(f.replies.at(-1).error, undefined);
  assert.equal(f.run('contextWatch.getChatOptions("source").completionSound'), false);
  assert.equal(f.run('contextWatch.getChatOptions("unrelated").completionSound'), true);
  assert.equal(f.run('contextWatch.tracks("source")'), false);
  await f.form.load({ threadId: 'source', requestId: 'handoff-options' });
  assert.equal(f.replies.at(-1).handoffDelaySeconds, 3);
  await f.run("handleChatOptions({threadId:'source',requestId:'bad',options:{handoffDelaySeconds:1,intervalMs:100,completionSound:true,thresholdPercent:100}},true)");
  assert.ok(f.replies.at(-1).error); assert.equal(f.run('contextWatch.getChatOptions("source").handoffDelaySeconds'), 3);
  assert.equal(f.calls.length, 0, 'no stop or creation while changing options');
});

test('handoff validates selected speed and keeps it on the resulting chat', async t => {
  const f = await fixture(t);
  await f.form.load({ threadId: 'source', requestId: 'load' });
  assert.equal(f.replies.at(-1).serviceTier, 'default');
  assert.deepEqual(Array.from(f.replies.at(-1).speeds, speed => speed.available), [true, true, true]);
  await f.submit({ settings: { enabled: false, thresholdPercent: 80, handoffDelaySeconds: 0, preset: '600k', series: null, extraMessage: '', serviceTier: 'ultrafast' } });
  assert.equal(f.replies.at(-1).success, true, f.replies.at(-1).error);
  assert.equal(f.calls.find(call => call[0] === 'create')[1].serviceTier, 'ultrafast');
  assert.equal(f.calls.find(call => call[0] === 'send')[1].serviceTier, 'ultrafast');
  assert.equal(f.run('contextWatch.snapshot().entries.next.serviceTier'), 'ultrafast');
});

test('host threshold path does not reject inherited Ultrafast before supported automatic speed resolution', async t => {
  const f = await fixture(t), { automaticSpeed } = require('../../src/codex_speed');
  const fastOnly = { id: 'source-model', serviceTiers: [{ id: 'priority' }] };
  f.backend.listModels = async () => [fastOnly];
  f.backend.resolveSuccessorSpeed = async params => automaticSpeed(params.serviceTier, fastOnly);
  const stop = f.backend.stopForHandoff;
  f.backend.stopForHandoff = async entry => ({ ...await stop(entry), serviceTier: 'ultrafast' });
  f.setReading({ running: true, percent: 85.645, turnId: 'reported-turn', model: 'source-model', reasoning: 'ultra', serviceTier: 'ultrafast' });
  f.run('newChatContextRule={apply:async()=>{}}');
  await f.run("contextWatch.setEntry('source',{enabled:true,thresholdPercent:85,serviceTier:'ultrafast'})");
  for (let i = 0; i < 200 && !f.run("contextWatch.snapshot().entries.source.handoff?.phase==='completed' && !contextWatch.snapshot().busy.length"); i++) await new Promise(resolve => setTimeout(resolve, 5));
  const result = f.run('contextWatch.snapshot().entries.source.handoff');
  assert.equal(result.phase, 'completed', JSON.stringify(result));
  assert.equal(result.serviceTier, 'priority'); assert.match(result.speedNotice, /Ultrafast.*Fast/);
  assert.equal(f.calls.filter(call => call[0] === 'stop').length, 1);
  assert.equal(f.calls.filter(call => call[0] === 'create').length, 1);
  assert.equal(f.calls.find(call => call[0] === 'send')[1].effort, 'ultra');
  assert.equal(f.run('contextWatch.snapshot().entries.next.serviceTier'), 'priority');
});

test('current ID and display label save before any handoff, preserve source title suffix and supply the next sequence', async t => {
  const f = await fixture(t);
  await f.run("handleChatOptions({threadId:'source',requestId:'identity',identity:{code:'dựÁn',number:'25'},expectedIdentity:{code:'TASK',number:'0001'},displayLabel:'Tên dễ nhớ',options:{handoffDelaySeconds:0,intervalMs:100,completionSound:true,thresholdPercent:85}},true)");
  assert.equal(f.replies.at(-1).error, undefined);
  assert.equal(f.replies.at(-1).title, '[dựÁn-0025] Work');
  assert.equal(f.replies.at(-1).displayLabel, 'Tên dễ nhớ');
  assert.equal(f.run('contextWatch.snapshot().entries.source.series.nextNumber'), '0026');
  assert.equal(f.run('contextWatch.tracks("source")'), false);
  assert.deepEqual(f.calls.map(c => c[0]), ['rename']);
  await f.form.load({ threadId: 'source', requestId: 'handoff-load' });
  assert.equal(f.replies.at(-1).series.code, 'dựÁn'); assert.equal(f.replies.at(-1).series.nextNumber, '0026');
  await f.run("handleChatOptions({threadId:'source',requestId:'alias-only',displayLabel:'[FAKE-9999] Chỉ là nhãn',options:{handoffDelaySeconds:0,intervalMs:100,completionSound:true,thresholdPercent:85}},true)");
  assert.equal(f.replies.at(-1).title, '[dựÁn-0025] Work');
  assert.equal(f.calls.filter(c => c[0] === 'rename').length, 1);
  assert.equal(f.run('contextWatch.snapshot().entries.source.series.code'), 'dựÁn');
});

test('permission failure after renaming the current ID restores native name and local metadata', async t => {
  const f = await fixture(t); f.backend.setAutoAllow = async () => { throw new Error('Permission rejected'); };
  await f.run("handleChatOptions({threadId:'source',requestId:'rollback',identity:{code:'NEW',number:'7'},displayLabel:'Not saved',options:{handoffDelaySeconds:0,intervalMs:300,completionSound:true,autoAllow:true}},true)");
  assert.match(f.replies.at(-1).error, /Permission rejected/);
  assert.equal(await f.backend.readChatTitle('source'), '[TASK-0001] Work');
  assert.equal(f.run('contextWatch.snapshot().entries.source'), undefined);
  assert.equal(f.calls.some(c => ['stop','create','send'].includes(c[0])), false);
});

test('options distinguish current native ID from a previously configured next-chat override', async t => {
  const f = await fixture(t);
  await f.run("contextWatch.setSeries('source',{code:'LEGACY',nextNumber:'25'})");
  await f.run("handleChatOptions({threadId:'source',requestId:'legacy'},false)");
  const reply = f.replies.at(-1);
  assert.equal(reply.identity.code, 'TASK'); assert.equal(reply.identity.number, '0001');
  assert.equal(reply.nextSeries.code, 'LEGACY'); assert.equal(reply.nextSeries.nextNumber, '0025');
  assert.equal(f.calls.length, 0);
});
