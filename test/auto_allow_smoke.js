'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { appServerFixture } = require('./app_server_fixture');
const fs = require('node:fs/promises'), path = require('node:path');
const { createAutoAllowStore } = require('../codex_auto_allow');
const { readThreadSettings } = require('../codex_thread_permissions');
const { runContextHandoff } = require('../codex_context_handoff');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await sleep(50); }
  throw new Error('Timed out: ' + label);
}
test('native permission update while an approval is pending', { timeout: 30000 }, async () => {
  let count = 0;
  const f = await appServerFixture({ respond: async (_request, res) => {
    if (++count > 2) return false;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [
      { type: 'response.created', response: { id: 'approval-' + count } },
      { type: 'response.output_item.done', item: { id: 'command-' + count, call_id: 'command-' + count, type: 'function_call', name: 'exec_command',
        arguments: JSON.stringify({ cmd: 'Write-Output tracker-permission-probe-' + count, sandbox_permissions: 'require_escalated', justification: 'Harmless isolated fixture command.' }) } },
      { type: 'response.completed', response: { id: 'approval-' + count, usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } }
    ]) res.write('data: ' + JSON.stringify(event) + '\n\n');
    res.end(); return true;
  } });
  try {
    const thread = (await f.rpc('thread/start', { cwd: f.root, approvalPolicy: 'on-request', permissions: ':read-only' })).thread;
    const turn = (await f.rpc('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Run harmless fixture probes.' }] })).turn;
    await until(() => f.events.some(e => e.method === 'item/commandExecution/requestApproval'), 'approval');
    const result = await f.backend.setAutoAllow({ threadId: thread.id, enabled: true });
    await until(() => f.events.some(e => e.method === 'turn/completed' && e.params.turn.id === turn.id), 'automatic approval and next command');
    const approvals = f.events.filter(e => e.method === 'item/commandExecution/requestApproval');
    assert.equal(result.enabled, true); assert.equal(approvals.length, 2);
    const completed = await f.rpc('thread/read', { threadId: thread.id, includeTurns: true });
    const commands = completed.thread.turns[0].items.filter(item => item.type === 'commandExecution');
    assert.equal(commands.length, 2);
    assert.ok(commands.every(command => command.exitCode === 0 && command.aggregatedOutput.includes('tracker-permission-probe-')));
    console.log('Current read-only turn: both pending and later terminal approvals accepted only after enabling this chat; commands executed.');
  } finally { await f.close(); }
});

