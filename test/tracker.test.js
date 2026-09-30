'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const EventEmitter = require('events');
const tracker = require('../tracker');
const codexQueue = require('../codex_queue');
const codexSteer = require('../codex_steer');

async function tempRoot() {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-tracker-test-'));
}

async function writeRollout(root, name, lines, mtimeMs = Date.now()) {
  const dir = path.join(root, '2026', '09', '30');
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await fs.promises.writeFile(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n', 'utf8');
  const time = new Date(mtimeMs);
  await fs.promises.utimes(file, time, time);
  return file;
}

function meta(id, cwd = 'C:\\repo', source = 'vscode') {
  return {
    timestamp: '2026-09-30T07:00:00Z',
    type: 'session_meta',
    payload: {
      id,
      session_id: id,
      timestamp: '2026-09-30T07:00:00Z',
      cwd,
      originator: 'Codex VS Code',
      source
    }
  };
}

function userMessage(text) {
  return {
    timestamp: '2026-09-30T07:00:01Z',
    type: 'event_msg',
    payload: { type: 'user_message', message: text }
  };
}

function started(turnId = 'turn-1', timestamp = '2026-09-30T07:00:02Z', startedAt = 1790751602) {
  return {
    timestamp,
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: turnId, started_at: startedAt }
  };
}

function completed(turnId = 'turn-1', error = null) {
  return {
    timestamp: '2026-09-30T07:00:03Z',
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      turn_id: turnId,
      completed_at: 1790751603,
      ...(error ? { error } : {})
    }
  };
}

test('reads VS Code session title and running state', async t => {
  const root = await tempRoot();
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const file = await writeRollout(root, 'rollout-a.jsonl', [
    meta('thread-a'),
    userMessage('Cải tổ UI UX AHUST Editor'),
    started()
  ]);

  const summary = await tracker.readSessionSummary(file);
  assert.equal(summary.threadId, 'thread-a');
  assert.equal(summary.title, 'Cải tổ UI UX AHUST Editor');
  assert.equal(summary.source, 'vscode');

  const status = await tracker.readLatestTaskEvent(file);
  assert.equal(status.kind, 'running');
  assert.equal(status.turnId, 'turn-1');
  const activity = await tracker.readRecentActivity(file, await tracker.readSessionSummary(file), 'thread-a', { timelineLimit: 20 });
  assert.equal(activity.latestUserText, 'Cải tổ UI UX AHUST Editor');
  assert.equal(activity.latestUserTextAt, Date.parse('2026-09-30T07:00:01Z'));
});

test('task_complete makes the latest state completed', async t => {
  const root = await tempRoot();
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const file = await writeRollout(root, 'rollout-b.jsonl', [
    meta('thread-b'),
    userMessage('Fix renderer'),
    started(),
    completed()
  ]);

  const status = await tracker.readLatestTaskEvent(file);
  assert.equal(status.kind, 'completed');
});

test('task_complete with error becomes error', async t => {
  const root = await tempRoot();
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const file = await writeRollout(root, 'rollout-c.jsonl', [
    meta('thread-c'),
    userMessage('Broken task'),
    started(),
    completed('turn-1', { message: 'failed' })
  ]);

  const status = await tracker.readLatestTaskEvent(file);
  assert.equal(status.kind, 'error');
});

test('turn_aborted is terminal and does not leave a chat falsely running', async t => {
  const root = await tempRoot();
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const id = 'abort-abort-abort-abort-abortabortabort';
  const file = await writeRollout(root, 'rollout-aborted.jsonl', [
    meta(id),
    started('turn-abort'),
    event('turn_aborted', { turn_id: 'turn-abort', started_at: '2026-09-30T07:00:02Z', completed_at: '2026-09-30T07:00:04Z', reason: 'user_cancelled' })
  ]);
  const status = await tracker.readLatestTaskEvent(file);
  assert.equal(status.kind, 'aborted');
  assert.equal(status.completedAt, Date.parse('2026-09-30T07:00:04Z'));
});

