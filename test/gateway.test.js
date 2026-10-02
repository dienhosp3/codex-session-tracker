'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DeliveryState } = require('../gateway/state_machine');
const { classifyRequest } = require('../gateway/classifier');
const { redactHeaders, sanitizePath, sha256 } = require('../gateway/redaction');
const { TraceStore } = require('../gateway/trace_store');
const { GatewayServer, isLoopback } = require('../gateway/server');
const { correlateNetwork, observeRolloutEvidence } = require('../gateway/correlation');
const { frameParser, upstreamTarget } = require('../gateway/websocket_proxy');
const { CodexGateway } = require('../gateway');

function requestJson(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body ? Buffer.from(JSON.stringify(options.body)) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: options.method || 'GET',
      headers: {
        ...(options.token ? { 'x-codex-gateway-token': options.token } : {}),
        ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {})
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('delivery state keeps precise local and upstream milestones', () => {
  const state = new DeliveryState({ gatewayCommandId: 'g1', clientUserMessageId: 'm1', threadId: 't1', action: 'steer', createdAt: 1000 });
  state.add('LOCAL_CREATED', { source: 'gateway' }, 1000);
  state.add('IPC_SENT', { source: 'ipc' }, 1010);
  state.add('OWNER_DISCOVERED', { source: 'ipc' }, 1020);
  state.add('CORE_ACCEPTED', { source: 'ipc-ack', turnId: 'turn-1' }, 1030);
  state.add('LOCAL_PERSISTED', { source: 'rollout' }, 1040);
  state.add('UPSTREAM_REQUEST_OPENED', { source: 'proxy', confidence: 'heuristic' }, 1050);
  state.add('UPSTREAM_FIRST_EVENT', { source: 'proxy', confidence: 'heuristic' }, 1100);
  const snap = state.snapshot();
  assert.equal(snap.stage, 'UPSTREAM_FIRST_EVENT');
  assert.equal(snap.turnId, 'turn-1');
  assert.equal(snap.events.find(e => e.stage === 'UPSTREAM_REQUEST_OPENED').confidence, 'heuristic');
});

test('late observation of local persistence does not roll state backwards', () => {
  const state = new DeliveryState({ gatewayCommandId: 'g1' });
  state.add('LOCAL_CREATED');
  state.add('CORE_ACCEPTED');
  state.add('UPSTREAM_REQUEST_OPENED');
  state.add('LOCAL_PERSISTED', { source: 'rollout' });
  assert.equal(state.snapshot().stage, 'UPSTREAM_REQUEST_OPENED');
  assert.equal(state.snapshot().events.at(-1).observedOutOfOrder, true);
});

test('delivery diagnostics distinguish accepted-no-upstream from upstream-no-first-byte', () => {
  const local = new DeliveryState({ gatewayCommandId: 'local' });
  local.add('LOCAL_CREATED', {}, 1000);
  local.add('CORE_ACCEPTED', {}, 2000);
  assert.equal(local.diagnose(40000, { localNoUpstreamMs: 30000 }).classification, 'LOCAL_ACCEPTED_NO_UPSTREAM');

  const upstream = new DeliveryState({ gatewayCommandId: 'upstream' });
  upstream.add('LOCAL_CREATED', {}, 1000);
  upstream.add('CORE_ACCEPTED', {}, 2000);
  upstream.add('UPSTREAM_REQUEST_OPENED', {}, 3000);
  assert.equal(upstream.diagnose(50000, { upstreamNoFirstEventMs: 45000 }).classification, 'UPSTREAM_NO_FIRST_BYTE');
});

test('request classifier separates model, auth, sync, telemetry and unknown traffic', () => {
  assert.equal(classifyRequest({ method: 'POST', path: '/backend-api/codex/responses' }), 'MODEL_REQUEST');
  assert.equal(classifyRequest({ method: 'GET', path: '/backend-api/codex/responses?x=1', upgrade: true }), 'MODEL_STREAM');
  assert.equal(classifyRequest({ path: '/oauth/token' }), 'AUTH');
  assert.equal(classifyRequest({ path: '/backend-api/threads/sync' }), 'THREAD_SYNC');
  assert.equal(classifyRequest({ path: '/telemetry/events' }), 'TELEMETRY');
  assert.equal(classifyRequest({ path: '/something-new' }), 'UNKNOWN');
});

test('redaction never retains authorization or cookies', () => {
  const headers = redactHeaders({
    authorization: 'Bearer secret',
    cookie: 'session=secret',
    'set-cookie': 'session=secret',
    'x-api-key': 'key',
    accept: 'application/json',
    'x-private-context': 'do-not-log-me'
  });
  assert.equal(headers.authorization, '[REDACTED]');
  assert.equal(headers.cookie, '[REDACTED]');
  assert.equal(headers['set-cookie'], '[REDACTED]');
  assert.equal(headers['x-api-key'], '[REDACTED]');
  assert.equal(headers.accept, 'application/json');
  assert.equal(headers['x-private-context'], '[OMITTED]');
  assert.equal(sanitizePath('/v1/responses?token=secret'), '/v1/responses');
  assert.equal(sha256(Buffer.from('abc')).length, 64);
});


test('rollout text fallback ignores an old identical message', async t => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gateway-correlation-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rollout.jsonl');
  const message = 'repeatable instruction';
  const oldAt = Date.now() - 60_000;
  await fs.promises.writeFile(file, JSON.stringify({
    timestamp: new Date(oldAt).toISOString(),
    type: 'event_msg',
    payload: { type: 'user_message', message }
  }) + '\n', 'utf8');
  const evidence = await observeRolloutEvidence(file, { message, afterMs: Date.now() });
  assert.equal(evidence, null);
});

