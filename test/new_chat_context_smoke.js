'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { appServerFixture } = require('./app_server_fixture');
const { subscribeNewChats } = require('../codex_live_backend');
const { contextConfig } = require('../codex_new_chat');
const { createNewChatContextRule } = require('../codex_new_chat_context');
const { readSessionMeta } = require('../tracker');

test('native new-chat events distinguish Codex, Tracker and successors, without classifying resume as new', { timeout: 45000 }, async () => {
  const f = await appServerFixture(), created = [], entries = {};
  const rule = createNewChatContextRule({ value: { enabled: true, scope: 'all', thresholdPercent: 85 }, save: async () => {},
    watch: () => ({ snapshot: () => ({ entries }), setEntry: async (id, value) => { entries[id] = value; } }) });
  const subscription = subscribeNewChats(async event => {
    created.push({ id: event.threadId, origin: event.origin });
    const thread = await event.readThread(), meta = await readSessionMeta(thread.path);
    if (!meta.parentThreadId) await rule.apply({ threadId: thread.id, cwd: thread.cwd, file: thread.path }, event.origin);
  });
  const waitTurn = async id => { for (let i = 0; i < 150; i++) { if (f.events.some(e => e.method === 'turn/completed' && e.params.turn.id === id)) return; await new Promise(r => setTimeout(r, 30)); } throw new Error('Turn did not complete'); };
  try {
    const native = (await f.rpc('thread/start', { cwd: f.root })).thread;
    const first = (await f.rpc('turn/start', { threadId: native.id, input: [{ type: 'text', text: 'Native new task' }] })).turn;
    await waitTurn(first.id); assert.equal(created[0].origin, 'native');
    for (let i = 0; i < 100 && !entries[native.id]; i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(entries[native.id].thresholdPercent, 85); assert.equal(entries[native.id].enabled, true);
    entries[native.id].enabled = false;
    await f.rpc('thread/resume', { threadId: native.id, excludeTurns: true });
    const resumed = (await f.rpc('turn/start', { threadId: native.id, input: [{ type: 'text', text: 'Same task' }] })).turn;
    await waitTurn(resumed.id); assert.equal(created.length, 1, 'resume is not a new chat'); assert.equal(entries[native.id].enabled, false);
    const config = contextConfig('400k', { model: 'gpt-6-astra', effectivePercent: 95 });
    const fresh = await f.backend.createFreshChat({ cwd: f.root, model: 'gpt-6-astra', contextConfig: config, message: 'Tracker new task' });
    for (let i = 0; i < 100 && !created.some(e => e.id === fresh.id); i++) await new Promise(r => setTimeout(r, 30));
    assert.equal(created.find(e => e.id === fresh.id).origin, 'tracker');
    const next = await f.backend.createSuccessor({ cwd: f.root, model: 'gpt-6-astra', permissionSettings: { start: { approvalPolicy: 'on-request', sandbox: 'read-only' } } });
    const turn = (await f.rpc('turn/start', { threadId: next.id, input: [{ type: 'text', text: 'Successor task' }] })).turn;
    await waitTurn(turn.id); assert.equal(created.find(e => e.id === next.id).origin, 'successor');
    console.log('New-chat origins and resume exclusion verified on installed Codex; external model calls: 0.');
  } finally { subscription.dispose(); await f.close(); }
});
