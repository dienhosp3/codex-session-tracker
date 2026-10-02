'use strict';

function classifyRequest({ method = '', path = '', upgrade = false } = {}) {
  const m = String(method || '').toUpperCase();
  const p = String(path || '').split('?')[0].toLowerCase();
  if (p.startsWith('/health') || p.startsWith('/control/') || p.startsWith('/diagnostics')) return 'CONTROL';
  if (/(?:\/backend-api)?\/codex\/responses(?:\/|$)/.test(p) || /^\/v1\/responses(?:\/|$)/.test(p)) {
    return upgrade ? 'MODEL_STREAM' : 'MODEL_REQUEST';
  }
  if (/auth|oauth|token|session/.test(p)) return 'AUTH';
  if (/models|model_config|model-metadata/.test(p)) return 'MODEL_METADATA';
  if (/thread|conversation|history|sync/.test(p)) return 'THREAD_SYNC';
  if (/telemetry|sentry|metrics|analytics/.test(p)) return 'TELEMETRY';
  return 'UNKNOWN';
}

module.exports = { classifyRequest };
