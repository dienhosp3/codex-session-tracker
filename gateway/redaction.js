'use strict';

const crypto = require('crypto');

const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|openai-api-key)$/i;
const SAFE_HEADER = /^(content-type|content-length|accept|accept-encoding|user-agent|cache-control)$/i;

function redactHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (SECRET_HEADER.test(key) || /(token|secret|api[-_]?key)/i.test(key)) out[key] = '[REDACTED]';
    else if (SAFE_HEADER.test(key)) out[key] = value;
    else out[key] = '[OMITTED]';
  }
  return out;
}

function sanitizePath(value) {
  const raw = String(value || '/');
  const q = raw.indexOf('?');
  return q >= 0 ? raw.slice(0, q) : raw;
}

function sha256(buffer) {
  const value = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeError(error) {
  if (!error) return '';
  return String(error.code || error.message || error).replace(/[\r\n]+/g, ' ').slice(0, 500);
}

module.exports = { redactHeaders, sanitizePath, sha256, safeError, SECRET_HEADER, SAFE_HEADER };