test('parses current Codex item_completed records for commands, file changes, images, and messages', async t => {
  const root = await tempRoot();
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const id = 'real-real-real-real-realrealrealreal';
  const completedItem = (item, at) => ({
    timestamp: new Date(at).toISOString(),
    type: 'event_msg',
    payload: { type: 'item_completed', thread_id: id, turn_id: 'turn-real', item, started_at_ms: at - 50, completed_at_ms: at }
  });
  const file = await writeRollout(root, 'rollout-real-items.jsonl', [
    richMeta({ id }),
    event('task_started', { turn_id: 'turn-real', started_at_ms: Date.parse('2026-09-30T08:00:00Z') }),
    completedItem({ type: 'CommandExecution', id: 'exec-1', command: ['npm', 'test'], status: 'completed', exit_code: 0, stdout: '22 passed' }, Date.parse('2026-09-30T08:00:02Z')),
    completedItem({ type: 'FileChange', id: 'patch-1', changes: { 'src/app.js': { type: 'update' } }, status: 'completed' }, Date.parse('2026-09-30T08:00:03Z')),
    completedItem({ type: 'ImageView', id: 'image-1', path: 'C:\\tmp\\screen.png' }, Date.parse('2026-09-30T08:00:04Z')),
    completedItem({ type: 'AgentMessage', id: 'message-1', content: [{ type: 'Text', text: 'Finished the checks.' }] }, Date.parse('2026-09-30T08:00:05Z'))
  ]);
  const summary = await tracker.readSessionSummary(file);
  const activity = await tracker.readRecentActivity(file, summary, id, { timelineLimit: 20 });
  assert.equal(activity.status.kind, 'running');
  assert.ok(activity.timeline.some(item => item.label === 'Da chay lenh' && /npm test/.test(item.detail)));
  const fileChange = activity.timeline.find(item => item.label === 'Da chinh sua cac tep');
  assert.ok(fileChange);
  assert.deepEqual(fileChange.children.map(child => child.detail), ['src/app.js']);
  assert.ok(activity.timeline.some(item => item.label === 'Da xem anh' && /screen\.png/.test(item.detail)));
  assert.ok(activity.timeline.some(item => item.kind === 'message' && item.text === 'Finished the checks.'));
  assert.equal(activity.latestAssistantText, 'Finished the checks.');
  assert.equal(activity.latestAssistantTextAt, Date.parse('2026-09-30T08:00:05Z'));
});

test('parses response_item tool calls and assistant messages with event timestamps', async t => {
  const root = await tempRoot();
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const id = 'resp-resp-resp-resp-resprespresp';
  const file = await writeRollout(root, 'rollout-response-items.jsonl', [
    richMeta({ id }),
    event('task_started', { turn_id: 'turn-response', started_at: 1790755200 }),
    { timestamp: '2026-09-30T09:00:02Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call-1', input: 'npm run lint' } },
    { timestamp: '2026-09-30T09:00:03Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call-1', output: 'ok' } },
    { timestamp: '2026-09-30T09:00:04Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'All good.' }] } }
  ]);
  const summary = await tracker.readSessionSummary(file);
  const activity = await tracker.readRecentActivity(file, summary, id, { timelineLimit: 20 });
  assert.ok(activity.timeline.some(item => item.kind === 'command' && item.phase === 'begin'));
  assert.ok(activity.timeline.some(item => item.kind === 'command' && item.phase === 'end'));
  assert.ok(activity.timeline.some(item => item.kind === 'message' && item.text === 'All good.'));
  assert.equal(activity.latestAssistantText, 'All good.');
  assert.equal(activity.latestAssistantTextAt, Date.parse('2026-09-30T09:00:04Z'));
});

test('scanSessions groups multiple rollout files by thread and keeps newest', async t => {
  const root = await tempRoot();
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const oldTime = Date.now() - 60_000;
  const newTime = Date.now();

  await writeRollout(root, 'rollout-old.jsonl', [
    meta('same-thread', 'C:\\repo'),
    userMessage('Old title'),
    started('turn-old'),
    completed('turn-old')
  ], oldTime);

  const newer = await writeRollout(root, 'rollout-new.jsonl', [
    meta('same-thread', 'C:\\repo'),
    userMessage('New title'),
    started('turn-new')
  ], newTime);

  await writeRollout(root, 'rollout-cli.jsonl', [
    meta('cli-thread', 'C:\\repo', 'cli'),
    userMessage('CLI chat')
  ], newTime + 1000);

  const sessions = await tracker.scanSessions({
    sessionsDir: root,
    historyLimit: 20,
    includeNonVsCodeSessions: false
  });

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].threadId, 'same-thread');
  assert.equal(sessions[0].file, newer);
  assert.equal(sessions[0].title, 'New title');
});

test('backward scan remains correct with a large rollout after task_started', async t => {
  const root = await tempRoot();
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const filler = 'x'.repeat(6000);
  const lines = [meta('thread-large'), userMessage('Large task'), started('turn-large')];
  for (let i = 0; i < 120; i += 1) {
    lines.push({ timestamp: `2026-09-30T07:01:${String(i % 60).padStart(2, '0')}Z`, type: 'response_item', payload: { type: 'reasoning', text: filler } });
  }
  const file = await writeRollout(root, 'rollout-large.jsonl', lines);
  const status = await tracker.readLatestTaskEvent(file);
  assert.equal(status.kind, 'running');
  assert.equal(status.turnId, 'turn-large');
});

function richMeta({ id, sessionId = id, parentThreadId = null, cwd = 'C:\\repo', source = 'vscode', nickname = null, role = null }) {
  return {
    timestamp: '2026-09-30T08:00:00Z',
    type: 'session_meta',
    payload: {
      id,
      session_id: sessionId,
      parent_thread_id: parentThreadId,
      timestamp: '2026-09-30T08:00:00Z',
      cwd,
      originator: 'Codex VS Code',
      source,
      agent_nickname: nickname,
      agent_role: role
    }
  };
}

function event(type, payload = {}, timestamp = '2026-09-30T08:00:05Z') {
  return { timestamp, type: 'event_msg', payload: { type, ...payload } };
}

