'use strict';

const childProcess = require('child_process');
const { randomUUID } = require('crypto');
const net = require('net');
const os = require('os');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 12_000;
const IPC_DEFAULT_TIMEOUT_MS = 5_000;
const IPC_STEER_TIMEOUT_MS = 15_000;
const IPC_INITIALIZING_CLIENT = 'initializing-client';
const IPC_MAX_FRAME_BYTES = 256 * 1024 * 1024;
const MAX_IMAGE_ATTACHMENTS = 5;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function imageMatchesMime(bytes, mimeType) {
  if (mimeType === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mimeType === 'image/webp') return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (mimeType === 'image/gif') return bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6));
  return false;
}

/** Accept only bounded browser image data URLs before they enter an IPC frame. */
function normalizeImageAttachments(rawImages) {
  if (rawImages == null) return [];
  if (!Array.isArray(rawImages)) throw new Error('Image attachments must be a list.');
  if (rawImages.length > MAX_IMAGE_ATTACHMENTS) throw new Error('Attach at most 5 images.');
  return rawImages.map((image, index) => {
    if (!image || typeof image !== 'object' || typeof image.dataUrl !== 'string') {
      throw new Error('Image attachment is invalid.');
    }
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(image.dataUrl);
    if (!match) throw new Error('Image must be a PNG, JPEG, WebP, or GIF data URL.');
    const mimeType = match[1].toLowerCase();
    if (image.mimeType && String(image.mimeType).toLowerCase() !== mimeType) {
      throw new Error('Image MIME type does not match its data URL.');
    }
    const encoded = match[2];
    if (encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error('Each image must be 8 MB or smaller.');
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('Each image must be 8 MB or smaller.');
    if (bytes.toString('base64') !== encoded || !imageMatchesMime(bytes, mimeType)) {
      throw new Error('Image data does not match the declared format.');
    }
    const rawName = String(image.name || 'image-' + (index + 1)).split(/[\\/]/).pop();
    const name = rawName.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120) || 'image';
    return { name, mimeType, dataUrl: 'data:' + mimeType + ';base64,' + encoded };
  });
}

/**
 * Codex Extension owns one app-server and exposes a local, user-scoped IPC
 * router for follower clients. On Windows this is a named pipe; on Unix it is
 * the socket under CODEX_HOME. Keeping the endpoint here (rather than spawning
 * another app-server) is what makes steer safe while the Codex webview is
 * blank/gray.
 */
function extensionIpcEndpoint(options = {}) {
  if (options.endpoint) return String(options.endpoint);
  if (process.platform === 'win32') return '\\\\.\\pipe\\codex-ipc';
  const codexHome = String(options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  return path.join(codexHome, 'ipc', 'ipc.sock');
}

function frameIpcMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (payload.length === 0 || payload.length > IPC_MAX_FRAME_BYTES) {
    throw new Error(`Codex Extension IPC frame is ${payload.length} bytes; maximum is ${IPC_MAX_FRAME_BYTES}.`);
  }
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function parseIpcFrames(buffer, onMessage) {
  let rest = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  while (rest.length >= 4) {
    const size = rest.readUInt32LE(0);
    if (size === 0 || size > IPC_MAX_FRAME_BYTES) throw new Error(`Invalid Codex Extension IPC frame length (${size}).`);
    if (rest.length < size + 4) break;
    const payload = rest.subarray(4, size + 4).toString('utf8');
    rest = rest.subarray(size + 4);
    let message;
    try { message = JSON.parse(payload); }
    catch { throw new Error('Codex Extension IPC returned invalid JSON.'); }
    if (onMessage) onMessage(message);
  }
  return rest;
}

function ipcVersion(method) {
  // These are the versions advertised by the installed Codex Extension.
  if (method === 'initialize') return 0;
  if (method === 'thread-owner-discovery') return 1;
  if (method === 'thread-follower-steer-turn') return 1;
  return 0;
}

function ipcError(response, fallback = 'Codex Extension IPC rejected the request.') {
  if (!response) return new Error(fallback);
  const raw = response.error;
  const detail = (raw && typeof raw === 'object' ? raw.message || raw.code : raw) || response.message || fallback;
  const error = new Error(String(detail));
  if (raw && typeof raw === 'object' && raw.code) error.code = raw.code;
  if (response.resultType) error.resultType = response.resultType;
  return error;
}

function connectExtensionIpc(options = {}) {
  const timeoutMs = Math.max(500, Number(options.timeoutMs || IPC_DEFAULT_TIMEOUT_MS));
  const connectImpl = options.connectImpl || net.connect;
  const endpoint = extensionIpcEndpoint(options);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    let socket;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) {
        try { socket && socket.destroy(); } catch {}
        reject(error);
      } else resolve(value);
    };
    try {
      socket = connectImpl(endpoint, () => finish(null, socket));
    } catch (error) { finish(error); return; }
    timer = setTimeout(() => {
      const error = new Error(`Timed out connecting to Codex Extension IPC (${endpoint}).`);
      error.code = 'ETIMEDOUT';
      finish(error);
    }, timeoutMs);
    socket.once('error', error => finish(error));
  });
}

