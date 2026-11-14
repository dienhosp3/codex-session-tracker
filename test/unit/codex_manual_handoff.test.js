'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createContextWatch } = require('../../src/codex_context_watch');

function fixture(t, options = {}) {
  const calls = [], saved = [];
  const watch = createContextWatch({
    state: { handoffDelaySeconds: 0, entries: { source: { enabled: false, thresholdPercent: 85,
      contextPreset: '600k', series: { code: 'dựÁn', nextNumber: '0042' } } } },
    save: async value => saved.push(value),
    read: async () => ({ running: true, percent: 1, turnId: 'turn' }),
    handoff: async entry => {
      calls.push(entry);
      return { phase: 'completed', nextThreadId: 'next', nextTitle: '[dựÁn-0042] Tiếp tục',
        successorSeries: { code: 'dựÁn', nextNumber: '0043' } };
    }, ...options
  });
  t.after(() => watch.dispose());
  return { watch, calls, saved };
}

for (const reading of [{ running: true, percent: 1 }, { running: true, percent: null }, { running: false, percent: 98 }]) {
  test('manual handoff works without monitoring or a threshold: ' + JSON.stringify(reading), async t => {
    const f = fixture(t, { readManual: async () => ({ ...reading, turnId: 'live', model: 'model', reasoning: 'high' }) });
    const result = await f.watch.transferNow('source');
    assert.equal(result.nextThreadId, 'next'); assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].manual, true); assert.equal(f.calls[0].turnId, 'live');
    assert.equal(f.calls[0].contextPreset, '600k'); assert.equal(f.calls[0].series.code, 'dựÁn');
    assert.equal(f.calls[0].reasoning, 'high'); assert.equal(f.calls[0].model, 'model');
    assert.equal(f.watch.tracks('next'), false); assert.equal(f.watch.tracks('source'), false);
    assert.equal(f.watch.snapshot().entries.next.thresholdPercent, 85);
    assert.equal(f.saved.at(-1).entries.source.handoff.phase, 'completed');
    await assert.rejects(f.watch.transferNow('source'), /chuyển tiếp/);
    const restored = createContextWatch({ state: f.saved.at(-1), save: async () => {}, handoff: async () => assert.fail('Must not resend') });
    t.after(() => restored.dispose());
    await assert.rejects(restored.transferNow('source'), /chuyển tiếp/);
  });
}

test('new untracked chat can transfer and inherits disabled monitoring', async t => {
  const f = fixture(t);
  await f.watch.transferNow('untracked', { title: 'Original', cwd: 'workspace', file: 'rollout' });
  assert.equal(f.calls[0].title, 'Original'); assert.equal(f.calls[0].cwd, 'workspace');
  assert.equal(f.watch.tracks('next'), false);
});

test('manual transfer locks before the live read and excludes automatic polling and double clicks', async t => {
  let release;
  const f = fixture(t, {
    state: { entries: { source: { enabled: true, thresholdPercent: 80 } } },
    read: async () => ({ running: true, percent: 99, turnId: 'old' }),
    readManual: () => new Promise(resolve => { release = resolve; })
  });
  const pending = f.watch.transferNow('source');
  await assert.rejects(f.watch.transferNow('source'), /chuyển tiếp/);
  await f.watch.poll(); assert.equal(f.calls.length, 0);
  release({ running: true, turnId: 'latest' }); await pending;
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].turnId, 'latest');
  assert.equal(f.watch.tracks('next'), true);
});

test('unchecking during a manual transfer stops chaining but does not duplicate or cancel the dispatched transfer', async t => {
  let release;
  const f = fixture(t, { state: { entries: { source: { enabled: true } } },
    readManual: () => new Promise(resolve => { release = resolve; }) });
  const pending = f.watch.transferNow('source');
  await f.watch.setEntry('source', { enabled: false });
  release({ turnId: 'live' }); await pending;
  assert.equal(f.calls.length, 1); assert.equal(f.watch.tracks('next'), false);
});

test('preflight failures are retryable and cannot enable monitoring or send anything', async t => {
  let unavailable = true;
  const f = fixture(t, { readManual: async () => { if (unavailable) throw new Error('offline'); return { turnId: 'live' }; } });
  await assert.rejects(f.watch.transferNow('source'), /offline/);
  assert.equal(f.watch.blocks('source'), false); assert.equal(f.calls.length, 0);
  assert.equal(f.watch.tracks('source'), false); unavailable = false;
  await f.watch.transferNow('source'); assert.equal(f.calls.length, 1);
});

test('other actions, uncertain transfers, invalid IDs and disposal cannot trigger a manual handoff', async t => {
  const f = fixture(t, { isBusy: () => true });
  await assert.rejects(f.watch.transferNow('source'), /thao tác khác/);
  await assert.rejects(f.watch.transferNow('../escape'), /ID/);
  const failed = fixture(t, { handoff: async () => { throw Object.assign(new Error('unknown delivery'), { handoff: { phase: 'failed', nextThreadId: 'created' } }); } });
  await assert.rejects(failed.watch.transferNow('source'), /unknown delivery/);
  assert.equal(failed.watch.snapshot().entries.source.handoff.nextThreadId, 'created');
  await assert.rejects(failed.watch.transferNow('source'), /chuyển tiếp/);
  f.watch.dispose(); await assert.rejects(f.watch.transferNow('source'));
  assert.equal(f.calls.length, 0);
});
