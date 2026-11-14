'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { speakAttentionReminder, attentionVoiceClips } = require('../../src/codex_attention_voice');

test('Windows plays the packaged 5/10/15-minute Vietnamese sentences and a longer wait from memory', { timeout: 60000 }, async () => {
  for (const [minutes, flag] of [[5, 'waitingOnApproval'], [10, 'waitingOnUserInput'], [15, 'waitingOnApproval'], [125, 'waitingOnUserInput']]) {
    const event = { waits: [{ flag, elapsedMinutes: minutes }] };
    const result = await speakAttentionReminder(event);
    assert.equal(result.source, 'bundled-wav');
    assert.ok(result.audioBytes > 20000);
    console.log(JSON.stringify({ minutes, flag, clips: attentionVoiceClips(event), ...result }));
  }
});