test('rollout text fallback correlates a recent identical message only as correlated', async t => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gateway-correlation-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rollout.jsonl');
  const message = 'new steer text';
  const createdAt = Date.now();
  await fs.promises.writeFile(file, JSON.stringify({
    timestamp: new Date(createdAt + 10).toISOString(),
    type: 'event_msg',
    payload: { type: 'user_message', message }
  }) + '\n', 'utf8');
  const evidence = await observeRolloutEvidence(file, { message, afterMs: createdAt });
  assert.equal(evidence.confidence, 'correlated');
  assert.match(evidence.detail, /recent rollout event/);
});

test('correlation marks a timing-only network association heuristic', () => {
  const command = {
    action: 'steer',
    createdAt: 1000,
    turnId: 'turn-1',
    state: { terminal: '' }
  };
  const exact = correlateNetwork([command], { turnId: 'turn-1' }, 2000);
  assert.equal(exact.confidence, 'authoritative');
  const timed = correlateNetwork([command], {}, 2000);
  assert.equal(timed.confidence, 'heuristic');
});

test('gateway health is loopback-only and never exposes its control token', async t => {
  const trace = new TraceStore();
  const server = new GatewayServer({ port: 0, version: 'test', trace });
  await server.start();
  t.after(() => server.stop());
  const address = server.address();
  const result = await requestJson(address.port, '/health');
  assert.equal(result.status, 200);
  assert.equal(result.body.running, true);
  assert.equal(result.body.listen.host, '127.0.0.1');
  assert.equal(Object.hasOwn(result.body.listen, 'token'), false);
});

