'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const tracker = require('./tracker');
const codexQueue = require('./codex_queue');
const codexSteer = require('./codex_steer');
const { ensureOwnerBridge } = require('./codex_owner_bridge');
const { disposeOwnerBridges, continueInLocalBackend, readAccountInLocalBackend, readRateLimitsInLocalBackend } = require('./codex_live_backend');
const { createUsageMonitor, intervalMinutes, usageIntervalError, usageStatus, accountKeyFromResult } = require('./codex_usage');
const { normalizeUsageAlertSettings, evaluateUsageAlerts, usageAlertSummary } = require('./codex_usage_alerts');
const codexDelete = require('./codex_delete');
const codexAuth = require('./codex_auth');
const { createConversationNavigator } = require('./codex_navigation');
const { createCurrentChatTracker } = require('./codex_current_chat');
const { createLocalProxyController, restartExecutable } = require('./local_proxy');
const { createProxyWatchdog, thresholdError } = require('./proxy_watchdog');
const { createProxyRecovery } = require('./proxy_recovery');
const { createErrorHistory, createRetryLimitMonitor } = require('./codex_error_alerts');
const { DEFAULT_ERROR_SOUND, DEFAULT_MODEL_CAPACITY_SOUND, createErrorSoundController } = require('./codex_error_sound');
const openCodexConversation = createConversationNavigator(vscode);
const { CodexGateway } = require('./gateway');
const gatewayConfig = require('./gateway/config_manager');
const { NativeInstrumentation, discoverOwners } = require('./gateway/native_instrumentation');
const runtimeVersions = require('./runtime_versions');
const clientRuntime = require('./gateway/client_runtime');
const {SavedTraffic}=require('./gateway/saved_traffic');
const TRAFFIC_SETTINGS_KEY='codexSessionTracker.trafficSettings.v1';
const USAGE_INTERVAL_KEY = 'codexSessionTracker.usageIntervalMinutes.v1';
const USAGE_ALERT_SETTINGS_KEY = 'codexSessionTracker.usageAlertSettings.v1';
const USAGE_ALERT_STATE_KEY = 'codexSessionTracker.usageAlertState.v1';
const LOCAL_PROXY_KEY = 'codexSessionTracker.localProxyExecutable.v1';
let localProxy = null;
let localProxyPicker = null;
let proxyWatchdog = null;
let proxyRecovery = null;
const PROXY_WATCHDOG_KEY = 'codexSessionTracker.proxyWatchdog.v1';
const PROXY_ATTEMPT_KEY = 'codexSessionTracker.proxyLastAttempt.v1';
const PROXY_RESTART_KEY = 'codexSessionTracker.proxyLastRestart.v1';
const PROXY_RECOVERY_KEY = 'codexSessionTracker.proxyRecovery.v1';
const ERROR_MONITOR_KEY = 'codexSessionTracker.retryErrorMonitor.v1';
const ERROR_SOUND_KEY = 'codexSessionTracker.errorSoundFile.v1';
const CAPACITY_SOUND_KEY = 'codexSessionTracker.modelCapacitySoundFile.v1';
const USER_INPUT_SOUND_KEY = 'codexSessionTracker.userInputSoundFile.v1';
let errorMonitor = null;
let errorHistory = null;
let errorSound = null;
let usageMonitor = null;
let usageStatusBar = null;
let usageAlertSettings = null;
let usageAlertState = null;
let usageAlertCheckedAt = 0;
let usageAlertPromise = Promise.resolve();
let trafficSettings={directory:path.join(require('os').homedir(),'Documents','Codex Logs'),enabled:true,mode:'post-get',maxRequests:1000};
let savedTraffic=null;

let contextRef = null;
let statusBar = null;
let trackerView = null;
let currentChatTracker = null;
let codexCurrentThreadId = '';
let trafficPanel = null;
let pollTimer = null;
let selected = null;
let selectionRequestId = 0;
let selectedTree = [];
let latestSnapshot = null;
let activeChats = [];
let nonRunningChats = [];
let showNonRunning = false;
let deleteBusy = false;
let deleteNotice = null;
let authSessionBusy = false;
let authSessionNotice = null;
let authSessionReloadRequired = false;
let authAccount = { label: 'Đang tải...', signedIn: null };
let authAccountRefreshing = false;
let authAccountCheckedAt = 0;
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
let continueBusy = false;
let continueNotice = null;
let ownerBridgePromise = null;
let ownerBridgeNotice = '';
let ownerBridgeTimer = null;

async function prepareOwnerBridge() {
  if (ownerBridgePromise) return ownerBridgePromise;
  const extension = vscode.extensions.getExtension('openai.chatgpt');
  if (!extension?.isActive) return;
  ownerBridgePromise = ensureOwnerBridge(extension.extensionPath)
    .then(() => { ownerBridgeNotice = ''; })
    .catch(error => { ownerBridgeNotice = error.message; })
    .finally(() => { ownerBridgePromise = null; });
  return ownerBridgePromise;
}
let gateway = null;
let nativeHook = null;
let nativeHookOwners = [];
let nativeHookNotice = '';
let clientHookNotice = '';
const CLIENT_HOOK_RULES_KEY='codexSessionTracker.clientJsonRules.v1';
let gatewayStatus = { enabled: false, running: false, error: '', address: null };
let gatewayManagedState = { active: false, managed: false, drifted: false };
let gatewayActionNotice = null;
const GATEWAY_SETTINGS_KEY = 'codexSessionTracker.gatewaySettings.v1';
const ORIGINAL_PROXY_ENV = Object.fromEntries(
  ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy']
    .map(key => [key, process.env[key]])
);
let gatewayProxyEnvApplied = false;

