'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { listRolloutFiles } = require('../tracker');
const { retryLimitError, modelCapacityError, userInputRequired, classifyCodexError, classifyCodexAlert, createErrorHistory, createRetryLimitMonitor } = require('../codex_error_alerts');

const START = Date.parse('2026-10-22T05:00:00Z');
const MESSAGE = 'exceeded retry limit, last status: 429 Too Many Requests';

function failure(at = START + 1000, turnId = 'turn-1') {
  return {
    timestamp: new Date(at).toISOString(),
    type: 'event_msg',
    payload: {
      type: 'task_complete', turn_id: turnId,
      error: { message: MESSAGE, codex_error_info: { response_too_many_failed_attempts: { http_status_code: 429 } } }
    }
  };
}

function line(item) { return JSON.stringify(item) + '\n'; }

function capacityFailure(at = START + 1000, turnId = 'capacity-turn') {
  return {
    timestamp: new Date(at).toISOString(),
    type: 'event_msg',
    payload: {
      type: 'task_complete', turn_id: turnId,
      error: { message: 'Selected model is at capacity. Please try a different model.', codex_error_info: 'server_overloaded' }
    }
  };
}

function waitingRequest(at = START + 1000, type = 'request_user_input', requestId = 'request-1') {
  return {
    timestamp: new Date(at).toISOString(),
    type: 'event_msg',
    payload: {
      type,
      turn_id: 'waiting-turn',
      request_id: requestId,
      question: 'Mày có muốn tiếp tục công việc không?'
    }
  };
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-retry-alert-test-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const sessionsDir = path.join(directory, 'sessions');
  await fs.mkdir(sessionsDir);
  const file = path.join(sessionsDir, 'rollout-fixture.jsonl');
  await fs.writeFile(file, '');
  const historyDirectory = path.join(directory, 'history');
  const history = createErrorHistory(historyDirectory);
  const sounds = [];
  const errors = [];
  let saved;
  let currentTime = START;
  const monitorOptions = {
    now: () => currentTime,
    history,
    listFiles: listRolloutFiles,
    describe: async () => ({ threadId: 'fixture-thread', title: 'Hello. Reply OK' }),
    save: async state => { saved = structuredClone(state); },
    notify: async event => { sounds.push(event); },
    onError: error => errors.push(error.message)
  };
  const monitor = createRetryLimitMonitor(monitorOptions);
  t.after(() => monitor.dispose());
  return {
    directory, sessionsDir, file, historyDirectory, history, monitorOptions, monitor, sounds, errors,
    append: item => fs.appendFile(file, line(item)),
    poll: () => monitor.poll(sessionsDir),
    saved: () => saved,
    setTime: value => { currentTime = value; },
    async records() {
      try { return (await fs.readFile(history.file, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    }
  };
}

test('real terminal retry-limit shape exposes the precise 429 trigger', () => {
  const event = retryLimitError(failure());
  assert.equal(event.httpStatus, 429);
  assert.equal(event.code, 'response_too_many_failed_attempts');
  assert.equal(event.message, MESSAGE);
  const legacy = failure();
  legacy.payload.error = MESSAGE;
  assert.equal(retryLimitError(legacy).httpStatus, 429);
});

test('ordinary 429 retries, other failures and quoted conversation text never trigger', () => {
  const ordinary = failure();
  ordinary.payload.error = { message: '429 Too Many Requests' };
  assert.equal(retryLimitError(ordinary), null);
  const other = failure();
  other.payload.error = { message: 'exceeded retry limit, last status: 503 Service Unavailable' };
  assert.equal(retryLimitError(other), null);
  const transient = failure();
  transient.payload.type = 'stream_error';
  assert.equal(retryLimitError(transient), null);
  assert.equal(retryLimitError({ type: 'response_item', payload: failure().payload }), null);
  assert.equal(retryLimitError(null), null);
});

test('model capacity errors use the dedicated alert and ignore quoted text', () => {
  const event = modelCapacityError(capacityFailure());
  assert.equal(event.alertType, 'model_capacity');
  assert.equal(event.soundKey, 'model_capacity');
  assert.equal(event.code, 'server_overloaded');
  assert.equal(classifyCodexError(capacityFailure()).alertType, 'model_capacity');
  const wrapped = capacityFailure();
  wrapped.payload.error.message = 'Error running remote compact task: Selected model is at capacity. Please try a different model.';
  assert.equal(modelCapacityError(wrapped).alertType, 'model_capacity');
  const quoted = { type: 'response_item', payload: { type: 'message', role: 'user', text: 'Selected model is at capacity. Please try a different model.' } };
  assert.equal(modelCapacityError(quoted), null);
  const ordinary = capacityFailure();
  ordinary.payload.error = { message: 'Selected model is at capacity. Please try a different model.', codex_error_info: 'other_error' };
  assert.equal(modelCapacityError(ordinary), null);
});

test('questions and approvals become explicit waiting alerts and quoted text is ignored', () => {
  const question = userInputRequired(waitingRequest());
  assert.equal(question.alertType, 'user_input_required');
  assert.equal(question.soundKey, 'user_input');
  assert.equal(question.code, 'request_user_input');
  assert.equal(classifyCodexAlert(waitingRequest('2026-10-22T05:00:02Z', 'exec_approval_request')).code, 'exec_approval_request');
  const quoted = { type: 'response_item', payload: { type: 'message', role: 'user', text: 'Mày có muốn tiếp tục công việc không?' } };
  assert.equal(userInputRequired(quoted), null);
});

test('model capacity rollout events are recorded and notified once', async t => {
  const f = await fixture(t);
  await f.poll();
  await f.append(capacityFailure());
  await f.poll();
  await f.poll();
  assert.equal(f.sounds.length, 1);
  assert.equal(f.sounds[0].soundKey, 'model_capacity');
  assert.equal((await f.records())[0].alertType, 'model_capacity');
});

test('waiting questions are recorded and beeped without sending an answer', async t => {
  const f = await fixture(t);
  await f.poll();
  await f.append(waitingRequest());
  await f.poll();
  assert.equal(f.sounds.length, 1);
  assert.equal(f.sounds[0].alertType, 'user_input_required');
  assert.equal(f.sounds[0].soundKey, 'user_input');
  assert.equal((await f.records())[0].code, 'request_user_input');
});

test('capacity sound is throttled per chat while every error remains in history', async t => {
  const f = await fixture(t);
  await f.poll();
  await f.append(capacityFailure(START + 1000, 'capacity-1'));
  await f.append(capacityFailure(START + 2000, 'capacity-2'));
  await f.poll();
  assert.equal(f.sounds.length, 1);
  assert.equal((await f.records()).length, 2);
  assert.equal(f.saved().soundCooldowns['fixture-thread'], START);
  f.setTime(START + 5 * 60 * 1000 + 1);
  await f.append(capacityFailure(START + 5 * 60 * 1000 + 2, 'capacity-3'));
  await f.poll();
  assert.equal(f.sounds.length, 2);
  assert.equal((await f.records()).length, 3);
});

test('existing historical errors are recorded silently and new errors alert once', async t => {
  const f = await fixture(t);
  await f.append(failure(START - 60000, 'old'));
  await f.poll();
  assert.equal(f.sounds.length, 0);
  assert.equal((await f.records())[0].historical, true);
  await f.append(failure());
  await f.poll();
  await f.poll();
  const records = await f.records();
  assert.equal(f.sounds.length, 1);
  assert.equal(records.length, 2);
  assert.equal(records[1].historical, false);
  assert.equal(records[1].title, 'Hello. Reply OK');
  assert.equal(records[1].threadId, 'fixture-thread');
  assert.ok(f.saved().files);
  assert.deepEqual(f.saved().pendingSounds, []);
});

test('an error followed by a successful turn before the next scan is still detected', async t => {
  const f = await fixture(t);
  await f.poll();
  await f.append(failure());
  await f.append({ timestamp: new Date(START + 2000).toISOString(), type: 'event_msg', payload: { type: 'task_complete', turn_id: 'successful' } });
  await f.poll();
  assert.equal(f.sounds.length, 1);
  assert.equal((await f.records()).length, 1);
});

test('partial UTF-8 records are retained until their terminating newline arrives', async t => {
  const f = await fixture(t);
  await f.poll();
  const event = failure();
  event.payload.error.message = 'Lỗi giới hạn, thử lại quá nhiều lần';
  const bytes = Buffer.from(line(event));
  const split = bytes.indexOf(Buffer.from('ỗ')) + 1;
  await fs.appendFile(f.file, bytes.subarray(0, split));
  await f.poll();
  assert.equal(f.sounds.length, 0);
  await fs.appendFile(f.file, bytes.subarray(split));
  await f.poll();
  assert.equal(f.sounds.length, 1);
  assert.equal((await f.records())[0].message, event.payload.error.message);
});

test('large quoted user records do not obscure a following actual failure', async t => {
  const f = await fixture(t);
  await f.poll();
  await f.append({ type: 'response_item', payload: { type: 'message', role: 'user', text: MESSAGE + 'x'.repeat(1200000) } });
  await f.append(failure());
  await f.poll();
  assert.equal(f.sounds.length, 1);
  assert.equal((await f.records()).length, 1);
});

test('copied and rewritten rollouts do not duplicate history or sound', async t => {
  const f = await fixture(t);
  await f.poll();
  await f.append(failure());
  await f.poll();
  await fs.copyFile(f.file, path.join(f.sessionsDir, 'rollout-copy.jsonl'));
  await fs.writeFile(f.file, '');
  await f.poll();
  await f.append(failure());
  await f.poll();
  assert.equal(f.sounds.length, 1);
  assert.equal((await f.records()).length, 1);
});

test('cursor restoration imports offline errors silently and observes subsequent live errors', async t => {
  const f = await fixture(t);
  await f.append(failure(START - 60000));
  await f.poll();
  const state = f.saved();
  f.monitor.dispose();
  await f.append(failure(START + 1000, 'offline'));
  f.setTime(START + 10000);
  const replacement = createRetryLimitMonitor({ ...f.monitorOptions, state });
  t.after(() => replacement.dispose());
  await replacement.poll(f.sessionsDir);
  assert.equal(f.sounds.length, 0);
  await f.append(failure(START + 11000, 'live'));
  await replacement.poll(f.sessionsDir);
  assert.equal(f.sounds.length, 1);
  assert.equal((await f.records()).length, 3);
});

test('a failed audio delivery survives reload and retries without duplicating the log', async t => {
  const f = await fixture(t);
  await f.poll();
  f.monitor.dispose();
  const failed = createRetryLimitMonitor({ ...f.monitorOptions, state: f.saved(), notify: async () => { throw new Error('fixture audio unavailable'); } });
  t.after(() => failed.dispose());
  await f.append(failure());
  await failed.poll(f.sessionsDir);
  assert.equal(f.saved().pendingSounds.length, 1);
  assert.deepEqual(f.errors, ['fixture audio unavailable']);
  failed.dispose();
  const restored = createRetryLimitMonitor({ ...f.monitorOptions, state: f.saved() });
  t.after(() => restored.dispose());
  await restored.poll(f.sessionsDir);
  assert.equal(f.sounds.length, 1);
  assert.deepEqual(f.saved().pendingSounds, []);
  assert.equal((await f.records()).length, 1);
});

test('overlapping polls share one scan and sound groups never overlap', async t => {
  const f = await fixture(t);
  await f.poll();
  f.monitor.dispose();
  let inFlight = 0;
  let maximum = 0;
  let played = 0;
  const monitor = createRetryLimitMonitor({ ...f.monitorOptions, state: f.saved(), notify: async () => {
    inFlight += 1;
    maximum = Math.max(maximum, inFlight);
    await new Promise(resolve => setImmediate(resolve));
    played += 1;
    inFlight -= 1;
  } });
  t.after(() => monitor.dispose());
  await f.append(failure());
  await f.append(failure(START + 2000, 'second'));
  const first = monitor.poll(f.sessionsDir);
  assert.equal(first, monitor.poll(f.sessionsDir));
  await first;
  assert.equal(played, 2);
  assert.equal(maximum, 1);
});

test('separate history writers claim one event once and recover a torn final line', async t => {
  const f = await fixture(t);
  const other = createErrorHistory(f.historyDirectory);
  const event = { id: 'shared-id', message: MESSAGE };
  const outcomes = await Promise.all([f.history.append(event), other.append(event)]);
  assert.equal(outcomes.filter(Boolean).length, 1);
  await fs.appendFile(f.history.file, '{"partial":');
  const reloaded = createErrorHistory(f.historyDirectory);
  assert.equal(await reloaded.append({ id: 'next-id' }), true);
  const text = await fs.readFile(f.history.file, 'utf8');
  assert.match(text, /\{"partial":\n\{"id":"next-id"\}/);
});

test('a failed history write is retried before the cursor advances past the error', async t => {
  const f = await fixture(t);
  await f.poll();
  f.monitor.dispose();
  let attempts = 0;
  const monitor = createRetryLimitMonitor({ ...f.monitorOptions, state: f.saved(), history: {
    async append(event) {
      attempts += 1;
      if (attempts === 1) throw new Error('fixture history temporarily locked');
      return f.history.append(event);
    }
  } });
  t.after(() => monitor.dispose());
  await f.append(failure());
  await monitor.poll(f.sessionsDir);
  assert.equal(f.sounds.length, 0);
  await monitor.poll(f.sessionsDir);
  assert.equal(f.sounds.length, 1);
  assert.equal((await f.records()).length, 1);
});

test('an abandoned history lock from an exited process is recovered', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.historyDirectory, { recursive: true });
  const lock = f.history.file + '.lock';
  await fs.writeFile(lock, JSON.stringify({ pid: 2147483647, createdAt: Date.now() - 60000 }));
  const old = new Date(Date.now() - 60000);
  await fs.utimes(lock, old, old);
  assert.equal(await f.history.append({ id: 'after-crash' }), true);
  await assert.rejects(fs.stat(lock), { code: 'ENOENT' });
});
