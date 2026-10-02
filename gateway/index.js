'use strict';

const { randomUUID } = require('crypto');
const { DeliveryState } = require('./state_machine');
const { TraceStore } = require('./trace_store');
const { GatewayServer } = require('./server');
const { observeRolloutEvidence, correlateNetwork } = require('./correlation');

class CodexGateway {
  constructor(options = {}) {
    this.version = String(options.version || 'dev');
    this.trace = new TraceStore({
      dir: options.traceDir,
      maxBytes: options.traceMaxBytes,
      memoryLimit: options.traceMemoryLimit
    });
    this.commands = new Map();
    this.networkFingerprints = new Map();
    this.lastModelNetworkAt = 0;
    this.handlers = options.handlers || {};
    this.server = new GatewayServer({
      port: options.port,
      version: this.version,
      trace: this.trace,
      modelProxyEnabled: Boolean(options.modelProxyEnabled),
      upstreamBaseUrl: options.upstreamBaseUrl,
      captureContent: Boolean(options.captureContent),
      captureMaxBytes: options.captureMaxBytes,
      diagnostics: () => this.diagnostics(),
      onNetworkEvent: event => this.onNetworkEvent(event),
      handlers: {
        steer: body => this.steer(body),
        queue: body => this.queue(body),
        interrupt: body => this.interrupt(body)
      }
    });
  }

  async start() {
    await this.trace.init();
    this.seedFromTrace();
    return this.server.start();
  }

  async stop() {
    return this.server.stop();
  }

  seedFromTrace() {
    this.lastModelNetworkAt = 0;
    this.networkFingerprints.clear();
    for (const event of this.trace.recent(this.trace.memoryLimit)) {
      const isModel = event && (event.kind === 'MODEL_REQUEST' || event.kind === 'MODEL_STREAM');
      if (!isModel) continue;
      this.lastModelNetworkAt = Math.max(this.lastModelNetworkAt, Number(event.at || 0));
      if (event.bodySha256) {
        this.networkFingerprints.set(event.bodySha256, {
          at: Number(event.at || 0),
          requestId: event.requestId || '',
          connectionId: event.connectionId || ''
        });
      }
    }
  }

  createCommand(action, input = {}) {
    const gatewayCommandId = String(input.gatewayCommandId || randomUUID());
    const clientUserMessageId = String(input.clientUserMessageId || randomUUID());
    const createdAt = Date.now();
    const state = new DeliveryState({
      gatewayCommandId,
      clientUserMessageId,
      threadId: input.threadId,
      turnId: input.turnId,
      action,
      createdAt
    });
    state.add('LOCAL_CREATED', { source: 'gateway', confidence: 'authoritative' }, createdAt);
    const command = {
      gatewayCommandId,
      clientUserMessageId,
      threadId: String(input.threadId || ''),
      turnId: String(input.turnId || ''),
      action,
      createdAt,
      state,
      probeMessage: String(input.message || ''),
      rolloutFile: String(input.rolloutFile || '')
    };
    this.commands.set(gatewayCommandId, command);
    this.trace.append({
      type: 'control',
      ...state.events[0],
      action,
      threadId: command.threadId,
      gatewayCommandId,
      clientUserMessageId
    }).catch(() => {});
    return command;
  }

  async progress(command, event) {
    const snapshot = command.state.add(event.stage, event, event.at);
    command.turnId = snapshot.turnId || command.turnId;
    await this.trace.append({
      type: 'control',
      action: command.action,
      gatewayCommandId: command.gatewayCommandId,
      clientUserMessageId: command.clientUserMessageId,
      threadId: command.threadId,
      turnId: command.turnId,
      ...snapshot.events[snapshot.events.length - 1]
    });
    return snapshot;
  }

  async steer(input = {}) {
    const command = this.createCommand('steer', input);
    if (typeof this.handlers.steer !== 'function') {
      const error = new Error('Steer handler unavailable.');
      error.delivery = 'not_sent';
      await this.progress(command, {
        stage: 'NOT_SENT',
        source: 'gateway-control',
        confidence: 'authoritative',
        detail: error.message
      });
      throw error;
    }

    try {
      const result = await this.handlers.steer({
        ...input,
        gatewayCommandId: command.gatewayCommandId,
        clientUserMessageId: command.clientUserMessageId,
        onProgress: event => this.progress(command, event)
      });
      command.turnId = String(result && result.turnId || command.turnId || '');
      if (input.rolloutFile) {
        const evidence = await observeRolloutEvidence(input.rolloutFile, {
          clientUserMessageId: command.clientUserMessageId,
          message: input.message,
          afterMs: command.createdAt
        });
        if (evidence) await this.progress(command, { stage: 'LOCAL_PERSISTED', ...evidence });
      }
      return {
        ...result,
        gatewayCommandId: command.gatewayCommandId,
        clientUserMessageId: command.clientUserMessageId,
        delivery: this.commandSnapshot(command)
      };
    } catch (error) {
      const alreadyTerminal = command.state.snapshot().terminal;
      if (!alreadyTerminal) {
        const stage = error && error.delivery === 'unknown'
          ? 'DELIVERY_UNKNOWN'
          : error && error.delivery === 'not_sent'
            ? 'NOT_SENT'
            : 'REJECTED';
        await this.progress(command, {
          stage,
          source: 'gateway-control',
          confidence: 'authoritative',
          detail: String(error && error.message || error)
        });
      }
      error.gatewayCommandId = command.gatewayCommandId;
      error.clientUserMessageId = command.clientUserMessageId;
      throw error;
    }
  }