test('parses current Codex subagent source shape with parent identity', () => {
  const root = '11111111-1111-1111-1111-111111111111';
  const parsed = tracker.parseSessionSource({
    subagent: {
      thread_spawn: {
        parent_thread_id: root,
        depth: 2,
        agent_path: ['worker', 'review'],
        agent_nickname: 'worker-1',
        agent_role: 'reviewer'
      }
    }
  });
  assert.equal(parsed.kind, 'subagent');
  assert.equal(parsed.subagentKind, 'thread_spawn');
  assert.equal(parsed.parentThreadId, root);
  assert.equal(parsed.agentDepth, 2);
  assert.equal(parsed.agentNickname, 'worker-1');
  assert.equal(parsed.agentRole, 'reviewer');
});

test('session tree includes only selected root and its descendants, not same-cwd chats', async t => {
  const root = await tempRoot();
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const rootId = '11111111-1111-1111-1111-111111111111';
  const childId = '22222222-2222-2222-2222-222222222222';
  const otherId = '33333333-3333-3333-3333-333333333333';

  const rootFile = await writeRollout(root, `rollout-2026-09-30T08-00-00-${rootId}.jsonl`, [
    richMeta({ id: rootId }),
    userMessage('Root chat'),
    started('root-turn'),
    completed('root-turn')
  ], Date.now() - 3000);

  await writeRollout(root, `rollout-2026-09-30T08-00-01-${childId}.jsonl`, [
    richMeta({
      id: childId,
      sessionId: rootId,
      parentThreadId: rootId,
      source: { subagent: { thread_spawn: { parent_thread_id: rootId, depth: 1, agent_path: ['worker'], agent_nickname: 'worker-a', agent_role: 'worker' } } },
      nickname: 'worker-a',
      role: 'worker'
    }),
    started('child-turn', '2026-09-30T07:00:04Z', 1790751604)
  ], Date.now() - 1000);

  await writeRollout(root, `rollout-2026-09-30T08-00-02-${otherId}.jsonl`, [
    richMeta({ id: otherId, cwd: 'C:\\repo' }),
    userMessage('Unrelated chat in same cwd'),
    started('other-turn')
  ], Date.now());

  const rootSummary = await tracker.readSessionSummary(rootFile);
  const tree = await tracker.scanSessionTree(root, rootSummary, { scanLimit: 50 });
  assert.deepEqual(new Set(tree.map(x => x.threadId)), new Set([rootId, childId]));
  assert.equal(tree.find(x => x.threadId === childId).parentThreadId, rootId);
});

test('overall selected chat stays running while a child agent is running', async t => {
  const root = await tempRoot();
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const rootId = '44444444-4444-4444-4444-444444444444';
  const childId = '55555555-5555-5555-5555-555555555555';

  const rootFile = await writeRollout(root, `rollout-2026-09-30T08-10-00-${rootId}.jsonl`, [
    richMeta({ id: rootId }),
    userMessage('Delegate this'),
    started('root-turn'),
    completed('root-turn')
  ], Date.now() - 3000);

  await writeRollout(root, `rollout-2026-09-30T08-10-01-${childId}.jsonl`, [
    richMeta({
      id: childId,
      sessionId: rootId,
      parentThreadId: rootId,
      source: { subagent: { thread_spawn: { parent_thread_id: rootId, depth: 1, agent_path: ['worker'], agent_nickname: 'worker-b', agent_role: 'worker' } } }
    }),
    started('child-turn', new Date(Date.now() - 600).toISOString(), Date.now() - 600),
    event('exec_command_begin', { call_id: 'cmd-1', turn_id: 'child-turn', started_at_ms: Date.now() - 500, command: ['npm', 'test'], cwd: 'file:///C:/repo', parsed_cmd: [], source: 'agent' })
  ], Date.now());

  const rootSummary = await tracker.readSessionSummary(rootFile);
  const tree = await tracker.scanSessionTree(root, rootSummary, { scanLimit: 50 });
  const snapshot = await tracker.buildSessionSnapshot(root, rootSummary, { tree, timelineLimit: 30, activityMaxBytes: 1024 * 1024 });
  assert.equal(snapshot.overallStatus.kind, 'running');
  assert.equal(snapshot.overallStatus.runningChildren, 1);
  assert.equal(snapshot.current.label, 'Dang chay lenh');
  assert.match(snapshot.current.detail, /npm test/);
  assert.equal(snapshot.current.actor, 'worker-b');
});

