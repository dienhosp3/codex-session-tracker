'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const tracker = require('../tracker');

test('proxy observation includes tasks beyond both the visible history and normal scan limit', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-proxy-monitor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessionsDir = path.join(root, 'sessions');
  fs.mkdirSync(sessionsDir);
  const base = Date.now() - 600000;
  for (let index = 0; index < 63; index += 1) {
    const id = 'fixture-' + index;
    const timestamp = new Date(base + index * 1000).toISOString();
    const lines = [
      { type: 'session_meta', timestamp, payload: { id, source: 'vscode', cwd: 'C:\\fixture' } },
      { type: 'event_msg', timestamp, payload: { type: 'user_message', message: 'Fixture task ' + index } },
      { type: 'event_msg', timestamp, payload: { type: 'task_started', turn_id: 'turn-' + index } }
    ];
    const file = path.join(sessionsDir, 'rollout-' + index + '.jsonl');
    fs.writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
    fs.utimesSync(file, new Date(base + index * 1000), new Date(base + index * 1000));
  }
  const ordinary = await tracker.scanConversationSessions({ codexHome: root, sessionsDir, historyLimit: 10, scanLimit: 50 });
  assert.equal(ordinary.active.length, 10);
  const observed = await tracker.scanConversationSessions({ codexHome: root, sessionsDir, historyLimit: 10, scanLimit: 50, monitorAll: true });
  assert.equal(observed.active.length, 10);
  assert.equal(observed.monitor.complete, true);
  assert.equal(observed.monitor.tasks.length, 63);
  assert.equal(observed.monitor.tasks.some(task => task.threadId === 'fixture-0'), true);
  assert.equal(observed.monitor.roots.length, 63);
  assert.equal(observed.monitor.tasks.find(task => task.threadId === 'fixture-0').turnId, 'turn-0');
});
