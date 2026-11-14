'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { createInputState, consumeInputRecord, createAsyncInputReader } = require('../../src/codex_async_input');
const { createAttentionMonitor } = require('../../src/codex_attention');
const call = (id = 'call-a', count = 1) => ({ type: 'response_item', payload: { type: 'function_call', name: 'request_user_input_async',
  call_id: id, arguments: JSON.stringify({ questions: Array.from({ length: count }, () => ({ title: 'Đóng MathType rồi tiếp tục?', options: ['Đã đóng', 'Cài sau'] })) }) } });
const output = (id = 'call-a', accepted = true) => ({ type: 'response_item', payload: { type: 'function_call_output', call_id: id, output: JSON.stringify({ accepted }) } });
const reply = (id = 'call-a', index = 0, answer = '') => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text',
  text: '<send_user_message_question_reply>\n' + JSON.stringify([{ questionItemId: JSON.stringify(['request_user_input_async', id, index]), question: 'Question', answer }]) + '\n</send_user_message_question_reply>' }] } });
const event = type => ({ type: 'event_msg', payload: { type } });

test('async accepted is not an answer; partial replies and Skip resolve exact question IDs', () => {
  const state = createInputState();
  for (const record of [event('task_started'), call('call-a', 2), output(), event('task_complete')]) consumeInputRecord(state, record);
  assert.equal(state.questions.size, 2);
  consumeInputRecord(state, reply('other')); assert.equal(state.questions.size, 2);
  consumeInputRecord(state, reply('call-a', 0, 'Đã đóng')); assert.equal(state.questions.size, 1);
  consumeInputRecord(state, reply('call-a', 1)); assert.equal(state.questions.size, 0);
  consumeInputRecord(state, call()); consumeInputRecord(state, output('call-a', false)); assert.equal(state.questions.size, 0);
  consumeInputRecord(state, call()); consumeInputRecord(state, event('task_started')); assert.equal(state.questions.size, 0);
  consumeInputRecord(state, call()); consumeInputRecord(state, event('turn_aborted')); assert.equal(state.questions.size, 0);
  consumeInputRecord(state, { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: JSON.stringify(call()) }] } });
  assert.equal(state.questions.size, 0, 'quoted tools are not prompts');
});

test('async waits notify with empty active flags and idle status, remind, and re-arm for additional questions', async () => {
  let now = 0, ids = ['a'], status = { type: 'active', activeFlags: [] };
  const notices = [];
  const monitor = createAttentionMonitor({ now: () => now, read: async () => [{ id: 'chat', status, pendingInputIds: ids }], notify: async e => notices.push(e) });
  try {
    await monitor.poll(); await monitor.poll(); assert.equal(notices.length, 1);
    status = { type: 'idle' }; await monitor.poll(); assert.equal(notices.length, 1);
    now = 300000; await monitor.poll(); assert.equal(notices.at(-1).isReminder, true);
    ids = ['a', 'b']; await monitor.poll(); assert.equal(notices.length, 3); assert.equal(notices.at(-1).isReminder, false);
    ids = ['b']; await monitor.poll(); assert.equal(notices.length, 3);
    ids = []; await monitor.poll(); assert.deepEqual(monitor.snapshot(), {});
    now += 600000; await monitor.poll(); assert.equal(notices.length, 3);
  } finally { monitor.dispose(); }
});

test('native replies with editor context or early user_message events clear exact IDs', () => {
  const state = createInputState();
  consumeInputRecord(state, event('task_started')); consumeInputRecord(state, call('call-a', 2));
  const answered = reply('call-a', 0, 'Yes');
  answered.payload.content[0].text = 'Editor context\n## My request:\n' + answered.payload.content[0].text;
  consumeInputRecord(state, answered); assert.equal(state.questions.size, 1);
  const other = reply('call-a', 1).payload.content[0].text;
  consumeInputRecord(state, { type: 'event_msg', payload: { type: 'user_message', message: other } });
  assert.equal(state.questions.size, 0);
});

