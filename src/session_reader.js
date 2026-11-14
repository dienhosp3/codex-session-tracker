'use strict';

const { Worker, isMainThread, parentPort } = require('node:worker_threads');
const METHODS = ['scanConversationSessions', 'scanSessionTree', 'buildSessionSnapshot', 'findLatestRolloutForThread', 'readThreadNames', 'readStateThreadActivity','clearCaches','cacheStats'];

if (!isMainThread) {
  const tracker = require('./tracker');
  let queue = Promise.resolve();
  parentPort.on('message', ({ id, method, args }) => {
    queue = queue.then(async () => {
      try {
        if (!METHODS.includes(method)) throw new Error('Unsupported session read');
        parentPort.postMessage({ id, result: await tracker[method](...args) });
      } catch (error) { parentPort.postMessage({ id, error: { message: error.message, code: error.code } }); }
    });
  });
} else {
  module.exports.createSessionReader = function createSessionReader() {
    let worker, sequence = 0, disposed = false;
    const pending = new Map();
    function fail(error) { for (const item of pending.values()) item.reject(error); pending.clear(); }
    function start() {
      if (disposed) throw new Error('Session reader disposed');
      if (worker) return;
      const instance = worker = new Worker(__filename);
      instance.on('message', message => {
        const item = pending.get(message.id); if (!item) return;
        pending.delete(message.id);
        if (message.error) item.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
        else item.resolve(message.result);
        if (!pending.size) instance.unref();
      });
      instance.on('error', fail);
      instance.on('exit', () => { if (worker === instance) { worker = null; fail(new Error('Session reader stopped')); } });
    }
    const result = Object.fromEntries(METHODS.map(method => [method, (...args) => new Promise((resolve, reject) => {
      try { start(); const id = ++sequence; pending.set(id, { resolve, reject }); worker.ref(); worker.postMessage({ id, method, args }); }
      catch (error) { reject(error); }
    })]));
    return { ...result, dispose() { disposed = true; fail(new Error('Session reader disposed')); return worker?.terminate(); } };
  };
}
