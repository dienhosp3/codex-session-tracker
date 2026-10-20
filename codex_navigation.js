'use strict';

const fs = require('node:fs');
const path = require('node:path');
const inspector = require('node:inspector');
const crypto = require('node:crypto');

function uriHandlerClass(source) {
  const marker = source.indexOf('async handleUri(');
  if (marker < 0 || !source.slice(marker, marker + 2500).includes('codexWebviewProvider.navigateToRoute(')) {
    throw new Error('Phiên bản Codex này chưa hỗ trợ kết nối điều hướng của Tracker.');
  }
  const declarations = [...source.slice(Math.max(0, marker - 8000), marker)
    .matchAll(/([\w$]+)=class(?:\s+extends\s+[\w$]+)?\s*\{/g)];
  if (!declarations.length) throw new Error('Không tìm thấy bộ điều hướng Codex.');
  return declarations[declarations.length - 1][1];
}

// Use the current host's existing URI handler, which queues navigation until
// the sidebar is ready. OS protocol links can target a different VS Code window.
async function withSidebarProvider(extensionRoot, visit, isCurrent = () => true) {
  const filename = path.join(extensionRoot, 'out', 'extension.js');
  const className = uriHandlerClass(fs.readFileSync(filename, 'utf8'));
  const session = new inspector.Session();
  session.connect();
  const group = 'codex-session-tracker-navigation';
  const callbackKey = 'codex-session-tracker-provider-' + crypto.randomUUID();
  const callbackSymbol = Symbol.for(callbackKey);
  globalThis[callbackSymbol] = visit;
  const post = (method, params = {}) => new Promise((resolve, reject) => {
    session.post(method, params, (error, value) => error ? reject(error) : resolve(value));
  });
  try {
    const activation = await post('Runtime.evaluate', {
      expression: `Object.values(process.getBuiltinModule('module')._cache).find(m=>m.filename.toLowerCase()===${JSON.stringify(filename.toLowerCase())})?.exports.activate`,
      objectGroup: group
    });
    if (!activation.result?.objectId) throw new Error('Codex chưa chạy trong cửa sổ VS Code này.');
    const properties = await post('Runtime.getProperties', { objectId: activation.result.objectId });
    const scopeId = properties.internalProperties?.find(p => p.name === '[[Scopes]]')?.value?.objectId;
    if (!scopeId) throw new Error('Không truy cập được bộ điều hướng Codex đang chạy.');
    const scopes = await post('Runtime.getProperties', { objectId: scopeId });
    let constructorId = '';
    for (const scope of scopes.result.filter(p => /^\d+$/.test(p.name))) {
      const variables = await post('Runtime.getProperties', { objectId: scope.value.objectId });
      constructorId = variables.result.find(p => p.name === className)?.value?.objectId || '';
      if (constructorId) break;
    }
    if (!constructorId) throw new Error('Không tìm thấy bộ điều hướng Codex trong cửa sổ này.');
    const constructor = await post('Runtime.getProperties', { objectId: constructorId });
    const prototypeObjectId = constructor.result.find(p => p.name === 'prototype')?.value?.objectId;
    if (!prototypeObjectId) throw new Error('Bộ điều hướng Codex không tương thích.');
    const instances = await post('Runtime.queryObjects', { prototypeObjectId, objectGroup: group });
    if (!isCurrent()) return false;
    const result = await post('Runtime.callFunctionOn', {
      objectId: instances.objects.objectId,
      functionDeclaration: `function(callbackKey) {
        const handlers = this.filter(value => typeof value.codexWebviewProvider?.navigateToRoute === 'function');
        if (handlers.length !== 1) throw new Error('Không xác định được sidebar Codex trong cửa sổ này.');
        globalThis[Symbol.for(callbackKey)](handlers[0].codexWebviewProvider);
        return true;
      }`,
      arguments: [{ value: callbackKey }],
      returnByValue: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    if (result.result.value !== true) throw new Error('Codex chưa nhận điều hướng hội thoại.');
    return true;
  } finally {
    delete globalThis[callbackSymbol];
    await post('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => {});
    session.disconnect();
  }
}

async function navigateSidebar(extensionRoot, route, isCurrent) {
  return withSidebarProvider(extensionRoot, provider => provider.navigateToRoute(route), isCurrent);
}

function createConversationNavigator(vscode, options = {}) {
  const navigate = options.navigateSidebar || navigateSidebar;
  let pending = Promise.resolve();
  return function openConversation(threadId, isCurrent = () => true) {
    const next = pending.catch(() => {}).then(async () => {
      if (!isCurrent()) return false;
      if (typeof threadId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(threadId)) {
        throw new Error('ID cuộc trò chuyện Codex không hợp lệ.');
      }
      const extension = vscode.extensions.getExtension('openai.chatgpt');
      if (!extension) throw new Error('Chưa cài extension Codex của OpenAI trong cửa sổ này.');
      if (!extension.isActive) await extension.activate();
      if (!isCurrent()) return false;
      await vscode.commands.executeCommand('chatgpt.openSidebar');
      if (!isCurrent()) return false;
      return navigate(extension.extensionPath, '/local/' + encodeURIComponent(threadId), isCurrent);
    });
    pending = next;
    return next;
  };
}

module.exports = { createConversationNavigator, navigateSidebar, withSidebarProvider, uriHandlerClass };
