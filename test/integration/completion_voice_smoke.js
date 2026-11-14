'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { speakCompletion } = require('../../src/codex_attention_voice');
test('Windows plays both completion voices from bundled PCM', { timeout: 30000 }, async () => {
  for (const type of ['chat_completed', 'chat_failed']) {
    const result = await speakCompletion(type);
    assert.equal(result.source, 'bundled-wav'); assert.ok(result.audioBytes > 20000);
    console.log(JSON.stringify({ type, ...result }));
  }
});