async function activate(context) {
  contextRef = context;
  startErrorMonitoring(context);
  localProxy = createLocalProxyController({
    executablePath: context.globalState.get(LOCAL_PROXY_KEY, ''),
    lastRestart: context.globalState.get(PROXY_RESTART_KEY),
    save: value => context.globalState.update(LOCAL_PROXY_KEY, value),
    saveRestart: value => context.globalState.update(PROXY_RESTART_KEY, value),
    restart: async executable => {
      const observation = await readProxyObservation();
      await proxyRecovery.prepare(observation);
      await proxyWatchdog.recordAttempt();
      await proxyRecovery.arm();
      return restartExecutable(executable, { originalProxyEnv: ORIGINAL_PROXY_ENV });
    },
    onChange: () => postViewState()
  });
  proxyRecovery = createProxyRecovery({
    plan: context.globalState.get(PROXY_RECOVERY_KEY),
    save: plan => context.globalState.update(PROXY_RECOVERY_KEY, plan),
    async send(task) {
      if (continueBusy || steerBusy || queueBusy) {
        throw Object.assign(new Error('Tracker đang gửi tin khác.'), { delivery: 'not_sent' });
      }
      continueBusy = true;
      postViewState();
      try { return await continueThread({ ...task, expectedPreviousTurnId: task.turnId }); }
      finally { continueBusy = false; postViewState(); }
    },
    onChange: () => postViewState()
  });
  proxyWatchdog = createProxyWatchdog({
    settings: context.globalState.get(PROXY_WATCHDOG_KEY),
    lastAttemptAt: context.globalState.get(PROXY_ATTEMPT_KEY, 0),
    proxySnapshot: () => localProxy.snapshot(),
    saveSettings: settings => context.globalState.update(PROXY_WATCHDOG_KEY, settings),
    saveAttempt: at => context.globalState.update(PROXY_ATTEMPT_KEY, at),
    restart: () => localProxy.restart('auto'),
    onChange: () => postViewState()
  });
  currentChatTracker = createCurrentChatTracker(vscode, {
    extensionUri: context.extensionUri,
    onChange(threadId) {
      codexCurrentThreadId = threadId;
      trackerView?.webview.postMessage({ type: 'codexCurrentChat', threadId });
    }
  });
  context.subscriptions.push(currentChatTracker);
  const savedUsageInterval = context.globalState.get(USAGE_INTERVAL_KEY, 5);
  usageAlertSettings = normalizeUsageAlertSettings(context.globalState.get(USAGE_ALERT_SETTINGS_KEY));
  usageAlertState = context.globalState.get(USAGE_ALERT_STATE_KEY) || { schemaVersion: 1, initialized: false, windows: {} };
  usageMonitor = createUsageMonitor({
    intervalMinutes: Number.isInteger(savedUsageInterval) && savedUsageInterval >= 0 && savedUsageInterval <= 1440 ? savedUsageInterval : 5,
    async read() {
      await prepareOwnerBridge();
      const rateLimits = await readRateLimitsInLocalBackend();
      try {
        const account = await readAccountInLocalBackend();
        return { ...rateLimits, accountKey: accountKeyFromResult(account) };
      } catch {
        return { ...rateLimits, accountKey: 'account:unknown' };
      }
    },
    onChange: () => {
      const snapshot = usageMonitor?.snapshot();
      if (snapshot?.checkedAt && snapshot.checkedAt !== usageAlertCheckedAt) {
        usageAlertCheckedAt = snapshot.checkedAt;
        processUsageAlerts(snapshot);
      }
      renderUsageStatus();
      postViewState();
    }
  });
  context.subscriptions.push(usageMonitor);
  renderUsageStatus();
  currentChatTracker.connect().catch(() => {}).then(() => usageMonitor?.refreshIfDue());
  trafficSettings={...trafficSettings,...context.globalState.get(TRAFFIC_SETTINGS_KEY,{})};
  if(process.platform==='win32'&&!context.globalState.get(TRAFFIC_SETTINGS_KEY)?.directory){
    try{
      const docs=await new Promise((resolve,reject)=>require('child_process').execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',"[Environment]::GetFolderPath('MyDocuments')"],{windowsHide:true,timeout:5000},(error,stdout)=>error?reject(error):resolve(stdout.trim())));
      if(docs)trafficSettings.directory=path.join(docs,'Codex Logs');
    }catch{}
  }
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
    vscode.commands.registerCommand('codexSessionTracker.checkUsage', () => usageMonitor?.refresh()),
    vscode.commands.registerCommand('codexSessionTracker.configureUsageInterval', configureUsageInterval),
    vscode.commands.registerCommand('codexSessionTracker.configureUsageAlerts', configureUsageAlerts),
    vscode.commands.registerCommand('codexSessionTracker.configureLocalProxy', configureLocalProxy),
    vscode.commands.registerCommand('codexSessionTracker.restartLocalProxy', restartLocalProxy),
    vscode.commands.registerCommand('codexSessionTracker.configureProxyWatchdog', configureProxyWatchdog),
    vscode.commands.registerCommand('codexSessionTracker.openErrorHistory', openErrorHistory),
    vscode.commands.registerCommand('codexSessionTracker.configureErrorSound', configureErrorSound),
    vscode.commands.registerCommand('codexSessionTracker.previewErrorSound', previewErrorSound),
    vscode.commands.registerCommand('codexSessionTracker.configureModelCapacitySound', configureModelCapacitySound),
    vscode.commands.registerCommand('codexSessionTracker.previewModelCapacitySound', previewModelCapacitySound),
    vscode.commands.registerCommand('codexSessionTracker.configureUserInputSound', configureUserInputSound),
    vscode.commands.registerCommand('codexSessionTracker.previewUserInputSound', previewUserInputSound),
    vscode.commands.registerCommand('codexSessionTracker.clearSelection', clearSelection),
    vscode.commands.registerCommand('codexSessionTracker.reprobeCodexCli', async () => { await refreshQueueCapability(true); await refreshSteerCapability(true); postViewState(); }),
    vscode.commands.registerCommand('codexSessionTracker.exportGatewayDiagnostics', exportGatewayDiagnostics),
    vscode.commands.registerCommand('codexSessionTracker.openTrafficMonitor', openTrafficMonitor),
    vscode.commands.registerCommand('codexSessionTracker.deactivateSession', deactivateCodexSession),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('codexSessionTracker')) return;
      restartPolling();
      refreshAll(true);
    })
  );

  restoreSelection(context);
  renderStatus();
  restartPolling();
  prepareOwnerBridge().catch(() => {});
  ownerBridgeTimer = setInterval(() => prepareOwnerBridge().catch(() => {}), 30000);
  refreshGatewayManagedState().catch(() => {});
  refreshTrackedStatus(true);
}

function startErrorMonitoring(context) {
  errorHistory = createErrorHistory(context.globalStorageUri.fsPath);
  errorSound = createErrorSoundController({
    files: {
      retry_429: context.globalState.get(ERROR_SOUND_KEY, '') || path.join(context.extensionUri.fsPath, 'media', DEFAULT_ERROR_SOUND),
      model_capacity: context.globalState.get(CAPACITY_SOUND_KEY, '') || path.join(context.extensionUri.fsPath, 'media', DEFAULT_MODEL_CAPACITY_SOUND),
      user_input: context.globalState.get(USER_INPUT_SOUND_KEY, '') || context.globalState.get(ERROR_SOUND_KEY, '') || path.join(context.extensionUri.fsPath, 'media', DEFAULT_ERROR_SOUND)
    },
    save: (value, soundKey) => context.globalState.update(
      soundKey === 'model_capacity' ? CAPACITY_SOUND_KEY : soundKey === 'user_input' ? USER_INPUT_SOUND_KEY : ERROR_SOUND_KEY,
      value
    )
  });
  errorMonitor = createRetryLimitMonitor({
    state: context.globalState.get(ERROR_MONITOR_KEY),
    history: errorHistory,
    listFiles: tracker.listRolloutFiles,
    async describe(file) {
      const meta = await tracker.readSessionMeta(file.file);
      const threadId = meta?.threadId || file.fileThreadId || '';
      const names = await tracker.readThreadNames(config().codexHome, new Set([threadId]));
      return { threadId, title: names.get(threadId)?.name || 'Codex chat' };
    },
    save: value => context.globalState.update(ERROR_MONITOR_KEY, value),
    notify: event => {
      if (event.alertType === 'user_input_required') {
        const approval = ['exec_approval_request', 'apply_patch_approval_request', 'request_permissions'].includes(event.code);
        const prefix = approval ? 'Codex đang chờ mày duyệt' : 'Codex đang chờ mày trả lời';
        vscode.window.showWarningMessage(`${prefix} trong "${event.title}": ${event.message}`);
      }
      return errorSound.play(event.soundKey || 'retry_429');
    },
    onError: error => console.warn('[Codex Session Tracker] Error alert: ' + friendlyError(error))
  });
  context.subscriptions.push(errorMonitor);
  errorMonitor.poll(config().sessionsDir);
}

