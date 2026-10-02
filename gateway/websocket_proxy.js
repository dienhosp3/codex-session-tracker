'use strict';

const net = require('net');
const tls = require('tls');
const { randomUUID, createHash } = require('crypto');
const { URL } = require('url');
const { classifyRequest } = require('./classifier');
const { redactHeaders, sanitizePath, safeError } = require('./redaction');
const { decodeWebSocketPayload } = require('./content_capture');

const MAX_FRAME_PARSE_BYTES = 64 * 1024 * 1024;

function upstreamTarget(baseUrl, requestUrl) {
  const base = new URL(baseUrl);
  const incoming = new URL(String(requestUrl || '/'), 'http://gateway.invalid');
  const prefix = base.pathname === '/' ? '' : base.pathname.replace(/\/$/, '');
  const incomingPath = incoming.pathname || '/';
  const path = prefix && !(incomingPath === prefix || incomingPath.startsWith(prefix + '/'))
    ? prefix + (incomingPath.startsWith('/') ? incomingPath : '/' + incomingPath)
    : incomingPath;
  return {
    protocol: base.protocol === 'http:' ? 'ws:' : 'wss:',
    host: base.hostname,
    port: Number(base.port || (base.protocol === 'http:' ? 80 : 443)),
    path: path + incoming.search
  };
}

function payloadFingerprint(frame, payloadOffset, payloadLength, masked, maskOffset) {
  if (!payloadLength) return '';
  const hash=createHash('sha256');
  if (!masked) {
    hash.update(frame.subarray(payloadOffset,payloadOffset+payloadLength));
    return hash.digest('hex');
  }
  const key=frame.subarray(maskOffset,maskOffset+4);
  const chunkSize=64*1024;
  for(let start=0;start<payloadLength;start+=chunkSize){
    const size=Math.min(chunkSize,payloadLength-start);
    const decoded=Buffer.allocUnsafe(size);
    const source=frame.subarray(payloadOffset+start,payloadOffset+start+size);
    for(let i=0;i<size;i++)decoded[i]=source[i]^key[(start+i)&3];
    hash.update(decoded);
  }
  return hash.digest('hex');
}

function frameParser(direction, onFrame, options = {}) {
  const captureContent = Boolean(options.captureContent);
  const captureMaxBytes = Math.max(1024, Number(options.captureMaxBytes || 16 * 1024 * 1024));
  let buffer = Buffer.alloc(0);
  let skipping = 0;

  function consumeSkip(chunk) {
    if (!skipping) return chunk;
    const used = Math.min(skipping, chunk.length);
    skipping -= used;
    return chunk.subarray(used);
  }

  return chunk => {
    let next = consumeSkip(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || ''));
    if (!next.length) return;
    buffer = Buffer.concat([buffer, next]);

    while (buffer.length >= 2) {
      const first = buffer[0];
      const second = buffer[1];
      const fin = Boolean(first & 0x80);
      const rsv1 = Boolean(first & 0x40);
      const rsv2 = Boolean(first & 0x20);
      const rsv3 = Boolean(first & 0x10);
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
          onFrame({ direction, fin, opcode, masked, size: Number.MAX_SAFE_INTEGER, oversized: true });
          buffer = Buffer.alloc(0);
          return;
        }
        length = Number(big);
        offset = 10;
      }
      const maskOffset=offset;
      if (masked) offset += 4;
      const payloadOffset=offset;

      const total = offset + length;
      if (length > MAX_FRAME_PARSE_BYTES) {
        onFrame({ direction, fin, opcode, masked, size: length, oversized: true });
        if (buffer.length >= total) {
          buffer = buffer.subarray(total);
          continue;
        }
        skipping = total - buffer.length;
        buffer = Buffer.alloc(0);
        return;
      }
      if (buffer.length < total) return;
      const isDataFrame = opcode === 0 || opcode === 1 || opcode === 2;
      const payloadSha256=isDataFrame&&length
        ? payloadFingerprint(buffer,payloadOffset,length,masked,maskOffset)
        : '';
      let contentCapture = null;
      if (captureContent && isDataFrame) {
        const decoded = decodeWebSocketPayload(buffer,payloadOffset,length,masked,maskOffset,captureMaxBytes);
        const textFrame = opcode === 1 && !rsv1;
        contentCapture = {
          contentType: textFrame ? 'application/json; charset=utf-8' : 'application/octet-stream',
          encoding: textFrame ? 'utf8' : 'base64',
          content: textFrame ? decoded.toString('utf8') : decoded.toString('base64'),
          capturedBytes: decoded.length,
          totalBytes: length,
          truncated: length > decoded.length,
          compressed: rsv1
        };
      }
      onFrame({
        direction, fin, rsv1, rsv2, rsv3, opcode, masked, size: length, wireBytes: total,
        ...(payloadSha256?{bodySha256:payloadSha256}:{}),
        ...(contentCapture?{contentCapture}:{})
      });
      buffer = buffer.subarray(total);
    }
  };
}

