'use strict';

const net = require('net');
const { randomUUID } = require('crypto');
const { safeError } = require('./redaction');

function parseAuthority(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('CONNECT target is empty.');
  let host = raw;
  let port = 443;
  const lastColon = raw.lastIndexOf(':');
  if (lastColon > 0 && raw.indexOf(':') === lastColon) {
    host = raw.slice(0, lastColon);
    port = Number(raw.slice(lastColon + 1) || 443);
  }
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid CONNECT target.');
  }
  return { host: host.toLowerCase(), port };
}

function tunnelConnect(req, clientSocket, head, options = {}) {
  const target = parseAuthority(req.url);
  const connectionId = String(options.connectionId || randomUUID());
  const record = typeof options.record === 'function' ? options.record : async () => {};
  const startedAt = Date.now();
  const upstream = net.connect(target.port, target.host);

  let clientToServerBytes = 0;
  let serverToClientBytes = 0;
  let pendingOut = 0;
  let pendingIn = 0;
  let flushTimer = null;
  let opened = false;
  let clientClosed = false;
  let upstreamClosed = false;
  let summaryRecorded = false;
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });

  const flushTraffic = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    const at = Date.now();
    if (pendingOut) {
      const size = pendingOut;
      pendingOut = 0;
      record({
        type: 'tunnel_bytes',
        direction: 'out',
        connectionId,
        at,
        targetHost: target.host,
        targetPort: target.port,
        size
      }).catch(() => {});
    }
    if (pendingIn) {
      const size = pendingIn;
      pendingIn = 0;
      record({
        type: 'tunnel_bytes',
        direction: 'in',
        connectionId,
        at,
        targetHost: target.host,
        targetPort: target.port,
        size
      }).catch(() => {});
    }
  };

  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(flushTraffic, 100);
    if (flushTimer && typeof flushTimer.unref === 'function') flushTimer.unref();
  };

  const recordSummary = reason => {
    if (summaryRecorded) return;
    summaryRecorded = true;
    flushTraffic();
    record({
      type: 'connect_tunnel',
      stage: 'TUNNEL_CLOSED',
      connectionId,
      at: Date.now(),
      targetHost: target.host,
      targetPort: target.port,
      inspected: false,
      closeReason: reason || '',
      clientToServerBytes,
      serverToClientBytes,
      totalMs: Date.now() - startedAt
    }).catch(() => {});
  };

  const maybeDone = reason => {
    if (!clientClosed || !upstreamClosed) return;
    recordSummary(reason);
    resolveDone();
  };

  const close = reason => {
    recordSummary(reason || 'forced');
    try { clientSocket.destroy(); } catch {}
    try { upstream.destroy(); } catch {}
  };

  upstream.once('connect', () => {
    opened = true;
    clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: Codex-Session-Tracker\r\n\r\n');

    record({
      type: 'connect_tunnel',
      stage: 'TUNNEL_OPEN',
      connectionId,
      at: Date.now(),
      targetHost: target.host,
      targetPort: target.port,
      inspected: false
    }).catch(() => {});

    if (head && head.length) {
      clientToServerBytes += head.length;
      pendingOut += head.length;
      upstream.write(head);
      scheduleFlush();
    }

    clientSocket.on('data', chunk => {
      clientToServerBytes += chunk.length;
      pendingOut += chunk.length;
      scheduleFlush();
      if (!upstream.write(chunk)) clientSocket.pause();
    });

    upstream.on('drain', () => clientSocket.resume());

    upstream.on('data', chunk => {
      serverToClientBytes += chunk.length;
      pendingIn += chunk.length;
      scheduleFlush();
      if (!clientSocket.write(chunk)) upstream.pause();
    });

    clientSocket.on('drain', () => upstream.resume());
  });

  upstream.on('error', error => {
    record({
      type: 'connect_tunnel',
      stage: 'UPSTREAM_ERROR',
      connectionId,
      at: Date.now(),
      targetHost: target.host,
      targetPort: target.port,
      inspected: false,
      error: safeError(error)
    }).catch(() => {});
    if (!opened) {
      try { clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); } catch {}
    }
    close('upstream-error');
  });

  clientSocket.on('error', () => close('client-error'));

  clientSocket.on('close', () => {
    clientClosed = true;
    try {
      if (!upstream.destroyed) upstream.destroy();
    } catch {}
    maybeDone('client-closed');
  });

  upstream.on('close', () => {
    upstreamClosed = true;
    try {
      if (!clientSocket.destroyed) clientSocket.destroy();
    } catch {}
    maybeDone('upstream-closed');
  });

  return {
    connectionId,
    target,
    close,
    done
  };
}

module.exports = { parseAuthority, tunnelConnect };