test('MCP calls and code patches appear in recent interaction timeline', async t => {
  const root = await tempRoot();
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const rootId = '66666666-6666-6666-6666-666666666666';
  const file = await writeRollout(root, `rollout-2026-09-30T08-20-00-${rootId}.jsonl`, [
    richMeta({ id: rootId }),
    userMessage('Use MCP then patch'),
    started('turn-x'),
    event('mcp_tool_call_begin', { call_id: 'mcp-1', turn_id: 'turn-x', invocation: { server: 'github', tool: 'fetch', arguments: {} } }, '2026-09-30T08:20:03Z'),
    event('mcp_tool_call_end', { call_id: 'mcp-1', turn_id: 'turn-x', invocation: { server: 'github', tool: 'fetch', arguments: {} }, result: {}, duration: '1s' }, '2026-09-30T08:20:04Z'),
    event('patch_apply_begin', { call_id: 'patch-1', turn_id: 'turn-x', auto_approved: true, changes: { 'src/app.js': {} } }, '2026-09-30T08:20:05Z')
  ]);

  const summary = await tracker.readSessionSummary(file);
  const activity = await tracker.readRecentActivity(file, summary, rootId, { timelineLimit: 20 });
  assert.equal(activity.status.kind, 'running');
  assert.equal(activity.current.label, 'Dang sua code');
  assert.match(activity.current.detail, /src\/app.js/);
  assert.ok(activity.timeline.some(x => x.label === 'Dang goi MCP'));
  assert.ok(activity.timeline.some(x => x.label === 'MCP da xong'));
});

test('current visible text aggregates message deltas and does not expose raw reasoning text', async t => {
  const root = await tempRoot();
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const rootId = '77777777-7777-7777-7777-777777777777';
  const file = await writeRollout(root, `rollout-2026-09-30T08-30-00-${rootId}.jsonl`, [
    richMeta({ id: rootId }),
    userMessage('Stream a reply'),
    started('turn-stream'),
    event('agent_reasoning_raw_content', { text: 'PRIVATE RAW REASONING' }, '2026-09-30T08:30:03Z'),
    event('agent_reasoning', { text: 'Checking the affected files' }, '2026-09-30T08:30:04Z'),
    event('agent_message_content_delta', { delta: 'Hello ' }, '2026-09-30T08:30:05Z'),
    event('agent_message_content_delta', { delta: 'world' }, '2026-09-30T08:30:06Z')
  ]);
  const summary = await tracker.readSessionSummary(file);
  const activity = await tracker.readRecentActivity(file, summary, rootId, { timelineLimit: 20 });
  assert.equal(activity.current.label, 'Dang tra loi');
  assert.equal(activity.current.text, 'Hello world');
  assert.ok(!JSON.stringify(activity).includes('PRIVATE RAW REASONING'));
});

test('cleanTitle removes injected recommended_plugins content', () => {
  assert.equal(tracker.cleanTitle('<recommended_plugins>Injected plugin list</recommended_plugins> Real user title'), 'Real user title');
  assert.equal(tracker.cleanTitle('<recommended_plugins>Injected plugin list without close'), '');
});

test('scanActiveSessions uses session_index title, hides completed roots, and sorts newest activity first', async t => {
  const root = await tempRoot();
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const sessionsDir = path.join(root, 'sessions');
  const a = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const b = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const done = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const now = Date.now();

  await writeRollout(sessionsDir, `rollout-2026-09-30T09-00-00-${a}.jsonl`, [
    richMeta({ id: a }),
    userMessage('<recommended_plugins>noise</recommended_plugins> Fallback A'),
    started('turn-a')
  ], now - 5000);
  await writeRollout(sessionsDir, `rollout-2026-09-30T09-00-01-${b}.jsonl`, [
    richMeta({ id: b }),
    userMessage('Fallback B'),
    started('turn-b')
  ], now - 1000);
  await writeRollout(sessionsDir, `rollout-2026-09-30T09-00-02-${done}.jsonl`, [
    richMeta({ id: done }),
    userMessage('Finished root'),
    started('turn-done'),
    completed('turn-done')
  ], now);

  await fs.promises.writeFile(path.join(root, 'session_index.jsonl'), [
    JSON.stringify({ id: a, thread_name: 'Actual title A', updated_at: '2026-09-30T09:00:10Z' }),
    JSON.stringify({ id: b, thread_name: 'Actual title B', updated_at: '2026-09-30T09:00:11Z' })
  ].join('\n') + '\n');

  const active = await tracker.scanActiveSessions({
    codexHome: root,
    sessionsDir,
    historyLimit: 20,
    scanLimit: 100,
    includeNonVsCodeSessions: false
  });
  assert.deepEqual(active.map(x => x.threadId), [b, a]);
  assert.deepEqual(active.map(x => x.title), ['Actual title B', 'Actual title A']);
  assert.ok(!active.some(x => x.threadId === done));
});

