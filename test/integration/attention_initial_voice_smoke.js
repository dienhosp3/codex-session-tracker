'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { speakAttentionInitial, attentionInitialText, attentionInitialVoiceClips } = require('../../src/codex_attention_voice');

test('Windows plays both approved initial Vietnamese alerts from bundled PCM in memory', { timeout: 30000 }, async () => {
  for (const flag of ['waitingOnApproval', 'waitingOnUserInput']) {
    const event = { flags: [flag], newFlags: [flag], isReminder: false };
    const result = await speakAttentionInitial(event);
    assert.equal(result.source, 'bundled-wav'); assert.ok(result.audioBytes > 20000);
    console.log(JSON.stringify({ flag, text: attentionInitialText(event), clips: attentionInitialVoiceClips(event), ...result }));
  }
});
