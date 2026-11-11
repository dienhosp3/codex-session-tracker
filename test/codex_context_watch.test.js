'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { parseSeries, normalizeSeries, continuationPlan, runContextHandoff } = require('../codex_context_handoff');
const { createContextWatch, validateSettings } = require('../codex_context_watch');
const { createContextReader } = require('../codex_context_reader');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check) { for (let i = 0; i < 100 && !check(); i++) await new Promise(r => setTimeout(r, 5)); assert.ok(check(), 'async work completed'); }
async function scratch(t) { const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'context-watch-')); t.after(() => fs.rm(directory, { recursive: true, force: true })); return directory; }
const event = payload => JSON.stringify({ type: 'event_msg', payload }) + '\n';

test('series uses the title prefix, preserves ID and padding, and handles more than 9999', () => {
  assert.equal(continuationPlan('old', '[QHTT-0001] Nội dung').message, '[QHTT-0002] Tiếp tục codex://threads/old\n\nMã ID và nhãn chỉ để nhận diện chat, không đưa vào repo.');
  assert.equal(continuationPlan('old', '[QHTT-9999] Nội dung').nextTitle, '[QHTT-10000] Tiếp tục');
  assert.equal(continuationPlan('old', '[ABCDEFGHIJ-000009] Nội dung').nextTitle, '[ABCDEFGHIJ-000010] Tiếp tục');
  for (const title of ['x [QHTT-0001] Nội dung', '[a-b-0001] title', '[' + 'A'.repeat(31) + '-0001] title', '[QHTT-1] title', '[QHTT-0001]suffix']) assert.equal(parseSeries(title), null);
  const plan = continuationPlan('old', 'Chat chưa có mã', [], () => 0);
  assert.equal(plan.sourceTitle, '[AAAA-0001] Chat chưa có mã');
  assert.equal(plan.nextTitle, '[AAAA-0002] Tiếp tục');
  assert.throws(() => continuationPlan('../oops', 'title'), /ID/);
});

test('settings default to 300ms and reject invalid threshold/interval values', () => {
  assert.deepEqual(validateSettings(), { intervalMs: 300, thresholdPercent: 80, handoffDelaySeconds: 10 });
  for (const thresholdPercent of [0, 100, 101, 79.5, NaN]) assert.throws(() => validateSettings({ thresholdPercent }));
  for (const intervalMs of [0, 99, 60001, 300.5, NaN]) assert.throws(() => validateSettings({ intervalMs }));
  for (const handoffDelaySeconds of [-1, 3601, 1.5, NaN]) assert.throws(() => validateSettings({ handoffDelaySeconds }));
  assert.equal(validateSettings({ handoffDelaySeconds: 0 }).handoffDelaySeconds, 0);
});

test('custom series starts at the requested number, preserves the source and validates before use', () => {
  const custom = normalizeSeries({ code: ' duan7 ', nextNumber: '25' });
  assert.deepEqual(custom, { code: 'duan7', nextNumber: '0025' });
  for (const title of ['Chat chưa có mã', '[OLD-0030] Nội dung']) {
    const plan = continuationPlan('old', title, [], undefined, custom);
    assert.equal(plan.sourceTitle, title); assert.equal(plan.renameSource, false);
    assert.equal(plan.message, '[duan7-0025] Tiếp tục codex://threads/old\n\nMã ID và nhãn chỉ để nhận diện chat, không đưa vào repo.');
    assert.deepEqual(plan.successorSeries, { code: 'duan7', nextNumber: '0026' });
  }
  assert.equal(continuationPlan('old', 'Title', [], undefined, { code: 'A', nextNumber: '9007199254740993' }).successorSeries.nextNumber, '9007199254740994');
  assert.equal(continuationPlan('old', 'Title', [], undefined, { code: 'A', nextNumber: '000099' }).successorSeries.nextNumber, '000100');
  for (const code of ['', 'A-B', 'ABC DEF', 'A'.repeat(31), '<script>', '\u0301', 'a\nB']) assert.throws(() => normalizeSeries({ code, nextNumber: '1' }), /ID/);
  for (const nextNumber of ['', '0', '0000', '-1', '1.5', '1e3', 'NaN']) assert.throws(() => normalizeSeries({ code: 'A', nextNumber }), /nguyên dương/);
});

