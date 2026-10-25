'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeContextCompactSettings, contextPercent, shouldAutoCompact } = require('../codex_context_compact');

test('context compact settings normalize an integer threshold and default to disabled', () => {
  assert.deepEqual(normalizeContextCompactSettings({ enabled: true, thresholdPercent: 82, resumeAfterCompact: false }), {
    schemaVersion: 1, enabled: true, thresholdPercent: 82, resumeAfterCompact: false
  });
  assert.equal(normalizeContextCompactSettings({ thresholdPercent: 120 }).thresholdPercent, 80);
});

test('context percent is clamped and auto compact fires once per turn key', () => {
  const runtime = { contextPercent: 82.4 };
  assert.equal(contextPercent(runtime), 82.4);
  const settings = normalizeContextCompactSettings({ enabled: true, thresholdPercent: 80 });
  assert.equal(shouldAutoCompact(runtime, settings, { key: 'chat:turn:475000', currentKey: '' }).should, true);
  assert.equal(shouldAutoCompact(runtime, settings, { key: 'chat:turn:475000', currentKey: 'chat:turn:475000' }).should, false);
  assert.equal(shouldAutoCompact({ contextPercent: 79.9 }, settings, { key: 'chat:turn2', currentKey: '' }).should, false);
});
