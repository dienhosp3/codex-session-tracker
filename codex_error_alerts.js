'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { playErrorSound } = require('./codex_error_sound');

const HISTORY_FILE = 'codex-retry-errors.jsonl';
const CHUNK_BYTES = 64 * 1024;
const MAX_RECORD_BYTES = 512 * 1024;
const RETRY_MESSAGE = 'exceeded retry limit, last status: 429 Too Many Requests';

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function retryLimitError(item) {
  if (!item || item.type !== 'event_msg') return null;
  const payload = item.payload;
  if (!payload || !['task_complete', 'turn_complete'].includes(payload.type)) return null;
  const error = payload.error;
  if (!error) return null;
  const message = typeof error === 'string' ? error : String(error.message || '');
  const status = error.codex_error_info?.response_too_many_failed_attempts?.http_status_code;
  const exactMessage = /^exceeded retry limit,\s*last status:\s*429 Too Many Requests\s*$/i.test(message);
  if (status !== 429 && !exactMessage) return null;
  const at = Date.parse(item.timestamp);
  return {
    eventType: payload.type,
    turnId: String(payload.turn_id || ''),
    occurredAt: Number.isFinite(at) ? new Date(at).toISOString() : '',
    httpStatus: 429,
    code: 'response_too_many_failed_attempts',
    message: message.slice(0, 2000) || RETRY_MESSAGE
  };
}