test('series IDs preserve lowercase, digits and Vietnamese across Unicode normalization and automatic continuation', () => {
  for (const code of ['abc', '1abc', '123', 'dựÁn09', 'TiếngViệt', 'đồÁn1']) {
    assert.equal(normalizeSeries({ code: code.normalize('NFD'), nextNumber: '1' }).code, code);
    const title = `[${code.normalize('NFD')}-0099] Task`;
    assert.equal(parseSeries(title).code, code);
    const plan = continuationPlan('thread', title);
    assert.equal(plan.nextTitle, `[${code}-0100] Tiếp tục`);
    assert.equal(plan.renameSource, false);
  }
});

test('saving and resetting a series persists per chat without enabling monitoring or renaming it', async t => {
  let saved;
  const options = { save: async value => { saved = value; }, read: async () => ({ percent: null }) };
  const watch = createContextWatch(options); t.after(() => watch.dispose());
  await watch.setSeries('old', { code: 'duan', nextNumber: '25' }, { title: 'Original', cwd: 'cwd' });
  assert.equal(watch.tracks('old'), false); assert.equal(watch.snapshot().entries.old.title, 'Original');
  await watch.setSeries('other', { code: 'OTHER', nextNumber: '1' }, { title: 'Other' });
  const restored = createContextWatch({ ...options, state: saved }); t.after(() => restored.dispose());
  assert.deepEqual(restored.snapshot().entries.old.series, { code: 'duan', nextNumber: '0025' });
  await restored.setEntry('old', { enabled: true, thresholdPercent: 90 });
  await restored.setSeries('old', null);
  assert.equal(restored.tracks('old'), true); assert.equal(saved.entries.old.thresholdPercent, 90);
  assert.equal(saved.entries.old.series, null); assert.equal(saved.entries.other.series.code, 'OTHER');
});

test('series changes roll back on save failure and cannot race a transfer', async t => {
  let fail = false, pending;
  const watch = createContextWatch({ state: { entries: { old: { enabled: true, thresholdPercent: 80 } } },
    save: async () => { if (fail) throw new Error('storage failed'); }, read: async () => ({ percent: 90, running: true, turnId: 'turn' }),
    handoff: async () => new Promise(resolve => { pending = resolve; }) }); t.after(() => watch.dispose());
  await watch.setSeries('old', { code: 'FIRST', nextNumber: '1' });
  fail = true;
  await assert.rejects(watch.setSeries('old', { code: 'SECOND', nextNumber: '2' }), /storage failed/);
  assert.equal(watch.snapshot().entries.old.series.code, 'FIRST');
  fail = false; await watch.poll(); await until(() => pending);
  await assert.rejects(watch.setSeries('old', { code: 'LATE', nextNumber: '99' }), /chuyển tiếp/);
  pending({ phase: 'completed', nextThreadId: 'next', nextTitle: '[FIRST-0001] Tiếp tục', successorSeries: { code: 'FIRST', nextNumber: '0002' } });
  await until(() => !watch.snapshot().busy.length);
  await assert.rejects(watch.setSeries('old', null), /chuyển tiếp/);
});

