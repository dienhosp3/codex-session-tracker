'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { URL } = require('url');
const { redactHeaders, safeError } = require('./redaction');
const { classifyRequest } = require('./classifier');

const CONFIG_FILE = 'codex-session-tracker-http-hook.json';

function hookConfigPath(codexHome) {
  return path.join(String(codexHome || ''), CONFIG_FILE);
}

function bodyCapture(body, maxBytes) {
  if (!body || typeof body !== 'object') return null;
  const encoding = body.encoding === 'base64' ? 'base64' : 'utf8';
  const raw = typeof body.content === 'string' ? body.content : '';
  let bytes;
  try {
    bytes = encoding === 'base64' ? Buffer.from(raw, 'base64') : Buffer.from(raw, 'utf8');
  } catch {
    bytes = Buffer.alloc(0);
  }
  const totalBytes = Number(body.totalBytes || bytes.length || 0);
  const capped = bytes.length > maxBytes ? bytes.subarray(0, maxBytes) : bytes;
  return {
    contentType: String(body.contentType || ''),
    encoding,
    content: encoding === 'base64' ? capped.toString('base64') : capped.toString('utf8'),
    capturedBytes: capped.length,
    totalBytes,
    truncated: totalBytes > capped.length || bytes.length > capped.length,
    plaintext: true
  };
}

function eventPath(url) {
  try {
    const parsed = new URL(String(url || ''));
    return parsed.pathname + parsed.search;
  } catch {
    return '';
  }
}

function eventHost(url) {
  try {
    return new URL(String(url || '')).hostname;
  } catch {
    return '';
  }
}

class HttpHookServer {
  constructor(options = {}) {
    this.host = '127.0.0.1';
    const requestedPort = options.port === 0 ? 0 : Number(options.port || 8767);
    this.port = requestedPort === 0 ? 0 : Math.max(1, Math.min(65535, requestedPort));
    this.token = String(options.token || randomUUID());
    this.captureMaxBytes = Math.max(1024, Number(options.captureMaxBytes || 16 * 1024 * 1024));
    this.record = typeof options.record === 'function' ? options.record : async () => {};
    this.filterRequest = typeof options.filterRequest === 'function'
      ? options.filterRequest
      : async () => ({ action: 'pass' });
    this.server = null;
    this.sockets = new Set();
    this.connectedClients = 0;
    this.lastEventAt = 0;
    this.lastPreflightAt = 0;
    this.lastError = '';
    this.mutationEnabled = Boolean(options.mutationEnabled);
  }

  async start() {
    if (this.server) return this.address();
    this.server = net.createServer(socket => this.handleSocket(socket));
    await new Promise((resolve, reject) => {
      const onError = error => {
        this.server = null;
        reject(error);
      };
      this.server.once('error', onError);
      this.server.listen(this.port, this.host, () => {
        this.server.off('error', onError);
        resolve();
      });
    });
    return this.address();
  }

  address() {
    const current = this.server && this.server.address();
    return {
      host: this.host,
      port: current && typeof current === 'object' ? current.port : this.port,
      token: this.token
    };
  }

