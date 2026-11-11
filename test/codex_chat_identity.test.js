'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { normalizeDisplayLabel, normalizeIdentity, identityFromTitle, identityPlan, prepareIdentityEdit } = require('../codex_chat_identity');
const { createContextWatch } = require('../codex_context_watch');
const { continuationPlan, CHAT_ID_NOTE } = require('../codex_context_handoff');
const options = { handoffDelaySeconds: 0, intervalMs: 100, completionSound: true, thresholdPercent: 85 };

test('current identity changes preserve the native suffix and calculate the next padded number', () => {
  assert.deepEqual(identityPlan('[OLD-0007] Tên gốc', { code: 'dựÁn2', number: '25' }), {
    title: '[dựÁn2-0025] Tên gốc', series: { code: 'dựÁn2', nextNumber: '0026' }
  });
  assert.equal(identityPlan('Chưa có ID', { code: 'x', number: '9999' }).series.nextNumber, '10000');
  assert.equal(identityPlan('[ABC-0001] Tên gốc', null).title, 'Tên gốc');
  assert.deepEqual(identityFromTitle('[ABC-00001] Tên'), { code: 'ABC', number: '00001' });
  assert.equal(normalizeIdentity({ code: 'á'.normalize('NFD').repeat(30), number: '1' }).code, 'á'.repeat(30));
  for (const value of [{ code: 'a'.repeat(31), number: '1' }, { code: 'bad-id', number: '1' }, { code: 'OK', number: '0' }]) assert.throws(() => normalizeIdentity(value));
});

test('labels are plain local strings, can be cleared and never become a series ID', () => {
  assert.equal(normalizeDisplayLabel('  Dự án <script>  '), 'Dự án <script>');
  assert.equal(normalizeDisplayLabel(''), '');
  assert.throws(() => normalizeDisplayLabel('a'.repeat(121)));
  assert.throws(() => normalizeDisplayLabel('two\nlines'));
  const plan = continuationPlan('uuid', '[REAL-0007] Native title');
  assert.equal(plan.nextTitle, '[REAL-0008] Tiếp tục');
  assert.equal(plan.message.split(CHAT_ID_NOTE).length, 2);
  assert.equal(CHAT_ID_NOTE, 'Mã ID và nhãn chỉ để nhận diện chat, không đưa vào repo.');
});

test('native rename is verified, rejects stale identity, and never resumes or starts anything', async () => {
  let title = '[OLD-0001] Native'; const calls = [];
  const backend = { readChatTitle: async () => title, renameThread: async (id, value) => { calls.push([id, value]); title = value; } };
  const prepared = await prepareIdentityEdit(backend, 'source', { code: 'NEW', number: '4' }, title, { code: 'OLD', number: '0001' });
  assert.equal(prepared.patch.title, '[NEW-0004] Native'); assert.equal(calls.length, 1);
  await prepared.rollback(); assert.equal(title, '[OLD-0001] Native');
  await assert.rejects(prepareIdentityEdit(backend, 'source', { code: 'NEW', number: '5' }, title, null), /ID chat đã thay đổi/);
  assert.equal(calls.length, 2);
});

test('alias and identity settings persist without enabling Auto resume; label follows the successor only as metadata', async t => {
  let saved, title = '[OLD-0001] Native', sent;
  const backend = { readChatTitle: async () => title, renameThread: async (_, value) => { title = value; } };
  const config = { save: async state => { saved = state; }, readManual: async () => ({ turnId: 'turn' }),
    handoff: async entry => { sent = continuationPlan(entry.threadId, title, [], undefined, entry.series); return { ...sent, phase: 'completed', nextThreadId: 'next' }; } };
  const watch = createContextWatch(config); t.after(() => watch.dispose());
  await watch.setChatOptions('source', options, { title }, { prepare: async () => {
    const result = await prepareIdentityEdit(backend, 'source', { code: 'REAL', number: '25' }, title);
    result.patch.displayLabel = '[FAKE-9999] Nhãn riêng'; return result;
  } });
  assert.equal(watch.tracks('source'), false); assert.equal(title, '[REAL-0025] Native');
  watch.dispose(); const restored = createContextWatch({ ...config, state: saved }); t.after(() => restored.dispose());
  await restored.transferNow('source');
  assert.equal(sent.nextTitle, '[REAL-0026] Tiếp tục');
  assert.equal(sent.message.includes('FAKE'), false);
  assert.equal(restored.snapshot().entries.next.displayLabel, '[FAKE-9999] Nhãn riêng');
  assert.equal(restored.snapshot().entries.next.series.nextNumber, '0027');
});

test('failed local save or later permission change rolls back native name and label', async t => {
  for (const afterSaveFails of [false, true]) {
    let title = '[OLD-0001] Native', saved;
    const backend = { readChatTitle: async () => title, renameThread: async (_, value) => { title = value; } };
    const watch = createContextWatch({ save: async state => { if (!afterSaveFails) throw new Error('storage'); saved = state; } }); t.after(() => watch.dispose());
    await assert.rejects(watch.setChatOptions('source', options, { title }, { prepare: async () => {
      const edit = await prepareIdentityEdit(backend, 'source', { code: 'NEW', number: '2' }, title);
      edit.patch.displayLabel = 'Not saved'; return edit;
    }, afterSave: async () => { throw new Error('permissions'); } }), afterSaveFails ? /permissions/ : /storage/);
    assert.equal(title, '[OLD-0001] Native'); assert.equal(watch.snapshot().entries.source, undefined);
    if (afterSaveFails) assert.equal(saved.entries.source, undefined);
  }
});

test('identity edit holds the same lock as auto/manual handoff until its metadata has been saved', async t => {
  let release, transfers = 0;
  const watch = createContextWatch({ state: { entries: { source: { enabled: true } } }, save: async () => {},
    read: async () => ({ running: true, turnId: 'turn', percent: 99 }), handoff: async () => { transfers++; return {}; } }); t.after(() => watch.dispose());
  const pending = watch.setChatOptions('source', options, {}, { prepare: () => new Promise(resolve => { release = resolve; }) });
  for (let i = 0; i < 20 && !release; i++) await new Promise(resolve => setImmediate(resolve));
  await watch.poll(); await assert.rejects(watch.transferNow('source'), /đang lưu/); assert.equal(transfers, 0);
  release({ patch: { displayLabel: 'Saved' } }); await pending;
});
