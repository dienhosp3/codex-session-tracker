'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { Writable } = require('node:stream');
const { attentionReminderText, attentionVoiceClips, composeAttentionVoice, speakAttentionReminder, numberClips,
  attentionInitialText, attentionInitialVoiceClips, composeAttentionInitialVoice, speakAttentionInitial } = require('../../src/codex_attention_voice');
const { createAttentionMonitor } = require('../../src/codex_attention');
const event = (minutes, flag = 'waitingOnApproval') => ({ waits: [{ flag, elapsedMinutes: minutes }] });

test('initial alerts use the approved Vietnamese phrases including completed Plan and complete PCM clips', async () => {
  const phrases = JSON.parse(fs.readFileSync(path.join(__dirname, '../../media/attention_voice/phrases.json'), 'utf8'));
  for (const [flag, clip, text] of [
    ['waitingOnApproval', 'approval_initial', 'Codex đang chờ duyệt thao tác'],
    ['waitingOnUserInput', 'input_initial', 'Codex đang chờ câu trả lời của bạn'],
    ['waitingOnPlanImplementation', 'plan_ready', 'Đã lập xong kế hoạch. Có triển khai luôn không?']
  ]) {
    const initial = { flags: [flag], isReminder: false };
    assert.equal(attentionInitialText(initial), text); assert.equal(phrases[clip], text);
    assert.deepEqual(attentionInitialVoiceClips(initial), [clip]);
    const wav = await composeAttentionInitialVoice(initial);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.readUInt32LE(24), 22050);
    assert.equal(wav.readUInt16LE(22), 1); assert.equal(wav.readUInt16LE(34), 16);
    assert.ok(wav.length > 20000); assert.equal(wav.readUInt32LE(40), wav.length - 44);
  }
  const both = { flags: ['waitingOnUserInput', 'waitingOnApproval', 'waitingOnApproval'] };
  assert.deepEqual(attentionInitialVoiceClips(both), ['approval_initial', 'input_initial']);
  const combined = await composeAttentionInitialVoice(both);
  const approval = await composeAttentionInitialVoice({ flags: ['waitingOnApproval'] });
  const input = await composeAttentionInitialVoice({ flags: ['waitingOnUserInput'] });
  assert.deepEqual(combined.subarray(44), Buffer.concat([approval.subarray(44), input.subarray(44)]));
});

test('a newly added waiting kind announces only that kind and never repeats the existing one', async () => {
  let flags = ['waitingOnApproval']; const clips = [];
  const monitor = createAttentionMonitor({ read: async () => [{ id: 'chat', status: { type: 'active', activeFlags: flags } }],
    notify: async e => clips.push(attentionInitialVoiceClips(e)) });
  try {
    await monitor.poll(); await monitor.poll();
    flags = ['waitingOnApproval', 'waitingOnUserInput']; await monitor.poll(); await monitor.poll();
    flags = ['waitingOnUserInput']; await monitor.poll();
    assert.deepEqual(clips, [['approval_initial'], ['input_initial']]);
  } finally { monitor.dispose(); }
});

test('Plan completion replaces generic input speech with exactly the requested question', async () => {
  const event = { newFlags: ['waitingOnUserInput', 'waitingOnPlanImplementation'] };
  assert.deepEqual(attentionInitialVoiceClips(event), ['plan_ready']);
  assert.equal(attentionInitialText(event), 'Đã lập xong kế hoạch. Có triển khai luôn không?');
  const wav = await composeAttentionInitialVoice(event);
  const phrase = await composeAttentionInitialVoice({ flags: ['waitingOnPlanImplementation'] });
  assert.deepEqual(wav, phrase);
});

test('approved initial speech uses offline memory playback and exposes missing assets without a beep fallback', async () => {
  const result = await speakAttentionInitial({ flags: ['waitingOnApproval'] }, { platform: 'win32', execFile(file, args, options, done) {
    assert.equal(options.windowsHide, true);
    assert.doesNotMatch(args.join(' '), /Beep|SpeechSynthesizer|https?:|Invoke-WebRequest|WriteAllBytes|TempPath/i);
    const chunks = [];
    return { stdin: new Writable({ write(chunk, encoding, callback) { chunks.push(chunk); callback(); }, final(callback) {
      const wav = Buffer.concat(chunks); assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
      done(null, JSON.stringify({ audioBytes: wav.length, source: 'bundled-wav' })); callback();
    } }) };
  } });
  assert.equal(result.source, 'bundled-wav');
  await assert.rejects(composeAttentionInitialVoice({ flags: ['waitingOnUserInput'] }, path.join(__dirname, 'missing-assets')), /ENOENT/);
});

