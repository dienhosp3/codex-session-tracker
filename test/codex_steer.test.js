'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const codexSteer = require('../codex_steer');

const THREAD_ID = 'root-thread';
const OWNER_ID = 'owner-client';
const CLIENT_MESSAGE_ID = '11111111-1111-4111-8111-111111111111';
const VIETNAMESE = 'Dừng bước hiện tại, kiểm tra lại tệp tiếng Việt và giữ nguyên luồng đang chạy.';
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

function responseFor(request, extra = {}) {
  if (request.method === 'initialize') {
    return {
      type: 'response',
      requestId: request.requestId,
      resultType: 'success',
      method: request.method,
      result: { clientId: 'tracker-client' },
      ...extra
    };
  }
  if (request.method === 'thread-owner-discovery') {
    return {
      type: 'response',
      requestId: request.requestId,
      resultType: 'success',
      method: request.method,
      handledByClientId: OWNER_ID,
      result: { supportsUntrustedAppInput: true },
      ...extra
    };
  }
  return {
    type: 'response',
    requestId: request.requestId,
    resultType: 'success',
    method: request.method,
    result: { method: request.method, result: { turnId: 'turn-99' } },
    ...extra
  };
}

async function withIpcServer(onRequest, run) {
  const requests = [];
  const server = net.createServer(socket => {
    let buffered = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffered = codexSteer.parseIpcFrames(Buffer.concat([buffered, chunk]), request => {
        requests.push(request);
        onRequest(request, socket, requests);
      });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const connectImpl = (_endpoint, callback) => net.connect({ host: '127.0.0.1', port }, callback);
  try {
    return await run({ requests, connectImpl, server });
  } finally {
    await new Promise(resolve => server.close(() => resolve()));
  }
}

function writeFrame(socket, message, chunks = [0]) {
  const frame = codexSteer.frameIpcMessage(message);
  if (chunks.length <= 1) {
    socket.write(frame);
    return;
  }
  let offset = 0;
  for (const length of chunks) {
    if (offset >= frame.length) break;
    socket.write(frame.subarray(offset, offset + length));
    offset += length;
  }
  if (offset < frame.length) socket.write(frame.subarray(offset));
}

function standardSteerOptions(connectImpl, extra = {}) {
  return {
    endpoint: 'local-test-endpoint',
    threadId: THREAD_ID,
    message: VIETNAMESE,
    cwd: 'C:\\workspace',
    clientUserMessageId: CLIENT_MESSAGE_ID,
    connectImpl,
    ...extra
  };
}

test('Extension IPC sends an image-only steer as image input', async () => {
  await withIpcServer((request, socket) => writeFrame(socket, responseFor(request)), async ({ requests, connectImpl }) => {
    const result = await codexSteer.steerViaExtensionIpc(standardSteerOptions(connectImpl, {
      message: '',
      images: [{ name: 'screenshot.png', mimeType: 'image/png', dataUrl: PNG_DATA_URL }]
    }));
    assert.equal(result.turnId, 'turn-99');
    const steers = requests.filter(request => request.method === 'thread-follower-steer-turn');
    assert.equal(steers.length, 1);
    assert.deepEqual(steers[0].params.input, [{ type: 'image', url: PNG_DATA_URL }]);
    assert.equal(steers[0].params.restoreMessage.text, '');
  });
});

test('Extension IPC preserves text before attached images in a mixed steer', async () => {
  await withIpcServer((request, socket) => writeFrame(socket, responseFor(request)), async ({ requests, connectImpl }) => {
    await codexSteer.steerViaExtensionIpc(standardSteerOptions(connectImpl, {
      images: [{ name: 'screenshot.png', mimeType: 'image/png', dataUrl: PNG_DATA_URL }]
    }));
    const input = requests.find(request => request.method === 'thread-follower-steer-turn').params.input;
    assert.deepEqual(input, [
      { type: 'text', text: VIETNAMESE, text_elements: [] },
      { type: 'image', url: PNG_DATA_URL }
    ]);
  });
});

test('Extension IPC rejects invalid image attachments before connecting', async () => {
  let connections = 0;
  const connectImpl = () => { connections += 1; throw new Error('Unexpected IPC connection.'); };
  const image = { name: 'screenshot.png', mimeType: 'image/png', dataUrl: PNG_DATA_URL };
  const invalidCases = [
    [{ ...image, mimeType: 'image/jpeg' }],
    [{ ...image, dataUrl: PNG_DATA_URL.replace('image/png', 'image/svg+xml') }],
    [{ ...image, dataUrl: 'data:image/png;base64,AAAA' }],
    [{ ...image, dataUrl: 'data:image/png;base64,%%%' }],
    Array(6).fill(image),
    [{ ...image, dataUrl: 'data:image/png;base64,' + Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.alloc(8 * 1024 * 1024)
    ]).toString('base64') }]
  ];
  for (const images of invalidCases) {
    await assert.rejects(codexSteer.steerViaExtensionIpc(standardSteerOptions(connectImpl, {
      message: '',
      images
    })), /image|attach|8 MB|format|MIME/i);
  }
  assert.equal(connections, 0);
});