test('UI cancellation without a rollout reply persists across reloads and stops 5/10-minute reminders', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'async-dismiss-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'rollout.jsonl');
  await fs.writeFile(file, [event('task_started'), call('call-a', 2), output()].map(r => JSON.stringify(r) + '\n').join(''));
  let saved, time = 0, changes = 0;
  const reader = createAsyncInputReader({ save: async value => { saved = value; }, onChange: () => changes++ });
  const rows = [{ id: 'chat', path: file, status: { type: 'active', activeFlags: [] } }], notices = [];
  const monitor = createAttentionMonitor({ read: () => reader.read(rows), now: () => time, notify: async e => notices.push(e) });
  t.after(() => { monitor.dispose(); reader.dispose(); });
  const id = index => JSON.stringify(['request_user_input_async', 'call-a', index]);
  await monitor.poll(); assert.equal(notices.length, 1);
  await reader.resolve('other', [id(0)]); await monitor.poll(); assert.equal(monitor.snapshot().chat.inputIds.length, 2);
  await reader.resolve('chat', [id(0)]); await monitor.poll(); assert.deepEqual(monitor.snapshot().chat.inputIds, [id(1)]);
  await reader.resolve('chat', [id(1)]); await monitor.poll(); assert.deepEqual(monitor.snapshot(), {});
  for (time of [300000, 600000]) await monitor.poll();
  assert.equal(notices.length, 1); assert.equal(changes, 3);
  await reader.resolve('chat', [id(1), 'bad', '{}']); assert.equal(changes, 3);
  const restored = createAsyncInputReader({ resolved: saved }); t.after(() => restored.dispose());
  assert.deepEqual((await restored.read(rows))[0].pendingInputIds, []);
  await fs.appendFile(file, JSON.stringify(call('new-call')) + '\n');
  assert.equal((await restored.read(rows))[0].pendingInputIds.length, 1, 'new question remains pending');
  await monitor.poll(); assert.equal(notices.length, 2);
  assert.equal(notices[1].waits[0].elapsedMinutes, 0);
});

test('reader restores unanswered prompts, follows appended UTF-8 records, resets replaced rollouts and preserves unreadable pending state', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'async-input-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'rollout.jsonl'), errors = [], reader = createAsyncInputReader({ onError: e => errors.push(e) });
  t.after(() => reader.dispose());
  const rows = [{ id: 'chat', path: file, status: { type: 'idle' } }];
  const encode = records => records.map(r => JSON.stringify(r) + '\n').join('');
  await fs.writeFile(file, encode([event('task_started'), call(), output(), event('task_complete')]));
  assert.equal((await reader.read(rows))[0].pendingInputIds.length, 1);
  assert.equal((await reader.read(rows))[0].pendingInputIds.length, 1, 'poll does not duplicate a prompt');
  const answer = Buffer.from(encode([reply('call-a', 0, 'Đã đóng')]));
  const split = answer.indexOf(Buffer.from('Đ')) + 1;
  await fs.appendFile(file, answer.subarray(0, split));
  assert.equal((await reader.read(rows))[0].pendingInputIds.length, 1);
  await fs.appendFile(file, answer.subarray(split));
  assert.equal((await reader.read(rows))[0].pendingInputIds.length, 0);
  await fs.writeFile(file, encode([call('new')]));
  assert.equal((await reader.read(rows))[0].pendingInputIds.length, 1);
  await fs.rename(file, file + '.hidden');
  assert.equal((await reader.read(rows))[0].pendingInputIds.length, 1); assert.equal(errors.length, 1);
  await fs.writeFile(file, encode([event('task_started')]));
  assert.equal((await reader.read(rows))[0].pendingInputIds.length, 0);
  await fs.appendFile(file, encode([call()]));
  assert.equal((await reader.read([{ ...rows[0], parentThreadId: 'parent' }]))[0].pendingInputIds, undefined);
  assert.deepEqual(await reader.read([]), []);
});