function requestLines(req, target) {
  const headers = { ...req.headers, host: target.port === 443 || target.port === 80 ? target.host : target.host + ':' + target.port };
  delete headers['proxy-connection'];
  const lines = [`GET ${target.path} HTTP/1.1`];
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) lines.push(`${key}: ${item}`);
    } else lines.push(`${key}: ${value}`);
  }
  return lines.join('\r\n') + '\r\n\r\n';
}

function proxyWebSocket(req, clientSocket, head, options = {}) {
  const baseUrl = String(options.upstreamBaseUrl || '').trim();
  if (!baseUrl) {
    clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    return;
  }
  const target = upstreamTarget(baseUrl, req.url);
  const captureContent = Boolean(options.captureContent);
  const captureMaxBytes = Math.max(1024, Number(options.captureMaxBytes || 16 * 1024 * 1024));
  const connectionId = randomUUID();
  const record = typeof options.record === 'function' ? options.record : async () => {};
  const kind = classifyRequest({ method: req.method, path: req.url, upgrade: true });
  const openedAt = Date.now();

  const socketOptions = { host: target.host, port: target.port };
  if (target.protocol === 'wss:') socketOptions.servername = target.host;
  const upstream = target.protocol === 'wss:' ? tls.connect(socketOptions) : net.connect(socketOptions);
  let handshake = Buffer.alloc(0);
  let upgraded = false;
  let firstOutbound = true;
  let firstInbound = true;
  clientSocket.pause();

  const closeBoth = () => {
    try { clientSocket.destroy(); } catch {}
    try { upstream.destroy(); } catch {}
  };

  const outboundFrames = frameParser('out', frame => {
    record({ type: 'ws_frame', connectionId, kind, at: Date.now(), ...frame }).catch(()=>{});
    if (firstOutbound) {
      firstOutbound = false;
      record({ type:'ws_connection', stage:'UPSTREAM_BYTES_SENT', connectionId, kind, at:Date.now(), frameSize:frame.size, ...(frame.bodySha256?{bodySha256:frame.bodySha256}:{}) }).catch(()=>{});
    }
  }, { captureContent, captureMaxBytes });
  const inboundFrames = frameParser('in', frame => {
    record({ type: 'ws_frame', connectionId, kind, at: Date.now(), ...frame }).catch(()=>{});
    if (firstInbound) {
      firstInbound = false;
      record({ type:'ws_connection', stage:'UPSTREAM_FIRST_EVENT', connectionId, kind, at:Date.now(), frameSize:frame.size }).catch(()=>{});
    }
  }, { captureContent, captureMaxBytes });

  const sendHandshake = async () => {
    await record({
      type: 'ws_connection',
      stage: 'UPSTREAM_REQUEST_OPENED',
      connectionId,
      kind,
      at: Date.now(),
      path: sanitizePath(req.url),
      headers: redactHeaders(req.headers)
    });
    upstream.write(requestLines(req, target));
  };
  if (target.protocol === 'wss:') upstream.once('secureConnect', sendHandshake);
  else upstream.once('connect', sendHandshake);

  upstream.on('data', async chunk => {
    if (!upgraded) {
      handshake = Buffer.concat([handshake, chunk]);
      if (handshake.length > 1024 * 1024) {
        await record({ type:'ws_connection', stage:'UPSTREAM_ERROR', connectionId, kind, at:Date.now(), error:'oversized websocket handshake' });
        closeBoth();
        return;
      }
      const marker = handshake.indexOf('\r\n\r\n');
      if (marker < 0) return;
      const responseHead = handshake.subarray(0, marker + 4);
      const rest = handshake.subarray(marker + 4);
      const statusLine = responseHead.toString('latin1').split('\r\n')[0] || '';
      upgraded = /^HTTP\/1\.[01] 101\b/.test(statusLine);
      clientSocket.write(responseHead);
      await record({
        type:'ws_connection',
        stage: upgraded ? 'UPSTREAM_RESPONSE_HEADERS' : 'UPSTREAM_ERROR',
        connectionId,
        kind,
        at:Date.now(),
        statusLine: statusLine.slice(0,160)
      });
      if (!upgraded) {
        if (rest.length) clientSocket.write(rest);
        closeBoth();
        return;
      }
      if (head && head.length) {
        outboundFrames(head);
        upstream.write(head);
      }
      if (rest.length) {
        inboundFrames(rest);
        clientSocket.write(rest);
      }
      clientSocket.on('data', data => {
        outboundFrames(data);
        upstream.write(data);
      });
      clientSocket.resume();
      handshake = Buffer.alloc(0);
      return;
    }
    inboundFrames(chunk);
    clientSocket.write(chunk);
  });

  upstream.on('error', async error => {
    await record({ type:'ws_connection', stage:'UPSTREAM_ERROR', connectionId, kind, at:Date.now(), error:safeError(error) });
    closeBoth();
  });
  clientSocket.on('error', closeBoth);
  clientSocket.on('close', () => {
    record({ type:'ws_connection', stage:'DISCONNECTED', connectionId, kind, at:Date.now(), elapsedMs:Date.now()-openedAt }).catch(()=>{});
    try { upstream.end(); } catch {}
  });
  upstream.on('close', () => {
    try { clientSocket.end(); } catch {}
  });
}

module.exports = { proxyWebSocket, frameParser, upstreamTarget };
