'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { validateContextConfig } = require('./codex_new_chat');
const ID = /^[A-Za-z0-9_-]{1,200}$/;
const hooks = new WeakMap();
let configuredStore;

function createChatContextStore(directory) {
  const filename = id => {
    if (!ID.test(id)) throw new Error('ID chat context không hợp lệ.');
    return path.join(directory, id + '.json');
  };
  return {
    get(id) {
      if (!ID.test(id)) return undefined;
      let text;
      try { text = fs.readFileSync(filename(id), 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
      const record = JSON.parse(text);
      if (record.threadId !== id) throw new Error('Bản lưu context không khớp ID chat.');
      return validateContextConfig(record.config);
    },
    async remember(id, value) {
      const config = validateContextConfig(value), file = filename(id);
      if (!config) return;
      await fs.promises.mkdir(directory, { recursive: true });
      const temporary = file + '.' + randomUUID() + '.tmp';
      try {
        await fs.promises.writeFile(temporary, JSON.stringify({ schemaVersion: 1, threadId: id, config }) + '\n', { flag: 'wx' });
        await fs.promises.rename(temporary, file);
      } finally { await fs.promises.rm(temporary, { force: true }); }
    }
  };
}

function configureChatContextStore(directory) {
  configuredStore = createChatContextStore(directory);
}
function currentChatContextStore() { return configuredStore; }

// The native Codex UI and Tracker share this connection. Restore settings for
// only recorded IDs when either client resumes them, including after reload.
function installContextResumeHook(connection, store) {
  if (!store) return () => {};
  let hook = hooks.get(connection);
  if (!hook) {
    const original = connection.sendRequest;
    hook = { count: 0, original, store, wrapped: null };
    hook.wrapped = function(provider, id, method, params, ...rest) {
      if (method === 'thread/resume' && params?.threadId) {
        const config = hook.store.get(params.threadId);
        if (config) params = { ...params, config: { ...params.config, ...config } };
      }
      return original.call(this, provider, id, method, params, ...rest);
    };
    connection.sendRequest = hook.wrapped;
    hooks.set(connection, hook);
  }
  hook.count++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--hook.count === 0) {
      if (connection.sendRequest === hook.wrapped) connection.sendRequest = hook.original;
      hooks.delete(connection);
    }
  };
}

module.exports = { createChatContextStore, configureChatContextStore, currentChatContextStore, installContextResumeHook };