async function openErrorHistory() {
  if (!errorHistory) return;
  try {
    const file = await errorHistory.ensureFile();
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(document, { preview: false });
  } catch (error) {
    vscode.window.showErrorMessage('Không mở được lịch sử lỗi Codex: ' + friendlyError(error));
  }
}

async function configureErrorSound() {
  return configureErrorSoundProfile('retry_429', 'Chọn âm báo lỗi 429 (MP3)');
}

async function configureModelCapacitySound() {
  return configureErrorSoundProfile('model_capacity', 'Chọn âm thanh cứu hoả cho lỗi model quá tải (MP3)');
}

async function configureUserInputSound() {
  return configureErrorSoundProfile('user_input', 'Chọn âm báo khi Codex chờ mày trả lời hoặc duyệt (MP3)');
}

async function configureErrorSoundProfile(soundKey, title) {
  if (!errorSound) return false;
  try {
    const current = errorSound.snapshot().files?.[soundKey] || errorSound.snapshot().file;
    const choice = await vscode.window.showOpenDialog({
      title,
      defaultUri: vscode.Uri.file(current),
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { MP3: ['mp3'] }
    });
    if (!choice?.[0]) return false;
    await errorSound.setFile(choice[0].fsPath, soundKey);
    vscode.window.setStatusBarMessage('Đã lưu âm báo lỗi Codex.', 5000);
    errorMonitor?.poll(config().sessionsDir);
    return true;
  } catch (error) {
    vscode.window.showErrorMessage('Không lưu được âm báo lỗi Codex: ' + friendlyError(error));
    return false;
  }
}

async function previewErrorSound() {
  try { await errorSound?.play('retry_429'); }
  catch (error) { vscode.window.showErrorMessage('Không phát được âm báo lỗi Codex: ' + friendlyError(error)); }
}

async function previewModelCapacitySound() {
  try { await errorSound?.play('model_capacity'); }
  catch (error) { vscode.window.showErrorMessage('Không phát được âm thanh cứu hoả: ' + friendlyError(error)); }
}

async function previewUserInputSound() {
  try { await errorSound?.play('user_input'); }
  catch (error) { vscode.window.showErrorMessage('Không phát được âm báo chờ trả lời: ' + friendlyError(error)); }
}

function processUsageAlerts(snapshot) {
  usageAlertPromise = usageAlertPromise.then(async () => {
    const result = evaluateUsageAlerts(snapshot.groups, usageAlertSettings, usageAlertState);
    usageAlertState = result.state;
    await contextRef?.globalState.update(USAGE_ALERT_STATE_KEY, usageAlertState);
    for (const event of result.events) {
      const historyEvent = {
        id: event.id,
        source: 'usage',
        alertType: event.alertType,
        soundKey: event.soundKey,
        eventType: 'usage_check',
        threadId: '',
        title: 'Codex Usage',
        occurredAt: event.occurredAt,
        detectedAt: new Date().toISOString(),
        window: event.window,
        thresholdPercent: event.thresholdPercent,
        ratePerHour: event.ratePerHour,
        thresholdRatePerHour: event.thresholdRatePerHour,
        usedPercent: event.usedPercent,
        remainingPercent: event.remainingPercent,
        message: event.message,
        historical: false
      };
      await errorHistory?.append(historyEvent);
      if (event.notify) vscode.window.showWarningMessage(event.message);
      if (event.soundKey) await errorSound?.play(event.soundKey);
    }
  }).catch(error => console.warn('[Codex Session Tracker] Usage alert: ' + friendlyError(error)));
  return usageAlertPromise;
}

async function configureUsageAlerts() {
  if (!contextRef) return false;
  const current = usageAlertSettings || normalizeUsageAlertSettings();
  const enabled = await vscode.window.showQuickPick([
    { label: 'Bật cảnh báo quota 5h', value: true },
    { label: 'Tắt cảnh báo quota 5h', value: false }
  ], { title: 'Cảnh báo Usage theo quota 5h' });
  if (!enabled) return false;
  if (enabled.value === false) {
    usageAlertSettings = normalizeUsageAlertSettings({
      ...current,
      enabled: false,
      primary: { ...current.primary, enabled: false }
    });
    await contextRef.globalState.update(USAGE_ALERT_SETTINGS_KEY, usageAlertSettings);
    postViewState();
    return true;
  }
  const value = await vscode.window.showInputBox({
    title: 'Các mốc cảnh báo quota 5h',
    prompt: 'Nhập % đã dùng, cách nhau bằng dấu phẩy. Ví dụ: 50,70,85,95',
    value: current.primary.thresholds.map(item => item.usedPercent).join(','),
    validateInput: input => {
      const values = String(input || '').split(',').map(item => Number(item.trim()));
      return values.length && values.every(item => Number.isFinite(item) && item > 0 && item < 100) ? undefined : 'Nhập các số từ 1 đến 99, cách nhau bằng dấu phẩy.';
    }
  });
  if (value === undefined) return false;
  const thresholds = value.split(',').map(item => ({ usedPercent: Number(item.trim()), notify: true, soundKey: '' }));
  const rateValue = await vscode.window.showInputBox({
    title: 'Tốc độ tụt quota 5h',
    prompt: 'Nhập các mốc % quota đã dùng trung bình mỗi giờ; để trống nếu không cần. Ví dụ: 10,20,30',
    value: current.primary.rateThresholds.map(item => item.percentPerHour).join(','),
    validateInput: input => {
      if (!String(input || '').trim()) return undefined;
      const values = String(input).split(',').map(item => Number(item.trim()));
      return values.length && values.every(item => Number.isFinite(item) && item > 0 && item <= 1000) ? undefined : 'Nhập các số lớn hơn 0, cách nhau bằng dấu phẩy.';
    }
  });
  if (rateValue === undefined) return false;
  const rateThresholds = String(rateValue || '').trim()
    ? rateValue.split(',').map(item => ({ percentPerHour: Number(item.trim()), notify: true, soundKey: '' }))
    : [];
  usageAlertSettings = normalizeUsageAlertSettings({ ...current, enabled: true, primary: { ...current.primary, enabled: true, thresholds, rateThresholds } });
  await contextRef.globalState.update(USAGE_ALERT_SETTINGS_KEY, usageAlertSettings);
  postViewState();
  return true;
}