test('5, 10, 15 minutes use complete bundled Vietnamese sentences for each waiting kind', async () => {
  for (const minutes of [5, 10, 15, 60, 120]) {
    for (const [flag, kind, ending] of [['waitingOnApproval', 'approval', 'chưa xác nhận.'], ['waitingOnUserInput', 'input', 'chưa có câu trả lời.']]) {
      assert.deepEqual(attentionVoiceClips(event(minutes, flag)), [`${kind}_${minutes}`]);
      assert.equal(attentionReminderText(event(minutes, flag)), `Đã ${minutes} phút ${ending}`);
      const wav = await composeAttentionVoice(event(minutes, flag));
      assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.ok(wav.length > 20000);
      assert.equal(wav.readUInt32LE(40), wav.length - 44);
    }
  }
});

test('long and delayed waits keep increasing using only bundled number recordings', async () => {
  assert.deepEqual(numberClips(125), ['hundreds_1', 'tens_2', 'five_after_tens']);
  assert.deepEqual(numberClips(1005), ['number_1', 'thousand', 'hundreds_0', 'link', 'number_5']);
  const phrases = JSON.parse(fs.readFileSync(path.join(__dirname, '../../media/attention_voice/phrases.json'), 'utf8'));
  for (const minutes of [6, 125, 185, 1440, 10005, 1500000, 1234567890]) {
    for (const name of attentionVoiceClips(event(minutes))) assert.ok(phrases[name], name);
    assert.match(attentionReminderText(event(minutes)), new RegExp(`Đã ${minutes} phút`));
    assert.ok((await composeAttentionVoice(event(minutes))).length > 20000);
  }
});

test('playback pipes prerecorded WAV to a hidden player without TTS, network or scratch files', async () => {
  let played;
  const result = await speakAttentionReminder(event(5), { platform: 'win32', execFile(file, args, options, done) {
    assert.equal(file, 'powershell.exe'); assert.equal(options.windowsHide, true);
    assert.doesNotMatch(args.join(' '), /SpeechSynthesizer|SpeechSynthesis|https?:|Invoke-WebRequest|WriteAllBytes|TempPath/i);
    const chunks = [];
    const stdin = new Writable({ write(chunk, encoding, callback) { chunks.push(chunk); callback(); }, final(callback) {
      played = Buffer.concat(chunks); done(null, JSON.stringify({ audioBytes: played.length, source: 'bundled-wav' })); callback();
    } });
    return { stdin };
  } });
  assert.equal(result.source, 'bundled-wav'); assert.equal(played.toString('ascii', 8, 12), 'WAVE');
  await assert.rejects(composeAttentionVoice(event(5), path.join(__dirname, 'missing-voice-assets')), /ENOENT/);
});

test('reminder speech advances from 5 to 10 to 15 minutes, then resets for the next wait', async () => {
  let at = 0, rows = [{ id: 'chat', status: { type: 'active', activeFlags: ['waitingOnApproval'] } }];
  const texts = [], initial = [];
  const monitor = createAttentionMonitor({ now: () => at, read: async () => rows, notify: async e => {
    if (e.isReminder) texts.push(attentionReminderText(e)); else initial.push(e);
    at += 3000; // Sound playback must not reset the original wait start.
  } });
  try {
    await monitor.poll(); assert.equal(initial.length, 1);
    for (const minute of [5, 10, 15]) { at = minute * 60000; await monitor.poll(); }
    assert.deepEqual(texts, [5, 10, 15].map(n => `Đã ${n} phút chưa xác nhận.`));
    rows = []; await monitor.poll();
    at = 20 * 60000; rows = [{ id: 'chat', status: { type: 'active', activeFlags: ['waitingOnUserInput'] } }];
    await monitor.poll(); at = 25 * 60000; await monitor.poll();
    assert.equal(texts.at(-1), 'Đã 5 phút chưa có câu trả lời.');
  } finally { monitor.dispose(); }
});

test('each waiting kind keeps its own start time; audio failure does not reset elapsed duration', async () => {
  let at = 0, failure = false;
  const rows = [{ id: 'chat', status: { type: 'active', activeFlags: ['waitingOnApproval'] } }], events = [];
  const monitor = createAttentionMonitor({ now: () => at, read: async () => rows, notify: async e => {
    if (failure) throw new Error('audio unavailable');
    events.push(e);
  } });
  try {
    await monitor.poll();
    at = 5 * 60000; rows[0].status.activeFlags.push('waitingOnUserInput'); await monitor.poll();
    at = 10 * 60000; failure = true; await monitor.poll();
    at = 15 * 60000; failure = false; await monitor.poll();
    assert.equal(attentionReminderText(events.at(-1)), 'Đã 15 phút chưa xác nhận. Đã 10 phút chưa có câu trả lời.');
  } finally { monitor.dispose(); }
});
