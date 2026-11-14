'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createHandoffForm } = require('../../src/codex_handoff_form');
const { createContextWatch } = require('../../src/codex_context_watch');
const { normalizeSeries, parseSeries, continuationPlan } = require('../../src/codex_context_handoff');

function fixture(t, capabilities = { goal: { available: true }, plan: { available: true } }) {
  const calls = [], replies = []; let modelGate, failure;
  const watch = createContextWatch({ state: { handoffDelaySeconds: 10 }, save: async () => {},
    readManual: async () => ({ turnId: 'live', model: 'source', reasoning: 'high' }),
    handoff: async entry => {
      calls.push(entry);
      if (failure) throw failure;
      return { phase: 'completed', trigger: 'manual', nextThreadId: 'next', nextTitle: '[TASK-0002] Tiếp tục', contextPreset: entry.contextPreset, successorMode: entry.successorMode, goalText: entry.goalText };
    } });
  t.after(() => watch.dispose());
  const form = createHandoffForm({ watch: () => watch, defaultPreset: () => 'default', post: m => replies.push(m),
    describe: async (id, model = 'source') => {
      if (modelGate) await modelGate;
      if (!['source', 'other'].includes(model)) throw new Error('Model không còn có sẵn.');
      return { session: { threadId: id, title: '[TASK-0001] Task', cwd: 'workspace' },
        modes: capabilities, sourceGoal: { objective: 'Existing native objective', status: 'active' },
        metadata: { model, defaultTokens: model === 'other' ? 128000 : 272000, maxTokens: 900000, effectivePercent: 95 },
        models: [{ id: 'source', label: 'Source' }, { id: 'other', label: 'Other' }] };
    } });
  const message = { threadId: 'old', requestId: 'request-1', model: 'other', settings: {
    preset: '600k', extraMessage: 'Lập plan trước.\nGiữ tiếng Việt.', series: { code: 'dựÁn'.repeat(7) + '01', nextNumber: '42' },
    enabled: true, thresholdPercent: 87, handoffDelaySeconds: 0 } };
  return { watch, form, calls, replies, message, gate: value => { modelGate = value; }, fail: value => { failure = value; } };
}

test('handoff options use source defaults and model-specific context without changing settings or starting a turn', async t => {
  const f = fixture(t);
  await f.form.load({ threadId: 'old', requestId: 'load' });
  let reply = f.replies.at(-1);
  assert.equal(reply.model, 'source'); assert.equal(reply.enabled, false); assert.equal(reply.thresholdPercent, 80);
  assert.deepEqual(reply.series, { code: 'TASK', nextNumber: '0002' });
  assert.match(reply.choices[0].label, /272K/);
  await f.form.load({ threadId: 'old', requestId: 'changed-model', model: 'other' });
  reply = f.replies.at(-1); assert.match(reply.choices[0].label, /128K/);
  assert.equal(f.calls.length, 0); assert.deepEqual(f.watch.snapshot().entries, {});
});

test('Goal options keep the plain native objective; Plan and normal never carry a Goal', async t => {
  const f = fixture(t);
  await f.form.load({ threadId: 'old', requestId: 'load' });
  assert.equal(f.replies.at(-1).successorMode, 'normal');
  assert.match(f.replies.at(-1).goalText, /Existing native objective/);
  assert.equal(f.replies.at(-1).goalText, 'Existing native objective');
  const goalText = 'Sửa Tracker và cài bản mới.';
  await f.form.submit({ ...f.message, settings: { ...f.message.settings, successorMode: 'goal', goalText } });
  assert.equal(f.replies.at(-1).success, true); assert.equal(f.calls[0].goalText, goalText);
  assert.equal(f.watch.snapshot().entries.next.continuationMode, 'goal');
  for (const successorMode of ['plan', 'normal']) {
    const other = fixture(t);
    await other.form.submit({ ...other.message, settings: { ...other.message.settings, successorMode, goalText } });
    assert.equal(other.calls[0].goalText, undefined); assert.equal(other.watch.snapshot().entries.next.continuationMode, 'normal');
  }
});

