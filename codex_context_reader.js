'use strict';

const fs = require('node:fs/promises');
const { StringDecoder } = require('node:string_decoder');
const { speedFromSettings } = require('./codex_speed');

function emptyReading() {
  return { running: false, turnId: '', model: '', reasoning: '', serviceTier: '', usedTokens: null, windowTokens: null, percent: null };
}
function applyContextEvent(state, item) {
  const p = item?.payload || {};
  if (item.type === 'turn_context' || (item.type === 'event_msg' && p.type === 'thread_settings_applied')) {
    const speed = speedFromSettings(item.type === 'turn_context' ? p : p.thread_settings);
    if (speed !== undefined) state.serviceTier = speed;
  }
  if (item.type === 'turn_context') {
    if (p.model && state.model && state.model !== p.model) state.usedTokens = null;
    state.model = p.model || state.model;
    state.reasoning = p.effort || p.reasoning_effort || state.reasoning;
  }
  if (item.type === 'compacted' || (item.type === 'event_msg' && p.type === 'context_compacted')) state.usedTokens = null;
  if (item.type !== 'event_msg') return;
  if (['task_started', 'turn_started'].includes(p.type)) {
    state.running = true;
    state.turnId = p.turn_id || p.turnId || p.id || '';
    if (Number.isFinite(p.model_context_window) && p.model_context_window > 0) state.windowTokens = p.model_context_window;
  }
  if (['task_complete', 'turn_complete', 'task_aborted', 'turn_aborted', 'task_cancelled', 'turn_cancelled'].includes(p.type)) {
    const id = p.turn_id || p.turnId;
    if (!id || id === state.turnId) state.running = false;
  }
  if (p.type !== 'token_count' || !p.info) return;
  const usage = p.info.last_token_usage;
  const window = p.info.model_context_window;
  if (Number.isFinite(window) && window > 0) state.windowTokens = window;
  // Match Codex's context meter: last.totalTokens / modelContextWindow.
  // total_token_usage and token_usage_record are cumulative billing counters.
  if (usage) {
    const total = usage.total_tokens ?? (Number.isFinite(usage.input_tokens) && Number.isFinite(usage.output_tokens)
      ? usage.input_tokens + usage.output_tokens : null);
    state.usedTokens = Number.isFinite(total) && total >= 0 ? total : null;
  }
}

function createContextReader(options) {
  const cursors = new Map();
  return async function read(entry) {
    let c = cursors.get(entry.threadId);
    const now = Date.now();
    if (!c || now - c.resolvedAt >= 5000) {
      const file = await options.resolveFile(entry);
      if (!file) throw new Error('Chưa tìm thấy rollout của chat.');
      if (!c || c.file !== file) c = { file, offset: 0, pending: '', skipLine: false,
        decoder: new StringDecoder('utf8'), reading: emptyReading(), identity: '', resolvedAt: now };
      c.resolvedAt = now;
      cursors.set(entry.threadId, c);
    }
    const handle = await fs.open(c.file, 'r');
    try {
      const stat = await handle.stat();
      const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
      if (stat.size < c.offset || (c.identity && c.identity !== identity)) {
        c.offset = 0; c.pending = ''; c.skipLine = false; c.decoder = new StringDecoder('utf8'); c.reading = emptyReading();
      }
      c.identity = identity;
      const end = Math.min(stat.size, c.offset + 4 * 1024 * 1024);
      const buffer = Buffer.alloc(64 * 1024);
      while (c.offset < end) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, end - c.offset), c.offset);
        if (!bytesRead) break;
        c.offset += bytesRead;
        const parts = (c.pending + c.decoder.write(buffer.subarray(0, bytesRead))).split('\n');
        c.pending = parts.pop();
        for (const line of parts) {
          if (c.skipLine) { c.skipLine = false; continue; }
          try { applyContextEvent(c.reading, JSON.parse(line)); } catch { /* Ignore torn/malformed records. */ }
        }
        if (c.pending.length > 1024 * 1024) { c.pending = ''; c.skipLine = true; }
      }
      const r = c.reading;
      const caughtUp = c.offset === stat.size && !c.pending.trim();
      return { ...r, file: c.file, caughtUp, checkedAt: now,
        percent: caughtUp && r.usedTokens !== null && r.windowTokens > 0 ? Math.min(100, r.usedTokens / r.windowTokens * 100) : null };
    } finally { await handle.close(); }
  };
}

module.exports = { emptyReading, applyContextEvent, createContextReader };
