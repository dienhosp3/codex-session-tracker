'use strict';

const fs = require('fs');
const path = require('path');
const inspector = require('inspector');
const { installedBridgeInfo } = require('./codex_live_backend');

// Bind to instances already owned by this VS Code Extension host without
// pausing JS, opening a debug port, restarting Codex, or reading its stdio.
async function ensureOwnerBridge(extensionRoot) {
  const installed = installedBridgeInfo();
  if (installed.length) return installed;
  const filename = path.join(extensionRoot, 'out', 'extension.js');
  const source = fs.readFileSync(filename, 'utf8');
  function classBefore(marker) {
    const end = source.indexOf(marker);
    if (end < 0) throw new Error('Unsupported Codex Extension connection layout.');
    const declarations = [...source.slice(Math.max(0, end - 8000), end).matchAll(/([\w$]+)=class(?:\s+extends\s+[\w$]+)?\s*\{/g)];
    if (!declarations.length) throw new Error('Cannot locate the existing Codex connection class.');
    return declarations[declarations.length - 1][1];
  }
  const names = [classBefore('"CodexMcpConnection"'), classBefore('ownedThreads=new Set')];
  const session = new inspector.Session();
  session.connect();
  const post = (method, params = {}) => new Promise((resolve, reject) => session.post(method, params, (error, value) => error ? reject(error) : resolve(value)));
  const group = 'codex-session-tracker-owner-bridge';
  try {
    const expression = `Object.values(process.getBuiltinModule('module')._cache).find(m=>m.filename.toLowerCase()===${JSON.stringify(filename.toLowerCase())})?.exports.activate`;
    const activation = await post('Runtime.evaluate', { expression, objectGroup: group });
    if (!activation.result?.objectId) throw new Error('Codex is not activated in this Extension host.');
    const props = await post('Runtime.getProperties', { objectId: activation.result.objectId });
    const scopeId = props.internalProperties?.find(p => p.name === '[[Scopes]]')?.value?.objectId;
    if (!scopeId) throw new Error('Cannot inspect the running Codex connection scope.');
    const scopes = await post('Runtime.getProperties', { objectId: scopeId });
    const constructors = new Map();
    for (const scope of scopes.result.filter(p => /^\d+$/.test(p.name))) {
      const variables = await post('Runtime.getProperties', { objectId: scope.value.objectId });
      for (const name of names) {
        const value = variables.result.find(p => p.name === name)?.value;
        if (value?.objectId) constructors.set(name, value.objectId);
      }
    }
    const arrays = [];
    for (const name of names) {
      if (!constructors.has(name)) throw new Error('Existing Codex connection constructor is unavailable.');
      const properties = await post('Runtime.getProperties', { objectId: constructors.get(name) });
      const prototypeObjectId = properties.result.find(p => p.name === 'prototype')?.value?.objectId;
      if (!prototypeObjectId) throw new Error('Existing Codex connection prototype is unavailable.');
      const instances = await post('Runtime.queryObjects', { prototypeObjectId, objectGroup: group });
      arrays.push(instances.objects.objectId);
    }
    const helper = path.join(__dirname, 'codex_live_backend.js');
    const result = await post('Runtime.callFunctionOn', {
      objectId: arrays[0],
      functionDeclaration: `function(streams){return process.getBuiltinModule('module').createRequire(${JSON.stringify(__filename)})(${JSON.stringify(helper)}).installOwnerBridge(this,streams);}`,
      arguments: [{ objectId: arrays[1] }], returnByValue: true
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  } finally {
    await post('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => {});
    session.disconnect();
  }
}

module.exports = { ensureOwnerBridge };