test('Extension IPC accepts a delayed acknowledgement beyond the old five second cutoff exactly once', async () => {
  const result = await withIpcServer((request, socket) => {
    if (request.method === 'thread-follower-steer-turn') {
      setTimeout(() => writeFrame(socket, responseFor(request)), 5_200);
    } else {
      writeFrame(socket, responseFor(request), [1, 2, 3, 5]);
    }
  }, async ({ requests, connectImpl }) => {
    const result = await codexSteer.steerViaExtensionIpc(standardSteerOptions(connectImpl));
    assert.equal(result.turnId, 'turn-99');
    assert.equal(result.transport, 'codex-extension-ipc');
    const steers = requests.filter(request => request.method === 'thread-follower-steer-turn');
    assert.equal(steers.length, 1);
    assert.equal(steers[0].params.clientUserMessageId, CLIENT_MESSAGE_ID);
    assert.deepEqual(steers[0].params.input, [{ type: 'text', text: VIETNAMESE, text_elements: [] }]);
  });
});

test('Extension IPC reports unknown delivery after a sent steer disconnects and never resends it', async () => {
  await withIpcServer((request, socket) => {
    if (request.method === 'thread-follower-steer-turn') {
      socket.destroy();
      return;
    }
    writeFrame(socket, responseFor(request));
  }, async ({ requests, connectImpl }) => {
    await assert.rejects(
      codexSteer.steerViaExtensionIpc({ ...standardSteerOptions(connectImpl), timeoutMs: 1_500 }),
      error => error && (error.delivery === 'unknown' || error.deliveryStatus === 'unknown')
    );
    assert.equal(requests.filter(request => request.method === 'thread-follower-steer-turn').length, 1);
  });
});

test('Extension IPC timeout after a sent steer stays unconfirmed and sends once', async () => {
  await withIpcServer((request, socket) => {
    if (request.method !== 'thread-follower-steer-turn') writeFrame(socket, responseFor(request));
  }, async ({ requests, connectImpl }) => {
    await assert.rejects(
      codexSteer.steerViaExtensionIpc({ ...standardSteerOptions(connectImpl), timeoutMs: 600 }),
      error => error && error.code === 'ETIMEDOUT' && error.delivery === 'unknown'
    );
    assert.equal(requests.filter(request => request.method === 'thread-follower-steer-turn').length, 1);
  });
});

test('Extension IPC reports a routed steer rejection without claiming success', async () => {
  await withIpcServer((request, socket) => {
    if (request.method === 'thread-follower-steer-turn') {
      writeFrame(socket, { ...responseFor(request), resultType: 'error', error: { code: 'turn-not-active', message: 'Turn is not active.' } });
      return;
    }
    writeFrame(socket, responseFor(request));
  }, async ({ requests, connectImpl }) => {
    await assert.rejects(
      codexSteer.steerViaExtensionIpc(standardSteerOptions(connectImpl)),
      error => error && error.delivery === 'rejected' && error.code === 'turn-not-active'
    );
    assert.equal(requests.filter(request => request.method === 'thread-follower-steer-turn').length, 1);
  });
});

