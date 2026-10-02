'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tracker = require('../tracker');

test('recent activity keeps a complete image event larger than the ordinary tail', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-tracker-tail-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'rollout-image-tail.jsonl');
  const imageBytes = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    Buffer.alloc(8 * 1024 * 1024)
  ]);
  const imageUrl = 'data:image/png;base64,' + imageBytes.toString('base64');
  const lines = [
    { timestamp: '2026-09-30T07:00:00Z', type: 'session_meta', payload: { id: 'tail-thread', cwd: 'C:\\repo' } },
    {
      timestamp: '2026-09-30T07:00:01Z',
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: 'Ảnh lớn ở đầu dòng',
        images: [{ type: 'image', url: imageUrl }]
      }
    },
    { timestamp: '2026-09-30T07:00:02Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } }
  ];
  await fs.promises.writeFile(file, lines.map(JSON.stringify).join('\n') + '\n', 'utf8');
  assert.ok((await fs.promises.stat(file)).size > 10 * 1024 * 1024);

  const activity = await tracker.readRecentActivity(file, { threadId: 'tail-thread', cwd: 'C:\\repo' }, 'tail-thread', {
    maxBytes: 128 * 1024,
    timelineLimit: 20
  });
  assert.equal(activity.latestUserText, 'Ảnh lớn ở đầu dòng');
  assert.ok(activity.timeline.some(item => item.kind === 'user' && item.text === 'Ảnh lớn ở đầu dòng'));
  assert.equal(activity.truncated, true);
});