test('gateway control routes require the in-memory token', async t => {
  let calls = 0;
  const server = new GatewayServer({
    port: 0,
    handlers: { steer: async body => { calls += 1; return { echoed: body.message }; } }
  });
  await server.start();
  t.after(() => server.stop());
  const address = server.address();

  const denied = await requestJson(address.port, '/control/steer', { method: 'POST', body: { message: 'x' } });
  assert.equal(denied.status, 401);
  assert.equal(calls, 0);

  const allowed = await requestJson(address.port, '/control/steer', { method: 'POST', token: address.token, body: { message: 'x' } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.echoed, 'x');
  assert.equal(calls, 1);
});


test('websocket frame parser records metadata without payload content', () => {
  const frames = [];
  const parse = frameParser('out', frame => frames.push(frame));
  const payload = Buffer.from('hello');
  const frame = Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  parse(frame.subarray(0, 3));
  parse(frame.subarray(3));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].direction, 'out');
  assert.equal(frames[0].fin, true);
  assert.equal(frames[0].opcode, 1);
  assert.equal(frames[0].masked, false);
  assert.equal(frames[0].size, 5);
  assert.equal(frames[0].wireBytes, 7);
  assert.equal(frames[0].bodySha256, sha256(payload));
  assert.equal(Object.values(frames[0]).includes('hello'), false);
});


test('masked websocket payload fingerprint is stable after unmasking', () => {
  const frames = [];
  const parse = frameParser('out', frame => frames.push(frame));
  const payload = Buffer.from('same-payload');
  const key = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ key[i & 3];
  parse(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), key, masked]));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].bodySha256, sha256(payload));
});

test('websocket upstream target preserves configured backend prefix', () => {
  assert.deepEqual(
    upstreamTarget('https://chatgpt.com/backend-api', '/codex/responses?x=1'),
    { protocol: 'wss:', host: 'chatgpt.com', port: 443, path: '/backend-api/codex/responses?x=1' }
  );
  assert.equal(
    upstreamTarget('https://chatgpt.com/backend-api', '/backend-api/codex/responses').path,
    '/backend-api/codex/responses'
  );
});


test('CodexGateway keeps a stable client message id through local steer acknowledgement', async t => {
  let observedId = '';
  const gateway = new CodexGateway({
    port: 0,
    handlers: {
      steer: async input => {
        observedId = input.clientUserMessageId;
        await input.onProgress({ stage: 'IPC_SENT', source: 'test-ipc' });
        await input.onProgress({ stage: 'OWNER_DISCOVERED', source: 'test-ipc' });
        await input.onProgress({ stage: 'OWNER_ROUTED', source: 'test-ipc' });
        await input.onProgress({ stage: 'CORE_ACCEPTED', source: 'test-ipc', turnId: 'turn-7' });
        return { turnId: 'turn-7', clientUserMessageId: input.clientUserMessageId };
      }
    }
  });
  await gateway.start();
  t.after(() => gateway.stop());
  const result = await gateway.steer({ threadId: 'thread-7', message: 'hello' });
  assert.equal(result.clientUserMessageId, observedId);
  assert.equal(result.turnId, 'turn-7');
  assert.equal(result.delivery.stage, 'CORE_ACCEPTED');
  assert.equal(result.delivery.events.some(event => /UPSTREAM/.test(event.stage)), false);
});

test('unsupported interrupt stays explicitly not-sent', async () => {
  const gateway = new CodexGateway({ port: 0 });
  const result = await gateway.interrupt({ threadId: 'thread-1', turnId: 'turn-1' });
  assert.equal(result.supported, false);
  assert.equal(result.delivery.terminal, 'NOT_SENT');
});