test('custom handoff chain survives reload and title edits while only naming future chats', async t => {
  const directory = await scratch(t), calls = []; let saved, created = 0, active = 'old';
  const backend = {
    stopForHandoff: async entry => ({ name: entry.threadId === 'old' ? 'Original source' : 'Manually renamed successor', cwd: 'cwd' }),
    renameThread: async (id, name) => { calls.push(['rename', id, name]); },
    createSuccessor: async () => ({ id: 'next' + (++created) }),
    startSuccessor: async value => { calls.push(['send', value.threadId, value.message]); return { turnId: 'turn' + created }; }
  };
  const options = { state: { handoffDelaySeconds: 0, entries: { old: { enabled: true, thresholdPercent: 80, title: 'Original source' } } },
    save: async value => { saved = value; },
    read: async entry => ({ percent: entry.threadId === active ? 90 : 0, running: true, turnId: 'turn' }),
    handoff: entry => runContextHandoff({ entry, directory, backend }) };
  const watch = createContextWatch(options); t.after(() => watch.dispose());
  await watch.setSeries('old', { code: 'dựÁn2', nextNumber: '25' }); await watch.poll();
  await until(() => watch.snapshot().entries.next1 && !watch.snapshot().busy.length);
  watch.dispose(); active = 'next1';
  const restored = createContextWatch({ ...options, state: saved }); t.after(() => restored.dispose());
  await restored.poll(); await until(() => restored.snapshot().entries.next2 && !restored.snapshot().busy.length);
  assert.deepEqual(calls, [
    ['rename', 'next1', '[dựÁn2-0025] Tiếp tục'], ['send', 'next1', '[dựÁn2-0025] Tiếp tục codex://threads/old\n\nMã ID và nhãn chỉ để nhận diện chat, không đưa vào repo.'],
    ['rename', 'next2', '[dựÁn2-0026] Tiếp tục'], ['send', 'next2', '[dựÁn2-0026] Tiếp tục codex://threads/next1\n\nMã ID và nhãn chỉ để nhận diện chat, không đưa vào repo.']
  ]);
  assert.deepEqual(saved.entries.next2.series, { code: 'dựÁn2', nextNumber: '0027' });
  assert.equal(saved.entries.old.title, 'Original source');
});

test('a newly marked chat uses the configured default and survives a reload', async t => {
  let saved;
  const options = { save: async value => { saved = value; }, read: async () => ({ percent: null }) };
  const first = createContextWatch(options); t.after(() => first.dispose());
  await first.configure({ intervalMs: 500, thresholdPercent: 65, handoffDelaySeconds: 25 });
  await first.setEntry('new', { enabled: true });
  assert.equal(first.snapshot().entries.new.thresholdPercent, 65);
  const second = createContextWatch({ ...options, state: saved }); t.after(() => second.dispose());
  assert.equal(second.tracks('new'), true); assert.equal(second.snapshot().intervalMs, 500);
  assert.equal(second.snapshot().handoffDelaySeconds, 25);
});

test('changing the configured threshold updates already tracked chats and persists across reload', async t => {
  let saved;
  const options = { save: async value => { saved = value; }, read: async () => ({ percent: null }) };
  const w = createContextWatch(options); t.after(() => w.dispose());
  await w.setEntry('existing', { enabled: true });
  await w.setEntry('another', { enabled: true, thresholdPercent: 70 });
  await w.setEntry('disabled', { enabled: false, thresholdPercent: 60 });
  await w.configure({ thresholdPercent: 85 });
  assert.equal(w.snapshot().entries.existing.thresholdPercent, 85);
  assert.equal(w.snapshot().entries.another.thresholdPercent, 85);
  assert.equal(w.snapshot().entries.disabled.thresholdPercent, 60);
  await w.configure({ intervalMs: 600 });
  assert.equal(w.snapshot().entries.existing.thresholdPercent, 85);
  await w.setEntry('existing', { enabled: true, thresholdPercent: 90 });
  assert.equal(w.tracks('existing'), true);
  assert.equal(w.snapshot().entries.existing.thresholdPercent, 90);
  const restored = createContextWatch({ ...options, state: saved }); t.after(() => restored.dispose());
  assert.equal(restored.snapshot().entries.existing.thresholdPercent, 90);
  assert.equal(restored.snapshot().entries.another.thresholdPercent, 85);
  await restored.configure({ thresholdPercent: 85 });
  assert.equal(restored.snapshot().entries.existing.thresholdPercent, 85, 'reapplying the current default repairs an older per-chat value');
});

test('only marked chats fire at the exact threshold; successor inherits settings once', async t => {
  const calls = [], saves = []; let percent = 79.999;
  const watch = createContextWatch({ state: { entries: {
    old: { enabled: true, thresholdPercent: 80, title: '[TEST-0001] Test' }, ignored: { enabled: false, thresholdPercent: 1 }
  } }, save: async s => saves.push(s), read: async e => { calls.push('read:' + e.threadId); return { running: true, turnId: 'turn', percent }; },
    handoff: async e => { calls.push('send:' + e.threadId); await tick(); return { phase: 'completed', nextThreadId: 'next', nextTitle: '[TEST-0002] Tiếp tục', cwd: 'workspace' }; }
  }); t.after(() => watch.dispose());
  await watch.poll(); assert.equal(calls.includes('read:ignored'), false); assert.equal(calls.some(c => c.startsWith('send:')), false);
  percent = 80; await Promise.all([watch.poll(), watch.poll()]);
  await until(() => watch.snapshot().entries.next);
  assert.equal(watch.tracks('old'), false); assert.equal(watch.tracks('next'), true);
  assert.equal(watch.snapshot().entries.next.thresholdPercent, 80);
  assert.equal(calls.filter(c => c === 'send:old').length, 1);
  assert.equal(saves.at(-1).entries.old.handoff.phase, 'completed');
});

