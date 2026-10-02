'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const childProcess = require('child_process');
const tracker = require('./tracker');
const codexQueue = require('./codex_queue');
const codexSteer = require('./codex_steer');
const codexDelete = require('./codex_delete');
const { CodexGateway } = require('./gateway');
const gatewayConfig = require('./gateway/config_manager');

let contextRef = null;
let statusBar = null;
let trackerView = null;
let trafficPanel = null;
let pollTimer = null;
let selected = null;
let selectedTree = [];
let latestSnapshot = null;
let activeChats = [];
let nonRunningChats = [];
let showNonRunning = false;
let deleteBusy = false;
let deleteNotice = null;
let refreshingSelected = false;
let refreshingActive = false;
let lastTreeRescanAt = 0;
let lastActiveScanAt = 0;
let queueCapability = { checked: false, available: false, reason: 'Chưa kiểm tra Codex CLI.', executable: '', source: '', version: '' };
let queueCapabilityCheckedAt = 0;
let queueBusy = false;
let queueNotice = null;
let steerCapability = { checked: false, available: false, reason: 'Steer capability has not been checked yet.', executable: '', source: '', version: '' };
let steerCapabilityCheckedAt = 0;
let steerCapabilityConversationId = '';
let steerBusy = false;
let steerNotice = null;
let gateway = null;
let gatewayStatus = { enabled: false, running: false, error: '', address: null };
let gatewayManagedState = { active: false, managed: false, drifted: false };
let gatewayActionNotice = null;
const GATEWAY_SETTINGS_KEY = 'codexSessionTracker.gatewaySettings.v1';
const HTTP_HOOK_INSTALL_KEY = 'codexSessionTracker.httpHookInstall.v1';
const HTTP_HOOK_CODEX_VERSION = '0.159.2';
const ORIGINAL_PROXY_ENV = Object.fromEntries(
  ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy']
    .map(key => [key, process.env[key]])
);
let gatewayProxyEnvApplied = false;

async function activate(context) {
  contextRef = context;
  applyGatewayProcessEnvironment();

  const migratedLegacyRoute = await migrateLegacyGatewayRoute();
  if (migratedLegacyRoute) {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
    return;
  }

  await startGateway().catch(() => {});

  const provider = new TrackerViewProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('codexSessionTracker.view', provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  statusBar = vscode.window.createStatusBarItem('codexSessionTracker.status', vscode.StatusBarAlignment.Left, 35);
  statusBar.name = 'Codex Session Tracker';
  statusBar.command = 'codexSessionTracker.openTracker';
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('codexSessionTracker.openTracker', openTracker),
    vscode.commands.registerCommand('codexSessionTracker.openDashboard', openTracker),
    vscode.commands.registerCommand('codexSessionTracker.selectChat', openTracker),
    vscode.commands.registerCommand('codexSessionTracker.refresh', () => refreshAll(true)),
    vscode.commands.registerCommand('codexSessionTracker.clearSelection', clearSelection),
    vscode.commands.registerCommand('codexSessionTracker.reprobeCodexCli', async () => { await refreshQueueCapability(true); await refreshSteerCapability(true); postViewState(); }),
    vscode.commands.registerCommand('codexSessionTracker.exportGatewayDiagnostics', exportGatewayDiagnostics),
    vscode.commands.registerCommand('codexSessionTracker.openTrafficMonitor', openTrafficMonitor),
    vscode.commands.registerCommand('codexSessionTracker.buildInstrumentedCodex', buildInstrumentedCodex),
    vscode.commands.registerCommand('codexSessionTracker.installInstrumentedCodex', installInstrumentedCodex),
    vscode.commands.registerCommand('codexSessionTracker.restoreOfficialCodexDaemon', restoreOfficialCodexDaemon),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('codexSessionTracker')) return;
      restartPolling();
      refreshAll(true);
    })
  );

  restoreSelection(context);
  renderStatus();
  restartPolling();
  refreshGatewayManagedState().catch(() => {});
  refreshTrackedStatus(true);
}

async function deactivate() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  trackerView = null;
  if (trafficPanel) {
    try { trafficPanel.dispose(); } catch {}
    trafficPanel = null;
  }
  if (gateway) {
    try { await gateway.stop(); } catch {}
    gateway = null;
  }
}

class TrackerViewProvider {
  resolveWebviewView(webviewView) {
    trackerView = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = dashboardHtml();

    webviewView.webview.onDidReceiveMessage(async message => {
      if (!message || typeof message !== 'object') return;
      if (message.command === 'selectChat' && message.threadId) await selectThread(String(message.threadId));
      if (message.command === 'refresh') await refreshAll(true);
      if (message.command === 'clear') await clearSelection();
      if (message.command === 'queueMessage') await sendQueuedMessage(message.text, message.images);
      if (message.command === 'steerMessage') await sendSteeredMessage(message.text, message.images);
      if (message.command === 'setShowNonRunning') await setShowNonRunning(Boolean(message.enabled));
      if (message.command === 'deleteChat' && message.threadId) await deleteChat(String(message.threadId));
      if (message.command === 'reprobeQueue' || message.command === 'reprobeCodex') { await refreshQueueCapability(true); await refreshSteerCapability(true); postViewState(); }
      if (message.command === 'saveGatewaySettings') await saveGatewaySettings(message.settings || {});
      if (message.command === 'enableGatewayFullCapture') await enableGatewayFullCapture(message.settings || {});
      if (message.command === 'revertGatewayManaged') await revertGatewayManaged(false);
      if (message.command === 'forceRestoreGatewayManaged') await revertGatewayManaged(true);
      if (message.command === 'loadGatewayPayload') await sendGatewayPayload(message.traceId, message.offset);
      if (message.command === 'openTrafficMonitor') await openTrafficMonitor();
      if (message.command === 'buildInstrumentedCodex') await buildInstrumentedCodex();
      if (message.command === 'installInstrumentedCodex') await installInstrumentedCodex();
      if (message.command === 'restoreOfficialCodexDaemon') await restoreOfficialCodexDaemon();
    }, null, contextRef.subscriptions);

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) refreshAll(true);
    }, null, contextRef.subscriptions);

    postViewState();
    refreshAll(true);
  }
}

function storedGatewaySettings() {
  const value = contextRef && contextRef.globalState.get(GATEWAY_SETTINGS_KEY);
  if (value && typeof value === 'object') {
    return {
      enabled: value.enabled !== undefined ? Boolean(value.enabled) : true,
      port: Number(value.port || 8765),
      modelProxyEnabled: Boolean(value.modelProxyEnabled),
      upstreamBaseUrl: String(value.upstreamBaseUrl || ''),
      captureContent: Boolean(value.captureContent),
      captureMaxMb: Number(value.captureMaxMb || 16),
      traceMaxMb: Number(value.traceMaxMb || 64),
      httpHookEnabled: Boolean(value.httpHookEnabled),
      httpHookPort: Number(value.httpHookPort || 8767),
      httpHookMutationEnabled: Boolean(value.httpHookMutationEnabled)
    };
  }

  const legacy = vscode.workspace.getConfiguration('codexSessionTracker');
  return {
    enabled: legacy.get('gateway.enabled', true),
    port: legacy.get('gateway.port', 8765),
    modelProxyEnabled: legacy.get('gateway.modelProxyEnabled', false),
    upstreamBaseUrl: legacy.get('gateway.upstreamBaseUrl', ''),
    captureContent: legacy.get('gateway.captureContent', false),
    captureMaxMb: legacy.get('gateway.captureMaxMb', 16),
    traceMaxMb: legacy.get('gateway.traceMaxMb', 64),
    httpHookEnabled: false,
    httpHookPort: 8767,
    httpHookMutationEnabled: false
  };
}

function applyGatewayProcessEnvironment() {
  const settings = storedGatewaySettings();
  if (!settings.modelProxyEnabled || !settings.enabled) {
    restoreOriginalProxyEnvironment();
    return false;
  }
  const proxy = 'http://127.0.0.1:' + Number(settings.port || 8765);
  process.env.HTTP_PROXY = proxy;
  process.env.HTTPS_PROXY = proxy;
  process.env.ALL_PROXY = proxy;
  process.env.http_proxy = proxy;
  process.env.https_proxy = proxy;
  process.env.all_proxy = proxy;

  const noProxyParts = new Set(
    String(ORIGINAL_PROXY_ENV.NO_PROXY || ORIGINAL_PROXY_ENV.no_proxy || '')
      .split(',')
      .map(item => item.trim())
      .filter(Boolean)
  );
  noProxyParts.add('127.0.0.1');
  noProxyParts.add('localhost');
  process.env.NO_PROXY = Array.from(noProxyParts).join(',');
  process.env.no_proxy = process.env.NO_PROXY;
  gatewayProxyEnvApplied = true;
  return true;
}

