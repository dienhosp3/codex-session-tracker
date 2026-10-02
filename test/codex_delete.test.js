'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { deleteThread } = require('../codex_delete');

function fakeServer(replyToDelete) {
  const requests = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => { child.killed = true; };
  child.stdin = {
    destroyed: false,
    end() { this.destroyed = true; },
    write(line) {
      const request = JSON.parse(line);
      requests.push(request);
      if (request.method === 'initialize') process.nextTick(() => child.stdout.emit('data', Buffer.from(JSON.stringify({ id: 1, result: {} }) + '\n')));
      if (request.method === 'thread/delete') process.nextTick(() => child.stdout.emit('data', Buffer.from(JSON.stringify({ id: 2, ...replyToDelete }) + '\n')));
    }
  };
  return { child, requests };
}

test('uses Codex thread/delete for the exact selected thread', async () => {
  const server = fakeServer({ result: {} });
  let invocation;
  await deleteThread({
    executable: 'codex',
    codexHome: 'example-home',
    threadId: 'thread-123',
    spawnImpl(executable, args, options) {
      invocation = { executable, args, options };
      return server.child;
    }
  });
  assert.equal(invocation.executable, 'codex');
  assert.deepEqual(invocation.args, ['app-server', '--stdio']);
  assert.equal(invocation.options.env.CODEX_HOME, 'example-home');
  assert.deepEqual(server.requests.map(request => request.method), ['initialize', 'initialized', 'thread/delete']);
  assert.deepEqual(server.requests[2].params, { threadId: 'thread-123' });
});

test('propagates a rejected native deletion', async () => {
  const server = fakeServer({ error: { code: -32602, message: 'Thread is still running' } });
  await assert.rejects(deleteThread({ executable: 'codex', threadId: 'thread-123', spawnImpl: () => server.child }), /still running/);
});