function renderUsageStatus() {
  if (!usageMonitor || !contextRef) return;
  const display = usageStatus(usageMonitor.snapshot());
  const alertSummary = usageAlertSummary(usageAlertState, usageAlertSettings);
  if (!usageStatusBar) {
    usageStatusBar = vscode.window.createStatusBarItem('codexSessionTracker.usage', vscode.StatusBarAlignment.Right, 99);
    usageStatusBar.name = 'Codex Usage';
    usageStatusBar.command = 'codexSessionTracker.checkUsage';
    contextRef.subscriptions.push(usageStatusBar);
  }
  usageStatusBar.text = display.text;
  usageStatusBar.tooltip = display.tooltip + '\nCảnh báo quota 5h: ' + (alertSummary.enabled ? 'bật' : 'tắt') + '. Mốc: ' + alertSummary.thresholds.join('%, ') + '% đã dùng.';
  usageStatusBar.color = display.color ? new vscode.ThemeColor(display.color) : undefined;
  usageStatusBar.accessibilityInformation = { label: 'Hạn mức Codex còn lại: ' + display.valueText + '. Bấm để kiểm tra ngay.' };
  usageStatusBar.show();
}

async function deactivate() {
  selectionRequestId += 1;
  errorMonitor?.dispose();
  errorMonitor = null;
  errorHistory = null;
  errorSound = null;
  currentChatTracker?.dispose();
  currentChatTracker = null;
  usageMonitor?.dispose();
  usageMonitor = null;
  usageStatusBar = null;
  if (ownerBridgeTimer) clearInterval(ownerBridgeTimer);
  ownerBridgeTimer = null;
  disposeOwnerBridges();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  trackerView = null;
  await clientRuntime.removeBridge(contextRef?.globalState.get('codexSessionTracker.clientRuntime.v1')?.executable).catch(()=>{});
  if (nativeHook) await nativeHook.stop();
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
      if (message.command === 'queueMessage') await sendComposerRequest('queue', message, () => sendQueuedMessage(message.text, message.images));
      if (message.command === 'steerMessage') await sendComposerRequest('steer', message, () => sendSteeredMessage(message.text, message.images));
      if (message.command === 'continueMessage') await sendContinuedMessage(message.text, message.images, message.threadId, message.requestId);
      if (message.command === 'setShowNonRunning') await setShowNonRunning(Boolean(message.enabled));
      if (message.command === 'deleteChat' && message.threadId) await deleteChat(String(message.threadId));
      if (message.command === 'deactivateSession') await deactivateCodexSession();
      if (message.command === 'checkUsage') await usageMonitor?.refresh();
      if (message.command === 'configureUsageInterval') await configureUsageInterval();
      if (message.command === 'configureUsageAlerts') await configureUsageAlerts();
      if (message.command === 'configureLocalProxy') await configureLocalProxy();
      if (message.command === 'restartLocalProxy') await restartLocalProxy();
      if (message.command === 'configureProxyWatchdog') await configureProxyWatchdog();
      if (message.command === 'setUsageInterval') await saveUsageInterval(message.minutes);
      if (message.command === 'reloadAfterDeactivation' && authSessionReloadRequired && !authSessionBusy) await reloadAfterDeactivation();
      if (message.command === 'reprobeQueue' || message.command === 'reprobeCodex') { await refreshQueueCapability(true); await refreshSteerCapability(true); postViewState(); }
      if (message.command === 'saveGatewaySettings') await saveGatewaySettings(message.settings || {});
      if (message.command === 'enableGatewayFullCapture') await enableGatewayFullCapture(message.settings || {});
      if (message.command === 'revertGatewayManaged') await revertGatewayManaged(false);
      if (message.command === 'forceRestoreGatewayManaged') await revertGatewayManaged(true);
      if (message.command === 'loadGatewayPayload') await sendGatewayPayload(message.traceId, message.offset);
      if (message.command === 'openTrafficMonitor') await openTrafficMonitor();
    }, null, contextRef.subscriptions);

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) refreshAll(true);
    }, null, contextRef.subscriptions);

    postViewState();
    refreshAll(true);
  }
}

async function reloadAfterDeactivation() {
  try {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  } catch (error) {
    vscode.window.showErrorMessage('Đã xoá phiên đăng nhập nhưng không Reload được VS Code: ' + friendlyError(error));
  }
}

async function refreshAuthAccount(force = false) {
  if (authAccountRefreshing || authSessionBusy || authSessionReloadRequired) return;
  if (!force && Date.now() - authAccountCheckedAt < 10000) return;
  authAccountRefreshing = true;
  try {
    await prepareOwnerBridge();
    const account = await codexAuth.currentAccount(readAccountInLocalBackend);
    if (authAccount.signedIn !== null && (authAccount.label !== account.label || authAccount.signedIn !== account.signedIn)) usageMonitor?.reset();
    authAccount = account;
  } catch {
    authAccount = { label: 'Chưa xác định tài khoản', signedIn: null };
  } finally {
    authAccountRefreshing = false;
    authAccountCheckedAt = Date.now();
    postViewState();
  }
}

async function deactivateCodexSession() {
  if (authSessionBusy) return;
  authSessionBusy = true;
  authSessionNotice = null;
  postViewState();
  try {
    await codexAuth.deactivateSession({ codexHome: config().codexHome });
    usageMonitor?.reset();
    authSessionReloadRequired = true;
    authSessionNotice = { kind: 'success', text: 'Đã xoá phiên đăng nhập đã lưu. Reload VS Code để Codex cập nhật.' };
    postViewState();
    const choice = await vscode.window.showInformationMessage(
      'Đã deactive tài khoản Codex.',
      'Reload ngay', 'Để sau'
    );
    if (choice === 'Reload ngay') await reloadAfterDeactivation();
  } catch (error) {
    authSessionNotice = { kind: 'error', text: 'Không xoá được phiên đăng nhập Codex: ' + friendlyError(error) };
    vscode.window.showErrorMessage(authSessionNotice.text);
  } finally {
    authSessionBusy = false;
    postViewState();
  }
}

async function saveUsageInterval(value) {
  try {
    const minutes = intervalMinutes(value);
    await contextRef.globalState.update(USAGE_INTERVAL_KEY, minutes);
    usageMonitor?.setInterval(minutes);
  } catch (error) {
    vscode.window.showErrorMessage(error.message);
  }
}

async function configureUsageInterval() {
  const value = await vscode.window.showInputBox({
    title: 'Chu kỳ kiểm tra Usage Codex',
    prompt: 'Số phút giữa các lần kiểm tra (0: thủ công)',
    value: String(usageMonitor?.snapshot().intervalMinutes ?? 5),
    validateInput: usageIntervalError
  });
  if (value === undefined) return;
  const error = usageIntervalError(value);
  if (error) {
    vscode.window.showErrorMessage(error);
    return;
  }
  await saveUsageInterval(Number(value.trim()));
}

async function configureLocalProxy() {
  if (!localProxy || localProxy.snapshot().busy) return false;
  if (localProxyPicker) return localProxyPicker;
  localProxyPicker = Promise.resolve().then(async () => {
    try {
      const current = localProxy.snapshot().executablePath;
      const choices = await vscode.window.showOpenDialog({
        title: 'Chọn file EXE của proxy',
        openLabel: 'Lưu proxy',
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { 'Windows executable': ['exe'] },
        ...(current ? { defaultUri: vscode.Uri.file(current) } : {})
      });
      if (!choices?.[0]) return false;
      const saved = await localProxy.setExecutable(choices[0].fsPath);
      if (!saved) vscode.window.showErrorMessage(localProxy.snapshot().notice?.text || 'Không thể lưu đường dẫn proxy.');
      return saved;
    } catch (error) {
      vscode.window.showErrorMessage(error.message);
      return false;
    }
  }).finally(() => { localProxyPicker = null; });
  return localProxyPicker;
}