test('state database timestamp is used when rollout mtime is behind', async t => {
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { t.skip('node:sqlite is unavailable in this host'); return; }
  const root = await tempRoot();
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const id = 'state-state-state-state-state-state';
  const db = new DatabaseSync(path.join(root, 'state_1.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, updated_at INTEGER, updated_at_ms INTEGER)');
  db.prepare('INSERT INTO threads (id, updated_at, updated_at_ms) VALUES (?, ?, ?)').run(id, 1790770000, 1790770000123);
  db.close();
  const times = tracker.readStateThreadActivity(root, new Set([id]));
  assert.equal(times.get(id), 1790770000123);
});

test('scanActiveSessions keeps a root visible when only its child is running', async t => {
  const root = await tempRoot();
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const sessionsDir = path.join(root, 'sessions');
  const rootId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  const childId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  const now = Date.now();

  await writeRollout(sessionsDir, `rollout-2026-09-30T09-10-00-${rootId}.jsonl`, [
    richMeta({ id: rootId }),
    userMessage('Root with worker'),
    started('root-turn'),
    completed('root-turn')
  ], now - 4000);
  await writeRollout(sessionsDir, `rollout-2026-09-30T09-10-01-${childId}.jsonl`, [
    richMeta({
      id: childId,
      sessionId: rootId,
      parentThreadId: rootId,
      source: { subagent: { thread_spawn: { parent_thread_id: rootId, depth: 1, agent_path: ['worker'], agent_nickname: 'worker', agent_role: 'worker' } } }
    }),
    started('child-turn', '2026-09-30T07:00:04Z', 1790751604)
  ], now - 500);

  const active = await tracker.scanActiveSessions({ codexHome: root, sessionsDir, historyLimit: 20, scanLimit: 100 });
  assert.equal(active.length, 1);
  assert.equal(active[0].threadId, rootId);
  assert.equal(active[0].status.kind, 'running');
  assert.equal(active[0].status.runningChildren, 1);
});

test('old orphan child rollouts do not revive a completed root conversation', async t => {
  const root = await tempRoot();
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const rootId = 'abababab-abab-abab-abab-111111111111';
  const childId = 'cdcdcdcd-cdcd-cdcd-cdcd-222222222222';
  await writeRollout(root, `rollout-root-${rootId}.jsonl`, [
    richMeta({ id: rootId }), userMessage('Completed root'), started('root-turn'), completed('root-turn')
  ]);
  await writeRollout(root, `rollout-child-${childId}.jsonl`, [
    richMeta({ id: childId, sessionId: rootId, parentThreadId: rootId, source: { subagent: { thread_spawn: { parent_thread_id: rootId, depth: 1, agent_path: ['old'], agent_nickname: 'old', agent_role: 'worker' } } } }),
    started('old-child')
  ]);
  const active = await tracker.scanActiveSessions({ sessionsDir: root, historyLimit: 20, scanLimit: 50 });
  assert.deepEqual(active, []);
  const rootSession = await tracker.readSessionSummary(path.join(root, '2026', '09', '30', `rollout-root-${rootId}.jsonl`));
  const tree = await tracker.scanSessionTree(root, rootSession, { scanLimit: 50 });
  const snapshot = await tracker.buildSessionSnapshot(root, rootSession, { tree, timelineLimit: 20, activityMaxBytes: 1024 * 1024 });
  assert.equal(snapshot.overallStatus.kind, 'completed');
  assert.deepEqual(snapshot.activeNodes, []);
});

test('an unfinished root remains running regardless of rollout file age', async t => {
  const root = await tempRoot();
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const id = 'age-age-age-age-age-age-age-age';
  await writeRollout(root, `rollout-old-${id}.jsonl`, [richMeta({ id }), userMessage('Still running'), started('turn')], Date.now() - 24 * 60 * 60 * 1000);
  const active = await tracker.scanActiveSessions({ sessionsDir: root, historyLimit: 20, scanLimit: 50 });
  assert.equal(active.length, 1);
  assert.equal(active[0].status.kind, 'running');
});

test('snapshot activeNodes contains only running nodes and is newest-first', async t => {
  const root = await tempRoot();
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const rootId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  const runningId = '12121212-1212-1212-1212-121212121212';
  const doneId = '34343434-3434-3434-3434-343434343434';
  const rootFile = await writeRollout(root, `rollout-2026-09-30T09-20-00-${rootId}.jsonl`, [
    richMeta({ id: rootId }), userMessage('Root'), started('r'), completed('r')
  ], Date.now() - 4000);
  await writeRollout(root, `rollout-2026-09-30T09-20-01-${runningId}.jsonl`, [
    richMeta({ id: runningId, sessionId: rootId, parentThreadId: rootId, source: { subagent: { thread_spawn: { parent_thread_id: rootId, depth: 1, agent_path: ['run'], agent_nickname: 'run', agent_role: 'worker' } } } }),
    started('run', '2026-09-30T07:00:04Z', 1790751604)
  ], Date.now() - 500);
  await writeRollout(root, `rollout-2026-09-30T09-20-02-${doneId}.jsonl`, [
    richMeta({ id: doneId, sessionId: rootId, parentThreadId: rootId, source: { subagent: { thread_spawn: { parent_thread_id: rootId, depth: 1, agent_path: ['done'], agent_nickname: 'done', agent_role: 'worker' } } } }),
    started('done'), completed('done')
  ], Date.now() - 1000);

  const summary = await tracker.readSessionSummary(rootFile);
  const tree = await tracker.scanSessionTree(root, summary, { scanLimit: 100 });
  const snapshot = await tracker.buildSessionSnapshot(root, summary, { tree, timelineLimit: 50, activityMaxBytes: 1024 * 1024 });
  assert.deepEqual(snapshot.activeNodes.map(x => x.threadId), [runningId]);
  assert.ok(!snapshot.activeNodes.some(x => x.threadId === doneId));
  assert.ok(!snapshot.activeNodes.some(x => x.threadId === rootId));
  for (let i = 1; i < snapshot.timeline.length; i += 1) {
    assert.ok((snapshot.timeline[i - 1].at || 0) >= (snapshot.timeline[i].at || 0));
  }
});

test('status bar tone is green only for running and red only for terminal states', () => {
  assert.equal(tracker.statusBarTone('running'), 'running');
  assert.equal(tracker.statusBarTone({ kind: 'completed' }), 'stopped');
  assert.equal(tracker.statusBarTone({ kind: 'error' }), 'stopped');
  assert.equal(tracker.statusBarTone({ kind: 'unknown' }), 'default');
  assert.equal(tracker.statusBarTone({ kind: 'missing' }), 'default');
  assert.equal(tracker.statusBarTone(null), 'default');
});

test('human agent display names never expose opaque thread ids', () => {
  const rootId = '01a0ebc7-ddbe-78f2-aaee-38c3b5b7144a';
  const childId = '01999999-aaaa-bbbb-cccc-123456789abc';
  assert.equal(tracker.agentDisplayName({ threadId: rootId }, rootId), 'Main');
  const fallback = tracker.agentDisplayName({ threadId: childId }, rootId, '', 3);
  assert.equal(fallback, 'Sub-agent 3');
  assert.ok(!fallback.includes(childId));
});

test('human agent display name prefers nickname, role, then task preview', () => {
  const rootId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const childId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  assert.equal(
    tracker.agentDisplayName({ threadId: childId, agentNickname: 'renderer-check' }, rootId, 'Investigate layout', 1),
    'renderer-check'
  );
  assert.equal(
    tracker.agentDisplayName({ threadId: childId, agentRole: 'test_runner' }, rootId, 'Investigate layout', 1),
    'Test Runner'
  );
  const fromTask = tracker.agentDisplayName({ threadId: childId, agentRole: 'worker' }, rootId, 'Investigate why the WebView table row height changes on zoom. Then report back.', 1);
  assert.match(fromTask, /^Investigate why the WebView table row height/);
});

test('queue support probe detects the official codex queue interface', async () => {
  const calls = [];
  const execFileImpl = (file, args, options, callback) => {
    calls.push({ file, args, options });
    if (args[0] === 'queue') callback(null, 'Usage: codex queue --thread <THREAD> --message <TEXT>\n', '');
    else callback(null, 'codex-cli 1.2.3\n', '');
  };
  const result = await codexQueue.probeQueueSupport('C:\\codex.exe', { execFileImpl });
  assert.equal(result.available, true);
  assert.equal(result.version, 'codex-cli 1.2.3');
  assert.equal(calls.length, 2);
});

test('queued message uses exact thread, preserves CODEX_HOME, and never passes a model override', async () => {
  const calls = [];
  const execFileImpl = (file, args, options, callback) => {
    calls.push({ file, args: [...args], options });
    callback(null, 'Queued message q-123 for thread root-thread.\n', '');
  };
  const result = await codexQueue.queueMessage({
    executable: 'C:\\OpenAI\\codex.exe',
    threadId: 'root-thread',
    message: 'Sau khi xong hãy chạy lại test.',
    codexHome: 'C:\\Users\\SP3\\.codex',
    cwd: 'C:\\repo',
    execFileImpl
  });
  assert.equal(result.queuedId, 'q-123');
  assert.equal(result.threadId, 'root-thread');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [
    'queue', '--thread', 'root-thread', '--message', 'Sau khi xong hãy chạy lại test.'
  ]);
  assert.equal(calls[0].options.env.CODEX_HOME, 'C:\\Users\\SP3\\.codex');
  assert.ok(!calls[0].args.some(arg => /^--?model$/i.test(arg) || String(arg).includes('model=')));
});