async function lockHistory(file) {
  const lock = file + '.lock';
  const deadline = Date.now() + 2500;
  while (true) {
    try {
      const handle = await fs.promises.open(lock, 'wx');
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      } catch (error) {
        await handle.close();
        await fs.promises.unlink(lock).catch(() => {});
        throw error;
      }
      return async () => {
        await handle.close();
        await fs.promises.unlink(lock);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const stat = await fs.promises.stat(lock);
        if (Date.now() - stat.mtimeMs > 30000) {
          const content = await fs.promises.readFile(lock, 'utf8');
          let owner;
          try { owner = JSON.parse(content); } catch {}
          let alive = false;
          if (Number.isInteger(owner?.pid) && owner.pid > 0) {
            try {
              process.kill(owner.pid, 0);
              alive = true;
            } catch (failure) { alive = failure.code !== 'ESRCH'; }
          }
          if (!alive && await fs.promises.readFile(lock, 'utf8') === content) {
            await fs.promises.unlink(lock);
            continue;
          }
        }
      } catch (failure) {
        if (failure.code === 'ENOENT') continue;
      }
      if (Date.now() >= deadline) throw new Error('Codex error history is busy in another window.');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}

function createErrorHistory(directory) {
  const file = path.join(directory, HISTORY_FILE);
  let queue = Promise.resolve();

  function append(event) {
    const operation = queue.then(async () => {
      await fs.promises.mkdir(directory, { recursive: true });
      const release = await lockHistory(file);
      try {
        let content = '';
        try { content = await fs.promises.readFile(file, 'utf8'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        for (const line of content.split(/\r?\n/)) {
          try { if (JSON.parse(line).id === event.id) return false; } catch {}
        }
        const separator = content && !content.endsWith('\n') ? '\n' : '';
        await fs.promises.appendFile(file, separator + JSON.stringify(event) + '\n', 'utf8');
        return true;
      } finally {
        await release();
      }
    });
    queue = operation.catch(() => {});
    return operation;
  }

  return {
    file,
    append,
    async ensureFile() {
      await queue;
      await fs.promises.mkdir(directory, { recursive: true });
      const handle = await fs.promises.open(file, 'a');
      await handle.close();
      return file;
    }
  };
}

function createRetryLimitMonitor(options) {
  const startedAt = (options.now || Date.now)();
  const now = options.now || Date.now;
  const files = new Map();
  for (const [key, value] of Object.entries(options.state?.files || {})) {
    if (value && Number.isSafeInteger(value.offset) && value.offset >= 0) {
      files.set(key, { offset: value.offset, identity: String(value.identity || '') });
    }
  }
  const pendingSounds = Array.isArray(options.state?.pendingSounds)
    ? options.state.pendingSounds.filter(event => event && typeof event.id === 'string' && event.httpStatus === 429)
    : [];
  let initialized = false;
  let disposed = false;
  let polling = null;
  let dirty = false;
  let lastError = '';

  function report(error) {
    const message = error?.message || String(error);
    if (message !== lastError) options.onError?.(error);
    lastError = message;
  }

  async function persist() {
    if (!dirty || disposed) return;
    try {
      await options.save({
        schemaVersion: 1,
        files: Object.fromEntries([...files].map(([key, cursor]) => [key, { ...cursor }])),
        pendingSounds: pendingSounds.map(event => ({ ...event }))
      });
      dirty = false;
    } catch (error) { report(error); }
  }

  async function consume(file, cursor, historical) {
    const handle = await fs.promises.open(file.file, 'r');
    try {
      const stat = await handle.stat();
      const identity = [stat.dev, stat.ino, stat.birthtimeMs].join(':');
      if (cursor.offset > stat.size || (cursor.identity && cursor.identity !== identity)) cursor.offset = 0;
      if (cursor.identity !== identity) dirty = true;
      cursor.identity = identity;
      const chunk = Buffer.alloc(CHUNK_BYTES);
      let position = cursor.offset;
      let lineStart = position;
      let fragments = [];
      let length = 0;
      let oversized = false;
      let description;
      while (position < stat.size && !disposed) {
        const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, stat.size - position), position);
        if (!bytesRead) break;
        let start = 0;
        while (start < bytesRead && !disposed) {
          const newline = chunk.indexOf(10, start);
          const end = newline >= 0 && newline < bytesRead ? newline + 1 : bytesRead;
          const fragment = chunk.subarray(start, end);
          length += fragment.length;
          if (!oversized && length <= MAX_RECORD_BYTES) fragments.push(Buffer.from(fragment));
          else {
            oversized = true;
            fragments = [];
          }
          if (newline >= 0 && newline < bytesRead) {
            if (!oversized) {
              const text = Buffer.concat(fragments, length).toString('utf8');
              if (text.includes('response_too_many_failed_attempts') || /exceeded retry limit/i.test(text)) {
                let item;
                try { item = JSON.parse(text); } catch {}
                const failure = retryLimitError(item);
                if (failure) {
                  if (!description) description = await options.describe(file);
                  const threadId = String(description?.threadId || file.fileThreadId || '');
                  const id = digest(JSON.stringify([threadId, failure.turnId, failure.occurredAt || [digest(file.file), lineStart], failure.code]));
                  const eventAt = Date.parse(failure.occurredAt);
                  const isNew = !historical || (Number.isFinite(eventAt) && eventAt >= startedAt);
                  const event = {
                    id,
                    ...failure,
                    detectedAt: new Date(now()).toISOString(),
                    threadId,
                    title: String(description?.title || 'Codex chat'),
                    historical: !isNew
                  };
                  if (await options.history.append(event)) {
                    if (isNew) {
                      pendingSounds.push(event);
                      dirty = true;
                    }
                    options.onEvent?.(event);
                  }
                }
              }
            }
            cursor.offset = position + end;
            lineStart = cursor.offset;
            dirty = true;
            fragments = [];
            length = 0;
            oversized = false;
          }
          start = end;
        }
        position += bytesRead;
      }
    } finally {
      await handle.close();
    }
  }

  async function scan(sessionsDir) {
    const rollouts = await options.listFiles(sessionsDir);
    for (const file of rollouts) {
      if (disposed) break;
      const key = digest(file.file);
      const known = files.has(key);
      const cursor = files.get(key) || { offset: 0, identity: '' };
      files.set(key, cursor);
      try {
        await consume(file, cursor, !initialized || !known);
      } catch (error) {
        if (error.code !== 'ENOENT') report(error);
      }
    }
    initialized = true;
    await persist();
    while (pendingSounds.length && !disposed) {
      try {
        const notify = options.notify || (() => playErrorSound({ file: options.soundFile }));
        await notify(pendingSounds[0]);
        pendingSounds.shift();
        dirty = true;
      } catch (error) {
        report(error);
        break;
      }
    }
    await persist();
  }

  return {
    poll(sessionsDir) {
      if (disposed) return Promise.resolve();
      if (polling) return polling;
      polling = scan(sessionsDir).catch(report).finally(() => { polling = null; });
      return polling;
    },
    dispose() { disposed = true; },
    snapshot() { return { pendingSounds: pendingSounds.length, error: lastError }; }
  };
}

module.exports = { HISTORY_FILE, retryLimitError, createErrorHistory, createRetryLimitMonitor };
