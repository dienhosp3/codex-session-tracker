'use strict';

const ORDER = [
  'LOCAL_CREATED',
  'IPC_SENT',
  'OWNER_DISCOVERED',
  'OWNER_ROUTED',
  'CORE_ACCEPTED',
  'LOCAL_PERSISTED',
  'UPSTREAM_REQUEST_OPENED',
  'UPSTREAM_BYTES_SENT',
  'UPSTREAM_RESPONSE_HEADERS',
  'UPSTREAM_FIRST_EVENT',
  'CODEX_CONSUMED_RESPONSE',
  'TURN_COMPLETED'
];

const TERMINAL = new Set([
  'NOT_SENT',
  'REJECTED',
  'DELIVERY_UNKNOWN',
  'DISCONNECTED',
  'INTERRUPTED',
  'ERROR'
]);

const DIAGNOSTIC = new Set([
  'LOCAL_STALLED',
  'UPSTREAM_STALLED',
  'POSSIBLE_REPLAY'
]);

function nowMs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : Date.now();
}

function cleanEvidence(value) {
  const input = value && typeof value === 'object' ? value : {};
  const out = {};
  for (const key of ['source','detail','connectionId','requestId','threadId','turnId','clientUserMessageId','gatewayCommandId','ownerClientId','confidence','classification','bodyHash']) {
    if (input[key] !== undefined && input[key] !== null && input[key] !== '') out[key] = input[key];
  }
  return out;
}

class DeliveryState {
  constructor(meta = {}) {
    this.meta = {
      gatewayCommandId: String(meta.gatewayCommandId || ''),
      clientUserMessageId: String(meta.clientUserMessageId || ''),
      threadId: String(meta.threadId || ''),
      turnId: String(meta.turnId || ''),
      action: String(meta.action || ''),
      createdAt: nowMs(meta.createdAt)
    };
    this.events = [];
    this.stage = '';
    this.terminal = '';
  }

  add(stage, evidence = {}, at = Date.now()) {
    const name = String(stage || '').trim();
    if (!name) throw new Error('Gateway delivery stage is required.');
    if (this.terminal && !DIAGNOSTIC.has(name)) return this.snapshot();

    if (ORDER.includes(name)) {
      const currentIndex = ORDER.indexOf(this.stage);
      const nextIndex = ORDER.indexOf(name);
      if (currentIndex < 0 || nextIndex >= currentIndex) this.stage = name;
    } else if (TERMINAL.has(name)) {
      this.terminal = name;
    } else if (!DIAGNOSTIC.has(name)) {
      throw new Error(`Unknown gateway delivery stage ${name}`);
    }

    const safe = cleanEvidence(evidence);
    this.events.push({
      stage: name,
      at: nowMs(at),
      source: String(safe.source || 'gateway'),
      confidence: ['authoritative','correlated','heuristic'].includes(safe.confidence) ? safe.confidence : 'authoritative',
      ...safe,
      observedOutOfOrder: ORDER.includes(name) && ORDER.indexOf(this.stage) > ORDER.indexOf(name)
    });
    if (safe.turnId && !this.meta.turnId) this.meta.turnId = String(safe.turnId);
    return this.snapshot();
  }

  diagnose(now = Date.now(), thresholds = {}) {
    const localMs = Math.max(1000, Number(thresholds.localNoUpstreamMs || 30_000));
    const upstreamMs = Math.max(1000, Number(thresholds.upstreamNoFirstEventMs || 45_000));
    const accepted = this.events.find(e => e.stage === 'CORE_ACCEPTED');
    const upstream = this.events.find(e => e.stage === 'UPSTREAM_REQUEST_OPENED');
    const first = this.events.find(e => e.stage === 'UPSTREAM_FIRST_EVENT');
    if (accepted && !upstream && now - accepted.at >= localMs) {
      return { classification: 'LOCAL_ACCEPTED_NO_UPSTREAM', since: accepted.at, elapsedMs: now - accepted.at };
    }
    if (upstream && !first && now - upstream.at >= upstreamMs) {
      return { classification: 'UPSTREAM_NO_FIRST_BYTE', since: upstream.at, elapsedMs: now - upstream.at };
    }
    return { classification: '', since: 0, elapsedMs: 0 };
  }

  snapshot() {
    return {
      ...this.meta,
      stage: this.stage,
      terminal: this.terminal,
      events: this.events.slice()
    };
  }
}

module.exports = { ORDER, TERMINAL, DIAGNOSTIC, DeliveryState };
