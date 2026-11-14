'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const inspector = require('node:inspector');
const { withSidebarProvider, rememberSidebarProvider, forgetSidebarProvider } = require('./codex_navigation');
const { questionId } = require('./codex_async_input');

const MESSAGE_TYPE = 'codex-session-tracker.current-chat';

function threadFromRoute(route) {
  if (typeof route !== 'string') return '';
  return /^\/local\/([A-Za-z0-9_-]{1,200})\/?(?:[?#].*)?$/.exec(route)?.[1] || '';
}

function propertyDescriptor(object, key) {
  for (let current = object; current; current = Object.getPrototypeOf(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return descriptor;
  }
  return null;
}

function createCurrentChatTracker(vscode, options = {}) {
  const loader = options.moduleLoader || Module;
  const extensionRoot = options.extensionRoot || vscode.extensions.getExtension('openai.chatgpt')?.extensionPath;
  const target = extensionRoot ? path.resolve(extensionRoot, 'out', 'extension.js').toLowerCase() : '';
  const mediaRoot = vscode.Uri.joinPath(options.extensionUri, 'media');
  const observerUri = vscode.Uri.joinPath(mediaRoot, 'codex_current_chat_observer.js');
  const providers = new Map();
  const wrappedInitializers = new Set();
  const views = new Map();
  let currentView = null;
  let currentThreadId = '';
  let disposed = false;
  let clonedApi;
  const planRequests = new Map();

  function attachCompiledProvider(source) {
    options.onDebug?.('compiled');
    const marker = source.indexOf('async initializeWebview(');
    if (marker < 0) return;
    const classes = [...source.slice(0, marker).matchAll(/([\w$]+)=class(?:\s+extends\s+[\w$]+)?\s*\{/g)];
    const className = classes.at(-1)?.[1];
    if (!className) return;
    const session = new inspector.Session();
    const key = 'codex-tracker-observer-' + crypto.randomUUID();
    const symbol = Symbol.for(key);
    globalThis[symbol] = attachProvider;
    session.connect();
    function post(method, params = {}) {
      let result;
      let failed;
      session.post(method, params, (error, value) => { failed = error; result = value; });
      if (failed) throw failed;
      if (!result) throw new Error('Codex observer inspection was not synchronous.');
      return result;
    }
    try {
      const activation = post('Runtime.evaluate', {
        expression: `Object.values(process.getBuiltinModule('module')._cache).find(m=>m.filename.toLowerCase()===${JSON.stringify(target)})?.exports.activate`,
        objectGroup: key
      });
      const properties = post('Runtime.getProperties', { objectId: activation.result.objectId });
      const scopesId = properties.internalProperties.find(item => item.name === '[[Scopes]]').value.objectId;
      const scopes = post('Runtime.getProperties', { objectId: scopesId });
      for (const scope of scopes.result.filter(item => /^\d+$/.test(item.name))) {
        const variables = post('Runtime.getProperties', { objectId: scope.value.objectId });
        const constructorId = variables.result.find(item => item.name === className)?.value?.objectId;
        if (!constructorId) continue;
        const constructor = post('Runtime.getProperties', { objectId: constructorId });
        const prototypeId = constructor.result.find(item => item.name === 'prototype').value.objectId;
        const result = post('Runtime.callFunctionOn', {
          objectId: prototypeId,
          functionDeclaration: 'function(key) { globalThis[Symbol.for(key)](this); }',
          arguments: [{ value: key }]
        });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
        options.onDebug?.('prototype-attached');
        return;
      }
    } finally {
      try { post('Runtime.releaseObjectGroup', { objectGroup: key }); } catch {}
      session.disconnect();
      delete globalThis[symbol];
    }
  }

  const originalCompile = loader.prototype?._compile;
  const hookedCompile = originalCompile && function(source, filename, ...args) {
    const result = originalCompile.call(this, source, filename, ...args);
    if (!disposed && target && path.resolve(filename).toLowerCase() === target) {
      try { attachCompiledProvider(source); } catch (error) { options.onError?.(error); }
    }
    return result;
  };
  if (hookedCompile) loader.prototype._compile = hookedCompile;

  function publish() {
    const next = currentView?.threadId || '';
    if (next === currentThreadId) return;
    currentThreadId = next;
    options.onChange?.(next);
  }

  function removeView(webview) {
    const record = views.get(webview);
    if (!record) return;
    views.delete(webview);
    for (const disposable of record.disposables) disposable.dispose();
    for (const [key, descriptor] of record.originals) {
      if (descriptor) Object.defineProperty(webview, key, descriptor);
      else delete webview[key];
    }
    if (currentView === record) {
      currentView = [...views.values()].sort((a, b) => b.focusedAt - a.focusedAt)[0] || null;
      publish();
    }
  }

  function attachView(webview, onDidDispose) {
    if (disposed || views.has(webview)) return;
    const html = propertyDescriptor(webview, 'html');
    if (!html?.set || !html.get) return;
    const record = {
      threadId: '',
      planTurnId: '',
      focusedAt: 0,
      token: crypto.randomBytes(24).toString('hex'),
      disposables: [],
      originals: new Map()
    };
    const remember = key => record.originals.set(key, Object.getOwnPropertyDescriptor(webview, key));
    try {
      const nativeReceive = webview.onDidReceiveMessage;
      const receive = nativeReceive(message => {
        if (!disposed && message?.type === 'codex-session-tracker.plan-result' && message.token === record.token) {
          const pending = planRequests.get(message.requestId);
          if (pending && pending.webview === webview) {
            planRequests.delete(message.requestId); clearTimeout(pending.timer);
            message.ok ? pending.resolve(true) : pending.reject(new Error(message.error || 'Chưa xác nhận triển khai.'));
          }
          return;
        }
        if (disposed || message?.type !== MESSAGE_TYPE || message.token !== record.token) return;
        if (typeof message.route !== 'string' || message.route.length > 500) return;
        const threadId = threadFromRoute(message.route);
        if (threadId && Array.isArray(message.resolvedInputIds)) {
          const ids = [...new Set(message.resolvedInputIds.slice(0, 100).map(questionId).filter(Boolean))];
          if (ids.length) options.onInputResolved?.({ threadId, ids });
        }
        if (threadId && threadId === record.threadId && message.resolvedPlanTurnId === record.planTurnId && record.planTurnId) {
          options.onPlanPrompt?.({ threadId, turnId: record.planTurnId, visible: false });
        }
        const planTurnId = typeof message.planTurnId === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(message.planTurnId) ? message.planTurnId : '';
        if (threadId && planTurnId && (threadId !== record.threadId || planTurnId !== record.planTurnId)) {
          options.onPlanPrompt?.({ threadId, turnId: planTurnId, visible: true });
        }
        record.threadId = threadId;
        record.planTurnId = planTurnId;
        if (message.focused === true || !currentView) {
          record.focusedAt = Date.now();
          currentView = record;
        }
        if (currentView === record) publish();
      });
      record.disposables.push(receive);
      remember('onDidReceiveMessage');
      // The native message bus does not know our private message type. Filter
      // it from subsequent native listeners while preserving every other event.
      Object.defineProperty(webview, 'onDidReceiveMessage', {
        configurable: true,
        get: () => (listener, thisArg, disposables) => nativeReceive(message => {
          if (message?.type !== MESSAGE_TYPE && message?.type !== 'codex-session-tracker.plan-result') listener.call(thisArg, message);
        }, undefined, disposables)
      });
      remember('html');
      Object.defineProperty(webview, 'html', {
        configurable: true,
        get: () => html.get.call(webview),
        set: value => {
          let content = value;
          if (!disposed && typeof value === 'string' && /<script\b/i.test(value)) {
            const roots = webview.options.localResourceRoots || [];
            if (!roots.some(uri => uri.toString() === mediaRoot.toString())) {
              webview.options = { ...webview.options, localResourceRoots: [...roots, mediaRoot] };
            }
            const src = webview.asWebviewUri(observerUri).toString().replace(/&/g, '&amp;').replace(/"/g, '&quot;');
            const script = '<script src="' + src + '" data-tracker-token="' + record.token + '"></script>';
            content = value.replace(/<script\b/i, () => script + '<script');
          }
          html.set.call(webview, content);
        }
      });
      views.set(webview, record);
      if (typeof onDidDispose === 'function') record.disposables.push(onDidDispose(() => removeView(webview)));
      options.onAttach?.({ htmlAlreadySet: Boolean(webview.html) });
    } catch (error) {
      views.set(webview, record);
      removeView(webview);
      options.onError?.(error);
    }
  }

  function attachProvider(provider) {
    if (disposed || providers.has(provider) || typeof provider?.initializeWebview !== 'function') return;
    if (wrappedInitializers.has(provider.initializeWebview)) return;
    const original = provider.initializeWebview;
    const wrapped = function(webview, role, onDidDispose, ...rest) {
      rememberSidebarProvider?.(extensionRoot, this);
      attachView(webview, onDidDispose);
      return original.call(this, webview, role, onDidDispose, ...rest);
    };
    providers.set(provider, { original, wrapped });
    wrappedInitializers.add(wrapped);
    provider.initializeWebview = wrapped;
  }

  const originalLoad = loader._load;
  const hookedLoad = function(request, parent, ...rest) {
    const api = originalLoad.call(this, request, parent, ...rest);
    if (disposed || !target || request !== 'vscode' || path.resolve(parent?.filename || '').toLowerCase() !== target) return api;
    options.onDebug?.('vscode-api');
    if (!clonedApi) {
      // Preserve getters such as window.state and activeTextEditor. Spreading
      // the API would eagerly read them and leave Codex with stale snapshots.
      const windowDescriptors = Object.getOwnPropertyDescriptors(api.window);
      windowDescriptors.registerWebviewViewProvider = {
        ...windowDescriptors.registerWebviewViewProvider,
        value: function(viewType, provider, ...args) {
          attachProvider(provider);
          return api.window.registerWebviewViewProvider(viewType, provider, ...args);
        }
      };
      const descriptors = Object.getOwnPropertyDescriptors(api);
      descriptors.window = {
        value: Object.create(Object.getPrototypeOf(api.window), windowDescriptors),
        enumerable: descriptors.window?.enumerable ?? true
      };
      clonedApi = Object.create(Object.getPrototypeOf(api), descriptors);
    }
    return clonedApi;
  };
  loader._load = hookedLoad;

  return {
    get threadId() { return currentThreadId; },
    async implementPlan(threadId, turnId) {
      const candidates = [...views].filter(([, record]) => record.threadId === threadId && record.planTurnId === turnId);
      if (candidates.length !== 1) throw new Error('Mở đúng chat và chờ kế hoạch hiện trong Codex.');
      const [webview, record] = candidates[0], requestId = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { planRequests.delete(requestId); reject(new Error('Chưa nhận xác nhận từ Codex; kiểm tra chat trước khi thử lại.')); }, 15000);
        planRequests.set(requestId, { webview, resolve, reject, timer });
        Promise.resolve(webview.postMessage({ type:'codex-session-tracker.implement-plan', token:record.token, requestId, threadId, turnId })).catch(reject);
      });
    },
    attachProvider,
    async connect() {
      const extension = vscode.extensions.getExtension('openai.chatgpt');
      if (!extension || disposed) return;
      if (!extension.isActive) await extension.activate();
      if (disposed) return;
      await withSidebarProvider(extension.extensionPath, provider => {
        attachProvider(provider);
        for (const view of provider.sidebarViews || []) attachView(view.webview, view.onDidDispose);
        for (const panel of provider.editorPanels?.keys() || []) attachView(panel.webview, panel.onDidDispose);
      }, () => !disposed);
    },
    dispose() {
      if (disposed) return;
      forgetSidebarProvider?.(extensionRoot);
      disposed = true;
      for (const request of planRequests.values()) { clearTimeout(request.timer); request.reject(new Error('Codex view closed')); }
      planRequests.clear();
      if (loader._load === hookedLoad) loader._load = originalLoad;
      if (hookedCompile && loader.prototype._compile === hookedCompile) loader.prototype._compile = originalCompile;
      for (const [provider, methods] of providers) {
        if (provider.initializeWebview === methods.wrapped) provider.initializeWebview = methods.original;
      }
      providers.clear();
      wrappedInitializers.clear();
      for (const webview of [...views.keys()]) removeView(webview);
    }
  };
}

module.exports = { createCurrentChatTracker, threadFromRoute, MESSAGE_TYPE };