function restoreOriginalProxyEnvironment() {
  for (const [key, value] of Object.entries(ORIGINAL_PROXY_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  gatewayProxyEnvApplied = false;
}

function config() {
  const cfg = vscode.workspace.getConfiguration('codexSessionTracker');
  const codexHome = tracker.getCodexHome(cfg.get('codexHome', ''));
  const gatewaySettings = storedGatewaySettings();
  return {
    codexHome,
    sessionsDir: path.join(codexHome, 'sessions'),
    historyLimit: cfg.get('historyLimit', 100),
    includeNonVsCodeSessions: cfg.get('includeNonVsCodeSessions', false),
    pollIntervalMs: cfg.get('pollIntervalMs', 1500),
    rescanThreadEverySeconds: cfg.get('rescanThreadEverySeconds', 5),
    activeScanEverySeconds: cfg.get('activeScanEverySeconds', 4),
    treeScanLimit: cfg.get('treeScanLimit', 1200),
    activityTailMb: cfg.get('activityTailMb', 6),
    timelineLimit: cfg.get('timelineLimit', 50),
    codexCliPath: cfg.get('codexCliPath', ''),
    gatewayEnabled: gatewaySettings.enabled,
    gatewayPort: gatewaySettings.port,
    gatewayModelProxyEnabled: gatewaySettings.modelProxyEnabled,
    gatewayUpstreamBaseUrl: gatewaySettings.upstreamBaseUrl,
    gatewayCaptureContent: gatewaySettings.captureContent,
    gatewayCaptureMaxMb: gatewaySettings.captureMaxMb,
    gatewayTraceMaxMb: gatewaySettings.traceMaxMb,
    gatewayHttpHookEnabled: gatewaySettings.httpHookEnabled,
    gatewayHttpHookPort: gatewaySettings.httpHookPort,
    gatewayHttpHookMutationEnabled: gatewaySettings.httpHookMutationEnabled
  };
}

async function startGateway() {
  const cfg = config();
  if (!cfg.gatewayEnabled || !contextRef) {
    gatewayStatus = { enabled: false, running: false, error: '', address: null };
    return null;
  }
  if (gateway) return gateway;
  const traceDir = gatewayStorageDir();
  gateway = new CodexGateway({
    version: String(contextRef.extension && contextRef.extension.packageJSON && contextRef.extension.packageJSON.version || 'dev'),
    port: cfg.gatewayPort,
    traceDir,
    modelProxyEnabled: cfg.gatewayModelProxyEnabled,
    upstreamBaseUrl: cfg.gatewayUpstreamBaseUrl,
    captureContent: cfg.gatewayCaptureContent,
    captureMaxBytes: Math.max(1, Number(cfg.gatewayCaptureMaxMb || 16)) * 1024 * 1024,
    traceMaxBytes: Math.max(8, Number(cfg.gatewayTraceMaxMb || 64)) * 1024 * 1024,
    httpHookPort: cfg.gatewayHttpHookPort,
    httpHookMutationEnabled: cfg.gatewayHttpHookMutationEnabled,
    handlers: {
      steer: async input => codexSteer.steerViaExtensionIpc({
        threadId: input.threadId,
        message: input.message,
        images: input.images,
        clientUserMessageId: input.clientUserMessageId,
        codexHome: config().codexHome,
        cwd: input.cwd || undefined,
        onProgress: input.onProgress
      }),
      queue: async input => {
        const current = config();
        const resolved = await codexQueue.resolveCodexExecutable({
          configuredPath: current.codexCliPath,
          extensionRoots: openAiExtensionRoots(),
          platform: process.platform
        });
        if (!resolved.executable) throw new Error(resolved.error || 'Không tìm thấy Codex CLI.');
        return codexQueue.queueMessage({
          executable: resolved.executable,
          threadId: input.threadId,
          message: input.message,
          codexHome: current.codexHome,
          cwd: input.cwd || undefined
        });
      }
    }
  });
  try {
    const address = await gateway.start();
    if (cfg.gatewayHttpHookEnabled) {
      await gateway.httpHook.writeConfig(cfg.codexHome);
    } else {
      await gateway.httpHook.removeConfig(cfg.codexHome);
    }
    gatewayStatus = { enabled: true, running: true, error: '', address: { host: address.host, port: address.port } };
  } catch (error) {
    gatewayStatus = { enabled: true, running: false, error: friendlyError(error), address: null };
    gateway = null;
  }
  await refreshGatewayManagedState().catch(() => {});
  postViewState();
  return gateway;
}

async function restartGateway() {
  if (gateway) {
    try { await gateway.stop(); } catch {}
    gateway = null;
  }
  return startGateway();
}

function gatewayStorageDir() {
  return path.join(contextRef.globalStorageUri.fsPath, 'gateway');
}

async function migrateLegacyGatewayRoute() {
  if (!contextRef) return false;
  try {
    const state = await gatewayConfig.getManagedState(config().codexHome, gatewayStorageDir());
    if (!state.active) {
      gatewayManagedState = state;
      return false;
    }
    await gatewayConfig.revertManagedConfig({
      codexHome: config().codexHome,
      storageDir: gatewayStorageDir(),
      forceExact: false
    });
    gatewayManagedState = await gatewayConfig.getManagedState(config().codexHome, gatewayStorageDir());
    return true;
  } catch (error) {
    gatewayActionNotice = {
      kind: 'error',
      text: 'Không thể tự gỡ legacy chatgpt_base_url route: ' + friendlyError(error),
      at: Date.now()
    };
    return false;
  }
}

async function refreshGatewayManagedState() {
  if (!contextRef) return gatewayManagedState;
  try {
    gatewayManagedState = await gatewayConfig.getManagedState(config().codexHome, gatewayStorageDir());
  } catch (error) {
    gatewayManagedState = { active: false, managed: false, drifted: false, error: friendlyError(error) };
  }
  return gatewayManagedState;
}

function gatewaySettingsSnapshot(cfg = config()) {
  return {
    enabled: Boolean(cfg.gatewayEnabled),
    port: Number(cfg.gatewayPort || 8765),
    modelProxyEnabled: Boolean(cfg.gatewayModelProxyEnabled),
    upstreamBaseUrl: String(cfg.gatewayUpstreamBaseUrl || ''),
    captureContent: Boolean(cfg.gatewayCaptureContent),
    captureMaxMb: Number(cfg.gatewayCaptureMaxMb || 16),
    traceMaxMb: Number(cfg.gatewayTraceMaxMb || 64),
    httpHookEnabled: Boolean(cfg.gatewayHttpHookEnabled),
    httpHookPort: Number(cfg.gatewayHttpHookPort || 8767),
    httpHookMutationEnabled: Boolean(cfg.gatewayHttpHookMutationEnabled)
  };
}

async function applyGatewaySettings(values) {
  if (!contextRef) throw new Error('Extension context chưa sẵn sàng.');
  const next = validateGatewaySettings({ ...storedGatewaySettings(), ...(values || {}) });
  await contextRef.globalState.update(GATEWAY_SETTINGS_KEY, next);
  return next;
}

function validateGatewaySettings(input = {}) {
  const port = Math.round(Number(input.port || 8765));
  const captureMaxMb = Math.round(Number(input.captureMaxMb || 16));
  const traceMaxMb = Math.round(Number(input.traceMaxMb || 64));
  const httpHookPort = Math.round(Number(input.httpHookPort || 8767));
  const upstreamBaseUrl = String(input.upstreamBaseUrl || '').trim();
  if (port < 1 || port > 65535) throw new Error('Gateway port phải nằm trong 1..65535.');
  if (captureMaxMb < 1 || captureMaxMb > 64) throw new Error('Giới hạn nội dung phải nằm trong 1..64 MiB.');
  if (traceMaxMb < 8 || traceMaxMb > 512) throw new Error('Giới hạn trace phải nằm trong 8..512 MiB.');
  if (httpHookPort < 1 || httpHookPort > 65535) throw new Error('HTTP hook port phải nằm trong 1..65535.');
  if (httpHookPort === port) throw new Error('HTTP hook port phải khác Gateway transport port.');
  if (upstreamBaseUrl && !/^https?:\/\//i.test(upstreamBaseUrl)) throw new Error('Upstream phải là URL http/https.');
  return {
    enabled: Boolean(input.enabled),
    port,
    modelProxyEnabled: Boolean(input.modelProxyEnabled),
    upstreamBaseUrl,
    captureContent: Boolean(input.captureContent),
    captureMaxMb,
    traceMaxMb,
    httpHookEnabled: Boolean(input.httpHookEnabled),
    httpHookPort,
    httpHookMutationEnabled: Boolean(input.httpHookMutationEnabled)
  };
}

async function saveGatewaySettings(input) {
  try {
    const before = gatewaySettingsSnapshot();
    const next = validateGatewaySettings({ ...input, upstreamBaseUrl: '' });
    const transportChanged =
      before.enabled !== next.enabled
      || before.modelProxyEnabled !== next.modelProxyEnabled
      || before.port !== next.port;

    await applyGatewaySettings(next);
    applyGatewayProcessEnvironment();

    gatewayActionNotice = {
      kind: 'success',
      text: transportChanged
        ? 'Đã lưu proxy transport. Đang reload VS Code để Codex nhận proxy mới...'
        : 'Đã lưu toàn bộ cài đặt Gateway trên giao diện.',
      at: Date.now()
    };

    if (transportChanged) {
      postViewState();
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
      return;
    }

    await restartGateway();
  } catch (error) {
    gatewayActionNotice = { kind: 'error', text: friendlyError(error), at: Date.now() };
  }
  postViewState();
}

async function enableGatewayFullCapture(input = {}) {
  if (process.platform !== 'win32') {
    gatewayActionNotice = { kind: 'error', text: 'Chế độ tự quản lý hiện được khóa cho Windows VS Code.', at: Date.now() };
    postViewState();
    return;
  }

  const originalTrackerSettings = gatewaySettingsSnapshot();
  const requested = validateGatewaySettings({
    ...originalTrackerSettings,
    ...input,
    enabled: true,
    modelProxyEnabled: true,
    upstreamBaseUrl: '',
    captureContent: true
  });

  try {
    await refreshGatewayManagedState();

    if (gatewayManagedState.active) {
      await gatewayConfig.revertManagedConfig({
        codexHome: config().codexHome,
        storageDir: gatewayStorageDir(),
        forceExact: false
      });
      await refreshGatewayManagedState();
    }

    await applyGatewaySettings({
      enabled: true,
      port: requested.port,
      modelProxyEnabled: true,
      upstreamBaseUrl: '',
      captureContent: true,
      captureMaxMb: Math.max(16, Number(requested.captureMaxMb || 16)),
      traceMaxMb: Math.max(256, Number(requested.traceMaxMb || 64)),
      httpHookEnabled: true,
      httpHookPort: Number(requested.httpHookPort || 8767),
      httpHookMutationEnabled: Boolean(requested.httpHookMutationEnabled)
    });

    applyGatewayProcessEnvironment();
    const activeGateway = await restartGateway();
    const diagnostics = activeGateway && activeGateway.diagnostics();
    if (!activeGateway || !diagnostics || !diagnostics.modelProxyReady) {
      throw new Error('Gateway forward proxy chưa sẵn sàng.');
    }

    gatewayActionNotice = {
      kind: 'success',
      text: 'Đã gỡ route localhost cũ, giữ nguyên HTTPS origin của Codex và bật forward proxy local. Đang reload VS Code...',
      at: Date.now()
    };
    postViewState();
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  } catch (error) {
    try {
      await applyGatewaySettings(originalTrackerSettings);
      applyGatewayProcessEnvironment();
      await restartGateway();
    } catch {}
    gatewayActionNotice = { kind: 'error', text: friendlyError(error), at: Date.now() };
    await refreshGatewayManagedState();
    postViewState();
  }
}

async function restoreTrackerGatewaySettings(saved) {
  if (!saved || typeof saved !== 'object') return;
  const values = {};
  for (const key of ['enabled','port','modelProxyEnabled','upstreamBaseUrl','captureContent','captureMaxMb','traceMaxMb','httpHookEnabled','httpHookPort','httpHookMutationEnabled']) {
    if (Object.prototype.hasOwnProperty.call(saved, key)) values[key] = saved[key];
  }
  await applyGatewaySettings(values);
}

async function revertGatewayManaged(forceExact) {
  const cfg = config();
  try {
    await refreshGatewayManagedState();
    if (gatewayManagedState.active) {
      if (forceExact) {
        const answer = await vscode.window.showWarningMessage(
          'Khôi phục snapshot config.toml gốc sẽ ghi đè thay đổi config phát sinh sau khi bật Gateway cũ. Tiếp tục?',
          { modal: true },
          'Khôi phục snapshot gốc'
        );
        if (answer !== 'Khôi phục snapshot gốc') return;
      }
      await gatewayConfig.revertManagedConfig({
        codexHome: cfg.codexHome,
        storageDir: gatewayStorageDir(),
        forceExact: Boolean(forceExact)
      });
    }

    const current = storedGatewaySettings();
    await applyGatewaySettings({
      ...current,
      modelProxyEnabled: false,
      upstreamBaseUrl: '',
      captureContent: false
    });
    restoreOriginalProxyEnvironment();
    await refreshGatewayManagedState();

    gatewayActionNotice = {
      kind: 'success',
      text: 'Đã tắt forward proxy và khôi phục route HTTPS gốc của Codex. Đang reload VS Code...',
      at: Date.now()
    };
    postViewState();
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  } catch (error) {
    gatewayActionNotice = { kind: 'error', text: friendlyError(error), at: Date.now() };
    await refreshGatewayManagedState();
    postViewState();
  }
}

async function sendGatewayPayload(traceId, offset = 0) {
  const event = gateway && gateway.payloadByTraceId(traceId, { offset, limit: 512 * 1024 });
  if (!trackerView) return;
  trackerView.webview.postMessage({
    type: 'gatewayPayload',
    payload: event || { traceId: Number(traceId || 0), missing: true }
  });
}

function gatewayThreadDiagnostics() {
  if (!gateway || !selected) return [];
  return gateway.recentForThread(selected.threadId);
}

function selectionKey() {
  return 'codexSessionTracker.selectedThread.v4';
}

function windowSelectionKey() {
  return `${selectionKey()}.${vscode.env.sessionId}`;
}

function restoreSelection(context) {
  const saved = context.globalState.get(windowSelectionKey()) || context.workspaceState.get(selectionKey());
  if (!saved || !saved.threadId) return;
  selected = {
    threadId: saved.threadId,
    sessionId: saved.sessionId || saved.threadId,
    file: saved.file || '',
    title: saved.title || path.basename(saved.cwd || '') || 'Codex chat',
    cwd: saved.cwd || '',
    source: saved.source || 'vscode',
    createdAt: saved.createdAt || '',
    status: null
  };
}

async function persistSelection() {
  if (!contextRef) return;
  if (!selected) {
    await contextRef.globalState.update(windowSelectionKey(), undefined);
    await contextRef.workspaceState.update(selectionKey(), undefined);
    return;
  }
  const value = {
    threadId: selected.threadId,
    sessionId: selected.sessionId || selected.threadId,
    file: selected.file,
    title: selected.title,
    cwd: selected.cwd,
    source: selected.source,
    createdAt: selected.createdAt || ''
  };
  await contextRef.globalState.update(windowSelectionKey(), value);
  await contextRef.workspaceState.update(selectionKey(), value);
}

function restartPolling() {
  if (pollTimer) clearInterval(pollTimer);
  const interval = Math.max(500, Math.min(10000, Number(config().pollIntervalMs) || 1500));
  pollTimer = setInterval(() => refreshAll(false), interval);
}

function execFilePromise(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(executable, args, {
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      ...options
    }, (error, stdout = '', stderr = '') => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function instrumentedCodexDir() {
  return path.join(contextRef.globalStorageUri.fsPath, 'http-hook-bin', HTTP_HOOK_CODEX_VERSION);
}

function instrumentedCodexPath() {
  return path.join(
    instrumentedCodexDir(),
    'package',
    'bin',
    process.platform === 'win32' ? 'codex.exe' : 'codex'
  );
}

async function buildInstrumentedCodex() {
  if (process.platform !== 'win32') {
    vscode.window.showWarningMessage('Build Codex HTTP Hook hiện chỉ được triển khai cho Windows.');
    return;
  }
  const script = path.join(contextRef.extensionPath, 'codex-hook', 'build-instrumented-codex.ps1');
  if (!fs.existsSync(script)) {
    vscode.window.showErrorMessage('Không tìm thấy build script của Codex HTTP Hook trong extension.');
    return;
  }
  await fs.promises.mkdir(instrumentedCodexDir(), { recursive: true });
  const terminal = vscode.window.createTerminal({ name: 'Codex HTTP Hook Build' });
  terminal.show(true);
  const command = '& ' + JSON.stringify(script) + ' -OutputDir ' + JSON.stringify(instrumentedCodexDir());
  terminal.sendText('powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command ' + JSON.stringify(command), true);
  gatewayActionNotice = {
    kind: 'success',
    text: 'Đã mở terminal build Codex HTTP Hook ' + HTTP_HOOK_CODEX_VERSION + '. Build xong thì bấm Cài hook daemon.',
    at: Date.now()
  };
  postViewState();
}

async function ensureHttpHookConfig() {
  const current = storedGatewaySettings();
  if (!current.httpHookEnabled) {
    await applyGatewaySettings({ ...current, enabled: true, httpHookEnabled: true });
  }
  const activeGateway = await restartGateway();
  if (!activeGateway) throw new Error('Gateway chưa chạy nên không thể cấp endpoint cho HTTP hook.');
  await activeGateway.httpHook.writeConfig(config().codexHome);
  return activeGateway;
}

async function installInstrumentedCodex() {
  const executable = instrumentedCodexPath();
  try {
    if (!fs.existsSync(executable)) {
      throw new Error('Chưa có codex.exe instrumented. Hãy bấm Build Codex HTTP Hook trước.');
    }
    const version = await execFilePromise(executable, ['--version'], { timeout: 10000 });
    const versionText = (version.stdout || version.stderr).trim();
    if (!versionText.includes(HTTP_HOOK_CODEX_VERSION)) {
      throw new Error('Instrumented Codex không đúng version yêu cầu: ' + versionText);
    }

    await ensureHttpHookConfig();
    const env = { ...process.env, CODEX_HOME: config().codexHome };
    const result = await execFilePromise(
      executable,
      ['app-server', 'daemon', 'update', '--from-cli', '--yes'],
      { env, timeout: 120000 }
    );

    await contextRef.globalState.update(HTTP_HOOK_INSTALL_KEY, {
      version: HTTP_HOOK_CODEX_VERSION,
      executable,
      installedAt: Date.now(),
      output: (result.stdout || result.stderr || '').slice(-2000)
    });

    gatewayActionNotice = {
      kind: 'success',
      text: 'Đã cài Codex app-server instrumented ' + HTTP_HOOK_CODEX_VERSION + '. Đang reload VS Code để kết nối lại owner...',
      at: Date.now()
    };
    postViewState();
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  } catch (error) {
    gatewayActionNotice = { kind: 'error', text: 'Cài HTTP hook thất bại: ' + friendlyError(error), at: Date.now() };
    postViewState();
  }
}

async function restoreOfficialCodexDaemon() {
  try {
    let executable = instrumentedCodexPath();
    if (!fs.existsSync(executable)) {
      const resolved = await codexQueue.resolveCodexExecutable({
        configuredPath: '',
        extensionRoots: openAiExtensionRoots(),
        platform: process.platform
      });
      if (!resolved.executable) throw new Error(resolved.error || 'Không tìm thấy Codex CLI để gọi updater chính thức.');
      executable = resolved.executable;
    }

    const env = { ...process.env, CODEX_HOME: config().codexHome };
    await execFilePromise(
      executable,
      ['app-server', 'daemon', 'update'],
      { env, timeout: 180000 }
    );

    const current = storedGatewaySettings();
    await applyGatewaySettings({
      ...current,
      httpHookEnabled: false,
      httpHookMutationEnabled: false
    });
    if (gateway) await gateway.httpHook.removeConfig(config().codexHome).catch(() => {});
    else await fs.promises.rm(
      path.join(config().codexHome, 'codex-session-tracker-http-hook.json'),
      { force: true }
    ).catch(() => {});
    await contextRef.globalState.update(HTTP_HOOK_INSTALL_KEY, undefined);

    gatewayActionNotice = {
      kind: 'success',
      text: 'Đã chuyển app-server daemon về production update channel và tắt plaintext hook. Đang reload VS Code...',
      at: Date.now()
    };
    postViewState();
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  } catch (error) {
    gatewayActionNotice = { kind: 'error', text: 'Khôi phục Codex chính thức thất bại: ' + friendlyError(error), at: Date.now() };
    postViewState();
  }
}

function trafficMonitorHtml() {
  const nonce = String(Date.now());
  const template = fs.readFileSync(path.join(__dirname, 'traffic_monitor.html'), 'utf8');
  return template.replaceAll('__NONCE__', nonce);
}

async function openTrafficMonitor() {
  if (trafficPanel) {
    trafficPanel.reveal(vscode.ViewColumn.Two, true);
    postTrafficState();
    return;
  }
  trafficPanel = vscode.window.createWebviewPanel(
    'codexSessionTracker.trafficMonitor',
    'Codex Traffic Monitor',
    vscode.ViewColumn.Two,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  trafficPanel.webview.html = trafficMonitorHtml();
  trafficPanel.onDidDispose(() => { trafficPanel = null; }, null, contextRef.subscriptions);
  trafficPanel.webview.onDidReceiveMessage(async message => {
    if (!message || typeof message !== 'object') return;
    if (message.command === 'refreshTraffic') postTrafficState();
    if (message.command === 'loadTrafficPayload') await sendTrafficPayload(message.traceId, message.offset);
  }, null, contextRef.subscriptions);
  postTrafficState();
}

function trafficGatewayState() {
  return {
    ...gatewayStatus,
    ...(gateway ? gateway.diagnostics() : {
      modelProxyConfigured: false,
      modelProxyReady: false,
      modelTrafficObserved: false,
      lastModelNetworkAt: 0,
      transportTrafficObserved: false,
      lastTransportNetworkAt: 0,
      websocketProxyReady: false,
      captureContent: false,
      captureMaxBytes: 0
    }),
    proxyEnvironmentApplied: gatewayProxyEnvApplied
  };
}

function postTrafficState() {
  if (!trafficPanel) return;
  trafficPanel.webview.postMessage({
    type: 'trafficState',
    data: {
      gateway: trafficGatewayState(),
      traffic: gateway ? gateway.trafficIndex(1000) : []
    }
  });
}

async function sendTrafficPayload(traceId, offset = 0) {
  const event = gateway && gateway.payloadByTraceId(traceId, { offset, limit: 512 * 1024 });
  if (!trafficPanel) return;
  trafficPanel.webview.postMessage({
    type: 'trafficPayload',
    payload: event || { traceId: Number(traceId || 0), missing: true }
  });
}

async function openTracker() {
  try { await vscode.commands.executeCommand('workbench.view.extension.codexSessionTrackerPanel'); } catch {}
  try { await vscode.commands.executeCommand('codexSessionTracker.view.focus'); } catch {}
  await refreshAll(true);
}

async function refreshAll(force) {
  await refreshActiveChats(force);
  await refreshTrackedStatus(force);
  if (trackerView && trackerView.visible) {
    await refreshQueueCapability(false);
    await refreshSteerCapability(false);
  }
  postViewState();
}

async function refreshActiveChats(force) {
  if (refreshingActive) return;
  if (!force && trackerView && !trackerView.visible) return;
  const cfg = config();
  const everyMs = Math.max(2000, Number(cfg.activeScanEverySeconds || 4) * 1000);
  if (!force && Date.now() - lastActiveScanAt < everyMs) return;

  refreshingActive = true;
  lastActiveScanAt = Date.now();
  try {
    const conversations = await tracker.scanConversationSessions({
      codexHome: cfg.codexHome,
      sessionsDir: cfg.sessionsDir,
      historyLimit: cfg.historyLimit,
      includeNonVsCodeSessions: cfg.includeNonVsCodeSessions,
      scanLimit: cfg.treeScanLimit,
      includeNonRunning: showNonRunning
    });
    activeChats = conversations.active;
    nonRunningChats = conversations.nonRunning;

    if (selected) {
      const activeSelected = activeChats.concat(nonRunningChats).find(chat => chat.threadId === selected.threadId);
      if (activeSelected) {
        selected.title = activeSelected.title || selected.title;
        selected.cwd = activeSelected.cwd || selected.cwd;
        selected.file = activeSelected.file || selected.file;
        selected.createdAt = activeSelected.createdAt || selected.createdAt;
        selected.status = activeSelected.status || selected.status;
        selected.indexedUpdatedAtMs = activeSelected.indexedUpdatedAtMs || selected.indexedUpdatedAtMs || 0;
        await persistSelection();
      }
    }
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      if (trackerView) trackerView.webview.postMessage({ type: 'error', message: friendlyError(error) });
    }
  } finally {
    refreshingActive = false;
  }
}

async function setShowNonRunning(enabled) {
  showNonRunning = enabled;
  if (!enabled) nonRunningChats = [];
  await refreshActiveChats(true);
  postViewState();
}

async function deleteChat(threadId) {
  if (deleteBusy) return;
  deleteBusy = true;
  deleteNotice = null;
  postViewState();
  try {
    const cfg = config();
    // A queued turn can make a listed chat active. Recheck all its nodes.
    const conversations = await tracker.scanConversationSessions({
      codexHome: cfg.codexHome,
      sessionsDir: cfg.sessionsDir,
      historyLimit: 1000,
      includeNonVsCodeSessions: cfg.includeNonVsCodeSessions,
      scanLimit: 10000,
      includeNonRunning: true
    });
    const session = conversations.nonRunning.find(chat => chat.threadId === threadId);
    if (!session) throw new Error(conversations.active.some(chat => chat.threadId === threadId)
      ? 'Chat đang chạy, không thể xóa.' : 'Không tìm thấy chat không chạy này. Hãy làm mới danh sách.');
    const snapshotOptions = { scanLimit: 10000, codexHome: cfg.codexHome, timelineLimit: 10, activityMaxBytes: 128 * 1024 };
    const tree = await tracker.scanSessionTree(cfg.sessionsDir, session, { scanLimit: 10000 });
    const snapshot = await tracker.buildSessionSnapshot(cfg.sessionsDir, session, { ...snapshotOptions, tree });
    if (snapshot.overallStatus.kind === 'running') throw new Error('Chat vừa chạy lại, không thể xóa.');
    const answer = await vscode.window.showWarningMessage(
      `Xóa vĩnh viễn cuộc trò chuyện “${humanChatTitle(session)}” khỏi Codex?`,
      { modal: true }, 'Xóa chat'
    );
    if (answer !== 'Xóa chat') return;
    // The confirmation can stay open while a new turn starts.
    const latestTree = await tracker.scanSessionTree(cfg.sessionsDir, session, { scanLimit: 10000 });
    const latestSnapshot = await tracker.buildSessionSnapshot(cfg.sessionsDir, session, { ...snapshotOptions, tree: latestTree });
    if (latestSnapshot.overallStatus.kind === 'running') throw new Error('Chat vừa chạy lại, không thể xóa.');
    const resolved = await codexQueue.resolveCodexExecutable({
      configuredPath: cfg.codexCliPath,
      extensionRoots: openAiExtensionRoots()
    });
    if (!resolved.executable) throw new Error(resolved.error || 'Không tìm thấy Codex CLI để xóa chat.');
    await codexDelete.deleteThread({ executable: resolved.executable, codexHome: cfg.codexHome, threadId });
    if (selected && selected.threadId === threadId) await clearSelection();
    deleteNotice = { kind: 'success', text: 'Đã xóa chat khỏi Codex.', at: Date.now() };
    await refreshAll(true);
  } catch (error) {
    deleteNotice = { kind: 'error', text: friendlyError(error), at: Date.now() };
  } finally {
    deleteBusy = false;
    postViewState();
  }
}

async function selectThread(threadId) {
  let session = activeChats.concat(nonRunningChats).find(chat => chat.threadId === threadId) || null;
  if (!session) {
    const cfg = config();
    session = await tracker.findLatestRolloutForThread(cfg.sessionsDir, threadId, { scanLimit: cfg.treeScanLimit });
  }
  if (!session) return;

  const cfg = config();
  const names = await tracker.readThreadNames(cfg.codexHome, new Set([session.threadId]));
  const indexed = names.get(session.threadId);
  const stateTimes = tracker.readStateThreadActivity(cfg.codexHome, new Set([session.threadId]));
  selected = {
    threadId: session.threadId,
    sessionId: session.sessionId || session.threadId,
    file: session.file,
    title: indexed && indexed.name ? indexed.name : session.title,
    cwd: session.cwd,
    source: session.source,
    createdAt: session.createdAt || '',
    status: session.status || null,
    indexedUpdatedAtMs: Math.max(parseDateMs(indexed && indexed.updatedAt), stateTimes.get(session.threadId) || 0)
  };
  selectedTree = [];
  latestSnapshot = null;
  queueNotice = null;
  steerNotice = null;
  steerCapability = { checked: false, available: false, reason: 'Chưa kiểm tra owner IPC của chat.', executable: '', source: '', version: '' };
  steerCapabilityCheckedAt = 0;
  steerCapabilityConversationId = '';
  lastTreeRescanAt = 0;
  await persistSelection();
  renderStatus();
  await refreshTrackedStatus(true);
  postViewState();
}

async function clearSelection() {
  selected = null;
  selectedTree = [];
  latestSnapshot = null;
  queueNotice = null;
  steerNotice = null;
  steerCapability = { checked: false, available: false, reason: 'Chưa kiểm tra owner IPC của chat.', executable: '', source: '', version: '' };
  steerCapabilityCheckedAt = 0;
  steerCapabilityConversationId = '';
  await persistSelection();
  renderStatus();
  postViewState();
}

async function refreshTrackedStatus(forceRescan) {
  if (!selected || refreshingSelected) {
    if (!selected) renderStatus();
    return;
  }

  refreshingSelected = true;
  try {
    const cfg = config();
    const rescanEveryMs = Math.max(2000, Number(cfg.rescanThreadEverySeconds || 5) * 1000);
    const shouldRescan = forceRescan || !selected.file || Date.now() - lastTreeRescanAt >= rescanEveryMs;

    if (shouldRescan || selectedTree.length === 0) {
      lastTreeRescanAt = Date.now();
      selectedTree = await tracker.scanSessionTree(cfg.sessionsDir, selected, { scanLimit: cfg.treeScanLimit });
      const latestRoot = selectedTree.find(node => node.threadId === selected.threadId);
      if (latestRoot) {
        selected.file = latestRoot.file || selected.file;
        selected.sessionId = latestRoot.sessionId || selected.threadId;
        selected.cwd = latestRoot.cwd || selected.cwd;
        selected.source = latestRoot.source || selected.source;
      }
      const names = await tracker.readThreadNames(cfg.codexHome, new Set([selected.threadId]));
      const indexed = names.get(selected.threadId);
      if (indexed && indexed.name) selected.title = indexed.name;
      const stateTimes = tracker.readStateThreadActivity(cfg.codexHome, new Set([selected.threadId]));
      selected.indexedUpdatedAtMs = Math.max(
        selected.indexedUpdatedAtMs || 0,
        parseDateMs(indexed && indexed.updatedAt),
        stateTimes.get(selected.threadId) || 0
      );
      await persistSelection();
    }

    if (!selected.file) {
      selected.status = { kind: 'missing', mtimeMs: 0 };
      renderStatus();
      return;
    }

    await fs.promises.access(selected.file, fs.constants.R_OK);
    const snapshot = await tracker.buildSessionSnapshot(cfg.sessionsDir, selected, {
      scanLimit: cfg.treeScanLimit,
      tree: selectedTree,
      activityMaxBytes: Math.max(1, Number(cfg.activityTailMb || 6)) * 1024 * 1024,
      timelineLimit: cfg.timelineLimit,
      timelinePerNode: Math.max(20, Math.ceil(Number(cfg.timelineLimit || 50) / 2)),
      codexHome: cfg.codexHome,
      indexedActivity: new Map([[selected.threadId, selected.indexedUpdatedAtMs || 0]])
    });
    latestSnapshot = snapshot;
    selected.status = snapshot.overallStatus;
    if (gateway) await gateway.refreshLocalPersistence(selected.threadId, selected.file).catch(() => {});
    renderStatus();
  } catch (error) {
    if (error && error.code === 'ENOENT') selected.status = { kind: 'missing', mtimeMs: 0 };
    else selected.status = { kind: 'unknown', mtimeMs: 0, error };
    renderStatus();
    if (trackerView) trackerView.webview.postMessage({ type: 'error', message: friendlyError(error) });
  } finally {
    refreshingSelected = false;
  }
}


function isOpenAiCodexExtension(extension) {
  const id = String(extension && extension.id || '').toLowerCase();
  const pkg = extension && extension.packageJSON || {};
  const publisher = String(pkg.publisher || '').toLowerCase();
  const name = String(pkg.name || '').toLowerCase();
  return id === 'openai.chatgpt'
    || (publisher === 'openai' && (name.includes('chatgpt') || name.includes('codex')))
    || (id.startsWith('openai.') && (id.includes('chatgpt') || id.includes('codex')));
}

function openAiExtensionRuntime() {
  for (const extension of vscode.extensions.all || []) {
    if (isOpenAiCodexExtension(extension)) {
      return {
        id: String(extension.id || ''),
        version: String(extension.packageJSON && extension.packageJSON.version || ''),
        path: String(extension.extensionPath || '')
      };
    }
  }
  return { id: '', version: '', path: '' };
}

async function exportGatewayDiagnostics() {
  const activeGateway = gateway || await startGateway();
  if (!activeGateway) {
    vscode.window.showWarningMessage('Gateway đang tắt nên chưa có dữ liệu chẩn đoán để xuất.');
    return;
  }
  const runtime = openAiExtensionRuntime();
  const snapshot = activeGateway.exportSnapshot({
    codexExtension: { id: runtime.id, version: runtime.version },
    codexCliVersion: queueCapability.version || ''
  });
  const target = await vscode.window.showSaveDialog({
    title: 'Xuất chẩn đoán Codex Gateway',
    filters: { JSON: ['json'] },
    defaultUri: vscode.Uri.file(path.join(
      contextRef.globalStorageUri.fsPath,
      `codex-gateway-diagnostic-${Date.now()}.json`
    ))
  });
  if (!target) return;
  await fs.promises.mkdir(path.dirname(target.fsPath), { recursive: true });
  await fs.promises.writeFile(target.fsPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
  vscode.window.showInformationMessage('Đã xuất chẩn đoán Gateway đã lọc dữ liệu nhạy cảm.');
}

function openAiExtensionRoots() {
  const roots = [];
  for (const extension of vscode.extensions.all || []) {
    if (isOpenAiCodexExtension(extension) && extension.extensionPath) roots.push(extension.extensionPath);
  }
  return Array.from(new Set(roots));
}

async function refreshQueueCapability(force) {
  const now = Date.now();
  if (!force && queueCapability.checked && now - queueCapabilityCheckedAt < 60_000) return queueCapability;
  queueCapabilityCheckedAt = now;
  const cfg = config();
  try {
    const resolved = await codexQueue.resolveCodexExecutable({
      configuredPath: cfg.codexCliPath,
      extensionRoots: openAiExtensionRoots(),
      platform: process.platform
    });
    if (!resolved.executable) {
      queueCapability = {
        checked: true,
        available: false,
        executable: '',
        source: resolved.source || '',
        version: '',
        reason: resolved.error || 'Không tìm thấy Codex CLI.'
      };
      return queueCapability;
    }
    const probe = await codexQueue.probeQueueSupport(resolved.executable);
    queueCapability = {
      checked: true,
      available: Boolean(probe.available),
      executable: resolved.executable,
      source: resolved.source || '',
      version: probe.version || '',
      reason: probe.reason || ''
    };
  } catch (error) {
    queueCapability = {
      checked: true,
      available: false,
      executable: '',
      source: '',
      version: '',
      reason: codexQueue.compactError(error)
    };
  }
  return queueCapability;
}

async function refreshSteerCapability(force) {
  const now = Date.now();
  const conversationId = String(selected && selected.threadId || '').trim();
  if (!force && steerCapability.checked && steerCapabilityConversationId === conversationId && now - steerCapabilityCheckedAt < 60_000) return steerCapability;
  steerCapabilityCheckedAt = now;
  steerCapabilityConversationId = conversationId;
  const cfg = config();
  try {
    const probe = await codexSteer.probeExtensionIpcSupport({
      codexHome: cfg.codexHome,
      threadId: conversationId
    });
    steerCapability = {
      checked: true,
      available: Boolean(probe.available),
      executable: '',
      source: probe.source || '',
      version: '',
      ownerClientId: probe.ownerClientId || '',
      reason: probe.reason || ''
    };
  } catch (error) {
    steerCapability = {
      checked: true,
      available: false,
      executable: '',
      source: '',
      version: '',
      ownerClientId: '',
      reason: codexSteer.compactError(error)
    };
  }
  return steerCapability;
}

async function sendQueuedMessage(rawText, rawImages) {
  const text = String(rawText || '').trim();
  if (rawImages && (!Array.isArray(rawImages) || rawImages.length)) {
    queueNotice = { kind: 'error', text: 'Gửi sau hiện chỉ hỗ trợ văn bản. Hãy dùng Steer ngay để gửi ảnh.', at: Date.now() };
    postViewState();
    return;
  }
  if (!text) return;
  if (!selected) {
    queueNotice = { kind: 'error', text: 'Chưa chọn chat Codex.', at: Date.now() };
    postViewState();
    return;
  }
  // Refresh the rollout immediately before enqueueing. This avoids sending to
  // a turn that became terminal while the composer was left open.
  await refreshTrackedStatus(true);
  if (!selected.status || selected.status.kind !== 'running') {
    queueNotice = { kind: 'error', text: 'Chat này không còn chạy nên tracker không gửi vào hàng chờ.', at: Date.now() };
    postViewState();
    return;
  }
  await refreshQueueCapability(false);
  if (!queueCapability.available || !queueCapability.executable) {
    queueNotice = { kind: 'error', text: queueCapability.reason || 'Codex CLI không hỗ trợ queue.', at: Date.now() };
    postViewState();
    return;
  }

  queueBusy = true;
  queueNotice = null;
  postViewState();
  const queueArgs = () => ({
    executable: queueCapability.executable,
    threadId: selected.threadId,
    message: text,
    codexHome: config().codexHome,
    cwd: selected.cwd || undefined
  });
  try {
    let result;
    try {
      const activeGateway = gateway || await startGateway();
      result = activeGateway
        ? await activeGateway.queue({ threadId: selected.threadId, message: text, cwd: selected.cwd || undefined })
        : await codexQueue.queueMessage(queueArgs());
    } catch (error) {
      // An extension update can leave a cached path pointing at a removed
      // binary. Re-probe once on ENOENT and retry with the newly selected
      // platform-matched executable; never duplicate a successful enqueue.
      if (!error || error.code !== 'ENOENT') throw error;
      const previous = queueCapability.executable;
      await refreshQueueCapability(true);
      if (!queueCapability.available || !queueCapability.executable || queueCapability.executable === previous) throw error;
      const activeGateway = gateway || await startGateway();
      result = activeGateway
        ? await activeGateway.queue({ threadId: selected.threadId, message: text, cwd: selected.cwd || undefined })
        : await codexQueue.queueMessage(queueArgs());
    }
    queueNotice = {
      kind: 'success',
      text: result.queuedId ? 'Đã xếp tin nhắn vào đúng chat.' : 'Đã gửi tin nhắn vào hàng chờ của chat.',
      queuedId: result.queuedId || '',
      at: Date.now()
    };
  } catch (error) {
    queueNotice = { kind: 'error', text: codexQueue.compactError(error), at: Date.now() };
  } finally {
    queueBusy = false;
    postViewState();
  }
}

async function sendSteeredMessage(rawText, rawImages) {
  const text = String(rawText || '').trim();
  let images;
  try { images = codexSteer.normalizeImageAttachments(rawImages); }
  catch (error) {
    steerNotice = { kind: 'error', text: codexSteer.compactError(error), at: Date.now() };
    postViewState();
    return;
  }
  if ((!text && !images.length) || steerBusy || queueBusy) return;
  if (!selected) {
    steerNotice = { kind: 'error', text: 'Chưa chọn chat Codex.', at: Date.now() };
    postViewState();
    return;
  }
  // Re-read lifecycle state immediately before steering.
  await refreshTrackedStatus(true);
  if (!selected.status || selected.status.kind !== 'running') {
    steerNotice = { kind: 'error', text: 'Chat này không còn chạy nên tracker không steer.', at: Date.now() };
    postViewState();
    return;
  }
  steerBusy = true;
  steerNotice = null;
  postViewState();
  const steerArgs = () => ({
    threadId: selected.threadId,
    message: text,
    images,
    codexHome: config().codexHome,
    cwd: selected.cwd || undefined
  });
  try {
    const activeGateway = gateway || await startGateway();
    const result = activeGateway
      ? await activeGateway.steer({ ...steerArgs(), rolloutFile: selected.file || '' })
      : await codexSteer.steerViaExtensionIpc(steerArgs());
    steerNotice = {
      kind: 'success',
      text: result && result.turnId ? 'Codex local đã nhận steer vào turn đang chạy; chưa đồng nghĩa server đã nhận.' : 'Codex local đã nhận steer; chưa đồng nghĩa server đã nhận.',
      turnId: result && result.turnId || '',
      gatewayCommandId: result && result.gatewayCommandId || '',
      clientUserMessageId: result && result.clientUserMessageId || '',
      at: Date.now()
    };
    await refreshTrackedStatus(true);
  } catch (error) {
    const detail = codexSteer.compactError(error);
    const unknown = error && error.delivery === 'unknown';
    steerNotice = {
      kind: unknown ? 'unknown' : 'error',
      text: unknown
        ? 'Codex chưa xác nhận đã nhận tin. Kiểm tra chat trước khi thử lại để tránh gửi trùng. ' + detail
        : detail,
      delivery: error && error.delivery || '',
      at: Date.now()
    };
  } finally {
    steerBusy = false;
    postViewState();
  }
}

function humanChatTitle(session) {
  return tracker.cleanTitle(session && session.title || '', 80)
    || path.basename(session && session.cwd || '')
    || 'Codex chat';
}

function postViewState() {
  postTrafficState();
  if (!trackerView) return;
  trackerView.webview.postMessage({
    type: 'state',
    data: {
      activeChats: activeChats.map(serializeActiveChat),
      nonRunningChats: nonRunningChats.map(serializeActiveChat),
      showNonRunning,
      gateway: {
        ...gatewayStatus,
        ...(gateway ? gateway.diagnostics() : {
          modelProxyConfigured: false,
          modelProxyReady: false,
          modelTrafficObserved: false,
          lastModelNetworkAt: 0,
          transportTrafficObserved: false,
          lastTransportNetworkAt: 0,
          websocketProxyReady: false,
          captureContent: false,
          captureMaxBytes: 0
        }),
        proxyEnvironmentApplied: gatewayProxyEnvApplied,
        commands: gatewayThreadDiagnostics(),
        traffic: [],
        settings: gatewaySettingsSnapshot(),
        managedConfig: gatewayManagedState,
        actionNotice: gatewayActionNotice,
        extensionRuntime: (() => { const runtime = openAiExtensionRuntime(); return { id: runtime.id, version: runtime.version }; })(),
        cliVersion: queueCapability.version || ''
      },
      deleteChat: { busy: deleteBusy, notice: deleteNotice },
      selectedThreadId: selected && selected.threadId || '',
      selected: selected && latestSnapshot ? serializeSnapshot(latestSnapshot) : (selected ? serializeSelectedShell() : null),
      queue: {
        checked: Boolean(queueCapability.checked),
        available: Boolean(queueCapability.available),
        busy: queueBusy,
        reason: queueCapability.reason || '',
        source: queueCapability.source || '',
        version: queueCapability.version || '',
        notice: queueNotice
      },
      steer: {
        checked: Boolean(steerCapability.checked),
        available: Boolean(steerCapability.available),
        busy: steerBusy,
        reason: steerCapability.reason || '',
        source: steerCapability.source || '',
        version: steerCapability.version || '',
        ownerClientId: steerCapability.ownerClientId || '',
        notice: steerNotice
      }
    }
  });
}

function serializeActiveChat(chat) {
  return {
    threadId: chat.threadId,
    title: humanChatTitle(chat),
    cwd: chat.cwd || '',
    createdAt: parseDateMs(chat.createdAt),
    lastActivity: Math.max(chat.mtimeMs || 0, chat.indexedUpdatedAtMs || 0),
    runningChildren: chat.status && chat.status.runningChildren || 0,
    runningCount: chat.status && chat.status.runningCount || 0,
    stateKind: chat.status && chat.status.kind || 'unknown',
    state: displayState(chat.status || { kind: 'unknown' })
  };
}

function serializeSelectedShell() {
  return {
    title: selected.title,
    threadId: selected.threadId,
    cwd: selected.cwd,
    createdAt: parseDateMs(selected.createdAt),
    state: displayState(selected.status || { kind: 'unknown' }),
    stateKind: selected.status && selected.status.kind || 'unknown',
    activeTurnId: selected.status && selected.status.turnId || '',
    lastActivityMs: Math.max(selected.status && selected.status.mtimeMs || 0, selected.indexedUpdatedAtMs || 0),
    current: null,
    latestUserText: '',
    latestUserTextAt: 0,
    latestUserImages: [],
    latestAssistantText: '',
    latestAssistantTextAt: 0,
    timeline: [],
    activeNodes: [],
    truncated: false
  };
}

function serializeSnapshot(snapshot) {
  const activeNodes = (snapshot.activeNodes || snapshot.nodes.filter(node => node.status && node.status.kind === 'running'))
    .slice()
    .sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
  const timeline = (snapshot.timeline || [])
    .slice()
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .map((item, index) => ({
      id: `${item.threadId || ''}:${item.type || item.kind || ''}:${item.callId || ''}:${item.at || 0}:${index}`,
      kind: String(item.kind || 'activity'),
      type: String(item.type || ''),
      phase: String(item.phase || ''),
      label: localizeActivity(item.label),
      detail: String(item.detail || ''),
      text: String(item.text || ''),
      images: Array.isArray(item.images) ? item.images : [],
      children: Array.isArray(item.children) ? item.children.slice(0, 100).map(child => ({
        label: String(child && child.label || ''),
        detail: String(child && child.detail || ''),
        at: Number.isFinite(child && child.at) ? child.at : (Number.isFinite(item.at) ? item.at : 0)
      })) : [],
      actor: String(item.actor || 'Main'),
      threadId: String(item.threadId || ''),
      callId: String(item.callId || ''),
      at: Number.isFinite(item.at) ? item.at : 0,
      terminal: Boolean(item.terminal)
    }));
  const latestEventAt = timeline.reduce((latest, item) => Math.max(latest, Number(item.at) || 0), 0);
  const statusAt = snapshot.overallStatus && (snapshot.overallStatus.completedAt || snapshot.overallStatus.mtimeMs) || 0;
  return {
    title: selected.title,
    threadId: selected.threadId,
    cwd: selected.cwd,
    createdAt: parseDateMs(selected.createdAt || snapshot.root && snapshot.root.createdAt),
    state: displayState(snapshot.overallStatus),
    stateKind: snapshot.overallStatus.kind,
    activeTurnId: String(snapshot.root && snapshot.root.status && snapshot.root.status.turnId || snapshot.overallStatus && snapshot.overallStatus.turnId || ''),
    lastActivityMs: Math.max(
      latestEventAt,
      Number(statusAt) || 0,
      snapshot.latestMtime || 0,
      snapshot.latestIndexedActivityMs || 0,
      selected.indexedUpdatedAtMs || 0
    ),
    lastActivitySource: snapshot.lastActivitySource || 'rollout-event',
    current: snapshot.current ? {
      label: localizeActivity(snapshot.current.label),
      detail: snapshot.current.detail || '',
      actor: snapshot.current.actor || 'Root',
      at: snapshot.current.at || 0,
      text: snapshot.current.text || ''
    } : null,
    latestUserText: snapshot.latestUserText || '',
    latestUserTextAt: Number(snapshot.latestUserTextAt) || 0,
    latestUserImages: snapshot.latestUserImages || [],
    latestAssistantText: snapshot.latestAssistantText || '',
    latestAssistantTextAt: Number(snapshot.latestAssistantTextAt) || 0,
    timeline,
    completedSummary: snapshot.completedSummary ? {
      count: Number(snapshot.completedSummary.count) || 0,
      childCount: Number(snapshot.completedSummary.childCount) || 0,
      errorCount: Number(snapshot.completedSummary.errorCount) || 0,
      latestAt: Number(snapshot.completedSummary.latestAt) || 0
    } : null,
    activeNodes: activeNodes.map(node => ({
      threadId: node.threadId,
      actor: node.displayName || (node.threadId === selected.threadId ? 'Main' : 'Sub-agent'),
      role: node.agentRole || '',
      nickname: node.agentNickname || '',
      state: displayState(node.status || { kind: 'unknown' }),
      current: node.current ? localizeActivity(node.current.label) : '',
      currentDetail: node.current && node.current.detail || '',
      currentText: node.current && node.current.text || '',
      currentAt: node.current && Number.isFinite(node.current.at) ? node.current.at : 0,
      taskPreview: node.taskPreview || '',
      updatedAt: Math.max(node.mtimeMs || 0, node.indexedUpdatedAtMs || 0)
    })),
    truncated: Boolean(snapshot.truncated)
  };
}

function parseDateMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
  if (!value) return 0;
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? (numeric > 1e12 ? numeric : numeric * 1000) : 0;
}

function localizeActivity(label) {
  const map = {
    'Bat dau turn': '\u0110ang b\u1eaft \u0111\u1ea7u turn',
    'Turn hoan tat': 'Turn \u0111\u00e3 ho\u00e0n t\u1ea5t',
    'Turn ket thuc voi loi': 'Turn k\u1ebft th\u00fac v\u1edbi l\u1ed7i',
    'Turn da dung': 'Turn \u0111\u00e3 d\u1eebng',
    'Loi': 'L\u1ed7i',
    'Canh bao': 'C\u1ea3nh b\u00e1o',
    'Dang suy nghi': '\u0110ang suy ngh\u0129',
    'Dang tra loi': '\u0110ang tr\u1ea3 l\u1eddi',
    'Da tra loi': '\u0110\u00e3 tr\u1ea3 l\u1eddi',
    'Nguoi dung gui': 'Ng\u01b0\u1eddi d\u00f9ng g\u1eedi',
    'Dang chay lenh': '\u0110ang ch\u1ea1y l\u1ec7nh',
    'Lenh da xong': 'L\u1ec7nh \u0111\u00e3 xong',
    'Da chay lenh': '\u0110\u00e3 ch\u1ea1y l\u1ec7nh',
    'Lenh that bai': 'L\u1ec7nh th\u1ea5t b\u1ea1i',
    'Dang tuong tac terminal': '\u0110ang t\u01b0\u01a1ng t\u00e1c terminal',
    'Dang sua code': '\u0110ang s\u1eeda code',
    'Sua code that bai': 'S\u1eeda code th\u1ea5t b\u1ea1i',
    'Da sua code': '\u0110\u00e3 s\u1eeda code',
    'Da chinh sua cac tep': '\u0110\u00e3 ch\u1ec9nh s\u1eeda c\u00e1c t\u1ec7p',
    'Sua tep that bai': 'S\u1eeda t\u1ec7p th\u1ea5t b\u1ea1i',
    'Dang goi MCP': '\u0110ang g\u1ecdi MCP',
    'MCP da xong': 'MCP \u0111\u00e3 xong',
    'Dang goi tool': '\u0110ang g\u1ecdi tool',
    'Tool da xong': 'Tool \u0111\u00e3 xong',
    'Dang tim web': '\u0110ang t\u00ecm web',
    'Tim web da xong': 'T\u00ecm web \u0111\u00e3 xong',
    'Dang tao anh': '\u0110ang t\u1ea1o \u1ea3nh',
    'Tao anh da xong': 'T\u1ea1o \u1ea3nh \u0111\u00e3 xong',
    'Da xem anh': '\u0110\u00e3 xem 1 \u1ea3nh',
    'Dang cho phep': '\u0110ang ch\u1edd c\u1ea5p quy\u1ec1n',
    'Dang cho ban tra loi': '\u0110ang ch\u1edd b\u1ea1n tr\u1ea3 l\u1eddi',
    'Loi stream / dang thu lai': 'L\u1ed7i stream / \u0111ang th\u1eed l\u1ea1i',
    'Dang tao sub-agent': '\u0110ang t\u1ea1o sub-agent',
    'Da tao sub-agent': '\u0110\u00e3 t\u1ea1o sub-agent',
    'Dang tuong tac sub-agent': '\u0110ang t\u01b0\u01a1ng t\u00e1c sub-agent',
    'Sub-agent phan hoi': 'Sub-agent ph\u1ea3n h\u1ed3i',
    'Dang cho sub-agent': '\u0110ang ch\u1edd sub-agent',
    'Da nhan sub-agent': '\u0110\u00e3 nh\u1eadn sub-agent',
    'Dang dong sub-agent': '\u0110ang \u0111\u00f3ng sub-agent',
    'Da dong sub-agent': '\u0110\u00e3 \u0111\u00f3ng sub-agent',
    'Dang resume sub-agent': '\u0110ang resume sub-agent',
    'Da resume sub-agent': '\u0110\u00e3 resume sub-agent',
    'Dang chay hook': '\u0110ang ch\u1ea1y hook',
    'Hook da xong': 'Hook \u0111\u00e3 xong',
    'Dang xu ly': '\u0110ang x\u1eed l\u00fd',
    'Da hoan tat': '\u0110\u00e3 ho\u00e0n t\u1ea5t',
    'Da dung voi loi': '\u0110\u00e3 d\u1eebng v\u1edbi l\u1ed7i',
    'Dang ranh': '\u0110ang r\u1ea3nh'
  };
  return map[label] || label || '';
}

function renderStatus() {
  if (!statusBar) return;
  statusBar.backgroundColor = undefined;

  if (!selected) {
    statusBar.color = undefined;
    statusBar.text = '$(radio-tower) Codex Tracker';
    statusBar.tooltip = new vscode.MarkdownString('**Codex Session Tracker**\n\nClick to show running Codex chats.');
    statusBar.show();
    return;
  }

  const status = selected.status || { kind: 'unknown', mtimeMs: 0 };
  const tone = tracker.statusBarTone(status);
  if (tone === 'running') statusBar.color = new vscode.ThemeColor('testing.iconPassed');
  else if (tone === 'stopped') statusBar.color = new vscode.ThemeColor('testing.iconFailed');
  else statusBar.color = undefined;

  const icon = iconFor(status.kind);
  const title = tracker.cleanTitle(selected.title, 34) || path.basename(selected.cwd || '') || 'Codex';
  const suffix = status.kind === 'running' && status.runningChildren ? ` +${status.runningChildren}` : '';
  statusBar.text = `$(${icon}${status.kind === 'running' ? '~spin' : ''}) ${title}${suffix}`;
  statusBar.tooltip = tooltipForSelection(selected, status);
  statusBar.show();
}

function displayState(status) {
  const kind = status && status.kind ? status.kind : 'unknown';
  if (kind === 'running') return 'Running';
  if (kind === 'completed') return 'Completed';
  if (kind === 'error') return 'Error';
  if (kind === 'aborted') return 'Aborted';
  if (kind === 'idle') return 'Idle';
  if (kind === 'missing') return 'Chat file missing';
  return 'Unknown';
}

function iconFor(kind) {
  if (kind === 'running') return 'sync';
  if (kind === 'completed') return 'check';
  if (kind === 'error') return 'error';
  if (kind === 'aborted') return 'circle-slash';
  if (kind === 'idle') return 'circle-outline';
  if (kind === 'missing') return 'warning';
  return 'question';
}

function tooltipForSelection(session, status) {
  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  md.appendMarkdown(`**${escapeMarkdown(session.title)}**\n\n`);
  md.appendMarkdown(`- **State:** ${escapeMarkdown(displayState(status))}\n`);
  if (status.runningChildren) md.appendMarkdown(`- **Running child agents:** ${status.runningChildren}\n`);
  if (session.cwd) md.appendMarkdown(`- **Workspace:** \`${escapeInlineCode(session.cwd)}\`\n`);
  if (status.mtimeMs) md.appendMarkdown(`- **Last activity:** ${escapeMarkdown(tracker.formatRelativeTime(status.mtimeMs))}\n`);
  md.appendMarkdown('\nClick to open the tracker panel.');
  return md;
}

function dashboardHtml() {
  const nonce = String(Date.now());
  const template = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
  return template.replaceAll('__NONCE__', nonce);
}

function escapeMarkdown(value) {
  return String(value || '').replace(/[\\`*_{}\[\]()#+\-.!]/g, '\\$&');
}

function escapeInlineCode(value) {
  return String(value || '').replace(/`/g, '\\`');
}

function friendlyError(error) {
  if (!error) return 'Unknown error';
  if (error.code === 'ENOENT') return 'Codex sessions directory was not found. Check Codex home in Settings.';
  return error.message || String(error);
}

module.exports = { activate, deactivate };