test('missing context, stopped chats, and another busy action never trigger a handoff', async t => {
  let reading = { percent: null, running: true, turnId: 't' }, busy = false, calls = 0;
  const w = createContextWatch({ state: { entries: { old: { enabled: true, thresholdPercent: 80 } } }, save: async () => {},
    read: async () => reading, isBusy: () => busy, handoff: async () => { calls++; } }); t.after(() => w.dispose());
  await w.poll(); reading = { percent: 100, running: false, turnId: 't' }; await w.poll();
  reading.running = true; busy = true; await w.poll(); assert.equal(calls, 0);
});

test('failure on one chat cannot block monitoring another; persisted partial handoffs do not resend', async t => {
  const sent = [];
  const w = createContextWatch({ state: { entries: {
    broken: { enabled: true, thresholdPercent: 80 }, good: { enabled: true, thresholdPercent: 80 },
    uncertain: { enabled: true, thresholdPercent: 80, handoff: { phase: 'sending' } }
  } }, save: async () => {}, read: async e => { if (e.threadId === 'broken') throw new Error('missing file'); return { percent: 90, running: true, turnId: 't' }; },
    handoff: async e => { sent.push(e.threadId); throw new Error('offline'); } }); t.after(() => w.dispose());
  await w.poll(); await until(() => w.snapshot().entries.good.handoff?.phase === 'failed'); await w.poll();
  assert.deepEqual(sent, ['good']); assert.match(w.snapshot().readings.broken.error, /missing/);
});

test('handoff rereads the stopped title, renames, creates, sends, then journals completion', async t => {
  const directory = await scratch(t), calls = [];
  const backend = {
    async stopForHandoff(e) { calls.push('stop:' + e.threadId); return { name: '[REAL-0042] Renamed while running', cwd: 'source-workspace' }; },
    async renameThread(id, name) { calls.push(['rename', id, name]); },
    async createSuccessor(params) { calls.push(['create', params]); return { id: 'next' }; },
    async startSuccessor(params) { calls.push(['send', params]); return { turnId: 'new-turn' }; }
  };
  const options = { directory, backend, entry: { threadId: 'old', turnId: 'active', title: '[STALE-0001] Stale', model: 'same-model', reasoning: 'high', handoffDelaySeconds: 0 } };
  const result = await runContextHandoff(options);
  assert.equal(result.phase, 'completed'); assert.equal(result.message, '[REAL-0043] Tiếp tục codex://threads/old\n\nMã ID và nhãn chỉ để nhận diện chat, không đưa vào repo.');
  assert.deepEqual(calls.map(c => Array.isArray(c) ? c[0] : c), ['stop:old', 'create', 'rename', 'send']);
  assert.equal(calls[1][1].cwd, 'source-workspace'); assert.equal(calls[3][1].threadId, 'next');
  assert.equal(calls[3][1].effort, 'high');
  await runContextHandoff(options); assert.equal(calls.length, 4, 'completed journal is not replayed');
});

test('two windows cannot create duplicates and an unknown send never retries after restart', async t => {
  const directory = await scratch(t); let sends = 0, creates = 0;
  const backend = { stopForHandoff: async () => ({ name: '[TEST-0001] Test', cwd: 'cwd' }), renameThread: async () => {},
    createSuccessor: async () => { creates++; return { id: 'next' }; }, startSuccessor: async () => { sends++; throw Object.assign(new Error('timeout'), { delivery: 'unknown' }); } };
  const options = { directory, backend, entry: { threadId: 'old', turnId: 't', handoffDelaySeconds: 0 } };
  const outcomes = await Promise.allSettled([runContextHandoff(options), runContextHandoff(options)]);
  assert.equal(outcomes.every(o => o.status === 'rejected'), true); assert.equal(creates, 1); assert.equal(sends, 1);
  await assert.rejects(runContextHandoff(options), /chưa hoàn tất/); assert.equal(sends, 1);
  const record = JSON.parse(await fs.readFile(path.join(directory, 'old.json'), 'utf8'));
  assert.equal(record.nextThreadId, 'next'); assert.equal(record.failedPhase, 'sending');
});