async function restartLocalProxy() {
  if (!localProxy || localProxy.snapshot().busy) return;
  if (localProxyPicker && !(await localProxyPicker)) return;
  if (!localProxy.snapshot().executablePath && !(await configureLocalProxy())) return;
  const restarted = await localProxy.restart();
  if (!restarted) {
    vscode.window.showErrorMessage('Proxy: ' + (localProxy.snapshot().notice?.text || 'Không thể khởi động lại.'));
  } else {
    vscode.window.setStatusBarMessage('Proxy đã được mở lại.', 4000);
  }
}

async function configureProxyWatchdog() {
  if (!proxyWatchdog) return;
  const current = proxyWatchdog.snapshot();
  const choice = await vscode.window.showQuickPick([
    { label: current.enabled ? '$(circle-slash) Tắt tự khởi động lại' : '$(check) Bật tự khởi động lại', action: 'toggle' },
    { label: '$(clock) Ngưỡng im lặng: ' + current.minutes + ' phút', action: 'minutes' },
    { label: '$(folder-opened) Chọn EXE proxy', action: 'path' }
  ], { title: 'Proxy tự khởi động lại: ' + (current.enabled ? 'Bật' : 'Tắt') + ' · ' + current.minutes + ' phút' });
  if (!choice) return;
  if (choice.action === 'path') { await configureLocalProxy(); return; }
  const next = { enabled: current.enabled, minutes: current.minutes };
  if (choice.action === 'toggle') {
    next.enabled = !current.enabled;
    if (next.enabled && !localProxy.snapshot().executablePath && !(await configureLocalProxy())) return;
  } else {
    const value = await vscode.window.showInputBox({
      title: 'Ngưỡng tự khởi động lại proxy', value: String(current.minutes),
      prompt: 'Restart khi tất cả task chưa xong đều im lặng ít nhất số phút này.', validateInput: thresholdError
    });
    if (value === undefined) return;
    if (thresholdError(value)) { vscode.window.showErrorMessage(thresholdError(value)); return; }
    next.minutes = Number(value);
  }
  try { await proxyWatchdog.configure(next); }
  catch (error) { vscode.window.showErrorMessage(error.message); }
  postViewState();
}

