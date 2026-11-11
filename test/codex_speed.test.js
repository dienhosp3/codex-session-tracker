'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { normalizeSpeed, observedSpeed, speedChoices, requireSpeed, automaticSpeed } = require('../codex_speed');
const { runContextHandoff } = require('../codex_context_handoff');
const { createContextWatch } = require('../codex_context_watch');
const { applyContextEvent, emptyReading } = require('../codex_context_reader');
const { readSessionRuntimeProfile } = require('../tracker');

test('speed choices use native advertised tiers and reject unsupported selections', () => {
  assert.equal(normalizeSpeed('fast'), 'priority'); assert.equal(normalizeSpeed(null), 'default');
  assert.equal(observedSpeed('bad'), undefined); assert.throws(() => normalizeSpeed('bad'));
  const model = { serviceTiers: [{ id: 'priority' }] };
  assert.deepEqual(speedChoices(model).map(x => x.available), [true, true, false]);
  assert.throws(() => requireSpeed('ultrafast', model), /chưa khả dụng/);
  assert.equal(requireSpeed('ultrafast', { serviceTiers: [{ id: 'ultrafast' }] }), 'ultrafast');
});

test('automatic handoff uses a supported lower speed with an explicit notice; manual choices stay strict', () => {
  const fast = { serviceTiers: [{ id: 'priority' }] };
  assert.deepEqual(automaticSpeed('ultrafast', fast), { serviceTier: 'priority', requestedServiceTier: 'ultrafast',
    speedNotice: 'Ultrafast chưa khả dụng; chat kế tiếp dùng Fast.' });
  assert.equal(automaticSpeed('ultrafast', {}).serviceTier, 'default');
  assert.deepEqual(automaticSpeed('priority', fast), { serviceTier: 'priority' });
  assert.deepEqual(automaticSpeed('default', fast), { serviceTier: 'default' });
  assert.deepEqual(automaticSpeed('ultrafast', { serviceTiers: ['ultrafast'] }), { serviceTier: 'ultrafast' });
  assert.throws(() => requireSpeed('ultrafast', fast), /chưa khả dụng/);
});

test('runtime readers follow native speed changes, including explicit Standard; quoted fields do not change speed', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'speed-reader-')), file = path.join(root, 'rollout.jsonl');
  const events = [
    { type: 'session_meta', payload: { id: 'chat' } },
    { type: 'turn_context', payload: { model: 'gpt-6-astra', effort: 'ultra', service_tier: 'ultrafast' } }
  ];
  await fs.writeFile(file, events.map(JSON.stringify).join('\n') + '\n');
  let runtime = await readSessionRuntimeProfile(file); assert.equal(runtime.serviceTier, 'ultrafast'); assert.equal(runtime.reasoning, 'ultra');
  const state = emptyReading(); for (const event of events) applyContextEvent(state, event);
  assert.equal(state.serviceTier, 'ultrafast');
  const changed = { type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { service_tier: null } } };
  await fs.appendFile(file, JSON.stringify(changed) + '\n'); applyContextEvent(state, changed);
  runtime = await readSessionRuntimeProfile(file); assert.equal(runtime.serviceTier, 'default'); assert.equal(state.serviceTier, 'default');
  applyContextEvent(state, { type: 'response_item', payload: { service_tier: 'ultrafast' } }); assert.equal(state.serviceTier, 'default');
});

test('automatic successors inherit the stopped source speed; manual selection overrides it and survives reload', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'speed-handoff-')), sent = []; let serial = 0, saved;
  const backend = { stopForHandoff: async () => ({ name: '[SPEED-0001] Source', cwd: 'cwd', serviceTier: 'priority' }),
    confirmHandoffStopped: async () => ({ cwd: 'cwd', serviceTier: 'priority' }), renameThread: async () => {},
    createSuccessor: async input => { sent.push(input); return { id: 'next' + (++serial) }; },
    startSuccessor: async input => { sent.push(input); return { turnId: 'turn' + serial }; } };
  const watch = createContextWatch({ state: { handoffDelaySeconds: 0, entries: { old: { enabled: true, thresholdPercent: 80, serviceTier: 'ultrafast' } } },
    save: async value => { saved = value; }, read: async () => ({ running: true, percent: 90, turnId: 't', serviceTier: 'ultrafast' }),
    readManual: async () => ({ turnId: 't' }), handoff: entry => runContextHandoff({ entry, backend, directory }) });
  t.after(() => watch.dispose()); await watch.poll();
  for (let i = 0; i < 100 && watch.snapshot().busy.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(sent[0].serviceTier, 'priority'); assert.equal(sent[1].serviceTier, 'priority');
  assert.equal(saved.entries.next1.serviceTier, 'priority');
  watch.dispose();
  const restored = createContextWatch({ state: saved, save: async value => { saved = value; }, readManual: async () => ({ turnId: 't' }),
    handoff: entry => runContextHandoff({ entry, backend, directory }) }); t.after(() => restored.dispose());
  await restored.transferNow('next1', {}, { serviceTier: 'default' });
  assert.equal(sent[2].serviceTier, 'default'); assert.equal(sent[3].serviceTier, 'default');
  assert.equal(saved.entries.next2.serviceTier, 'default');
});
