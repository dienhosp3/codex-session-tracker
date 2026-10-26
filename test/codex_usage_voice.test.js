'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateUsageVoice,
  integerPercent,
  normalizeUsageVoiceSettings,
  speakUsageVoice,
  usageVoiceAssetSequence,
  vietnameseNumber
} = require('../codex_usage_voice');

function snapshot(remainingPercent, checkedAt = 1000) {
  return {
    groups: [{
      id: 'codex',
      accountKey: 'account:test',
      windows: [{ key: 'primary', usedPercent: 100 - remainingPercent, resetsAt: 2000000000000, durationMinutes: 300 }]
    }],
    checkedAt
  };
}

test('usage voice clamps spoken percentages to integer values from 0 through 100', () => {
  assert.equal(integerPercent(-5), 0);
  assert.equal(integerPercent(42.6), 43);
  assert.equal(integerPercent(105), 100);
  assert.equal(vietnameseNumber(0), 'không');
  assert.equal(vietnameseNumber(42), 'bốn mươi hai');
  assert.equal(vietnameseNumber(100), 'một trăm');
});

test('usage voice establishes a silent baseline and speaks a changed percentage in Vietnamese', () => {
  const settings = normalizeUsageVoiceSettings({ enabled: true, largeChangePercent: 10 });
  const first = evaluateUsageVoice(snapshot(88, 1000), undefined, settings, 1000);
  assert.deepEqual(first.events, []);
  const second = evaluateUsageVoice(snapshot(84.4, 2000), first.state, settings, 2000);
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].remainingPercent, 84);
  assert.equal(second.events[0].usedPercent, 16);
  assert.equal(second.events[0].deltaPercent, -4);
  assert.equal(second.events[0].largeChange, false);
  assert.match(second.events[0].text, /quota năm giờ còn tám mươi tư phần trăm/);
});

test('large changes can speak even when ordinary change reading is disabled', () => {
  const settings = normalizeUsageVoiceSettings({
    enabled: true,
    speakOnChange: false,
    speakOnLargeChange: true,
    largeChangePercent: 10
  });
  const first = evaluateUsageVoice(snapshot(90), undefined, settings, 1000);
  const small = evaluateUsageVoice(snapshot(84), first.state, settings, 2000);
  assert.deepEqual(small.events, []);
  const large = evaluateUsageVoice(snapshot(70), small.state, settings, 3000);
  assert.equal(large.events.length, 1);
  assert.equal(large.events[0].changePercent, 14);
  assert.equal(large.events[0].largeChange, true);
  assert.match(large.events[0].text, /^Quota thay đổi mạnh,/);
});

test('disabled usage voice still advances its comparison baseline without speaking', () => {
  const disabled = normalizeUsageVoiceSettings({ enabled: false });
  const first = evaluateUsageVoice(snapshot(80), undefined, disabled, 1000);
  const second = evaluateUsageVoice(snapshot(60), first.state, disabled, 2000);
  assert.deepEqual(second.events, []);
  assert.equal(second.state.samples['account:test|codex|primary|2000000000000'].remainingPercent, 60);
});

test('usage voice selects complete integer Vietnamese clips without Windows speech synthesis', async () => {
  assert.deepEqual(usageVoiceAssetSequence(42), ['percent_42']);
  assert.deepEqual(usageVoiceAssetSequence(100), ['percent_100']);
  assert.deepEqual(usageVoiceAssetSequence(7), ['percent_7']);
  assert.deepEqual(usageVoiceAssetSequence(42, true), ['large_prefix', 'percent_42']);
  const calls = [];
  await speakUsageVoice({
    platform: 'win32',
    event: { remainingPercent: 42, largeChange: false },
    execFile(file, args, options, callback) {
      calls.push({ file, args, options });
      callback(null);
    }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'powershell.exe');
  assert.match(calls[0].args[3], /waveaudio/);
  assert.doesNotMatch(calls[0].args[3], /SpeechSynthesizer|System\.Speech/);
  assert.ok(calls[0].options.env.CODEX_TRACKER_USAGE_WAV);
  assert.equal(calls[0].options.env.CODEX_TRACKER_USAGE_VOICE_TEXT, undefined);
});