function createIpcClient(socket, options = {}) {
  const timeoutMs = Math.max(500, Number(options.timeoutMs || IPC_DEFAULT_TIMEOUT_MS));
  let buffer = Buffer.alloc(0);
  let closed = false;
  let clientId = IPC_INITIALIZING_CLIENT;
  const pending = new Map();
  const requestFailure = (error, item) => {
    const failure = new Error(error && error.message || String(error));
    if (error && error.code) failure.code = error.code;
    if (item.method === 'thread-follower-steer-turn' && item.sent) {
      failure.delivery = 'unknown';
      failure.deliveryStatus = 'unknown';
    }
    return failure;
  };

  const close = () => {
    if (closed) return;
    closed = true;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(requestFailure(new Error('Codex Extension IPC connection closed.'), item));
    }
    pending.clear();
    try { socket.end(); } catch {}
    try { socket.destroy(); } catch {}
  };
  const onMessage = message => {
    if (!message || message.type !== 'response' || !message.requestId) return;
    const item = pending.get(message.requestId);
    if (!item) return;
    pending.delete(message.requestId);
    clearTimeout(item.timer);
    // Native error envelopes omit method; requestId still correlates them.
    if ((message.resultType === 'success' || message.method !== undefined) && message.method !== item.method) {
      const error = new Error('Codex Extension IPC response method did not match the request.');
      error.code = 'EPROTO';
      item.reject(requestFailure(error, item));
      return;
    }
    if (message.resultType === 'success') {
      if (message.method === 'initialize' && message.result && message.result.clientId) {
        clientId = String(message.result.clientId);
      }
      item.resolve(message);
    } else {
      const error = ipcError(message);
      if (item.method === 'thread-follower-steer-turn') {
        error.delivery = /\[CST_NOT_SENT\]|no-client-found/i.test(error.message) ? 'not_sent'
          : /\[CST_DELIVERY_UNKNOWN\]|timeout|timed.out|client-disconnected/i.test(error.message) ? 'unknown' : 'rejected';
      }
      item.reject(error);
    }
  };
  socket.on('data', chunk => {
    try {
      buffer = parseIpcFrames(Buffer.concat([buffer, chunk]), onMessage);
    } catch (error) {
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(requestFailure(error, item));
      }
      pending.clear();
      close();
    }
  });
  socket.on('close', close);
  socket.on('error', error => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(requestFailure(error, item));
    }
    pending.clear();
  });

  const request = (method, params, requestOptions = {}) => {
    if (closed || !socket.writable) {
      const error = new Error('Codex Extension IPC is not connected.');
      error.delivery = 'not_sent';
      return Promise.reject(error);
    }
    const requestId = randomUUID();
    const request = {
      type: 'request',
      requestId,
      sourceClientId: clientId,
      version: ipcVersion(method),
      method,
      params
    };
    if (requestOptions.targetClientId) request.targetClientId = requestOptions.targetClientId;
    if (requestOptions.hostId) request.hostId = requestOptions.hostId;
    return new Promise((resolve, reject) => {
      const item = { resolve, reject, method, sent: false, timer: null };
      item.timer = setTimeout(() => {
        pending.delete(requestId);
        const error = new Error(`Codex Extension IPC timed out during ${method}.`);
        error.code = 'ETIMEDOUT';
        reject(requestFailure(error, item));
      }, Math.max(500, Number(requestOptions.timeoutMs || (method === 'thread-follower-steer-turn' ? IPC_STEER_TIMEOUT_MS : timeoutMs))));
      pending.set(requestId, item);
      try {
        socket.write(frameIpcMessage(request));
        item.sent = true;
      }
      catch (error) {
        clearTimeout(item.timer);
        pending.delete(requestId);
        reject(requestFailure(error, item));
      }
    });
  };
  return {
    request,
    close,
    getClientId: () => clientId
  };
}