test('HTTP model proxy streams request bytes, preserves backend prefix, and redacts trace secrets', async t => {
  let receivedPath = '';
  let receivedBody = '';
  const upstream = http.createServer((req, res) => {
    receivedPath = req.url;
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      receivedBody = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\\n\\n');
      res.end('data: done\\n\\n');
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const upstreamPort = upstream.address().port;
  const trace = new TraceStore();
  const gateway = new GatewayServer({
    port: 0,
    trace,
    modelProxyEnabled: true,
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/backend-api`
  });
  await gateway.start();
  t.after(() => gateway.stop());
  const address = gateway.address();

  const payload = Buffer.from('{"input":"hello"}');
  const response = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      path: '/codex/responses?trace=private',
      method: 'POST',
      headers: {
        authorization: 'Bearer top-secret',
        cookie: 'session=private',
        'content-type': 'application/json',
        'content-length': payload.length
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.write(payload.subarray(0, 5));
    setTimeout(() => { req.end(payload.subarray(5)); }, 10);
  });

  assert.equal(response.status, 200);
  assert.equal(receivedPath, '/backend-api/codex/responses?trace=private');
  assert.equal(receivedBody, payload.toString('utf8'));
  const events = trace.recent(50).filter(event => event.type === 'http_upstream');
  assert.ok(events.some(event => event.stage === 'UPSTREAM_BYTES_SENT'));
  assert.ok(events.some(event => event.stage === 'UPSTREAM_FIRST_EVENT'));
  const finishedBody = events.find(event => event.stage === 'UPSTREAM_BODY_FINISHED');
  assert.equal(finishedBody.bodySha256, sha256(payload));
  const opened = events.find(event => event.stage === 'UPSTREAM_REQUEST_OPENED');
  assert.equal(opened.path, '/codex/responses');
  assert.equal(opened.headers.authorization, '[REDACTED]');
  assert.equal(opened.headers.cookie, '[REDACTED]');
});


test('non-model gateway traffic never advances steer upstream state', async () => {
  const gateway = new CodexGateway({ port: 0 });
  const command = gateway.createCommand('steer', { threadId: 'thread-x', message: 'x' });
  await gateway.progress(command, { stage: 'CORE_ACCEPTED', source: 'test', turnId: 'turn-x' });
  await gateway.onNetworkEvent({
    type: 'http_upstream',
    kind: 'THREAD_SYNC',
    stage: 'UPSTREAM_REQUEST_OPENED',
    at: Date.now()
  });
  const snap = gateway.commandSnapshot(command);
  assert.equal(snap.stage, 'CORE_ACCEPTED');
  assert.equal(snap.events.some(event => event.stage === 'UPSTREAM_REQUEST_OPENED'), false);
  assert.equal(gateway.diagnostics().modelTrafficObserved, false);
});

test('model proxy readiness is distinct from observed model traffic', async () => {
  const gateway = new CodexGateway({
    port: 0,
    modelProxyEnabled: true,
    upstreamBaseUrl: 'http://127.0.0.1:65534/backend-api'
  });
  assert.equal(gateway.diagnostics().modelProxyReady, true);
  assert.equal(gateway.diagnostics().modelTrafficObserved, false);
  await gateway.onNetworkEvent({
    type: 'http_upstream',
    kind: 'MODEL_REQUEST',
    stage: 'UPSTREAM_REQUEST_OPENED',
    at: 12345
  });
  assert.equal(gateway.diagnostics().modelTrafficObserved, true);
  assert.equal(gateway.diagnostics().lastModelNetworkAt, 12345);
});


test('diagnostic export omits headers and raw message content', async () => {
  const gateway = new CodexGateway({ port: 0, version: 'test-export' });
  await gateway.trace.append({
    type: 'http_upstream',
    stage: 'UPSTREAM_REQUEST_OPENED',
    at: 1,
    kind: 'MODEL_REQUEST',
    path: '/codex/responses',
    headers: { authorization: '[REDACTED]', 'user-agent': 'private-agent' },
    rawBody: 'private prompt'
  });
  const snapshot = gateway.exportSnapshot({ codexCliVersion: '0.test' });
  assert.equal(snapshot.gatewayVersion, 'test-export');
  assert.equal(snapshot.codexCliVersion, '0.test');
  assert.equal(snapshot.events.length, 1);
  assert.equal(Object.hasOwn(snapshot.events[0], 'headers'), false);
  assert.equal(Object.hasOwn(snapshot.events[0], 'rawBody'), false);
});

test('loopback predicate rejects non-loopback clients', () => {
  assert.equal(isLoopback({ socket: { remoteAddress: '127.0.0.1' } }), true);
  assert.equal(isLoopback({ socket: { remoteAddress: '::1' } }), true);
  assert.equal(isLoopback({ socket: { remoteAddress: '192.168.1.10' } }), false);
});