  async stop() {
    const server = this.server;
    this.server = null;
    if (!server) return;
    for (const socket of Array.from(this.sockets)) {
      try { socket.destroy(); } catch {}
    }
    await new Promise(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      try { server.close(finish); } catch { finish(); }
      setTimeout(finish, 750);
    });
    this.sockets.clear();
    this.connectedClients = 0;
  }

  diagnostics() {
    return {
      httpHookRunning: Boolean(this.server),
      httpHookAddress: this.server ? { host: this.address().host, port: this.address().port } : null,
      httpHookConnectedClients: this.connectedClients,
      httpHookLastEventAt: this.lastEventAt,
      httpHookLastPreflightAt: this.lastPreflightAt,
      httpHookMutationEnabled: this.mutationEnabled,
      httpHookLastError: this.lastError
    };
  }

  async writeConfig(codexHome) {
    if (!codexHome) throw new Error('Codex home is required for HTTP hook config.');
    await fs.promises.mkdir(codexHome, { recursive: true });
    const address = this.address();
    const payload = {
      schemaVersion: 1,
      enabled: true,
      host: address.host,
      port: address.port,
      token: this.token,
      mutationEnabled: this.mutationEnabled,
      maxBodyBytes: this.captureMaxBytes
    };
    const target = hookConfigPath(codexHome);
    const temp = target + '.tmp';
    await fs.promises.writeFile(temp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    await fs.promises.rename(temp, target);
    return target;
  }

  async removeConfig(codexHome) {
    if (!codexHome) return;
    await fs.promises.rm(hookConfigPath(codexHome), { force: true }).catch(() => {});
  }

  handleSocket(socket) {
    if (!socket || !socket.remoteAddress || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(socket.remoteAddress))) {
      try { socket.destroy(); } catch {}
      return;
    }
    this.sockets.add(socket);
    this.connectedClients += 1;
    let buffer = '';
    let closed = false;
    const maxLineChars = Math.ceil(this.captureMaxBytes * 1.5) + 2 * 1024 * 1024;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      this.sockets.delete(socket);
      this.connectedClients = Math.max(0, this.connectedClients - 1);
    };

    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > maxLineChars) {
        this.lastError = 'HTTP hook message exceeded configured capture limit.';
        try { socket.destroy(); } catch {}
        return;
      }
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        this.handleLine(line, socket).catch(error => {
          this.lastError = safeError(error);
        });
      }
    });
    socket.on('error', error => {
      this.lastError = safeError(error);
    });
    socket.on('close', cleanup);
    socket.on('end', cleanup);
  }

  async handleLine(line, socket) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || String(message.token || '') !== this.token) {
      if (message && message.type === 'preflight') {
        socket.write(JSON.stringify({ action: 'pass', error: 'unauthorized' }) + '\n');
      }
      return;
    }

    if (message.type === 'preflight') {
      this.lastPreflightAt = Date.now();
      const request = message.request && typeof message.request === 'object' ? message.request : {};
      const observed = this.normalizeEvent({
        phase: 'outbound_preflight',
        direction: 'out',
        requestId: request.requestId,
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: request.body,
        at: Date.now()
      });
      await this.record(observed);
      let decision = { action: 'pass' };
      if (this.mutationEnabled) {
        try {
          decision = await this.filterRequest({
            requestId: String(request.requestId || ''),
            method: String(request.method || ''),
            url: String(request.url || ''),
            headers: request.headers || {},
            body: request.body || null
          }) || decision;
        } catch (error) {
          this.lastError = safeError(error);
          decision = { action: 'pass', error: 'filter-error' };
        }
      }
      socket.write(JSON.stringify(decision) + '\n');
      return;
    }

    if (message.type === 'event') {
      this.lastEventAt = Date.now();
      const event = this.normalizeEvent(message.event || {});
      await this.record(event);
    }
  }

  normalizeEvent(input) {
    const at = Number(input.at || Date.now());
    const url = String(input.url || '');
    const phase = String(input.phase || input.stage || 'event');
    const direction = input.direction === 'in' ? 'in' : input.direction === 'out' ? 'out' : '';
    const capture = bodyCapture(input.body, this.captureMaxBytes);
    return {
      type: 'http_hook',
      stage: phase,
      phase,
      direction,
      at,
      requestId: String(input.requestId || ''),
      method: String(input.method || ''),
      url,
      path: eventPath(url),
      targetHost: eventHost(url),
      statusCode: Number(input.statusCode || 0),
      kind: classifyRequest({ method: String(input.method || ''), path: eventPath(url), upgrade: false }),
      headers: redactHeaders(input.headers || {}),
      hookPlaintext: true,
      hookLogical: Boolean(input.logical),
      hookMutationApplied: Boolean(input.mutationApplied),
      ...(capture ? { contentCapture: capture } : {}),
      ...(input.error ? { error: String(input.error) } : {})
    };
  }
}

module.exports = {
  HttpHookServer,
  hookConfigPath,
  bodyCapture,
  eventPath,
  eventHost
};