  async queue(input = {}) {
    const command = this.createCommand('queue', input);
    if (typeof this.handlers.queue !== 'function') {
      const error = new Error('Queue handler unavailable.');
      await this.progress(command, {
        stage: 'NOT_SENT',
        source: 'codex-queue-cli',
        confidence: 'authoritative',
        detail: error.message
      });
      throw error;
    }

    try {
      const result = await this.handlers.queue({
        ...input,
        gatewayCommandId: command.gatewayCommandId,
        clientUserMessageId: command.clientUserMessageId
      });
      await this.progress(command, {
        stage: 'CORE_ACCEPTED',
        source: 'codex-queue-cli',
        confidence: 'authoritative',
        detail: 'Codex queue command accepted'
      });
      return {
        ...result,
        gatewayCommandId: command.gatewayCommandId,
        clientUserMessageId: command.clientUserMessageId,
        delivery: this.commandSnapshot(command)
      };
    } catch (error) {
      await this.progress(command, {
        stage: error && error.delivery === 'not_sent' ? 'NOT_SENT' : 'REJECTED',
        source: 'codex-queue-cli',
        confidence: 'authoritative',
        detail: String(error && error.message || error)
      });
      throw error;
    }
  }

  async interrupt(input = {}) {
    const command = this.createCommand('interrupt', input);
    if (typeof this.handlers.interrupt !== 'function') {
      await this.progress(command, {
        stage: 'NOT_SENT',
        source: 'gateway-control',
        confidence: 'authoritative',
        detail: 'Interrupt transport is not verified for the installed Extension owner.'
      });
      return {
        gatewayCommandId: command.gatewayCommandId,
        clientUserMessageId: command.clientUserMessageId,
        supported: false,
        delivery: this.commandSnapshot(command)
      };
    }

    try {
      const result = await this.handlers.interrupt({
        ...input,
        gatewayCommandId: command.gatewayCommandId,
        clientUserMessageId: command.clientUserMessageId,
        onProgress: event => this.progress(command, event)
      });
      return {
        ...result,
        gatewayCommandId: command.gatewayCommandId,
        clientUserMessageId: command.clientUserMessageId,
        supported: true,
        delivery: this.commandSnapshot(command)
      };
    } catch (error) {
      const stage = error && error.delivery === 'unknown'
        ? 'DELIVERY_UNKNOWN'
        : error && error.delivery === 'not_sent'
          ? 'NOT_SENT'
          : 'REJECTED';
      await this.progress(command, {
        stage,
        source: 'gateway-control',
        confidence: 'authoritative',
        detail: String(error && error.message || error)
      });
      throw error;
    }
  }

  async refreshLocalPersistence(threadId, rolloutFile) {
    const candidates = Array.from(this.commands.values())
      .filter(command =>
        command.threadId === threadId
        && command.action === 'steer'
        && !command.state.events.some(event => event.stage === 'LOCAL_PERSISTED')
      )
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 5);