test('bundled OpenAI Codex binary is preferred over PATH for version compatibility', async t => {
  const root = await tempRoot();
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const binDir = path.join(root, 'bin', 'win32-x64');
  await fs.promises.mkdir(binDir, { recursive: true });
  const bundled = path.join(binDir, 'codex.exe');
  await fs.promises.writeFile(bundled, 'fake');
  const execFileImpl = (file, args, options, callback) => {
    if (String(file).toLowerCase().includes('where')) callback(null, 'C:\\Other\\codex.exe\r\n', '');
    else callback(null, '', '');
  };
  const resolved = await codexQueue.resolveCodexExecutable({
    extensionRoots: [root],
    platform: 'win32',
    execFileImpl,
    maxDepth: 5
  });
  assert.equal(resolved.source, 'openai-extension');
  assert.equal(path.normalize(resolved.executable), path.normalize(bundled));
});

test('never selects the Linux Codex binary on Windows', async t => {
  const root = await tempRoot();
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const binDir = path.join(root, 'bin', 'linux-x86_64');
  await fs.promises.mkdir(binDir, { recursive: true });
  await fs.promises.writeFile(path.join(binDir, 'codex'), 'fake');
  const pathRoot = await tempRoot();
  t.after(() => fs.promises.rm(pathRoot, { recursive: true, force: true }));
  const pathBinary = path.join(pathRoot, 'codex.exe');
  await fs.promises.writeFile(pathBinary, 'fake');
  const execFileImpl = (file, args, options, callback) => {
    if (String(file).toLowerCase().includes('where')) callback(null, `${pathBinary}\r\n`, '');
    else callback(null, '', '');
  };
  const resolved = await codexQueue.resolveCodexExecutable({
    extensionRoots: [root],
    platform: 'win32',
    execFileImpl,
    maxDepth: 5
  });
  assert.equal(resolved.source, 'PATH');
  assert.match(resolved.executable, /codex\.exe$/i);
});

