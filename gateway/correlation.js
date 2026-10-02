'use strict';

const fs = require('fs');
const crypto = require('crypto');

function textHash(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

async function tailText(file, maxBytes = 8 * 1024 * 1024) {
  const stat = await fs.promises.stat(file);
  const start = Math.max(0, stat.size - maxBytes);
  const handle = await fs.promises.open(file, 'r');
  try {
    const buffer = Buffer.alloc(stat.size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

function containsText(value, target) {
  if (!target || value == null) return false;
  if (typeof value === 'string') return value.includes(target);
  if (Array.isArray(value)) return value.some(item => containsText(item, target));
  if (typeof value === 'object') return Object.values(value).some(item => containsText(item, target));
  return false;
}

async function observeRolloutEvidence(file, options = {}) {
  if (!file) return null;
  const clientUserMessageId = String(options.clientUserMessageId || '').trim();
  const message = String(options.message || '').trim();
  const afterMs = Math.max(0, Number(options.afterMs || 0));
  let text;
  try { text = await tailText(file, options.maxBytes); }
  catch { return null; }

  if (clientUserMessageId && text.includes(clientUserMessageId)) {
    return {
      source: 'rollout',
      confidence: 'authoritative',
      detail: 'clientUserMessageId observed in rollout',
      clientUserMessageId
    };
  }
  if (message) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let item;
      try { item = JSON.parse(line); } catch { continue; }
      const at = Date.parse(item && item.timestamp || '') || 0;
      if (afterMs && (!at || at < afterMs - 5000)) continue;
      if (containsText(item, message)) {
        return {
          source: 'rollout',
          confidence: 'correlated',
          detail: 'message content observed in a recent rollout event',
          bodyHash: textHash(message)
        };
      }
    }
  }
  return null;
}

function correlateNetwork(commands, request = {}, now = Date.now()) {
  const list = Array.from(commands || []).filter(Boolean);
  const active = list
    .filter(item => item.action === 'steer' && !(item.state && item.state.terminal) && (!request.threadId||item.threadId===request.threadId))
    .sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
  const exactTurn = String(request.turnId || '').trim();
  if (exactTurn) {
    const found = active.find(item => item.turnId === exactTurn);
    if (found) return { command: found, confidence: 'authoritative', reason: 'turnId' };
  }
  const found = active.find(item => now - Number(item.createdAt || 0) <= 120000);
  return found ? { command: found, confidence: 'heuristic', reason: 'active steer timing window' } : null;
}

module.exports = { observeRolloutEvidence, correlateNetwork, textHash, containsText };
