'use strict';

const http = require('http');
const net = require('net');
const tls = require('tls');
const { randomUUID } = require('crypto');
const { safeError } = require('./redaction');

function parseAuthority(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('CONNECT target is empty.');
  let host = raw;
  let port = 443;
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end < 0) throw new Error('Invalid CONNECT IPv6 authority.');
    host = raw.slice(1, end);
    if (raw[end + 1] === ':') port = Number(raw.slice(end + 2) || 443);
  } else {
    const lastColon = raw.lastIndexOf(':');
    if (lastColon > 0 && raw.indexOf(':') === lastColon) {
      host = raw.slice(0, lastColon);
      port = Number(raw.slice(lastColon + 1) || 443);
    }
  }
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid CONNECT target.');
  }
  return { host: host.toLowerCase(), port };
}

function rawTunnel(req, clientSocket, head, options = {}) {
  const target = parseAuthority(req.url);
  const connectionId = String(options.connectionId || randomUUID());
  const record = typeof options.record === 'function' ? options.record : async () => {};
  const upstream = net.connect(target.port, target.host);
  let opened = false;

  const closeBoth = () => {
    try { clientSocket.destroy(); } catch {}
    try { upstream.destroy(); } catch {}
  };

  upstream.once('connect', () => {
    opened = true;
    clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: Codex-Session-Tracker\r\n\r\n');
    if (head && head.length) upstream.write(head);
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
    record({
      type: 'connect_tunnel',
      stage: 'TUNNEL_OPEN',
      connectionId,
      at: Date.now(),
      host: target.host,
      port: target.port,
      inspected: false
    }).catch(() => {});
  });

  upstream.on('error', error => {
    record({
      type: 'connect_tunnel',
      stage: 'UPSTREAM_ERROR',
      connectionId,
      at: Date.now(),
      host: target.host,
      port: target.port,
      inspected: false,
      error: safeError(error)
    }).catch(() => {});
    if (!opened) {
      try { clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); } catch {}
    }
    closeBoth();
  });
  clientSocket.on('error', closeBoth);
}

async function interceptConnect(req, clientSocket, head, options = {}) {
  const target = parseAuthority(req.url);
  const connectionId = String(options.connectionId || randomUUID());
  const record = typeof options.record === 'function' ? options.record : async () => {};
  const certificateManager = options.certificateManager;
  const handleHttp = options.handleHttp;
  const handleUpgrade = options.handleUpgrade;

  if (!certificateManager || typeof handleHttp !== 'function') {
    rawTunnel(req, clientSocket, head, { connectionId, record });
    return;
  }

  try {
    const leaf = await certificateManager.tlsOptionsForHost(target.host);
    const innerHttp = http.createServer((innerReq, innerRes) => {
      handleHttp(innerReq, innerRes, target, connectionId);
    });
    innerHttp.on('upgrade', (innerReq, innerSocket, innerHead) => {
      if (typeof handleUpgrade === 'function') {
        handleUpgrade(innerReq, innerSocket, innerHead, target, connectionId);
      } else {
        innerSocket.end('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n');
      }
    });
    innerHttp.on('clientError', (error, socket) => {
      record({
        type: 'mitm_connection',
        stage: 'CLIENT_HTTP_ERROR',
        connectionId,
        at: Date.now(),
        host: target.host,
        port: target.port,
        error: safeError(error)
      }).catch(() => {});
      try { socket.destroy(); } catch {}
    });

    const tlsServer = tls.createServer({
      pfx: leaf.pfx,
      passphrase: leaf.passphrase,
      minVersion: 'TLSv1.2',
      ALPNProtocols: ['http/1.1']
    }, tlsSocket => {
      tlsSocket.on('error', () => {});
      innerHttp.emit('connection', tlsSocket);
    });

    tlsServer.on('tlsClientError', error => {
      record({
        type: 'mitm_connection',
        stage: 'TLS_CLIENT_ERROR',
        connectionId,
        at: Date.now(),
        host: target.host,
        port: target.port,
        error: safeError(error)
      }).catch(() => {});
    });

    clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: Codex-Session-Tracker\r\n\r\n');
    await record({
      type: 'mitm_connection',
      stage: 'CONNECT_ACCEPTED',
      connectionId,
      at: Date.now(),
      host: target.host,
      port: target.port,
      inspected: true
    });

    if (head && head.length) clientSocket.unshift(head);
    tlsServer.emit('connection', clientSocket);
  } catch (error) {
    await record({
      type: 'mitm_connection',
      stage: 'MITM_FALLBACK_TUNNEL',
      connectionId,
      at: Date.now(),
      host: target.host,
      port: target.port,
      inspected: false,
      error: safeError(error)
    });
    rawTunnel(req, clientSocket, head, { connectionId, record });
  }
}

module.exports = {
  parseAuthority,
  rawTunnel,
  interceptConnect
};
