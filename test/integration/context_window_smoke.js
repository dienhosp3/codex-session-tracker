'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path');
const { appServerFixture } = require('../fixtures/app_server_fixture');
const { contextConfig } = require('../../src/codex_new_chat');

test('installed Codex: isolated fresh contexts, native limits, first task and persistence after restart', { timeout: 90000 }, async () => {
  const f = await appServerFixture();
  const metadata = { model: 'gpt-6-astra', defaultTokens: 272000, maxTokens: 872000, effectivePercent: 95 };
  const records = [];
  async function turn(threadId, message) {
    const result = await f.rpc('turn/start', { threadId, input: [{ type: 'text', text: message }] });
    for (let i = 0; i < 200; i++) {
      const completed = f.events.find(e => e.method === 'turn/completed' && e.params.threadId === threadId && e.params.turn.id === result.turn.id);
      if (completed) {
        assert.equal(completed.params.turn.status, 'completed', JSON.stringify(completed.params.turn.error));
        const usage = f.events.filter(e => e.method === 'thread/tokenUsage/updated' && e.params.threadId === threadId && e.params.turnId === result.turn.id).at(-1);
        assert.ok(usage, 'native token usage notification');
        return usage.params.tokenUsage.modelContextWindow;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Turn did not finish');
  }
  try {
    const models = await f.backend.listModels();
    assert.ok(models.some(model => model.id === 'gpt-6-astra'));
    assert.ok(models.some(model => model.id === 'gpt-6.1-sol'));
    const before = await fs.readFile(path.join(f.home, 'config.toml'), 'utf8');
    for (const [preset, expected] of [['default', 258400], ['400k', 380000], ['600k', 570000], ['900k', 828400]]) {
      const thread = await f.backend.createFreshChat({ cwd: f.root, model: metadata.model, contextConfig: contextConfig(preset, metadata) });
      assert.ok(thread.id);
      assert.equal(f.requests.length, records.length, 'creating an empty chat sends no model request');
      records.push({ preset, expected, id: thread.id });
      const read = (await f.rpc('thread/read', { threadId: thread.id, includeTurns: false })).thread;
      assert.notEqual(read.status.type, 'active');
      assert.equal(await turn(thread.id, 'Fresh task ' + preset), expected);
      await f.rpc('thread/resume', { threadId: thread.id, excludeTurns: true });
      const input = JSON.stringify(f.requests.at(-1).input);
      assert.ok(input.includes('Fresh task ' + preset));
      assert.ok(!input.includes('codex://threads/'), 'no resume prompt');
      for (const previous of records.slice(0, -1)) assert.ok(!input.includes('Fresh task ' + previous.preset), 'fresh conversation has no prior task');
    }
    const alternate = { ...metadata, model: 'gpt-6.1-sol', defaultTokens: 500000 };
    const alternateThread = await f.backend.createFreshChat({ cwd: f.root, model: alternate.model, contextConfig: contextConfig('default', alternate) });
    assert.equal(await turn(alternateThread.id, 'Selected alternate model'), 475000);
    assert.equal(f.requests.at(-1).model, 'gpt-6.1-sol', 'selected model reaches the real Responses request');
    records.push({ id: alternateThread.id, preset: 'alternate-model', expected: 475000 });
    // A task entered in the creation wizard is a brand new first turn.
    const blank = await f.backend.createFreshChat({ cwd: f.root, model: metadata.model, contextConfig: contextConfig('600k', metadata), message: 'Wizard first task' });
    for (let i = 0; i < 100 && !f.events.some(e => e.method === 'turn/completed' && e.params.threadId === blank.id); i++) await new Promise(r => setTimeout(r, 50));
    assert.ok(f.events.some(e => e.method === 'turn/completed' && e.params.threadId === blank.id));
    await f.restart();
    for (const record of [{ id: blank.id, preset: 'wizard task', expected: 570000 }, ...records]) {
      await f.rpc('thread/resume', { threadId: record.id, excludeTurns: true });
      assert.equal(await turn(record.id, 'After restart ' + record.preset), record.expected, record.preset);
      if (record.preset === 'alternate-model') assert.equal(f.requests.at(-1).model, 'gpt-6.1-sol');
    }
    assert.equal(await fs.readFile(path.join(f.home, 'config.toml'), 'utf8'), before, 'global config unchanged');
    const thread = (await f.rpc('thread/read', { threadId: records[0].id, includeTurns: false })).thread;
    const rollout = (await fs.readFile(thread.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    console.log('Rollout provenance: ' + JSON.stringify({ cliVersion: rollout.find(e => e.type === 'session_meta')?.payload.cli_version,
      model: rollout.find(e => e.type === 'turn_context')?.payload.model }));
    console.log('Native effective windows: default=258400; 400K=380000; 600K=570000; 900K=828400. Used chats preserve context after process restart. Empty chat creation sends no model request. External model requests: 0.');
  } finally { await f.close(); }
});
