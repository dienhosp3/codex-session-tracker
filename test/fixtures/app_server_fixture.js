'use strict';

const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { spawn } = require('node:child_process');
const { findBundledCli } = require('../../src/runtime_versions');
const { createLiveBackend } = require('../../src/codex_live_backend');
const { createChatContextStore } = require('../../src/codex_chat_context_store');
const { createAutoAllowStore } = require('../../src/codex_auto_allow');

// Isolated Codex runtime; every model request terminates at this loopback server.
async function appServerFixture(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'context-window-'));
  const home = path.join(root, 'home'), pending = new Map(), providers = new Map(), sockets = new Set();
  const events = [], requests = [];
  let child, backend, connection, sequence = 0, buffer = '', stderr = '';
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url.endsWith('/responses')) { res.writeHead(404); res.end('{}'); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (options.respond && await options.respond(requests.at(-1), res)) return;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const id = 'fixture-' + requests.length;
    for (const event of [
      { type: 'response.created', response: { id } },
      { type: 'response.output_item.done', item: { id: id + '-msg', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] } },
      { type: 'response.completed', response: { id, usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } } }
    ]) res.write('data: ' + JSON.stringify(event) + '\n\n');
    res.end();
  });
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  const close = async () => {
    backend?.dispose();
    for (const p of pending.values()) p.reject(new Error('Fixture closed')); pending.clear();
    if (child && child.exitCode === null) await new Promise(resolve => { child.once('close', resolve); child.kill(); });
    for (const s of sockets) s.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    // The PowerShell runner verifies generated descendants and removes scratch.
  };
  function rpc(method, params) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Timeout: ' + method + ' ' + stderr)); }, 12000);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      if (connection) connection.sendRequest('native-fixture', id, method, params);
      else child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  async function launch() {
    connection = null;
    const executable = await findBundledCli(process.env.CST_CODEX_EXTENSION_ROOT);
    if (!executable) throw new Error('Set CST_CODEX_EXTENSION_ROOT to the installed Codex extension.');
    const env = { ...process.env, CODEX_HOME: home };
    for (const key of Object.keys(env)) if (/^(?:OPENAI_|CODEX_API_KEY|CODEX_TRACKER_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|http_proxy$|https_proxy$|all_proxy$)/.test(key)) delete env[key];
    child = spawn(executable, ['app-server'], { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-1200); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', text => {
      buffer += text; let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.method) events.push(msg);
        if (msg.method && msg.id !== undefined) for (const provider of providers.values()) provider.onRequest?.(msg);
        if (msg.method && msg.id === undefined) for (const provider of providers.values()) provider.onNotification?.(msg);
        if (pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(Object.assign(new Error(msg.error.message), msg.error)) : p.resolve(msg.result); }
        if (typeof msg.id === 'string' && msg.id.startsWith('backend:')) {
          const [, name, id] = msg.id.split(':'); providers.get(name)?.onResult({ ...msg, id });
        }
      }
    });
    child.on('error', error => { for (const p of pending.values()) p.reject(error); pending.clear(); });
    await rpc('initialize', { clientInfo: { name: 'context_window_smoke', version: '1' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    connection = { proc: child, initialized: true,
      sendResponse(id, result) { child.stdin.write(JSON.stringify({ id, result }) + '\n'); },
      registerProvider(name, provider) { providers.set(name, provider); return { dispose: () => providers.delete(name) }; },
      sendRequest(name, id, method, params) { child.stdin.write(JSON.stringify({ id: name === 'native-fixture' ? id : `backend:${name}:${id}`, method, params }) + '\n'); }
    };
    backend = createLiveBackend(connection, { contextStore: createChatContextStore(path.join(root, 'settings')),
      autoAllowStore: createAutoAllowStore(path.join(root, 'permissions')) });
  }
  try {
    await fs.mkdir(home);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await fs.writeFile(path.join(home, 'config.toml'), `model_provider="fixture"\nmodel="gpt-6-astra"\nmodel_context_window=900000\napproval_policy="on-request"\nsandbox_mode="read-only"\n[model_providers.fixture]\nname="Loopback fixture"\nbase_url="http://127.0.0.1:${server.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\nrequest_max_retries=0\nstream_max_retries=0\n`);
    await launch();
    return { root, home, rpc, reply: (id, result) => connection.sendResponse(id, result),
      get backend() { return backend; }, events, requests, close, async restart() {
      backend.dispose();
      await new Promise(resolve => { child.once('close', resolve); child.kill(); });
      buffer = '';
      await launch();
    } };
  } catch (error) { await close(); throw error; }
}

module.exports = { appServerFixture };