test('active thread rows are sorted by newest rollout activity first', async t => {
  const root = await tempRoot();
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const rootId = 'abababab-abab-abab-abab-abababababab';
  const olderId = 'cdcdcdcd-cdcd-cdcd-cdcd-cdcdcdcdcdcd';
  const newerId = 'efefefef-efef-efef-efef-efefefefefef';
  const now = Date.now();
  const rootFile = await writeRollout(root, `rollout-2026-09-30T10-00-00-${rootId}.jsonl`, [
    richMeta({ id: rootId }), userMessage('Root'), started('root'), completed('root')
  ], now - 5000);
  await writeRollout(root, `rollout-2026-09-30T10-00-01-${olderId}.jsonl`, [
    richMeta({ id: olderId, sessionId: rootId, parentThreadId: rootId, source: { subagent: { thread_spawn: { parent_thread_id: rootId, depth: 1, agent_path: ['older'], agent_nickname: 'Older', agent_role: 'worker' } } } }),
    started('older', '2026-09-30T07:00:04Z', 1790751604)
  ], now - 2000);
  await writeRollout(root, `rollout-2026-09-30T10-00-02-${newerId}.jsonl`, [
    richMeta({ id: newerId, sessionId: rootId, parentThreadId: rootId, source: { subagent: { thread_spawn: { parent_thread_id: rootId, depth: 1, agent_path: ['newer'], agent_nickname: 'Newer', agent_role: 'worker' } } } }),
    started('newer', '2026-09-30T07:00:05Z', 1790751605)
  ], now - 200);

  const summary = await tracker.readSessionSummary(rootFile);
  const tree = await tracker.scanSessionTree(root, summary, { scanLimit: 100 });
  const snapshot = await tracker.buildSessionSnapshot(root, summary, { tree, activityMaxBytes: 1024 * 1024 });
  assert.deepEqual(snapshot.activeNodes.map(node => node.threadId), [newerId, olderId]);
  assert.deepEqual(snapshot.activeNodes.map(node => node.displayName), ['Newer', 'Older']);
});

test('dashboard UI renders timeline details, timestamps, and safe queue composer', async () => {
  const html = await fs.promises.readFile(path.join(__dirname, '..', 'dashboard.html'), 'utf8');
  assert.match(html, /renderTimeline/);
  assert.match(html, /groupTimeline/);
  assert.match(html, /absTime/);
  assert.match(html, /queueMessage/);
  assert.match(html, /steerMessage/);
  assert.match(html, /data-state-key/);
  assert.match(html, /sidebarResizer/);
  assert.match(html, /history-summary/);
  assert.doesNotMatch(html, /index===0&&item\.kind==='message'\?' open'/);
  assert.doesNotMatch(html, /index===0\?' open'/);
  assert.match(html, /captureUiState/);
  assert.match(html, /composerInput/);
  assert.match(html, /latestUserTextAt/);
  assert.match(html, /latestAssistantTextAt/);
  assert.match(html, /message-time/);
});

test('steer request uses the official active-turn precondition and text input shape', () => {
  const request = codexSteer.buildSteerRequest({
    threadId: 'root-thread',
    expectedTurnId: 'turn-42',
    message: 'Đổi hướng ngay',
    clientUserMessageId: '11111111-1111-4111-8111-111111111111'
  });
  assert.equal(request.method, 'turn/steer');
  assert.deepEqual(request.params, {
    threadId: 'root-thread',
    expectedTurnId: 'turn-42',
    input: [{ type: 'text', text: 'Đổi hướng ngay', text_elements: [] }],
    clientUserMessageId: '11111111-1111-4111-8111-111111111111'
  });
  assert.throws(() => codexSteer.buildSteerRequest({ threadId: 'root-thread', message: 'missing turn' }), /active turn id/);
});

