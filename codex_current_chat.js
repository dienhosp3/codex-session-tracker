'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const inspector = require('node:inspector');
const { withSidebarProvider } = require('./codex_navigation');

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
      focusedAt: 0,
      token: crypto.randomBytes(24).toString('hex'),
      disposables: [],
      originals: new Map()
    };
    const remember = key => record.originals.set(key, Object.getOwnPropertyDescriptor(webview, key));
    try {
      const nativeReceive = webview.onDidReceiveMessage;
      const receive = nativeReceive(message => {
        if (disposed || message?.type !== MESSAGE_TYPE || message.token !== record.token) return;
        if (typeof message.route !== 'string' || message.route.length > 500) return;
        record.threadId = threadFromRoute(message.route);
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
          if (message?.type !== MESSAGE_TYPE) listener.call(thisArg, message);
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
      disposed = true;
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