test('fresh Tracker chat writes with full access from its first turn, survives stale native overrides/restart, and restores on disable', { timeout: 40000 }, async () => {
  let tool = null;
  const f = await appServerFixture({ respond: async (_request, res) => {
    if (!tool) return false;
    const item = tool; tool = null;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [
      { type: 'response.created', response: { id: item.id } },
      { type: 'response.output_item.done', item },
      { type: 'response.completed', response: { id: item.id, usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } }
    ]) res.write('data: ' + JSON.stringify(event) + '\n\n');
    res.end(); return true;
  } });
  const config = { model_context_window: 200000, model_auto_compact_token_limit: 180000, model_auto_compact_token_limit_scope: 'total' };
  const command = (id, extra = {}) => ({ type: 'function_call', id, call_id: id, name: 'exec_command', arguments: JSON.stringify(extra) });
  const completed = id => f.events.some(e => e.method === 'turn/completed' && e.params.threadId === id);
  try {
    const configBefore = await fs.readFile(path.join(f.home, 'config.toml'), 'utf8');
    const output = path.join(f.root, 'first-turn-write.txt');
    tool = command('first-write', { cmd: "Set-Content -LiteralPath '" + output.replace(/'/g, "''") + "' -Value 'first-turn-full-access'" });
    const source = await f.backend.createFreshChat({ cwd: f.root, model: 'gpt-6-astra', contextConfig: config, message: 'Write the fixture file.' });
    await until(() => completed(source.id), 'first full-access turn completed');
    assert.equal((await fs.readFile(output, 'utf8')).trim(), 'first-turn-full-access');
    assert.equal(f.events.filter(e => e.method === 'item/commandExecution/requestApproval').length, 0);
    let settings = await readThreadSettings(source.path, source.id);
    assert.equal(settings.approval_policy, 'never'); assert.equal(settings.active_permission_profile.id, ':danger-full-access');
    const store = createAutoAllowStore(path.join(f.root, 'permissions'));
    assert.equal(store.get(source.id).enabled, true);

    await f.restart();
    await f.rpc('thread/resume', { threadId: source.id, permissions: ':read-only', approvalPolicy: 'on-request' });
    tool = command('after-restart', { cmd: 'Write-Output resumed-full-access' });
    const resumed = (await f.rpc('turn/start', { threadId: source.id, permissions: ':read-only', approvalPolicy: 'on-request',
      input: [{ type: 'text', text: 'Continue fixture after restart.' }] })).turn;
    await until(() => f.events.some(e => e.method === 'turn/completed' && e.params.turn.id === resumed.id), 'resumed turn completed');
    settings = await readThreadSettings(source.path, source.id);
    assert.equal(settings.approval_policy, 'never'); assert.equal(settings.active_permission_profile.id, ':danger-full-access');

    const unrelated = (await f.rpc('thread/start', { cwd: f.root, permissions: ':read-only', approvalPolicy: 'on-request' })).thread;
    tool = command('other-command', { cmd: 'Write-Output other-must-ask', sandbox_permissions: 'require_escalated', justification: 'Fixture approval must remain interactive.' });
    const otherTurn = (await f.rpc('turn/start', { threadId: unrelated.id, input: [{ type: 'text', text: 'Other fixture.' }] })).turn;
    await until(() => f.events.some(e => e.method === 'item/commandExecution/requestApproval' && e.params.threadId === unrelated.id), 'unrelated approval');
    await sleep(150);
    assert.ok((await f.rpc('thread/read', { threadId: unrelated.id })).thread.status.activeFlags.includes('waitingOnApproval'));
    const otherApproval = f.events.find(e => e.method === 'item/commandExecution/requestApproval' && e.params.threadId === unrelated.id);
    f.reply(otherApproval.id, { decision: 'decline' });
    await until(() => f.events.some(e => e.method === 'turn/completed' && e.params.turn.id === otherTurn.id), 'unrelated complete');

    await f.backend.setAutoAllow({ threadId: source.id, enabled: false });
    assert.equal(store.get(source.id).enabled, false);
    await f.restart();
    await f.rpc('thread/resume', { threadId: source.id, permissions: ':danger-full-access', approvalPolicy: 'never' });
    tool = command('disabled-command', { cmd: 'Write-Output disabled-must-ask', sandbox_permissions: 'require_escalated', justification: 'Fixture disabled approval.' });
    const offTurn = (await f.rpc('turn/start', { threadId: source.id, permissions: ':danger-full-access', approvalPolicy: 'never',
      input: [{ type: 'text', text: 'Verify Auto Allow off.' }] })).turn;
    await until(() => f.events.some(e => e.method === 'item/commandExecution/requestApproval' && e.params.turnId === offTurn.id), 'disabled approval');
    await sleep(150);
    assert.ok((await f.rpc('thread/read', { threadId: source.id })).thread.status.activeFlags.includes('waitingOnApproval'));
    settings = await readThreadSettings(source.path, source.id);
    assert.equal(settings.approval_policy, 'on-request');
    assert.equal(settings.sandbox_policy.type, 'workspace-write');
    const offApproval = f.events.find(e => e.method === 'item/commandExecution/requestApproval' && e.params.turnId === offTurn.id);
    f.reply(offApproval.id, { decision: 'decline' });
    assert.equal(await fs.readFile(path.join(f.home, 'config.toml'), 'utf8'), configBefore);
    console.log('Fresh first-turn write, persistent full access, unrelated chat isolation and restored approval after disabling all passed; global config unchanged.');
  } finally { await f.close(); }
});

test('Auto Allow and original permission backup inherit into a Goal successor independently', { timeout: 30000 }, async () => {
  let holding = false;
  const f = await appServerFixture({ respond: async (_request, res) => {
    if (!holding) return false;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ type: 'response.created', response: { id: 'inherit-goal' } }) + '\n\n');
    return true;
  } });
  try {
    const source = await f.backend.createFreshChat({ cwd: f.root, model: 'gpt-6-astra', message: 'Seed independent task.',
      contextConfig: { model_context_window: 200000, model_auto_compact_token_limit: 180000, model_auto_compact_token_limit_scope: 'total' } });
    await until(() => f.events.some(e => e.method === 'turn/completed' && e.params.threadId === source.id), 'source completed');
    await until(async () => (await f.rpc('thread/read', { threadId: source.id })).thread.status.type === 'idle', 'source idle');
    holding = true;
    const objective = 'MỤC TIÊU:\nGiữ quyền qua chuyển chat.\n\nHOÀN TẤT KHI:\nKiểm tra đạt.';
    const result = await runContextHandoff({ backend: f.backend, directory: path.join(f.root, 'handoffs'), entry: {
      threadId: source.id, ...await f.backend.readHandoffState(source.id), model: 'gpt-6-astra', cwd: f.root,
      successorMode: 'goal', goalText: objective, manual: true, handoffDelaySeconds: 0
    } });
    await until(() => f.requests.length === 2, 'Goal request');
    const next = (await f.rpc('thread/read', { threadId: result.nextThreadId })).thread;
    const settings = await readThreadSettings(next.path, next.id);
    assert.equal(settings.approval_policy, 'never'); assert.equal(settings.active_permission_profile.id, ':danger-full-access');
    const store = createAutoAllowStore(path.join(f.root, 'permissions'));
    assert.equal(store.get(next.id).enabled, true);
    assert.deepEqual(store.get(next.id).previous, store.get(source.id).previous);
    await f.backend.setAutoAllow({ threadId: next.id, enabled: false });
    assert.equal(store.get(source.id).enabled, true); assert.equal(store.get(next.id).enabled, false);
    assert.equal((await f.backend.readGoal(next.id)).objective, objective);
    console.log('Goal successor inherits Auto Allow/full access; changing successor preference does not change source or goal.');
  } finally { await f.close(); }
});
