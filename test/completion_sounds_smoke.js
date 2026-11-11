'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { appServerFixture } = require('./app_server_fixture');
const { subscribeTurnLifecycle } = require('../codex_live_backend');
const { createCompletionSounds } = require('../codex_completion_sounds');
const { normalizeSoundSettings } = require('../codex_sound_settings');
const { soundsForChat } = require('../codex_chat_options');
const { readSessionMeta } = require('../tracker');

test('installed Codex lifecycle: success, terminal service failure and user interrupt produce distinct sound decisions', { timeout: 45000 }, async () => {
  let mode = 'success', saved; const played = [], quiet = new Set();
  const f = await appServerFixture({ respond: async (_request, response) => {
    if (mode === 'failure') { response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Fixture terminal failure', type: 'server_error' } })); return true; }
    if (mode === 'hold') { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write('data: {"type":"response.created","response":{"id":"hold"}}\n\n'); return true; }
    return false;
  } });
  const monitor = createCompletionSounds({ settings: threadId => soundsForChat(normalizeSoundSettings(), { completionSound: !quiet.has(threadId) }), save: async value => { saved = value; },
    describe: async e => { const thread = await e.readThread(); const meta = await readSessionMeta(thread.path); return { isRoot: !meta.parentThreadId, active: thread.status.type === 'active' }; },
    notify: async (type, event) => played.push({ type, ...event }) });
  const subscription = subscribeTurnLifecycle(e => monitor.handle(e));
  const until = async check => { for (let i = 0; i < 160; i++) { if (check()) return; await new Promise(r => setTimeout(r, 50)); } throw new Error('Lifecycle condition not reached'); };
  try {
    for (const status of ['success', 'quiet', 'failure', 'hold']) {
      mode = status;
      const thread = (await f.rpc('thread/start', { cwd: f.root })).thread;
      if (status === 'quiet') quiet.add(thread.id);
      const turn = (await f.rpc('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Fixture ' + status }] })).turn;
      if (status === 'hold') { await until(() => f.requests.length >= 4); await f.rpc('turn/interrupt', { threadId: thread.id, turnId: turn.id }); }
      await until(() => f.events.some(e => e.method === 'turn/completed' && e.params.turn.id === turn.id));
      await monitor.idle();
      if (status === 'success') { await until(() => played.length === 1); assert.equal(played[0].type, 'chat_completed'); }
      if (status === 'quiet') {
        await until(() => saved?.seen.includes(thread.id + ':' + turn.id));
        assert.equal(played.length, 1, 'a muted chat completes without a sound while other chats keep their notifications');
      }
      if (status === 'failure') { await until(() => played.length === 2); assert.equal(played[1].type, 'chat_failed'); }
      if (status === 'hold') { await new Promise(r => setTimeout(r, 300)); assert.equal(played.length, 2); }
    }
    console.log('Real success and terminal failure notified once; per-chat muted completion and manual interrupt stayed silent; external model calls: 0.');
  } finally { subscription.dispose(); monitor.dispose(); await f.close(); }
});
