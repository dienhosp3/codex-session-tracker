'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createNewChatContextRule, normalizeNewChatContext } = require('../codex_new_chat_context');
const { createContextWatch } = require('../codex_context_watch');

test('new-chat context has exactly three scopes and validates its threshold', () => {
  assert.deepEqual(normalizeNewChatContext(), { enabled: false, scope: 'all', thresholdPercent: 80 });
  for (const scope of ['all', 'tracker', 'successor']) assert.equal(normalizeNewChatContext({ scope }).scope, scope);
  assert.throws(() => normalizeNewChatContext({ scope: 'unknown' }));
  for (const thresholdPercent of [0, 101, 8.5, NaN]) assert.throws(() => normalizeNewChatContext({ thresholdPercent }));
});

test('scope defaults apply only to matching new chats; old per-chat settings stay intact', async t => {
  for (const scope of ['all', 'tracker', 'successor']) {
    const watch = createContextWatch({ save: async () => {}, read: async () => ({ percent: 0 }) }); t.after(() => watch.dispose());
    await watch.setEntry('old', { enabled: false, thresholdPercent: 42 });
    let saved;
    const rule = createNewChatContextRule({ watch: () => watch, save: async s => { saved = s; } });
    await rule.update({ enabled: true, scope, thresholdPercent: 85 });
    for (const origin of ['native', 'tracker', 'successor']) {
      const applied = await rule.apply({ threadId: origin, title: origin }, origin);
      assert.equal(applied, scope === 'all' || scope === origin);
      if (applied) { assert.equal(watch.snapshot().entries[origin].enabled, true); assert.equal(watch.snapshot().entries[origin].thresholdPercent, 85); }
    }
    await rule.apply({ threadId: 'old' }, 'tracker');
    assert.equal(watch.snapshot().entries.old.thresholdPercent, 42); assert.equal(watch.snapshot().entries.old.enabled, false);
    const restored = createNewChatContextRule({ value: saved, watch: () => watch, save: async () => {} });
    assert.deepEqual(restored.snapshot(), { enabled: true, scope, thresholdPercent: 85 });
  }
});

test('successor override keeps inherited series and applies once; disabling a rule does not alter existing chats', async t => {
  const watch = createContextWatch({ save: async () => {}, read: async () => ({ percent: 0 }) }); t.after(() => watch.dispose());
  await watch.setEntry('next', { enabled: true, thresholdPercent: 70, previousThreadId: 'old', series: { code: 'dựÁn1', nextNumber: '0003' } });
  const rule = createNewChatContextRule({ value: { enabled: true, scope: 'successor', thresholdPercent: 90 }, watch: () => watch, save: async () => {} });
  await Promise.all([rule.apply({ threadId: 'next' }, 'successor', true), rule.apply({ threadId: 'next' }, 'successor', true)]);
  assert.equal(watch.snapshot().entries.next.thresholdPercent, 90);
  assert.equal(watch.snapshot().entries.next.series.code, 'dựÁn1');
  await watch.setEntry('next', { enabled: false, thresholdPercent: 60 });
  assert.equal(await rule.apply({ threadId: 'next' }, 'successor', true), false);
  await rule.update({ enabled: false });
  assert.equal(await rule.apply({ threadId: 'new' }, 'successor'), false);
  assert.equal(watch.snapshot().entries.next.thresholdPercent, 60);
});
