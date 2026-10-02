'use strict';

const zlib = require('zlib');

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
    this.contentEncoding = String(options.contentEncoding || '').toLowerCase().trim();
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

  finish(contentType, contentEncoding) {
    if (contentType !== undefined) this.contentType = String(contentType || '');
    if (contentEncoding !== undefined) this.contentEncoding = String(contentEncoding || '').toLowerCase().trim();
    if (!this.enabled) return null;
    const wireBuffer = Buffer.concat(this.chunks);
    const truncated = this.totalBytes > this.capturedBytes;
    let decodedBuffer = wireBuffer;
    let decoded = false;
    let decodeError = '';
    if (this.contentEncoding && this.contentEncoding !== 'identity' && !truncated) {
      try {
        const limits = { maxOutputLength:this.maxBytes };
        if (this.contentEncoding.includes('gzip')) decodedBuffer = zlib.gunzipSync(wireBuffer,limits);
        else if (this.contentEncoding.includes('deflate')) decodedBuffer = zlib.inflateSync(wireBuffer,limits);
        else if (this.contentEncoding.includes('br')) decodedBuffer = zlib.brotliDecompressSync(wireBuffer,limits);
        else if (this.contentEncoding === 'zstd' && typeof zlib.zstdDecompressSync === 'function') decodedBuffer = zlib.zstdDecompressSync(wireBuffer,limits);
        else throw new Error('unsupported content-encoding ' + this.contentEncoding);
        decoded = true;
      } catch (error) {
        decodedBuffer = wireBuffer;
        decodeError = String(error && error.message || error);
      }
    }
    const text = isTextContentType(this.contentType) && (!this.contentEncoding || this.contentEncoding === 'identity' || decoded)
      && require('buffer').isUtf8(decodedBuffer);
    return {
      contentType: this.contentType,
      wireContentEncoding: this.contentEncoding,
      decoded,
      decodeError,
      encoding: text ? 'utf8' : 'base64',
      content: text ? decodedBuffer.toString('utf8') : decodedBuffer.toString('base64'),
      capturedBytes: this.capturedBytes,
      totalBytes: this.totalBytes,
      decodedBytes: decodedBuffer.length,
      truncated
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
