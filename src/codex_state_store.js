'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Small shared state files, serialized across extension hosts. Persist decisions
// before side effects so another window/reload cannot replay an uncertain action.
function createStateStore(file, initial = {}, options = {}) {
  const io = options.fsImpl || fs;
  const lockFile = file + '.lock';
  const backupFile = file + '.bak';
  function decode(bytes) {
    try {
      const state = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
      if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Invalid state root');
      return state;
    } catch {
      const error = new Error('File trạng thái ' + path.basename(file) + ' bị hỏng; chưa thể thực hiện thao tác.');
      error.code = 'STATE_FILE_INVALID';
      throw error;
    }
  }
  async function record(target) {
    try { const bytes = await io.readFile(target); return {bytes, state:decode(bytes)}; }
    catch (error) { if (error.code === 'ENOENT') return {bytes:null,state:structuredClone(initial)}; throw error; }
  }
  async function read() {
    return (await record(file)).state;
  }
  async function durableReplace(target, bytes) {
    const temp = target + '.tmp-' + randomUUID();
    let handle;
    try {
      handle = await io.open(temp, 'wx');
      await handle.writeFile(bytes);
      // Closing alone does not flush Windows write caches. Commit only after
      // the complete contents have reached the filesystem.
      await handle.sync();
      await handle.close(); handle = null;
      await io.rename(temp, target);
    } finally {
      if (handle) await handle.close();
      try { await io.unlink(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  async function locked(operation) {
    await io.mkdir(path.dirname(file), { recursive: true });
    const deadline = Date.now() + 5000;
    const owner = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
    let handle;
    while (!handle) {
      try { handle = await io.open(lockFile, 'wx'); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          const content = await io.readFile(lockFile, 'utf8');
          let pid; try { pid = JSON.parse(content).pid; } catch {}
          let dead = false;
          if (Number.isInteger(pid) && pid > 0) {
            try { process.kill(pid, 0); } catch (failure) { dead = failure.code === 'ESRCH'; }
          } else dead = Date.now() - (await io.stat(lockFile)).mtimeMs > 30000;
          if (dead && await io.readFile(lockFile, 'utf8') === content) await io.unlink(lockFile);
        } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
        if (Date.now() >= deadline) throw new Error('Trạng thái đang được cửa sổ khác cập nhật. Hãy thử lại.');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    try {
      await handle.writeFile(owner);
      return await operation();
    } finally {
      await handle.close();
      try { if (await io.readFile(lockFile, 'utf8') === owner) await io.unlink(lockFile); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  async function transaction(update) {
    return locked(async () => {
      const previous = await record(file);
      const result = await update(previous.state);
      const bytes = Buffer.from(JSON.stringify(previous.state), 'utf8');
      decode(bytes);
      if (!previous.bytes || !bytes.equals(previous.bytes)) {
        // One bounded, valid fallback, never replaced with corrupt bytes.
        await durableReplace(backupFile, previous.bytes || bytes);
        await durableReplace(file, bytes);
      }
      return result;
    });
  }
  async function recover(transform) {
    if (typeof transform !== 'function') throw new TypeError('Recovery requires an explicit state policy.');
    return locked(async () => {
      let damaged;
      try {
        damaged = await io.readFile(file);
        return {recovered:false,state:decode(damaged)};
      } catch (error) {
        if (error.code !== 'STATE_FILE_INVALID') throw error;
      }
      let fallback = {bytes:null,state:structuredClone(initial)};
      try { fallback = await record(backupFile); }
      catch (error) { if (error.code !== 'STATE_FILE_INVALID') throw error; }
      const source = fallback.bytes ? 'backup' : 'defaults';
      const state = await transform(fallback.state, {source});
      const bytes = Buffer.from(JSON.stringify(state), 'utf8');
      decode(bytes);
      // Keep the actual damaged file for diagnosis; recovery never silently
      // discards it or replays old account-switch/send decisions.
      await durableReplace(file + '.corrupt', damaged);
      if (!fallback.bytes) await durableReplace(backupFile, bytes);
      await durableReplace(file, bytes);
      return {recovered:true,source,state};
    });
  }
  return { read, transaction, recover };
}

module.exports = { createStateStore };