async function readProxyObservation() {
  const cfg = config();
  const conversations = await tracker.scanConversationSessions({
    codexHome: cfg.codexHome, sessionsDir: cfg.sessionsDir, historyLimit: cfg.historyLimit,
    includeNonVsCodeSessions: cfg.includeNonVsCodeSessions, monitorAll: true
  });
  return conversations.monitor;
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
      traceMaxMb: Number(value.traceMaxMb || 64)
    };
  }

  const legacy = vscode.workspace.getConfiguration('codexSessionTracker');
  return {
    enabled: legacy.get('gateway.enabled', true),
    port: legacy.get('gateway.port', 8765),
    modelProxyEnabled: legacy.get('gateway.modelProxyEnabled', false),
    upstreamBaseUrl: legacy.get('gateway.upstreamBaseUrl', ''),
    captureContent: legacy.get('gateway.captureContent', false),
    traceMaxMb: legacy.get('gateway.traceMaxMb', 64)
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
    gatewayTraceMaxMb: gatewaySettings.traceMaxMb
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
    trafficLogsDirectory:trafficSettings.directory,
    trafficLogsEnabled:trafficSettings.enabled,
    trafficCaptureMode:trafficSettings.mode,
    trafficMaxRequests:trafficSettings.maxRequests,
    modelProxyEnabled: cfg.gatewayModelProxyEnabled,
    upstreamBaseUrl: cfg.gatewayUpstreamBaseUrl,
    captureContent: cfg.gatewayCaptureContent,
    captureMaxBytes: Number.MAX_SAFE_INTEGER,
    traceMaxBytes: Math.max(8, Number(cfg.gatewayTraceMaxMb || 64)) * 1024 * 1024,
    handlers: {
      continue: async input => codexSteer.continueConversation({
        ...input, codexHome: config().codexHome, localContinue: continueInLocalBackend
      }),
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
    gateway.server.clientHook.filters.configure(contextRef.globalState.get(CLIENT_HOOK_RULES_KEY,[]));
    gatewayStatus = { enabled: true, running: true, error: '', address: { host: address.host, port: address.port } };
    const managedRuntime=contextRef.globalState.get('codexSessionTracker.clientRuntime.v1');
    if(managedRuntime?.enabled){
      await clientRuntime.publishBridge(managedRuntime.executable,address);
      process.env.CODEX_TRACKER_GATEWAY_PORT=String(address.port);
      process.env.CODEX_TRACKER_GATEWAY_TOKEN=address.token;
    }
  } catch (error) {
    if(gateway)await gateway.stop().catch(()=>{});
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
    traceMaxMb: Number(cfg.gatewayTraceMaxMb || 64)
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
  const traceMaxMb = Math.round(Number(input.traceMaxMb || 64));
  const upstreamBaseUrl = String(input.upstreamBaseUrl || '').trim();
  if (port < 1 || port > 65535) throw new Error('Gateway port phải nằm trong 1..65535.');
  if (traceMaxMb < 8 || traceMaxMb > 512) throw new Error('Giới hạn trace phải nằm trong 8..512 MiB.');
  if (upstreamBaseUrl && !/^https?:\/\//i.test(upstreamBaseUrl)) throw new Error('Upstream phải là URL http/https.');
  return {
    enabled: Boolean(input.enabled),
    port,
    modelProxyEnabled: Boolean(input.modelProxyEnabled),
    upstreamBaseUrl,
    captureContent: Boolean(input.captureContent),
    traceMaxMb
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
      traceMaxMb: Math.max(256, Number(requested.traceMaxMb || 64))
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
  for (const key of ['enabled','port','modelProxyEnabled','upstreamBaseUrl','captureContent','traceMaxMb']) {
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
    if (message.command === 'loadTrafficPayload') await sendTrafficPayload(message.traceId, message.offset,message.part,message.viewToken);
    if (message.command === 'copyTrafficPlaintext' && typeof message.text === 'string') {
      let error;
      try { await vscode.env.clipboard.writeText(message.text); }
      catch (failure) { error = friendlyError(failure); }
      trafficPanel?.webview.postMessage({type:'trafficCopyResult',viewToken:message.viewToken,copySequence:message.copySequence,error});
    }
    if (message.command === 'refreshNativeOwners') await refreshNativeOwners();
    if (message.command === 'setupNativeHook') await setupNativeHook();
    if (message.command === 'startNativeHook') await startNativeHook(Number(message.pid));
    if (message.command === 'stopNativeHook' && nativeHook) {await nativeHook.stop();postTrafficState();}
    if (message.command === 'saveJsonFilters') await saveJsonFilters(message.rules);
    if (message.command === 'enableClientRuntime') await enableClientRuntime();
    if (message.command === 'disableClientRuntime') await disableClientRuntime();
    if (message.command === 'configureTraffic') await configureTraffic(message.settings);
    if (message.command === 'chooseTrafficLogDirectory') await chooseTrafficLogDirectory();
    if (message.command === 'openSavedTraffic') await openSavedTraffic();
    if (message.command === 'liveTraffic') {savedTraffic=null;postTrafficState();}
    if (message.command === 'newTrafficSession') {
      gateway?.server.trafficLogs.newSession();if(gateway)gateway.server.trafficPolicy.count=0;postTrafficState();
    }
  }, null, contextRef.subscriptions);
  postTrafficState();
}

async function saveJsonFilters(rules){
  try{
    const active=await startGateway();if(!active)throw new Error('Gateway đang tắt.');
    const {JsonFilters}=require('./gateway/json_filters');const validated=new JsonFilters();validated.configure(rules);
    await contextRef.globalState.update(CLIENT_HOOK_RULES_KEY,validated.rules);
    active.server.clientHook.filters.configure(validated.rules);
    clientHookNotice='Đã lưu bộ lọc JSON. Áp dụng cho request tiếp theo khớp rule.';
    trafficPanel?.webview.postMessage({type:'jsonRulesSaved'});
  }catch(error){clientHookNotice=error.message;}
  postTrafficState();
}

async function configureTraffic(settings={}){
  try{
    const {TrafficPolicy}=require('./gateway/traffic_policy');
    const validated=new TrafficPolicy({mode:settings.mode??trafficSettings.mode,maxRequests:Number(settings.maxRequests??trafficSettings.maxRequests)});
    trafficSettings={...trafficSettings,mode:validated.mode,maxRequests:validated.maxRequests,enabled:settings.enabled===undefined?trafficSettings.enabled:Boolean(settings.enabled)};
    await contextRef.globalState.update(TRAFFIC_SETTINGS_KEY,trafficSettings);
    gateway?.server.trafficPolicy.configure(trafficSettings);
    gateway?.server.trafficLogs.configure(trafficSettings);
    if(savedTraffic)await savedTraffic.open(savedTraffic.root,trafficSettings.maxRequests);
    clientHookNotice='Đã cập nhật giới hạn và chế độ bắt gói.';
  }catch(error){clientHookNotice=error.message;}
  postTrafficState();
}
async function chooseTrafficLogDirectory(){
  const selected=await vscode.window.showOpenDialog({canSelectFiles:false,canSelectFolders:true,canSelectMany:false,defaultUri:vscode.Uri.file(trafficSettings.directory),openLabel:'Chọn thư mục lưu POST/GET'});
  if(!selected?.length)return;
  trafficSettings.directory=selected[0].fsPath;
  await contextRef.globalState.update(TRAFFIC_SETTINGS_KEY,trafficSettings);
  gateway?.server.trafficLogs.configure(trafficSettings);postTrafficState();
}
async function openSavedTraffic(){
  const selected=await vscode.window.showOpenDialog({canSelectFiles:false,canSelectFolders:true,canSelectMany:false,defaultUri:vscode.Uri.file(trafficSettings.directory),openLabel:'Mở thư mục log'});
  if(!selected?.length)return;
  try{
    const reader=new SavedTraffic();
    clientHookNotice='Đang đọc thư mục log...';postTrafficState();
    await reader.open(selected[0].fsPath,trafficSettings.maxRequests);savedTraffic=reader;
    clientHookNotice='Đã mở log. Lọc theo host/backend, endpoint, method và thời gian.';
  }catch(error){clientHookNotice='Không mở được thư mục log: '+friendlyError(error);}
  postTrafficState();
}

async function enableClientRuntime(){
  try{
    const active=await startGateway();if(!active)throw new Error('Gateway đang tắt.');
    const settings=vscode.workspace.getConfiguration('chatgpt');
    const existing=contextRef.globalState.get('codexSessionTracker.clientRuntime.v1');
    if(existing?.enabled&&settings.get('cliExecutable')!==existing.executable)throw new Error('CLI đã được thay đổi bên ngoài Tracker. Tắt hook để xử lý cấu hình này trước.');
    const installed=await clientRuntime.deploy({extensionRoot:contextRef.extensionPath,storageDir:contextRef.globalStorageUri.fsPath,bundledExecutable:await installedCodexExecutable()});
    const previous=existing?.enabled?existing.previous:settings.inspect('cliExecutable')?.globalValue;
    const state={enabled:true,executable:installed.executable,previous:previous??null,previousWasUnset:existing?.enabled?existing.previousWasUnset:previous===undefined,cliVersion:installed.metadata.cliVersion};
    await clientRuntime.publishBridge(state.executable,active.server.address());
    await contextRef.globalState.update('codexSessionTracker.clientRuntime.v1',state);
    await settings.update('cliExecutable',state.executable,vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }catch(error){clientHookNotice=error.message;postTrafficState();}
}

async function disableClientRuntime(){
  try{
    const state=contextRef.globalState.get('codexSessionTracker.clientRuntime.v1');
    if(!state?.enabled)return;
    const settings=vscode.workspace.getConfiguration('chatgpt');
    if(settings.get('cliExecutable')===state.executable)await settings.update('cliExecutable',state.previousWasUnset?undefined:state.previous,vscode.ConfigurationTarget.Global);
    await contextRef.globalState.update('codexSessionTracker.clientRuntime.v1',{...state,enabled:false});
    await clientRuntime.removeBridge(state.executable);
    delete process.env.CODEX_TRACKER_GATEWAY_PORT;delete process.env.CODEX_TRACKER_GATEWAY_TOKEN;
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }catch(error){clientHookNotice=error.message;postTrafficState();}
}

async function installedCodexExecutable() {
  const extension = vscode.extensions.getExtension('openai.chatgpt');
  return extension ? runtimeVersions.findBundledCli(extension.extensionPath) : '';
}

function getNativeHook() {
  if (!nativeHook) nativeHook = new NativeInstrumentation({
    storageDir:gatewayStorageDir(),
    maxBytes:Number.MAX_SAFE_INTEGER,
    record:event => gateway ? gateway.server.record(event) : Promise.resolve(),
    onChange:() => postTrafficState()
  });
  return nativeHook;
}

async function refreshNativeOwners() {
  try {nativeHookOwners=await discoverOwners(await installedCodexExecutable());nativeHookNotice='';}
  catch {nativeHookOwners=[];nativeHookNotice='Không đọc được danh sách app-server của Codex.';}
  postTrafficState();
}

async function setupNativeHook() {
  try {await getNativeHook().setup();nativeHookNotice='Frida đã sẵn sàng. Chọn tiến trình và bật plaintext.';}
  catch(error) {nativeHookNotice=error.message;}
  postTrafficState();
}

async function startNativeHook(pid) {
  try {
    const active=await startGateway();
    if(!active)throw new Error('Bật Gateway trước khi gắn native hook.');
    await getNativeHook().start(pid,await installedCodexExecutable());
    nativeHookNotice='Hook đã gắn. Chỉ báo plaintext khi quan sát được dữ liệu TLS thực tế.';
  } catch(error) {nativeHookNotice=error.message;}
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
    proxyEnvironmentApplied: gatewayProxyEnvApplied,
    nativeHook:nativeHook ? nativeHook.snapshot() : null,
    nativeHookOwners,
    nativeHookNotice,
    clientHookNotice,
    ...gateway?.server.trafficLogs.snapshot(),
    ...gateway?.server.trafficPolicy.snapshot(),
    trafficLogsDirectory:trafficSettings.directory,
    trafficLogsEnabled:trafficSettings.enabled,
    trafficCaptureMode:trafficSettings.mode,
    trafficMaxRequests:trafficSettings.maxRequests,
    clientJsonRules:gateway?.server.clientHook.filters.rules||[],
    clientRuntimeEnabled:Boolean(contextRef?.globalState.get('codexSessionTracker.clientRuntime.v1')?.enabled)
  };
}

function postTrafficState() {
  if (!trafficPanel) return;
  trafficPanel.webview.postMessage({
    type: 'trafficState',
    data: {
      gateway: trafficGatewayState(),
      traffic: savedTraffic?savedTraffic.snapshot().traffic:gateway ? gateway.trafficIndex(2500) : [],
      savedTraffic:savedTraffic?{directory:savedTraffic.root,total:savedTraffic.total,loaded:savedTraffic.loaded,eventCount:savedTraffic.items.size-savedTraffic.loaded}:null
    }
  });
}

async function sendTrafficPayload(traceId, offset = 0,part='request',viewToken) {
  let event;
  try{event = savedTraffic?await savedTraffic.payload(traceId,part,0,{whole:true}):gateway && gateway.payloadByTraceId(traceId, { whole:true });}
  catch(error){clientHookNotice=friendlyError(error);event={traceId,missing:true};postTrafficState();}
  if (!trafficPanel) return;
  trafficPanel.webview.postMessage({
    type: 'trafficPayload',
    viewToken,
    payload: event || { traceId: Number(traceId || 0), missing: true }
  });
}

async function openTracker() {
  try { await vscode.commands.executeCommand('workbench.view.extension.codexSessionTrackerPanel'); } catch {}
  try { await vscode.commands.executeCommand('codexSessionTracker.view.focus'); } catch {}
  await refreshAll(true);
}

async function refreshAll(force) {
  errorMonitor?.poll(config().sessionsDir);
  if (trackerView && trackerView.visible) refreshAuthAccount(force).catch(() => {});
  if (trackerView && trackerView.visible) usageMonitor?.refreshIfDue();
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
  const monitorProxy = proxyWatchdog?.snapshot().enabled || proxyRecovery?.snapshot().pendingCount > 0;
  if (!force && trackerView && !trackerView.visible && !monitorProxy) return;
  const cfg = config();
  const everyMs = Math.max(monitorProxy ? 15000 : 2000, Number(cfg.activeScanEverySeconds || 4) * 1000);
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
      includeNonRunning: showNonRunning,
      monitorAll: Boolean(monitorProxy)
    });
    activeChats = conversations.active;
    nonRunningChats = conversations.nonRunning;
    if (conversations.monitor && !localProxy?.snapshot().busy) {
      const recoverySent = await proxyRecovery?.consider(conversations.monitor);
      await proxyWatchdog?.consider({ ...conversations.monitor, recoverySent: Boolean(recoverySent) });
    }

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
  const requestId = ++selectionRequestId;
  const isCurrent = () => requestId === selectionRequestId;
  let session = activeChats.concat(nonRunningChats).find(chat => chat.threadId === threadId) || null;
  if (!session) {
    const cfg = config();
    session = await tracker.findLatestRolloutForThread(cfg.sessionsDir, threadId, { scanLimit: cfg.treeScanLimit });
  }
  if (!isCurrent()) return;
  if (!session) {
    vscode.window.showErrorMessage('Không tìm thấy cuộc trò chuyện Codex này. Hãy làm mới danh sách.');
    return;
  }

  const cfg = config();
  const names = await tracker.readThreadNames(cfg.codexHome, new Set([session.threadId]));
  if (!isCurrent()) return;
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
  if (!isCurrent()) return;
  renderStatus();
  postViewState();
  try {
    await openCodexConversation(session.threadId, isCurrent);
  } catch (error) {
    if (isCurrent()) {
      vscode.window.showErrorMessage('Không mở được cuộc trò chuyện trong Codex: ' + friendlyError(error));
    }
  }
  if (!isCurrent()) return;
  await refreshTrackedStatus(true);
  postViewState();
}

