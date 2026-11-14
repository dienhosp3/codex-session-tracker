'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createKeepAwake } = require('../../src/codex_keep_awake');

test('Windows accepts the power request and releases the helper on off/dispose', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const children = [];
  const controller = createKeepAwake({ spawn(...args) { const child = spawn(...args); children.push(child); return child; } });
  t.after(() => controller.dispose());
  assert.equal((await controller.setEnabled(true)).enabled, true);
  await controller.setEnabled(true);
  assert.equal(children.length, 1);
  assert.equal((await controller.setEnabled(false)).enabled, false);
  assert.equal(children[0].exitCode, 0);
  assert.equal((await controller.setEnabled(true)).enabled, true);
  const closed = once(children[1], 'close');
  controller.dispose();
  assert.equal((await closed)[0], 0);
  assert.equal(controller.snapshot().enabled, false);
});

test('helper failure does not report an active power request', { skip: process.platform !== 'win32', timeout: 10000 }, async t => {
  const controller = createKeepAwake({ spawn() { return spawn(process.execPath, ['-e', 'process.exit(2)'], { windowsHide: true, stdio: ['pipe','pipe','pipe'] }); } });
  t.after(() => controller.dispose());
  const state = await controller.setEnabled(true);
  assert.equal(state.enabled, false);
  assert.equal(state.busy, false);
  assert.ok(state.error);
});