async function openExtensionIpc(options = {}) {
  const socket = await connectExtensionIpc(options);
  const client = createIpcClient(socket, options);
  try {
    const initialize = await client.request('initialize', { clientType: 'vscode' });
    if (!initialize.result || !initialize.result.clientId) throw new Error('Codex Extension IPC did not return a client id.');
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}

function noOwnerReason(threadId) {
  const suffix = threadId ? ` cho chat ${threadId}` : '';
  return `Chưa tìm được owner IPC${suffix}. Webview bị xám hoặc mất phản hồi cũng có thể làm discovery thất bại; chưa thể kết luận app-server đã dừng.`;
}

/** Probe the Extension's live IPC router and (when supplied) the selected chat owner. */
async function probeExtensionIpcSupport(options = {}) {
  const threadId = String(options.threadId || options.conversationId || '').trim();
  if (!threadId) return { available: false, source: 'codex-extension-ipc', reason: 'Chưa chọn chat Codex để tìm owner IPC.' };
  let client;
  try {
    client = await openExtensionIpc(options);
    const response = await client.request('thread-owner-discovery', { hostId: 'local', conversationId: threadId }, { timeoutMs: options.timeoutMs });
    const ownerId = response && response.handledByClientId;
    if (!ownerId) return { available: false, source: 'codex-extension-ipc', reason: noOwnerReason(threadId) };
    return { available: true, source: 'codex-extension-ipc', ownerClientId: String(ownerId), clientId: client.getClientId(), reason: '' };
  } catch (error) {
    const detail = compactError(error);
    if (/no-client-found|client-disconnected/i.test(detail)) {
      return { available: false, source: 'codex-extension-ipc', reason: noOwnerReason(threadId) };
    }
    return { available: false, source: 'codex-extension-ipc', reason: detail || 'Không kết nối được IPC của Codex Extension.' };
  } finally {
    if (client) client.close();
  }
}

/** Send a follower steer through the existing Codex Extension owner. */
async function steerViaExtensionIpc(options = {}) {
  const conversationId = String(options.threadId || options.conversationId || '').trim();
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const text = String(options.message || '').trim();
  const images = normalizeImageAttachments(options.images);
  if (!conversationId) throw new Error('No Codex conversation is selected.');
  if (!text && !images.length) throw new Error('Message is empty.');
  let client;
  let steerStarted = false;
  try {
    client = await openExtensionIpc(options);
    onProgress({ stage: 'IPC_SENT', source: 'codex-extension-ipc', confidence: 'authoritative' });
    const discovery = await client.request('thread-owner-discovery', { hostId: 'local', conversationId }, { timeoutMs: options.timeoutMs });
    const ownerId = String(discovery && discovery.handledByClientId || '').trim();
    if (!ownerId) throw new Error(noOwnerReason(conversationId));
    onProgress({ stage: 'OWNER_DISCOVERED', source: 'codex-extension-ipc', confidence: 'authoritative', ownerClientId: ownerId });
    const clientUserMessageId = options.clientUserMessageId || makeClientUserMessageId();
    const cwd = String(options.cwd || process.cwd() || '/');
    const params = {
      conversationId,
      clientUserMessageId,
      input: [...(text ? [{ type: 'text', text, text_elements: [] }] : []), ...images.map(image => ({ type: 'image', url: image.dataUrl }))],
      attachments: [],
      restoreMessage: {
        id: clientUserMessageId,
        text,
        context: {
          prompt: text,
          addedFiles: [],
          fileAttachments: [],
          ideContext: null,
          imageAttachments: [],
          workspaceRoots: [cwd]
        },
        cwd,
        createdAt: Date.now()
      }
    };
    // Only the installed Tracker bridge recognizes this opt-in. Native
    // followers continue using the Extension's original webview handlers.
    if (discovery.result?.supportsTrackerDirectSteer === true) params.trackerDirectSteer = 1;
    // These fields are optional in the Extension follower contract. Omitting
    // them matches the native composer and avoids passing null into a newer
    // app-server schema that only accepts the core steer fields.
    if (options.additionalContext !== undefined) params.additionalContext = options.additionalContext;
    if (options.toolOutput !== undefined) params.toolOutput = options.toolOutput;
    steerStarted = true;
    onProgress({ stage: 'OWNER_ROUTED', source: 'codex-extension-ipc', confidence: 'authoritative', ownerClientId: ownerId, clientUserMessageId });
    const response = await client.request('thread-follower-steer-turn', params, {
      targetClientId: ownerId,
      timeoutMs: options.timeoutMs
    });
    const outer = response && response.result;
    if (outer && outer.method && outer.method !== 'thread-follower-steer-turn') {
      throw new Error('Codex Extension IPC returned a mismatched steer acknowledgement.');
    }
    const result = outer && outer.result !== undefined ? outer.result : outer;
    const turnId = result && typeof result.turnId === 'string' ? result.turnId.trim() : '';
    if (!turnId) throw new Error('Codex Extension IPC did not acknowledge a steer turn id.');
    onProgress({ stage: 'CORE_ACCEPTED', source: 'codex-extension-ipc-ack', confidence: 'authoritative', ownerClientId: ownerId, clientUserMessageId, turnId });
    return { ...(result && typeof result === 'object' ? result : {}), turnId, clientUserMessageId, ownerClientId: ownerId, transport: result?.transport || 'codex-extension-ipc' };
  } catch (error) {
    const detail = compactError(error);
    if (/no-client-found/i.test(detail)) {
      const unavailable = new Error(steerStarted
        ? `Đã tìm thấy owner IPC, nhưng owner không xử lý được steer cho chat ${conversationId}. Webview bị xám có thể không trả lời bước kiểm tra quyền giữ chat. Tin chưa được chuyển tới app-server.`
        : noOwnerReason(conversationId));
      unavailable.delivery = 'not_sent';
      throw unavailable;
    }
    if (!steerStarted) error.delivery = 'not_sent';
    else if (/client-disconnected/i.test(detail) || !error.delivery) error.delivery = 'unknown';
    throw error;
  } finally {
    if (client) client.close();
  }
}

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
  normalizeImageAttachments,
  compactError,
  controlSocketUnavailableReason,
  extensionIpcEndpoint,
  frameIpcMessage,
  parseIpcFrames,
  probeExtensionIpcSupport,
  steerViaExtensionIpc,
  probeSteerSupport,
  buildInitializeRequest,
  buildSteerRequest,
  parseLineMessages,
  responseError,
  steerMessage
};
