'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { HttpHookServer, hookConfigPath } = require('../gateway/http_hook_server');
const patcher = require('../codex-hook/apply_patch');

function sendLine(port, message, expectReply = false) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let buffer = '';
    const finish = value => {
      try { socket.destroy(); } catch {}
      resolve(value);
    };
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.write(JSON.stringify(message) + '\n');
      if (!expectReply) {
        setTimeout(() => finish(''), 20);
      }
    });
    if (expectReply) {
      socket.setEncoding('utf8');
      socket.on('data', chunk => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline >= 0) finish(buffer.slice(0, newline));
      });
    }
  });
}

test('HTTP hook server records plaintext OUT events and redacts credential headers', async t => {
  let recordedResolve;
  const recorded = new Promise(resolve => { recordedResolve = resolve; });
  const hook = new HttpHookServer({
    port: 0,
    captureMaxBytes: 1024 * 1024,
    record: async event => recordedResolve(event)
  });
  await hook.start();
  t.after(() => hook.stop());

  const address = hook.address();
  await sendLine(address.port, {
    token: address.token,
    type: 'event',
    event: {
      phase: 'outbound_request',
      direction: 'out',
      requestId: 'req-1',
      method: 'POST',
      url: 'https://chatgpt.com/backend-api/codex/responses',
      headers: {
        authorization: 'Bearer should-not-survive',
        cookie: 'secret=1',
        'content-type': 'application/json'
      },
      body: {
        encoding: 'utf8',
        contentType: 'application/json',
        content: '{"input":"hello"}',
        totalBytes: 17
      }
    }
  });

  const event = await recorded;
  assert.equal(event.type, 'http_hook');
  assert.equal(event.direction, 'out');
  assert.equal(event.hookPlaintext, true);
  assert.equal(event.path, '/backend-api/codex/responses');
  assert.equal(event.headers.authorization, '[REDACTED]');
  assert.equal(event.headers.cookie, '[REDACTED]');
  assert.match(event.contentCapture.content, /hello/);
});

test('HTTP hook mutation preflight fails open by default', async t => {
  const hook = new HttpHookServer({ port: 0, mutationEnabled: false });
  await hook.start();
  t.after(() => hook.stop());

  const address = hook.address();
  const reply = await sendLine(address.port, {
    token: address.token,
    type: 'preflight',
    request: {
      requestId: 'req-pass',
      method: 'POST',
      url: 'https://chatgpt.com/backend-api/codex/responses',
      headers: { 'content-type': 'application/json' },
      body: { encoding: 'utf8', contentType: 'application/json', content: '{}', totalBytes: 2 }
    }
  }, true);

  assert.deepEqual(JSON.parse(reply), { action: 'pass' });
});

test('HTTP hook mutation preflight returns filter decisions when explicitly enabled', async t => {
  const hook = new HttpHookServer({
    port: 0,
    mutationEnabled: true,
    filterRequest: async request => ({
      action: 'replace',
      body: {
        encoding: 'utf8',
        contentType: 'application/json',
        content: JSON.stringify({ rewritten: request.requestId }),
        totalBytes: 0
      }
    })
  });
  await hook.start();
  t.after(() => hook.stop());

  const address = hook.address();
  const reply = JSON.parse(await sendLine(address.port, {
    token: address.token,
    type: 'preflight',
    request: {
      requestId: 'req-mut',
      method: 'POST',
      url: 'https://chatgpt.com/backend-api/codex/responses',
      headers: {},
      body: { encoding: 'utf8', contentType: 'application/json', content: '{"x":1}', totalBytes: 7 }
    }
  }, true));

  assert.equal(reply.action, 'replace');
  assert.match(reply.body.content, /req-mut/);
});

test('HTTP hook config is written under CODEX_HOME and removed reversibly', async t => {
  const codexHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-hook-home-'));
  t.after(() => fs.promises.rm(codexHome, { recursive: true, force: true }));

  const hook = new HttpHookServer({ port: 0, mutationEnabled: true });
  await hook.start();
  t.after(() => hook.stop());

  const target = await hook.writeConfig(codexHome);
  assert.equal(target, hookConfigPath(codexHome));
  const parsed = JSON.parse(await fs.promises.readFile(target, 'utf8'));
  assert.equal(parsed.host, '127.0.0.1');
  assert.equal(parsed.port, hook.address().port);
  assert.equal(parsed.token, hook.address().token);
  assert.equal(parsed.mutationEnabled, true);

  await hook.removeConfig(codexHome);
  assert.equal(fs.existsSync(target), false);
});

test('Codex source patcher is pinned to the installed 0.159.2 source revision', () => {
  assert.equal(patcher.EXPECTED_TAG, 'rust-v0.159.2');
  assert.equal(patcher.EXPECTED_COMMIT, 'ff6aec96948b70d94983af2641a6b67c94faeff5');
  assert.equal(
    patcher.replaceOnce('a\nTARGET\nz', 'TARGET', 'PATCHED', 'fixture'),
    'a\nPATCHED\nz'
  );
  assert.throws(() => patcher.replaceOnce('none', 'TARGET', 'PATCHED', 'fixture'), /anchor not found/i);
});
