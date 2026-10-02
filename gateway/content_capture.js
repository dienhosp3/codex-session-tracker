'use strict';

function isTextContentType(value) {
  const contentType = String(value || '').toLowerCase();
  return !contentType
    || contentType.includes('json')
    || contentType.startsWith('text/')
    || contentType.includes('javascript')
    || contentType.includes('xml')
    || contentType.includes('event-stream')
    || contentType.includes('x-www-form-urlencoded');
}

class ContentCapture {
  constructor(options = {}) {
    this.enabled = Boolean(options.enabled);
    this.maxBytes = Math.max(1, Number(options.maxBytes || 16 * 1024 * 1024));
    this.contentType = String(options.contentType || '');
    this.totalBytes = 0;
    this.capturedBytes = 0;
    this.chunks = [];
  }

  add(chunk) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || '');
    this.totalBytes += value.length;
    if (!this.enabled || this.capturedBytes >= this.maxBytes || !value.length) return;
    const remaining = this.maxBytes - this.capturedBytes;
    const slice = value.length > remaining ? value.subarray(0, remaining) : value;
    this.chunks.push(Buffer.from(slice));
    this.capturedBytes += slice.length;
  }

  finish(contentType) {
    if (contentType !== undefined) this.contentType = String(contentType || '');
    if (!this.enabled) return null;
    const buffer = Buffer.concat(this.chunks);
    const text = isTextContentType(this.contentType);
    return {
      contentType: this.contentType,
      encoding: text ? 'utf8' : 'base64',
      content: text ? buffer.toString('utf8') : buffer.toString('base64'),
      capturedBytes: this.capturedBytes,
      totalBytes: this.totalBytes,
      truncated: this.totalBytes > this.capturedBytes
    };
  }
}

function decodeWebSocketPayload(frame, payloadOffset, payloadLength, masked, maskOffset, maxBytes) {
  const limit = Math.max(0, Math.min(Number(maxBytes || payloadLength), payloadLength));
  if (!limit) return Buffer.alloc(0);
  if (!masked) return Buffer.from(frame.subarray(payloadOffset, payloadOffset + limit));
  const key = frame.subarray(maskOffset, maskOffset + 4);
  const decoded = Buffer.allocUnsafe(limit);
  const source = frame.subarray(payloadOffset, payloadOffset + limit);
  for (let i = 0; i < limit; i++) decoded[i] = source[i] ^ key[i & 3];
  return decoded;
}

module.exports = { ContentCapture, isTextContentType, decodeWebSocketPayload };
