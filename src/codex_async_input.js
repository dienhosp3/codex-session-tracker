'use strict';

const fs = require('node:fs');
const TOOL = 'request_user_input_async';
const OPEN = '<send_user_message_question_reply>';
const CLOSE = '</send_user_message_question_reply>';

function createInputState() {
  return { questions: new Map(), running: false };
}
function parse(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}
function questionId(value) {
  const parts = parse(value);
  return Array.isArray(parts) && parts.length === 3 && parts[0] === TOOL &&
    typeof parts[1] === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(parts[1]) &&
    Number.isSafeInteger(parts[2]) && parts[2] >= 0 ? JSON.stringify(parts) : '';
}
function consumeReply(state, text) {
  // Codex can prepend editor context before this native message delimiter.
  const separator = '\n## My request:\n';
  text = text.slice(text.lastIndexOf(separator) < 0 ? 0 : text.lastIndexOf(separator) + separator.length).trim();
  if (!text.startsWith(OPEN) || !text.endsWith(CLOSE)) return false;
  const reply = parse(text.slice(OPEN.length, -CLOSE.length).trim());
  for (const answer of Array.isArray(reply) ? reply : reply ? [reply] : []) {
    if (typeof answer?.answer === 'string') state.questions.delete(questionId(answer.questionItemId));
  }
  return true;
}
function consumeInputRecord(state, record) {
  const p = record?.payload;
  if (!p) return;
  if (record.type === 'event_msg') {
    if (p.type === 'user_message' && typeof p.message === 'string') consumeReply(state, p.message);
    if (p.type === 'task_started') { state.questions.clear(); state.running = true; }
    if (['task_complete', 'turn_complete'].includes(p.type)) state.running = false;
    if (['turn_aborted', 'task_aborted'].includes(p.type)) { state.questions.clear(); state.running = false; }
    return;
  }
  if (record.type !== 'response_item') return;
  if (p.type === 'function_call' && p.name === TOOL && typeof p.call_id === 'string') {
    const args = parse(p.arguments);
    if (!Array.isArray(args?.questions)) return;
    args.questions.forEach((question, index) => {
      if (typeof question?.title !== 'string' || !question.title.trim()) return;
      const id = JSON.stringify([TOOL, p.call_id, index]);
      // IDs only: question text need not be retained in the tracker.
      state.questions.set(id, p.call_id);
    });
  } else if (p.type === 'function_call_output') {
    const output = parse(p.output);
    // accepted:true means the prompt was displayed, NOT answered.
    if (output?.accepted === false || output?.error || output?.isError === true) {
      for (const [id, callId] of state.questions) if (callId === p.call_id) state.questions.delete(id);
    }
  } else if (p.type === 'message' && p.role === 'user') {
    const text = (p.content || []).filter(c => c.type === 'input_text' || c.type === 'text').map(c => c.text || '').join('\n').trim();
    if (!consumeReply(state, text) && !state.running && !record.metadata?.is_user_system_message) {
      state.questions.clear();
    }
  }
}

// Poll only bytes appended since the previous read. A partial UTF-8/JSON line
// stays at its original byte offset until its newline has arrived.
function createAsyncInputReader(options = {}) {
  const cache = new Map();
  // Skip/close is local UI state: Codex does not append an empty reply for it.
  // Persist exact IDs so a refresh/reload cannot resurrect a dismissed question.
  const resolved = new Map();
  for (const entry of Array.isArray(options.resolved) ? options.resolved : []) {
    if (Array.isArray(entry) && /^[A-Za-z0-9_-]{1,200}$/.test(entry[0]) && questionId(entry[1])) {
      resolved.set(JSON.stringify([entry[0], questionId(entry[1])]), [entry[0], questionId(entry[1])]);
    }
  }
  let saving = Promise.resolve();
  async function pending(file) {
    const handle = await fs.promises.open(file, 'r');
    try {
      const stat = await handle.stat(), identity = [stat.dev, stat.ino, stat.birthtimeMs].join(':');
      let entry = cache.get(file);
      if (!entry || entry.identity !== identity || stat.size < entry.offset ||
          stat.size === entry.size && stat.mtimeMs !== entry.mtimeMs) {
        entry = { identity, offset: 0, ...createInputState() };
      }
      const buffer = Buffer.alloc(64 * 1024);
      let position = entry.offset, fragments = [], length = 0;
      while (position < stat.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - position), position);
        if (!bytesRead) break;
        let start = 0;
        while (start < bytesRead) {
          const newline = buffer.indexOf(10, start);
          const end = newline >= 0 && newline < bytesRead ? newline + 1 : bytesRead;
          const fragment = Buffer.from(buffer.subarray(start, end));
          fragments.push(fragment); length += fragment.length;
          if (newline >= 0 && newline < bytesRead) {
            const record = parse(Buffer.concat(fragments, length).toString('utf8'));
            if (record) consumeInputRecord(entry, record);
            entry.offset = position + end;
            fragments = []; length = 0;
          }
          start = end;
        }
        position += bytesRead;
      }
      entry.size = stat.size; entry.mtimeMs = stat.mtimeMs;
      cache.set(file, entry);
      return [...entry.questions.keys()];
    } finally { await handle.close(); }
  }
  return {
    resolve(threadId, ids) {
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(threadId || '') || !Array.isArray(ids)) return;
      let changed = false;
      for (const value of ids) {
        const id = questionId(value), key = JSON.stringify([threadId, id]);
        if (!id || resolved.has(key)) continue;
        resolved.set(key, [threadId, id]); changed = true;
      }
      if (!changed) return;
      const snapshot = [...resolved.values()];
      saving = saving.then(() => options.save?.(snapshot)).catch(error => options.onError?.(error));
      options.onChange?.({ threadId, ids: ids.map(questionId).filter(Boolean) });
      return saving;
    },
    async read(threads) {
      const files = new Set(threads.map(t => t.path).filter(Boolean));
      for (const file of cache.keys()) if (!files.has(file)) cache.delete(file);
      return Promise.all(threads.map(async thread => {
        if (!thread.path || thread.parentThreadId || thread.source?.subAgent || thread.source?.sub_agent) return thread;
        let pendingInputIds;
        try { pendingInputIds = await pending(thread.path); }
        catch (error) {
          options.onError?.(error);
          pendingInputIds = [...cache.get(thread.path)?.questions.keys() || []];
        }
        return { ...thread, pendingInputIds: pendingInputIds.filter(id => !resolved.has(JSON.stringify([thread.id, id]))) };
      }));
    },
    dispose() { cache.clear(); }
  };
}

module.exports = { createInputState, consumeInputRecord, createAsyncInputReader, questionId };