test('Extension IPC reports no owner after routing as not sent', async () => {
  await withIpcServer((request, socket) => {
    if (request.method === 'thread-follower-steer-turn') {
      writeFrame(socket, { ...responseFor(request), resultType: 'error', error: 'no-client-found' });
      return;
    }
    writeFrame(socket, responseFor(request));
  }, async ({ requests, connectImpl }) => {
    await assert.rejects(
      codexSteer.steerViaExtensionIpc(standardSteerOptions(connectImpl)),
      error => error && error.delivery === 'not_sent' && /owner IPC/i.test(error.message)
    );
    assert.equal(requests.filter(request => request.method === 'thread-follower-steer-turn').length, 1);
  });
});

test('Extension IPC does not treat a method-mismatched acknowledgement as success', async () => {
  await withIpcServer((request, socket) => {
    if (request.method === 'thread-follower-steer-turn') {
      writeFrame(socket, responseFor(request, { method: 'different-method' }));
      return;
    }
    writeFrame(socket, responseFor(request));
  }, async ({ connectImpl }) => {
    await assert.rejects(
      codexSteer.steerViaExtensionIpc({ ...standardSteerOptions(connectImpl), timeoutMs: 1_200 }),
      /timed out|method|acknowledg|response|IPC/i
    );
  });
});

test('Extension IPC requires an acknowledged turn id and rejects a malformed nested acknowledgement', async () => {
  await withIpcServer((request, socket) => {
    if (request.method === 'thread-follower-steer-turn') {
      writeFrame(socket, {
        type: 'response',
        requestId: request.requestId,
        resultType: 'success',
        method: request.method,
        result: { method: request.method, result: { accepted: true } }
      });
      return;
    }
    writeFrame(socket, responseFor(request));
  }, async ({ connectImpl }) => {
    await assert.rejects(
      codexSteer.steerViaExtensionIpc({ ...standardSteerOptions(connectImpl), timeoutMs: 1_200 }),
      /turn|acknowledg|response|malformed|IPC/i
    );
  });
});

test('Extension IPC ignores broadcasts and unrelated responses while decoding fragmented frames', async () => {
  await withIpcServer((request, socket) => {
    writeFrame(socket, { type: 'event', method: 'thread/activity', params: { threadId: THREAD_ID } }, [1, 1, 2]);
    writeFrame(socket, { type: 'response', requestId: 'unrelated-request', resultType: 'success', method: request.method, result: { clientId: 'wrong' } }, [2, 1, 1, 3]);
    writeFrame(socket, responseFor(request), [1, 1, 1, 2, 3]);
  }, async ({ requests, connectImpl }) => {
    const result = await codexSteer.steerViaExtensionIpc({ ...standardSteerOptions(connectImpl), timeoutMs: 2_000 });
    assert.equal(result.turnId, 'turn-99');
    assert.deepEqual(requests.map(request => request.method), [
      'initialize',
      'thread-owner-discovery',
      'thread-follower-steer-turn'
    ]);
  });
});

test('Extension IPC discovery failure never sends a steer request', async () => {
  await withIpcServer((request, socket) => {
    if (request.method === 'thread-owner-discovery') {
      writeFrame(socket, {
        type: 'response',
        requestId: request.requestId,
        resultType: 'success',
        method: request.method,
        result: { canHandle: false, ownerClientId: null }
      });
      return;
    }
    writeFrame(socket, responseFor(request));
  }, async ({ requests, connectImpl }) => {
    await assert.rejects(
      codexSteer.steerViaExtensionIpc({ ...standardSteerOptions(connectImpl), timeoutMs: 1_200 }),
      /owner|discovery|handle|available|chat/i
    );
    assert.equal(requests.some(request => request.method === 'thread-follower-steer-turn'), false);
  });
});
