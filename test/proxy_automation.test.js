'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProxyWatchdog, normalizeSettings, thresholdError } = require('../proxy_watchdog');
const { createProxyRecovery, RECOVERY_TEXT } = require('../proxy_recovery');

function watchdog(overrides = {}) {
  let now = 1800000000000;
  let calls = 0;
  const saved = [];
  const proxy = { executablePath: 'fixture.exe', busy: false, lastRestartAt: 0 };
  const controller = createProxyWatchdog({
    settings: { enabled: true, minutes: 5 }, now: () => now,
    proxySnapshot: () => proxy, saveAttempt: async at => saved.push(at),
    restart: async () => { calls += 1; return true; }, ...overrides
  });
  return {
    controller, proxy, saved, calls: () => calls, now: () => now,
    advance: value => { now += value; },
    observation: tasks => ({ complete: true, checkedAt: now, tasks: tasks || [{ threadId: 'a', stateKind: 'running', lastActivity: now - 300000 }] })
  };
}

test('automation defaults to disabled and exactly five minutes', () => {
  assert.deepEqual(normalizeSettings(), { enabled: false, minutes: 5 });
  for (const value of ['', '0', '-1', '1.5', '1441', 'abc']) assert.ok(thresholdError(value));
  for (const value of ['1', '5', '1440']) assert.equal(thresholdError(value), undefined);
});

test('automation requires at least one running task and every running task idle for the full interval', async () => {
  const f = watchdog();
  assert.equal(await f.controller.consider(f.observation([])), false);
  assert.equal(await f.controller.consider(f.observation([{ stateKind: 'completed', lastActivity: f.now() - 900000 }])), false);
  assert.equal(await f.controller.consider(f.observation([
    { stateKind: 'running', lastActivity: f.now() - 900000 },
    { stateKind: 'running', lastActivity: f.now() - 299999 }
  ])), false);
  assert.equal(await f.controller.consider(f.observation()), true);
  assert.equal(f.calls(), 1);
  assert.deepEqual(f.saved, [f.now()]);
});

test('automation blocks unknown timestamps, incomplete or stale scans, missing EXE and a busy proxy', async () => {
  for (const value of [0, undefined, NaN, 1800000000001]) {
    const f = watchdog();
    assert.equal(await f.controller.consider(f.observation([{ stateKind: 'running', lastActivity: value }])), false);
  }
  const f = watchdog();
  assert.equal(await f.controller.consider({ ...f.observation(), complete: false }), false);
  assert.equal(await f.controller.consider({ ...f.observation(), checkedAt: f.now() - 30001 }), false);
  f.proxy.executablePath = '';
  assert.equal(await f.controller.consider(f.observation()), false);
  f.proxy.executablePath = 'fixture.exe';
  f.proxy.busy = true;
  assert.equal(await f.controller.consider(f.observation()), false);
  assert.equal(f.calls(), 0);
});

test('automation throttles repeated failures and honors persisted and manual restart timestamps', async () => {
  let attempts = 0;
  const f = watchdog({ restart: async () => { attempts += 1; return false; } });
  assert.equal(await f.controller.consider(f.observation()), false);
  assert.equal(await f.controller.consider(f.observation()), false);
  assert.equal(attempts, 1);
  f.advance(300000);
  await f.controller.consider(f.observation());
  assert.equal(attempts, 2);
  const previous = watchdog({ lastAttemptAt: 1800000000000 - 299999 });
  assert.equal(await previous.controller.consider(previous.observation()), false);
  const manual = watchdog();
  manual.proxy.lastRestartAt = manual.now() - 20000;
  assert.equal(await manual.controller.consider(manual.observation()), false);
});

test('automation single flight cancels a pending attempt when disabled before restart', async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const f = watchdog({ saveAttempt: () => waiting });
  const pending = f.controller.consider(f.observation());
  assert.equal(await f.controller.consider(f.observation()), false);
  await f.controller.configure({ enabled: false, minutes: 5 });
  release();
  assert.equal(await pending, false);
  assert.equal(f.calls(), 0);
});

test('automation refuses restart when persisting the attempt fails', async () => {
  const f = watchdog({ saveAttempt: async () => { throw new Error('fixture storage denied'); } });
  assert.equal(await f.controller.consider(f.observation()), false);
  assert.equal(f.calls(), 0);
  assert.match(f.controller.snapshot().notice, /storage denied/);
});

function recovery(overrides = {}) {
  let now = 1800000000000;
  const plans = [];
  const sends = [];
  const controller = createProxyRecovery({
    now: () => now, save: async plan => plans.push(plan),
    send: async input => { sends.push(input); return { turnId: 'new-' + input.threadId }; }, ...overrides
  });
  return {
    controller, plans, sends, now: () => now, advance: value => { now += value; },
    observation: roots => ({ complete: true, checkedAt: now, roots }),
    async capture(ids) {
      await controller.prepare({ complete: true, checkedAt: now, tasks: ids.map(threadId => ({ threadId, stateKind: 'running', turnId: 'turn-' + threadId })) });
      await controller.arm();
    }
  };
}