    for (const command of candidates) {
      const evidence = await observeRolloutEvidence(rolloutFile || command.rolloutFile, {
        clientUserMessageId: command.clientUserMessageId,
        message: command.probeMessage,
        afterMs: command.createdAt
      });
      if (evidence) await this.progress(command, { stage: 'LOCAL_PERSISTED', ...evidence });
    }
  }

  async onNetworkEvent(event) {
    const isModel = event && (event.kind === 'MODEL_REQUEST' || event.kind === 'MODEL_STREAM');
    if (!isModel) return;

    const at = Number(event.at || Date.now());
    this.lastModelNetworkAt = Math.max(this.lastModelNetworkAt, at);
    const match = correlateNetwork(Array.from(this.commands.values()), event, at);

    if (
      match
      && ['UPSTREAM_REQUEST_OPENED', 'UPSTREAM_BYTES_SENT', 'UPSTREAM_RESPONSE_HEADERS', 'UPSTREAM_FIRST_EVENT'].includes(event.stage)
    ) {
      await this.progress(match.command, {
        stage: event.stage,
        source: 'gateway-model-proxy',
        confidence: match.confidence,
        connectionId: event.connectionId,
        requestId: event.requestId,
        detail: event.kind,
        bodyHash: event.bodySha256 || ''
      });
    }

    if (event.bodySha256) {
      const previous = this.networkFingerprints.get(event.bodySha256);
      if (previous && at - previous.at > 10000 && match) {
        await this.progress(match.command, {
          stage: 'POSSIBLE_REPLAY',
          source: 'gateway-model-proxy',
          confidence: 'heuristic',
          requestId: event.requestId,
          connectionId: event.connectionId,
          bodyHash: event.bodySha256,
          detail: 'same outbound model payload fingerprint observed again after ' + (at - previous.at) + ' ms'
        });
      }
      this.networkFingerprints.set(event.bodySha256, {
        at,
        requestId: event.requestId || '',
        connectionId: event.connectionId || ''
      });
    }
  }

  commandSnapshot(command) {
    const snapshot = command.state.snapshot();
    return { ...snapshot, diagnosis: command.state.diagnose() };
  }

  recentForThread(threadId) {
    return Array.from(this.commands.values())
      .filter(command => command.threadId === threadId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 10)
      .map(command => this.commandSnapshot(command));
  }

  trafficIndex(limit = 80) {
    return this.trace.recent(Math.max(20, Math.min(250, Number(limit || 80))))
      .filter(event => event && ['http_upstream', 'ws_connection', 'ws_frame', 'gateway_error', 'ws_upgrade_rejected'].includes(event.type))
      .map(event => ({
        traceId: event.traceId,
        type: event.type,
        stage: event.stage || '',
        at: event.at || 0,
        kind: event.kind || '',
        method: event.method || '',
        path: event.path || '',
        requestId: event.requestId || '',
        connectionId: event.connectionId || '',
        statusCode: event.statusCode || 0,
        direction: event.direction || '',
        opcode: event.opcode,
        size: event.size || 0,
        requestBytes: event.requestBytes || 0,
        responseBytes: event.responseBytes || 0,
        totalMs: event.totalMs || 0,
        bodySha256: event.bodySha256 || '',
        error: event.error || '',
        hasContent: Boolean(event.contentCapture),
        capturedBytes: event.contentCapture && event.contentCapture.capturedBytes || 0,
        totalContentBytes: event.contentCapture && event.contentCapture.totalBytes || 0,
        truncated: Boolean(event.contentCapture && event.contentCapture.truncated),
        encoding: event.contentCapture && event.contentCapture.encoding || ''
      }));
  }

  payloadByTraceId(traceId, options = {}) {
    const event = this.trace.byTraceId(traceId);
    if (!event) return null;
    const content = event.contentCapture && typeof event.contentCapture.content === 'string'
      ? event.contentCapture.content
      : '';
    const offset = Math.max(0, Number(options.offset || 0));
    const limit = Math.max(4096, Math.min(1024 * 1024, Number(options.limit || 512 * 1024)));
    const chunk = content.slice(offset, offset + limit);
    const nextOffset = offset + chunk.length;
    const capture = event.contentCapture ? {
      ...event.contentCapture,
      content: chunk,
      contentLengthChars: content.length,
      offset,
      nextOffset,
      complete: nextOffset >= content.length
    } : null;

    return {
      traceId: event.traceId,
      type: event.type,
      stage: event.stage || '',
      at: event.at || 0,
      kind: event.kind || '',
      method: event.method || '',
      path: event.path || '',
      requestId: event.requestId || '',
      connectionId: event.connectionId || '',
      direction: event.direction || '',
      opcode: event.opcode,
      statusCode: event.statusCode || 0,
      headers: event.headers || null,
      bodySha256: event.bodySha256 || '',
      contentCapture: capture
    };
  }

  exportSnapshot(extra = {}) {
    const allowed = new Set([
      'type', 'stage', 'at', 'kind', 'method', 'path', 'requestId', 'connectionId',
      'statusCode', 'requestBytes', 'responseBytes', 'totalMs', 'bodySha256',
      'direction', 'opcode', 'size', 'wireBytes', 'oversized', 'error', 'elapsedMs',
      'frameSize', 'confidence', 'source', 'detail', 'classification'
    ]);
    const events = this.trace.recent(2000).map(event => {
      const output = {};
      for (const [key, value] of Object.entries(event || {})) {
        if (allowed.has(key) && value !== undefined) output[key] = value;
      }
      return output;
    });

    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      gatewayVersion: this.version,
      ...extra,
      diagnostics: this.diagnostics(),
      events
    };
  }

  diagnostics() {
    return {
      modelProxyConfigured: this.server.modelProxyEnabled,
      modelProxyReady: Boolean(this.server.modelProxyEnabled && this.server.upstreamBaseUrl),
      modelTrafficObserved: Boolean(this.lastModelNetworkAt),
      lastModelNetworkAt: this.lastModelNetworkAt,
      websocketProxyReady: Boolean(this.server.modelProxyEnabled && this.server.upstreamBaseUrl),
      captureContent: Boolean(this.server.captureContent),
      captureMaxBytes: Number(this.server.captureMaxBytes || 0),
      recentCommands: Array.from(this.commands.values())
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 20)
        .map(command => this.commandSnapshot(command))
    };
  }
}

module.exports = { CodexGateway };