async function clearSelection() {
  selectionRequestId += 1;
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
  const target = selected;
  const requestId = selectionRequestId;
  const isCurrent = () => selected === target && requestId === selectionRequestId;
  try {
    const cfg = config();
    const rescanEveryMs = Math.max(2000, Number(cfg.rescanThreadEverySeconds || 5) * 1000);
    const shouldRescan = forceRescan || !selected.file || Date.now() - lastTreeRescanAt >= rescanEveryMs;

    if (shouldRescan || selectedTree.length === 0) {
      lastTreeRescanAt = Date.now();
      const tree = await tracker.scanSessionTree(cfg.sessionsDir, target, { scanLimit: cfg.treeScanLimit });
      if (!isCurrent()) return;
      selectedTree = tree;
      const latestRoot = selectedTree.find(node => node.threadId === selected.threadId);
      if (latestRoot) {
        selected.file = latestRoot.file || selected.file;
        selected.sessionId = latestRoot.sessionId || selected.threadId;
        selected.cwd = latestRoot.cwd || selected.cwd;
        selected.source = latestRoot.source || selected.source;
      }
      const names = await tracker.readThreadNames(cfg.codexHome, new Set([selected.threadId]));
      if (!isCurrent()) return;
      const indexed = names.get(selected.threadId);
      if (indexed && indexed.name) selected.title = indexed.name;
      const stateTimes = tracker.readStateThreadActivity(cfg.codexHome, new Set([selected.threadId]));
      selected.indexedUpdatedAtMs = Math.max(
        selected.indexedUpdatedAtMs || 0,
        parseDateMs(indexed && indexed.updatedAt),
        stateTimes.get(selected.threadId) || 0
      );
      await persistSelection();
      if (!isCurrent()) return;
    }

    if (!selected.file) {
      selected.status = { kind: 'missing', mtimeMs: 0 };
      renderStatus();
      return;
    }

    await fs.promises.access(target.file, fs.constants.R_OK);
    if (!isCurrent()) return;
    const snapshot = await tracker.buildSessionSnapshot(cfg.sessionsDir, target, {
      scanLimit: cfg.treeScanLimit,
      tree: selectedTree,
      activityMaxBytes: Math.max(1, Number(cfg.activityTailMb || 6)) * 1024 * 1024,
      timelineLimit: cfg.timelineLimit,
      timelinePerNode: Math.max(20, Math.ceil(Number(cfg.timelineLimit || 50) / 2)),
      codexHome: cfg.codexHome,
      indexedActivity: new Map([[selected.threadId, selected.indexedUpdatedAtMs || 0]])
    });
    if (!isCurrent()) return;
    latestSnapshot = snapshot;
    selected.status = snapshot.overallStatus;
    if (gateway) await gateway.refreshLocalPersistence(selected.threadId, selected.file).catch(() => {});
    if (!isCurrent()) return;
    renderStatus();
  } catch (error) {
    if (!isCurrent()) return;
    if (error && error.code === 'ENOENT') selected.status = { kind: 'missing', mtimeMs: 0 };
    else selected.status = { kind: 'unknown', mtimeMs: 0, error };
    renderStatus();
    if (trackerView) trackerView.webview.postMessage({ type: 'error', message: friendlyError(error) });
  } finally {
    refreshingSelected = false;
    if (selected && selected !== target) {
      await refreshTrackedStatus(true);
      postViewState();
    }
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
    await prepareOwnerBridge();
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

async function sendComposerRequest(kind, message, operation) {
  const before = kind === 'queue' ? queueNotice : steerNotice;
  const threadId = selected?.threadId || '';
  if (message.threadId && message.threadId !== threadId) {
    const rejected = { kind: 'error', text: 'Chat đã đổi; bản nháp được giữ lại.', threadId: message.threadId, requestId: message.requestId, at: Date.now() };
    if (kind === 'queue') queueNotice = rejected;
    else steerNotice = rejected;
    postViewState();
    return;
  }
  try { await operation(); }
  catch (error) {
    const failed = { kind: error.delivery === 'unknown' ? 'unknown' : 'error', text: error.message, at: Date.now() };
    if (kind === 'queue') queueNotice = failed;
    else steerNotice = failed;
  }
  const current = kind === 'queue' ? queueNotice : steerNotice;
  const notice = current && current !== before ? current : { kind: 'error', text: 'Chưa gửi được tin; bản nháp được giữ lại.', at: Date.now() };
  const tagged = { ...notice, threadId, requestId: message.requestId };
  if (kind === 'queue') queueNotice = tagged;
  else steerNotice = tagged;
  postViewState();
}

async function sendQueuedMessage(rawText, rawImages) {
  const requestedThreadId = selected?.threadId || '';
  if (queueBusy || steerBusy || continueBusy) return;
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
  if (selected?.threadId !== requestedThreadId) {
    queueNotice = { kind: 'error', text: 'Chat đã đổi; chưa gửi tin vào hàng chờ.', at: Date.now() };
    postViewState();
    return;
  }
  if (!queueCapability.available || !queueCapability.executable) {
    queueNotice = { kind: 'error', text: queueCapability.reason || 'Codex CLI không hỗ trợ queue.', at: Date.now() };
    postViewState();
    return;
  }

  queueBusy = true;
  queueNotice = null;
  postViewState();
  const target = { threadId: selected.threadId, cwd: selected.cwd };
  const queueArgs = () => ({
    executable: queueCapability.executable,
    threadId: target.threadId,
    message: text,
    codexHome: config().codexHome,
    cwd: target.cwd || undefined
  });
  try {
    let result;
    try {
      const activeGateway = gateway || await startGateway();
      result = activeGateway
        ? await activeGateway.queue({ threadId: target.threadId, message: text, cwd: target.cwd || undefined })
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
        ? await activeGateway.queue({ threadId: target.threadId, message: text, cwd: target.cwd || undefined })
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
  if ((!text && !images.length) || steerBusy || queueBusy || continueBusy) return;
  if (!selected) {
    steerNotice = { kind: 'error', text: 'Chưa chọn chat Codex.', at: Date.now() };
    postViewState();
    return;
  }
  const target = { threadId: selected.threadId, cwd: selected.cwd, file: selected.file };
  steerBusy = true;
  steerNotice = null;
  postViewState();
  const steerArgs = () => ({
    threadId: target.threadId,
    message: text,
    images,
    codexHome: config().codexHome,
    cwd: target.cwd || undefined
  });
  try {
    await prepareOwnerBridge();
    const activeGateway = gateway || await startGateway();
    const result = activeGateway
      ? await activeGateway.steer({ ...steerArgs(), rolloutFile: target.file || '' })
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
      ownerBridgeReason: ownerBridgeNotice,
      at: Date.now()
    };
  } finally {
    steerBusy = false;
    postViewState();
  }
}

async function continueThread(target) {
  await prepareOwnerBridge();
  const activeGateway = gateway || await startGateway();
  const input = { ...target, images: target.images || [], codexHome: config().codexHome, rolloutFile: target.file || '' };
  return activeGateway
    ? activeGateway.continueConversation(input)
    : codexSteer.continueConversation({ ...input, localContinue: continueInLocalBackend });
}

async function sendContinuedMessage(rawText, rawImages, threadId, requestId) {
  if (continueBusy || steerBusy || queueBusy || !selected || selected.threadId !== threadId) {
    continueNotice = { kind: 'error', text: 'Chat đã đổi hoặc đang có tin khác được gửi. Nội dung nháp được giữ lại.', threadId, requestId, at: Date.now() };
    postViewState();
    return;
  }
  const text = String(rawText || '').trim();
  let images;
  try { images = codexSteer.normalizeImageAttachments(rawImages); }
  catch (error) { continueNotice = { kind: 'error', text: error.message, threadId, requestId, at: Date.now() }; postViewState(); return; }
  if (!text && !images.length) return;
  const target = { threadId, cwd: selected.cwd, file: selected.file };
  continueBusy = true;
  continueNotice = null;
  postViewState();
  try {
    const result = await continueThread({ ...target, message: text, images });
    continueNotice = { kind: 'success', text: 'Codex đã nhận tin để tiếp tục đúng cuộc trò chuyện này.', threadId, requestId,
      sentText: text, sentImages: images.map(i => i.dataUrl), turnId: result.turnId, clientUserMessageId: result.clientUserMessageId, at: Date.now() };
    await refreshAll(true);
  } catch (error) {
    continueNotice = { kind: error.delivery === 'unknown' ? 'unknown' : 'error', threadId, requestId, at: Date.now(),
      text: error.delivery === 'unknown' ? 'Chưa xác nhận Codex đã nhận tin; kiểm tra chat trước khi gửi lại để tránh trùng. ' + error.message : error.message };
  } finally { continueBusy = false; postViewState(); }
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
      localProxy: { ...(localProxy?.snapshot() || { executablePath: '', busy: false, notice: null }),
        watchdog: proxyWatchdog?.snapshot(), recovery: proxyRecovery?.snapshot() },
      authSession: {
        busy: authSessionBusy,
        accountLabel: authAccount.label,
        canDeactivate: !authSessionReloadRequired && authAccount.signedIn !== false
      },
      selectedThreadId: selected && selected.threadId || '',
      codexCurrentThreadId,
      usage: (() => {
        const state = usageMonitor?.snapshot() || { intervalMinutes: 5, groups: [] };
        return { ...state, display: usageStatus(state), alerts: { settings: usageAlertSettings, state: usageAlertState, summary: usageAlertSummary(usageAlertState, usageAlertSettings) } };
      })(),
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
      },
      continuation: { busy: continueBusy, notice: continueNotice }
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