test('recovery saves all original chat IDs before reset and continues only stopped original chats', async () => {
  const f = recovery();
  await f.capture(['a', 'b']);
  assert.deepEqual(f.plans[0].tasks.map(task => task.threadId), ['a', 'b']);
  f.advance(6000);
  await f.controller.consider(f.observation([
    { threadId: 'a', turnId: 'turn-a', stateKind: 'aborted', lastActivity: f.now() },
    { threadId: 'b', turnId: 'turn-b', stateKind: 'running', lastActivity: f.now() },
    { threadId: 'unrelated', stateKind: 'completed', lastActivity: f.now() }
  ]));
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].threadId, 'a');
  assert.equal(f.sends[0].message, 'Tiếp tục công việc (nếu còn)');
  assert.equal(f.sends[0].message, RECOVERY_TEXT);
  assert.equal(f.sends[0].clientUserMessageId, f.plans[0].tasks[0].clientUserMessageId);
  assert.equal(f.controller.snapshot().pendingCount, 1);
});

test('prepared recovery never sends when restart was not armed', async () => {
  const f = recovery();
  await f.controller.prepare({ complete: true, checkedAt: f.now(), tasks: [{ threadId: 'a', stateKind: 'running', turnId: 'turn-a' }] });
  f.advance(6000);
  await f.controller.consider(f.observation([{ threadId: 'a', turnId: 'turn-a', stateKind: 'error', lastActivity: f.now() }]));
  assert.equal(f.sends.length, 0);
  assert.equal(f.controller.snapshot().pendingCount, 0);
});

test('recovery waits for restart grace, ignores incomplete scans and skips a newer turn', async () => {
  const f = recovery();
  await f.capture(['a']);
  const roots = [{ threadId: 'a', turnId: 'turn-a', stateKind: 'completed', lastActivity: f.now() }];
  await f.controller.consider(f.observation(roots));
  assert.equal(f.sends.length, 0);
  f.advance(6000);
  await f.controller.consider({ ...f.observation(roots), complete: false });
  assert.equal(f.sends.length, 0);
  roots[0].turnId = 'different-new-turn';
  await f.controller.consider(f.observation(roots));
  assert.equal(f.sends.length, 0);
  assert.equal(f.controller.snapshot().pendingCount, 0);
});

test('recovery never retries unknown delivery, including after extension reload', async () => {
  let attempts = 0;
  const f = recovery({ send: async () => { attempts += 1; throw Object.assign(new Error('ACK lost'), { delivery: 'unknown' }); } });
  await f.capture(['a']);
  f.advance(6000);
  const observation = f.observation([{ threadId: 'a', turnId: 'turn-a', stateKind: 'error', lastActivity: f.now() }]);
  await f.controller.consider(observation);
  f.advance(10000);
  await f.controller.consider({ ...observation, checkedAt: f.now() });
  const restored = createProxyRecovery({ plan: f.plans.at(-1), now: f.now, send: async () => { attempts += 1; } });
  await restored.consider({ ...observation, checkedAt: f.now() });
  assert.equal(attempts, 1);
});

test('recovery retries definite non delivery after ten seconds with the same message ID', async () => {
  const sends = [];
  const f = recovery({ send: async task => {
    sends.push(task);
    if (sends.length === 1) throw Object.assign(new Error('not connected'), { delivery: 'not_sent' });
    return { turnId: 'new-turn' };
  } });
  await f.capture(['a']);
  f.advance(6000);
  const roots = [{ threadId: 'a', turnId: 'turn-a', stateKind: 'error', lastActivity: f.now() }];
  await f.controller.consider(f.observation(roots));
  await f.controller.consider(f.observation(roots));
  assert.equal(sends.length, 1);
  f.advance(10000);
  await f.controller.consider(f.observation(roots));
  assert.equal(sends.length, 2);
  assert.equal(sends[0].clientUserMessageId, sends[1].clientUserMessageId);
  await f.controller.consider(f.observation(roots));
  assert.equal(sends.length, 2);
});

test('recovery refuses reset when the before reset snapshot cannot be saved', async () => {
  const f = recovery({ save: async () => { throw new Error('storage denied'); } });
  await assert.rejects(f.capture(['a']), /storage denied/);
  assert.equal(f.controller.snapshot().pendingCount, 0);
});

test('recovery restores in flight messages as unknown and expires old pending work', async () => {
  const f = recovery();
  await f.capture(['a']);
  const plan = structuredClone(f.plans[0]);
  plan.tasks[0].state = 'sending';
  const restored = createProxyRecovery({ plan });
  assert.equal(restored.snapshot().pendingCount, 0);
  f.advance(600001);
  await f.controller.consider(f.observation([]));
  assert.equal(f.controller.snapshot().pendingCount, 0);
  assert.equal(f.sends.length, 0);
});