test('unsupported modes and unfinished Goal templates fail before touching the source', async t => {
  const f = fixture(t, { goal: { available: false, reason: 'Goal unavailable' }, plan: { available: false, reason: 'Plan unavailable' } });
  const goalText = 'MỤC TIÊU:\nSửa Tracker\nHOÀN TẤT KHI:\nTests đạt';
  for (const successorMode of ['goal', 'plan', 'bad']) {
    await f.form.submit({ ...f.message, requestId: successorMode, settings: { ...f.message.settings, successorMode, goalText } });
    assert.ok(f.replies.at(-1).error);
  }
  assert.equal(f.calls.length, 0); assert.deepEqual(f.watch.snapshot().entries, {});
  const valid = fixture(t);
  await valid.form.submit({ ...valid.message, settings: { ...valid.message.settings, successorMode: 'goal', goalText: '   ' } });
  assert.ok(valid.replies.at(-1).error); assert.equal(valid.calls.length, 0);
});

test('30 Unicode characters are accepted and continue as the same ID; 31 are rejected', () => {
  const code = 'dựÁn'.repeat(7) + '01'; assert.equal([...code].length, 30);
  assert.equal(normalizeSeries({ code: code.normalize('NFD'), nextNumber: '1' }).code, code);
  assert.equal(parseSeries(`[${code}-0001] Task`).code, code);
  assert.equal(continuationPlan('old', `[${code}-0001] Task`).nextTitle, `[${code}-0002] Tiếp tục`);
  assert.throws(() => normalizeSeries({ code: code + 'X', nextNumber: '1' }), /ID/);
});

test('submit transfers optional text, chosen model and settings and inherits only chain settings', async t => {
  const f = fixture(t); await f.form.submit(f.message);
  assert.equal(f.replies.at(-1).success, true); assert.equal(f.calls.length, 1);
  const actual = f.calls[0];
  assert.equal(actual.extraMessage, f.message.settings.extraMessage); assert.equal(actual.successorModel, 'other');
  assert.equal(actual.series.code.length, 30); assert.equal(actual.series.nextNumber, '0042');
  assert.equal(actual.handoffDelaySeconds, 0); assert.equal(actual.thresholdPercent, 87);
  const next = f.watch.snapshot().entries.next;
  assert.equal(next.enabled, true); assert.equal(next.contextPreset, '600k'); assert.equal(next.thresholdPercent, 87);
  assert.equal(next.extraMessage, undefined); assert.equal(next.successorModel, undefined);
  await f.form.submit(f.message); assert.equal(f.calls.length, 1);
});

test('empty added content and disabled automatic resume are valid', async t => {
  const f = fixture(t); f.message.settings = { ...f.message.settings, extraMessage: '', enabled: false, series: null };
  await f.form.submit(f.message); assert.equal(f.replies.at(-1).success, true); assert.equal(f.watch.tracks('next'), false);
});

test('invalid fields, 100 percent and unavailable models cannot mutate the source', async t => {
  const f = fixture(t);
  for (const patch of [{ thresholdPercent: 100 }, { thresholdPercent: 0 }, { thresholdPercent: 99.1 }, { enabled: 'true' }, { extraMessage: null }, { preset: '999k' }, { handoffDelaySeconds: -1 }, { series: { code: 'A'.repeat(31), nextNumber: '1' } }]) {
    await f.form.submit({ ...f.message, requestId: 'bad-' + f.replies.length, settings: { ...f.message.settings, ...patch } });
    assert.ok(f.replies.at(-1).error);
  }
  await f.form.submit({ ...f.message, requestId: 'bad-model', model: 'missing' });
  assert.match(f.replies.at(-1).error, /Model/); assert.equal(f.calls.length, 0); assert.deepEqual(f.watch.snapshot().entries, {});
});

test('duplicates during catalog lookup share one result; another submit cannot race the same source', async t => {
  const f = fixture(t); let release; f.gate(new Promise(resolve => { release = resolve; }));
  const one = f.form.submit(f.message), duplicate = f.form.submit(f.message);
  await f.form.submit({ ...f.message, requestId: 'other-request' }); assert.ok(f.replies.at(-1).blocked);
  release(); await Promise.all([one, duplicate]); assert.equal(f.calls.length, 1);
});

test('uncertain delivery preserves successor recovery and rejects later submits', async t => {
  const f = fixture(t); f.fail(Object.assign(new Error('timeout'), { handoff: { phase: 'failed', nextThreadId: 'created' } }));
  await f.form.submit(f.message); assert.equal(f.replies.at(-1).nextThreadId, 'created'); assert.equal(f.replies.at(-1).blocked, true);
  await f.form.submit({ ...f.message, requestId: 'later' }); assert.equal(f.calls.length, 1);
});
