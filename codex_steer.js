'use strict';

const childProcess = require('child_process');
const { randomUUID } = require('crypto');

const DEFAULT_TIMEOUT_MS = 12_000;

function execFileAsync(executable, args, options = {}, execFileImpl = childProcess.execFile) {
  return new Promise((resolve, reject) => {
    execFileImpl(executable, args, options, (error, stdout = '', stderr = '') => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function compactError(error) {
  if (!error) return 'Unknown Codex app-server error.';
  const stderr = String(error.stderr || '').trim();
  const stdout = String(error.stdout || '').trim();
  const message = stderr || stdout || error.message || String(error);
  const lines = message.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return lines.slice(-4).join(' | ');
}

function controlSocketUnavailableReason(detail = '') {
  const suffix = detail ? ` (${detail})` : '';
  return `Steer chưa khả dụng: Codex Extension đang giữ app-server qua stdio riêng, không có control socket để tracker kết nối an toàn${suffix}. Dùng “Gửi sau” để xếp tin nhắn vào queue.`;
}

/**
 * Check the read-only daemon control endpoint. This never starts, restarts, or
 * owns an app-server. A successful response only proves that a daemon socket
 * exists; the subsequent steer request still validates the active turn id.
 */
async function probeSteerSupport(executable, options = {}) {
  if (!executable) return { available: false, reason: 'Codex CLI binary is unavailable.', executable: '' };
  const env = { ...process.env, ...(options.env || {}) };
  if (options.codexHome) env.CODEX_HOME = options.codexHome;
  const execFileImpl = options.execFileImpl || childProcess.execFile;
  try {
    const [help, version] = await Promise.all([
      execFileAsync(executable, ['app-server', 'proxy', '--help'], {
        env,
        windowsHide: true,
        timeout: options.timeoutMs || 7000,
        maxBuffer: 512 * 1024
      }, execFileImpl),
      execFileAsync(executable, ['app-server', 'daemon', 'version'], {
        env,
        windowsHide: true,
        timeout: options.timeoutMs || 7000,
        maxBuffer: 512 * 1024
      }, execFileImpl)
    ]);
    const helpText = `${help.stdout}\n${help.stderr}`;
    if (!/Proxy stdio bytes to the running app-server control socket/i.test(helpText)) {
      return {
        available: false,
        reason: 'Codex CLI không có app-server proxy tương thích để steer an toàn.',
        executable,
        version: String(version.stdout || version.stderr || '').trim()
      };
    }
    return {
      available: true,
      reason: '',
      executable,
      version: String(version.stdout || version.stderr || '').trim(),
      source: 'app-server-control-socket'
    };
  } catch (error) {
    // The extension-owned stdio process does not expose this socket. Keep the
    // diagnostic actionable, while retaining the CLI detail for logs/tests.
    return {
      available: false,
      reason: controlSocketUnavailableReason(),
      detail: compactError(error),
      executable,
      version: ''
    };
  }
}

function makeClientUserMessageId() {
  try { return randomUUID(); } catch { return ''; }
}

function buildInitializeRequest(id = 1) {
  return {
    id,
    method: 'initialize',
    params: {
      clientInfo: {
        name: 'codex-session-tracker',
        title: 'Codex Session Tracker',
        version: '0.6.0'
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false
      }
    }
  };
}

function buildSteerRequest({ id = 2, threadId, expectedTurnId, message, clientUserMessageId = makeClientUserMessageId() } = {}) {
  const normalizedThreadId = String(threadId || '').trim();
  const normalizedTurnId = String(expectedTurnId || '').trim();
  const text = String(message || '').trim();
  if (!normalizedThreadId) throw new Error('No Codex thread is selected.');
  if (!normalizedTurnId) throw new Error('The selected chat has no active turn id. Refresh and try again.');
  if (!text) throw new Error('Message is empty.');
  return {
    id,
    method: 'turn/steer',
    params: {
      threadId: normalizedThreadId,
      expectedTurnId: normalizedTurnId,
      input: [{ type: 'text', text, text_elements: [] }],
      clientUserMessageId: clientUserMessageId || null
    }
  };
}

function parseLineMessages(buffer, onMessage) {
  let rest = String(buffer || '');
  const messages = [];
  while (true) {
    const newline = rest.indexOf('\n');
    if (newline < 0) break;
    const line = rest.slice(0, newline).trim();
    rest = rest.slice(newline + 1);
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      messages.push(parsed);
      if (onMessage) onMessage(parsed);
    } catch {
      // A malformed notification must not make us send a duplicate steer. The
      // matching request timeout will report the failure to the user.
    }
  }
  return { rest, messages };
}

function isErrorResponse(message) {
  return Boolean(message && typeof message === 'object' && message.error);
}

function responseError(message) {
  const error = message && message.error || {};
  const detail = error.message || error.code || 'Codex app-server rejected the request.';
  const result = new Error(String(detail));
  if (error.code !== undefined) result.code = error.code;
  result.data = error.data;
  return result;
}

function spawnProxy(executable, options = {}) {
  const env = { ...process.env, ...(options.env || {}) };
  if (options.codexHome) env.CODEX_HOME = options.codexHome;
  const args = ['app-server', 'proxy'];
  if (options.socketPath) args.push('--sock', String(options.socketPath));
  return (options.spawnImpl || childProcess.spawn)(executable, args, {
    cwd: options.cwd || undefined,
    env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
}

function steerMessage(options = {}) {
  const executable = String(options.executable || '').trim();
  if (!executable) return Promise.reject(new Error('Codex CLI binary is unavailable.'));
  const initialize = buildInitializeRequest(1);
  const steer = buildSteerRequest({
    id: 2,
    threadId: options.threadId,
    expectedTurnId: options.expectedTurnId,
    message: options.message,
    clientUserMessageId: options.clientUserMessageId
  });
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));

  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnProxy(executable, options); }
    catch (error) { reject(error); return; }

    let buffer = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    let phase = 'initialize';

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { if (child.stdin && !child.stdin.destroyed) child.stdin.end(); } catch {}
      try { if (!child.killed && child.exitCode === null) child.kill(); } catch {}
      if (error) {
        if (!error.stderr && stderr.trim()) error.stderr = stderr.trim();
        reject(error);
      } else resolve(result || {});
    };

    const armTimeout = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const error = new Error(`Codex app-server proxy timed out during ${phase}.`);
        error.stderr = stderr.trim();
        finish(error);
      }, timeoutMs);
    };

    const send = request => {
      try {
        // The app-server proxy uses newline-delimited JSON.  A trailing space
        // alone leaves the request buffered indefinitely and eventually causes
        // a misleading timeout.
        child.stdin.write(`${JSON.stringify(request)}\n`);
        armTimeout();
      } catch (error) { finish(error); }
    };

    const onMessage = message => {
      if (!message || message.id === undefined || message.id === null) return;
      if (message.id === initialize.id && phase === 'initialize') {
        if (isErrorResponse(message)) { finish(responseError(message)); return; }
        phase = 'steer';
        try {
          child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
        } catch (error) { finish(error); return; }
        send(steer);
        return;
      }
      if (message.id === steer.id && phase === 'steer') {
        if (isErrorResponse(message)) { finish(responseError(message)); return; }
        finish(null, message.result || {});
      }
    };

    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      const parsed = parseLineMessages(buffer, onMessage);
      buffer = parsed.rest;
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => finish(error));
    child.on('exit', (code, signal) => {
      if (settled) return;
      const error = new Error(`Codex app-server proxy exited before steer completed (code ${code === null ? 'null' : code}, signal ${signal || 'none'}).`);
      error.stderr = stderr.trim();
      finish(error);
    });
    armTimeout();
    send(initialize);
  });
}

module.exports = {
  compactError,
  controlSocketUnavailableReason,
  probeSteerSupport,
  buildInitializeRequest,
  buildSteerRequest,
  parseLineMessages,
  responseError,
  steerMessage
};
