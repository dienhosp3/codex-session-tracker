'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { spawn } = require('node:child_process');
const { createLiveBackend } = require('../../src/codex_live_backend');
const { runContextHandoff } = require('../../src/codex_context_handoff');
const { findBundledCli } = require('../../src/runtime_versions');
const { permissionSettings, readThreadPermissions } = require('../../src/codex_thread_permissions');
const { createAttentionMonitor } = require('../../src/codex_attention');
const { contextConfig } = require('../../src/codex_new_chat');

test('installed app-server: real stop, new thread, name and deeplink continuation with no quota', { timeout: 45000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-live-')), home = path.join(root, 'home');
  await fs.mkdir(home);
  const requests = [], sockets = new Set(), providers = new Map(), pending = new Map(), serverRequests = [];
  let nextTool = null;
  let child, backend, buffer = '', stderr = '', sequence = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url.endsWith('/responses')) { res.writeHead(404); res.end('{}'); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ type: 'response.created', response: { id: 'fixture-' + requests.length } }) + '\n\n');
    if (requests.length === 1) return;
    const output = nextTool || { id: 'fixture-msg', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'CONTINUED_OK' }] };
    nextTool = null;
    for (const event of [
      { type: 'response.output_item.done', item: output },
      { type: 'response.completed', response: { id: 'fixture-' + requests.length, usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } } }
    ]) res.write('data: ' + JSON.stringify(event) + '\n\n');
    res.end();
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  function rpc(method, params) {
    const id = 'probe-' + ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Timeout: ' + method + ' ' + stderr.slice(-600))); }, 12000);
      pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await fs.writeFile(path.join(home, 'config.toml'), `model_provider="fixture"\nmodel="fixture-model"\napproval_policy="on-request"\nsandbox_mode="read-only"\n[model_providers.fixture]\nname="Loopback fixture"\nbase_url="http://127.0.0.1:${server.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\nrequest_max_retries=0\nstream_max_retries=0\n`);
    assert.ok(process.env.CST_CODEX_EXTENSION_ROOT, 'Set CST_CODEX_EXTENSION_ROOT');
    const executable = await findBundledCli(process.env.CST_CODEX_EXTENSION_ROOT); assert.ok(executable);
    const env = { ...process.env, CODEX_HOME: home };
    for (const key of Object.keys(env)) if (/^(?:OPENAI_|CODEX_API_KEY|CODEX_TRACKER_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|http_proxy$|https_proxy$|all_proxy$)/.test(key)) delete env[key];
    child = spawn(executable, ['app-server'], { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-2000); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', text => {
      buffer += text;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.method && msg.id !== undefined) serverRequests.push(msg);
        if (pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(Object.assign(new Error(msg.error.message), msg.error)) : p.resolve(msg.result); }
        if (typeof msg.id === 'string' && msg.id.startsWith('backend:')) {
          const [, name, id] = msg.id.split(':'); providers.get(name)?.onResult({ ...msg, id });
        }
      }
    });
    child.on('error', error => { for (const p of pending.values()) p.reject(error); pending.clear(); });
    await rpc('initialize', { clientInfo: { name: 'context_handoff_smoke', version: '0.12.28' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    backend = createLiveBackend({ proc: child, initialized: true,
      registerProvider(name, provider) { providers.set(name, provider); return { dispose: () => providers.delete(name) }; },
      sendRequest(name, id, method, params) { child.stdin.write(JSON.stringify({ id: `backend:${name}:${id}`, method, params }) + '\n'); }
    });
    const fullAccess = permissionSettings({ approval_policy: 'never', approvals_reviewer: 'user',
      active_permission_profile: { id: ':danger-full-access' } });
    const source = await backend.createSuccessor({ cwd: root, model: 'gpt-6-astra', permissionSettings: fullAccess });
    await backend.renameThread(source.id, '[LIVE-0001] Smoke test');
    const started = await backend.startSuccessor({ threadId: source.id, message: 'Wait for stop.', clientUserMessageId: require('node:crypto').randomUUID(), permissionSettings: fullAccess });
    await rpc('thread/goal/set', { threadId: source.id, objective: 'Loopback smoke goal', status: 'active' });
    for (let i = 0; i < 100 && !requests.length; i++) await new Promise(r => setTimeout(r, 50));
    assert.equal(requests.length, 1, 'first turn reaches only the local fixture');
    const result = await runContextHandoff({ directory: path.join(root, 'journal'), backend,
      entry: { threadId: source.id, turnId: started.turnId, cwd: root, model: 'gpt-6-astra', contextPreset: '600k',
        contextConfig: contextConfig('600k', { model: 'gpt-6-astra', effectivePercent: 95 }) },
      onProgress: state => { if (state.phase === 'waiting') assert.equal(state.delaySeconds, 10); } });
    assert.equal(result.message, `[LIVE-0002] Tiếp tục codex://threads/${source.id}\n\nMã ID và nhãn chỉ để nhận diện chat, không đưa vào repo.`);
    for (let i = 0; i < 100 && requests.length < 2; i++) await new Promise(r => setTimeout(r, 50));
    assert.equal(requests.length, 2); assert.ok(JSON.stringify(requests[1].input).includes(result.message));
    const old = (await rpc('thread/read', { threadId: source.id, includeTurns: false })).thread;
    const next = (await rpc('thread/read', { threadId: result.nextThreadId, includeTurns: false })).thread;
    assert.notEqual(old.status.type, 'active'); assert.equal(next.name, '[LIVE-0002] Tiếp tục'); assert.notEqual(next.id, old.id);
    assert.equal((await rpc('thread/goal/get', { threadId: source.id })).goal, null);
    const inherited = await readThreadPermissions(next.path, next.id);
    assert.equal(inherited.start.approvalPolicy, 'never');
    assert.equal(inherited.start.permissions, ':danger-full-access');
    const successorEvents = (await fs.readFile(next.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(successorEvents.some(e => e.type === 'event_msg' && e.payload.type === 'task_started' && e.payload.model_context_window === 570000), 'successor has the selected context: ' + JSON.stringify(successorEvents.filter(e => e.payload?.type === 'task_started').map(e => e.payload.model_context_window)));
    assert.equal(result.contextPreset, '600k');
    console.log('Full access inherited across the real handoff with read-only server defaults.');
    const waitUntil = async check => {
      for (let i = 0; i < 120; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 50)); }
      throw new Error('Native waiting state was not observed. Threads: ' + JSON.stringify((await backend.readAttentionThreads()).map(t => ({ id: t.id, status: t.status }))) + '; Server requests: ' + JSON.stringify(serverRequests.map(x => ({ method: x.method, threadId: x.params?.threadId }))));
    };
    const inputThread = (await rpc('thread/start', { cwd: root, approvalPolicy: 'on-request', sandbox: 'read-only' })).thread;
    nextTool = { id: 'input-call', type: 'function_call', call_id: 'input-call', name: 'request_user_input',
      arguments: JSON.stringify({ questions: [{ header: 'Choice', id: 'choice', question: 'Choose the fixture option.', options: [{ label: 'One', description: 'First option.' }, { label: 'Two', description: 'Second option.' }] }] }) };
    await rpc('turn/start', { threadId: inputThread.id, input: [{ type: 'text', text: 'Ask the fixture question.' }],
      collaborationMode: { mode: 'plan', settings: { model: 'fixture-model', reasoning_effort: 'medium', developer_instructions: null } } });
    await waitUntil(() => serverRequests.some(x => x.method === 'item/tool/requestUserInput'));
    const sounds = [];
    const monitor = createAttentionMonitor({ read: () => backend.readAttentionThreads(), notify: async e => sounds.push(e.threadId) });
    try {
      await monitor.poll(); await monitor.poll();
      assert.deepEqual(monitor.snapshot()[inputThread.id].flags, ['waitingOnUserInput']);
      assert.deepEqual(sounds, [inputThread.id]);
      const question = serverRequests.find(x => x.method === 'item/tool/requestUserInput');
      child.stdin.write(JSON.stringify({ id: question.id, result: { answers: { choice: { answers: ['One'] } } } }) + '\n');
      await waitUntil(async () => { await monitor.poll(); return !monitor.snapshot()[inputThread.id]; });
      await waitUntil(async () => (await rpc('thread/read', { threadId: inputThread.id, includeTurns: false })).thread.status.type === 'idle');
      console.log('Native requestUserInput status, one notification, and clearing after reply verified.');
      const approvalThread = (await rpc('thread/start', { cwd: root, approvalPolicy: 'on-request', sandbox: 'read-only' })).thread;
      nextTool = { id: 'approval-call', type: 'function_call', call_id: 'approval-call', name: 'exec_command',
        arguments: JSON.stringify({ cmd: 'Write-Output approval-fixture', sandbox_permissions: 'require_escalated', justification: 'Local fixture approval check.' }) };
      await rpc('turn/start', { threadId: approvalThread.id, input: [{ type: 'text', text: 'Run the local fixture command after approval.' }] });
      await waitUntil(() => serverRequests.some(x => x.method === 'item/commandExecution/requestApproval' && x.params.threadId === approvalThread.id));
      await waitUntil(async () => { await monitor.poll(); return monitor.snapshot()[approvalThread.id]?.flags.includes('waitingOnApproval'); });
      await monitor.poll();
      assert.deepEqual(monitor.snapshot()[approvalThread.id].flags, ['waitingOnApproval']);
      assert.deepEqual(sounds, [inputThread.id, approvalThread.id]);
      const approval = serverRequests.find(x => x.method === 'item/commandExecution/requestApproval');
      child.stdin.write(JSON.stringify({ id: approval.id, result: { decision: 'decline' } }) + '\n');
      await waitUntil(async () => { await monitor.poll(); return !monitor.snapshot()[approvalThread.id]; });
      console.log('Native command approval status, one notification, and clearing after decline verified.');
    } finally { monitor.dispose(); }
    console.log('Real installed Codex interrupt + fresh thread + exact deeplink message verified; external model requests: 0.');
  } finally {
    backend?.dispose();
    for (const p of pending.values()) p.reject(new Error('Test cleanup')); pending.clear();
    if (child && child.exitCode === null) await new Promise(resolve => { child.once('close', resolve); child.kill(); });
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