test('steer capability probe is read-only and requires the running daemon control socket', async () => {
  const calls = [];
  const execFileImpl = (file, args, options, callback) => {
    calls.push({ file, args: [...args], options });
    if (args[0] === 'app-server' && args[1] === 'proxy') callback(null, 'Proxy stdio bytes to the running app-server control socket\n', '');
    else callback(null, '{"version":"0.155.0"}\n', '');
  };
  const result = await codexSteer.probeSteerSupport('C:\\codex.exe', { execFileImpl, codexHome: 'C:\\codex-home' });
  assert.equal(result.available, true);
  assert.equal(result.source, 'app-server-control-socket');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.args[0] === 'app-server' && !call.args.includes('start')));
  assert.equal(calls[0].options.env.CODEX_HOME, 'C:\\codex-home');
});

test('steer capability probe reports unavailable instead of starting a competing owner', async () => {
  const execFileImpl = (file, args, options, callback) => {
    if (args[1] === 'proxy') callback(null, 'Proxy stdio bytes to the running app-server control socket\n', '');
    else {
      const error = new Error('no control socket');
      error.stderr = 'failed to connect to app-server-control.sock';
      callback(error, '', error.stderr);
    }
  };
  const result = await codexSteer.probeSteerSupport('C:\\codex.exe', { execFileImpl });
  assert.equal(result.available, false);
  assert.match(result.reason, /Steer/);
});

test('Extension IPC probe discovers the live owner without starting another app-server', async () => {
  const requests = [];
  const connectImpl = (endpoint, callback) => {
    assert.equal(endpoint, 'test-extension-ipc');
    const socket = new EventEmitter();
    socket.writable = true;
    socket.destroyed = false;
    socket.write = frame => {
      codexSteer.parseIpcFrames(frame, request => {
        requests.push(request);
        const result = request.method === 'initialize'
          ? { clientId: 'tracker-client' }
          : { supportsUntrustedAppInput: true };
        const response = {
          type: 'response',
          requestId: request.requestId,
          resultType: 'success',
          method: request.method,
          ...(request.method === 'thread-owner-discovery' ? { handledByClientId: 'owner-client' } : {}),
          result
        };
        process.nextTick(() => socket.emit('data', codexSteer.frameIpcMessage(response)));
      });
      return true;
    };
    socket.end = () => {};
    socket.destroy = () => { socket.destroyed = true; };
    process.nextTick(callback);
    return socket;
  };
  const result = await codexSteer.probeExtensionIpcSupport({
    endpoint: 'test-extension-ipc',
    threadId: 'root-thread',
    connectImpl
  });
  assert.equal(result.available, true);
  assert.equal(result.source, 'codex-extension-ipc');
  assert.equal(result.ownerClientId, 'owner-client');
  assert.deepEqual(requests.map(request => request.method), ['initialize', 'thread-owner-discovery']);
  assert.equal(requests[1].params.hostId, 'local');
  assert.equal(requests[1].params.conversationId, 'root-thread');
});

test('Extension IPC steer targets the discovered owner and uses the follower restore shape', async () => {
  const requests = [];
  const connectImpl = (endpoint, callback) => {
    const socket = new EventEmitter();
    socket.writable = true;
    socket.destroyed = false;
    socket.write = frame => {
      codexSteer.parseIpcFrames(frame, request => {
        requests.push(request);
        let response;
        if (request.method === 'initialize') {
          response = { type: 'response', requestId: request.requestId, resultType: 'success', method: request.method, result: { clientId: 'tracker-client' } };
        } else if (request.method === 'thread-owner-discovery') {
          response = { type: 'response', requestId: request.requestId, resultType: 'success', method: request.method, handledByClientId: 'owner-client', result: { supportsUntrustedAppInput: true } };
        } else {
          response = { type: 'response', requestId: request.requestId, resultType: 'success', method: request.method, result: { method: request.method, result: { turnId: 'turn-99' } } };
        }
        process.nextTick(() => socket.emit('data', codexSteer.frameIpcMessage(response)));
      });
      return true;
    };
    socket.end = () => {};
    socket.destroy = () => { socket.destroyed = true; };
    process.nextTick(callback);
    return socket;
  };
  const result = await codexSteer.steerViaExtensionIpc({
    endpoint: 'test-extension-ipc',
    threadId: 'root-thread',
    message: 'Dừng bước hiện tại và kiểm tra lại',
    cwd: 'C:\\workspace',
    clientUserMessageId: '11111111-1111-4111-8111-111111111111',
    connectImpl
  });
  assert.equal(result.turnId, 'turn-99');
  assert.equal(result.transport, 'codex-extension-ipc');
  const steer = requests.find(request => request.method === 'thread-follower-steer-turn');
  assert.ok(steer);
  assert.equal(steer.version, 1);
  assert.equal(steer.targetClientId, 'owner-client');
  assert.equal(steer.sourceClientId, 'tracker-client');
  assert.deepEqual(steer.params.input, [{ type: 'text', text: 'Dừng bước hiện tại và kiểm tra lại', text_elements: [] }]);
  assert.equal(steer.params.conversationId, 'root-thread');
  assert.equal(steer.params.restoreMessage.id, steer.params.clientUserMessageId);
  assert.deepEqual(steer.params.restoreMessage.context.workspaceRoots, ['C:\\workspace']);
});