test('failed or unconfirmed stop never creates a successor', async t => {
  const directory = await scratch(t); let created = false;
  await assert.rejects(runContextHandoff({ directory, entry: { threadId: 'old', turnId: 't' }, backend: {
    stopForHandoff: async () => { throw new Error('not stopped'); }, createSuccessor: async () => { created = true; }
  } }), /not stopped/); assert.equal(created, false);
});

test('handoff waits the configured delay after stop, journals its deadline, and rechecks the source before creating', async t => {
  const directory = await scratch(t), calls = [];
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const source = { name: '[TEST-0001] Test', cwd: 'source' };
  const operation = runContextHandoff({ directory, entry: { threadId: 'delay', turnId: 't' },
    wait: async ms => { calls.push(ms); await waiting; }, backend: {
      stopForHandoff: async () => { calls.push('stop'); return source; },
      confirmHandoffStopped: async () => { calls.push('recheck'); return source; },
      createSuccessor: async () => { calls.push('create'); return { id: 'next' }; },
      renameThread: async () => {}, startSuccessor: async () => ({ turnId: 'next-turn' })
    } });
  await until(() => calls.includes(10000));
  assert.deepEqual(calls, ['stop', 10000]);
  const journal = JSON.parse(await fs.readFile(path.join(directory, 'delay.json'), 'utf8'));
  assert.equal(journal.phase, 'waiting'); assert.ok(journal.opensAt > journal.at);
  release(); await operation; assert.deepEqual(calls, ['stop', 10000, 'recheck', 'create']);
});

test('a source resumed during the delay prevents creating and sending a successor', async t => {
  const directory = await scratch(t); let created = false;
  await assert.rejects(runContextHandoff({ directory, entry: { threadId: 'resumed', turnId: 't', handoffDelaySeconds: 3 },
    wait: async ms => assert.equal(ms, 3000), backend: {
      stopForHandoff: async () => ({ name: '[TEST-0001] Test', cwd: 'source' }),
      confirmHandoffStopped: async () => { throw new Error('source resumed'); },
      createSuccessor: async () => { created = true; }
    } }), /source resumed/);
  assert.equal(created, false);
});

test('incremental context reader ignores cumulative billing and handles partial JSON, compaction and truncation', async t => {
  const directory = await scratch(t), file = path.join(directory, 'rollout.jsonl');
  await fs.writeFile(file, event({ type: 'task_started', turn_id: 't', model_context_window: 1000 }) + event({ type: 'token_count', info: {
    model_context_window: 1000, last_token_usage: { input_tokens: 750, output_tokens: 50, total_tokens: 800 }, total_token_usage: { total_tokens: 999999 }
  } }) + JSON.stringify({ type: 'token_usage_record', payload: { usage: { input_tokens: 999999 } } }) + '\n');
  const read = createContextReader({ resolveFile: async () => file });
  assert.equal((await read({ threadId: 'old' })).percent, 80);
  const next = event({ type: 'token_count', info: { model_context_window: 1000, last_token_usage: { total_tokens: 850 } } });
  await fs.appendFile(file, next.slice(0, 20)); assert.equal((await read({ threadId: 'old' })).percent, null);
  await fs.appendFile(file, next.slice(20)); assert.equal((await read({ threadId: 'old' })).percent, 85);
  await fs.appendFile(file, JSON.stringify({ type: 'compacted', payload: {} }) + '\n'); assert.equal((await read({ threadId: 'old' })).percent, null);
  await fs.writeFile(file, event({ type: 'task_started', turn_id: 'new', model_context_window: 1000 }) + event({ type: 'task_complete', turn_id: 'new' }));
  const last = await read({ threadId: 'old' }); assert.equal(last.running, false); assert.equal(last.turnId, 'new'); assert.equal(last.percent, null);
});
