'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const tracker = require('./src/tracker');
const { createAttentionDismissals } = require('./src/codex_attention_dismissals');
let attentionDismissals;
const {createAccountManager} = require('./src/codex_account_manager');
const {createImageQueue} = require('./src/codex_image_queue');
const {createStorageMaintenance} = require('./src/codex_storage');
let storageMaintenance;
let imageQueue;
let accountManager, attentionNativeThreads = [], attentionNativeAt = 0;
const planAccepting = new Set();
const sessionReader = tracker.createSessionReader?.() || tracker;
const codexQueue = require('./src/codex_queue');
const codexSteer = require('./src/codex_steer');
const { ensureOwnerBridge } = require('./src/codex_owner_bridge');
const { disposeOwnerBridges, installedBridgeInfo, continueInLocalBackend, readAccountInLocalBackend, readRateLimitsInLocalBackend, interruptInLocalBackend, compactInLocalBackend, compactAndResumeInLocalBackend } = require('./src/codex_live_backend');
const { createUsageMonitor, intervalMinutes, usageIntervalError, usageInterval, usageStatus, accountKeyFromResult } = require('./src/codex_usage');
const { normalizeUsageAlertSettings, evaluateUsageAlerts, usageAlertSummary } = require('./src/codex_usage_alerts');
const { normalizeUsageHistory, recordUsageSample, createUsageHistoryStore, usageHistoryChart } = require('./src/codex_usage_history');
const { normalizeUsageVoiceSettings, normalizeUsageVoiceState, evaluateUsageVoice, createUsageVoiceController } = require('./src/codex_usage_voice');
const { createUsageNotifications } = require('./src/codex_usage_notifications');
const { createFailureRecovery } = require('./src/codex_failure_recovery');
const { diagnoseConnection, connectionTargets, readRelayFailure } = require('./src/codex_connection_diagnostics');
const { readRecoveryInLocalBackend } = require('./src/codex_live_backend');
let failureRecovery = null;
const { normalizeContextCompactSettings, normalizeContextCompactState, contextPercent, contextCompactDecision, markContextCompactStarted, markContextCompactSucceeded, markContextCompactFailed } = require('./src/codex_context_compact');
const { createContextWatch } = require('./src/codex_context_watch');
const { subscribeCompactionStarted } = require('./src/codex_compaction_events');
const { createContextReader } = require('./src/codex_context_reader');
const { runContextHandoff, parseSeries, THREAD_ID } = require('./src/codex_context_handoff');
const { contextHandoffBackend, readAttentionInLocalBackend } = require('./src/codex_live_backend');
const { newChatBackend } = require('./src/codex_live_backend');
const { PRESETS, normalizeContextPreset, readModelContext, contextChoice, contextConfig, formatContextK,customPresetK,contextChoices } = require('./src/codex_new_chat');
const { configureChatContextStore, currentChatContextStore } = require('./src/codex_chat_context_store');
const NEW_CHAT_SETTINGS_KEY = 'codexSessionTracker.newChatContext.v1';
const NEW_CHAT_MODEL_KEY = 'codexSessionTracker.newChatModel.v1';
const NEW_CHAT_SPEED_KEY = 'codexSessionTracker.newChatSpeed.v1';
const { normalizeSpeed, requireSpeed } = require('./src/codex_speed');
let newChatBusy = false;
const { createNewChatForm } = require('./src/codex_new_chat_form');
const { createHandoffForm } = require('./src/codex_handoff_form');
let handoffForm = null, pendingHandoffDialog = null;
let newChatForm = null, newChatDialogReady = false, pendingNewChatDialog = null;
const { createAttentionMonitor } = require('./src/codex_attention');
const { createAsyncInputReader } = require('./src/codex_async_input');
const { speakAttentionReminder, speakAttentionInitial } = require('./src/codex_attention_voice');
const { speakCompletion } = require('./src/codex_attention_voice');
const { SOUND_TYPES, createSoundSettings, filterAttentionSound } = require('./src/codex_sound_settings');
const { createCompletionSounds } = require('./src/codex_completion_sounds');
const { soundsForChat } = require('./src/codex_chat_options');
const { validateChatOptions } = require('./src/codex_chat_options');
const { normalizeDisplayLabel, normalizeIdentity, identityFromTitle, identityPlan, prepareIdentityEdit,familyMembers,prepareFamilyIdentityEdit,displayChatTitle } = require('./src/codex_chat_identity');
const { configureAutoAllowStore, currentAutoAllowStore } = require('./src/codex_auto_allow');
const { chatPermissionsBackend } = require('./src/codex_live_backend');
const chatOptionsSaving = new Set();
const { planState, mergePlanAttention, PLAN_READY_TEXT } = require('./src/codex_plan_state');
const { subscribeTurnLifecycle } = require('./src/codex_live_backend');
const { subscribeNewChats } = require('./src/codex_live_backend');
const { subscribeGoalUpdates } = require('./src/codex_live_backend');
const { createNewChatContextRule } = require('./src/codex_new_chat_context');
const NEW_CHAT_CONTEXT_RULE_KEY = 'codexSessionTracker.newChatContextRule.v1';
let newChatContextRule = null;
const SOUND_SETTINGS_KEY = 'codexSessionTracker.soundSettings.v1';
const COMPLETION_SOUNDS_KEY = 'codexSessionTracker.completionSounds.v1';
let soundSettings = null, completionSounds = null, soundNotice = '';
const codexDelete = require('./src/codex_delete');
const codexAuth = require('./src/codex_auth');
const { createConversationNavigator } = require('./src/codex_navigation');
const { createCurrentChatTracker } = require('./src/codex_current_chat');
const { createLocalProxyController, restartExecutable } = require('./src/local_proxy');
const { createProxyWatchdog, thresholdError } = require('./src/proxy_watchdog');
const { createProxyRecovery } = require('./src/proxy_recovery');
const { createErrorHistory, createRetryLimitMonitor } = require('./src/codex_error_alerts');
const { DEFAULT_ERROR_SOUND, DEFAULT_MODEL_CAPACITY_SOUND, createErrorSoundController } = require('./src/codex_error_sound');
const openCodexConversation = createConversationNavigator(vscode);
const { CodexGateway } = require('./gateway');
const gatewayConfig = require('./gateway/config_manager');
const { NativeInstrumentation, discoverOwners } = require('./gateway/native_instrumentation');
const runtimeVersions = require('./src/runtime_versions');
const clientRuntime = require('./gateway/client_runtime');
const {SavedTraffic}=require('./gateway/saved_traffic');
const TRAFFIC_SETTINGS_KEY='codexSessionTracker.trafficSettings.v1';
const { createKeepAwake } = require('./src/codex_keep_awake');
const KEEP_AWAKE_KEY = 'codexSessionTracker.keepAwake.v1';
const USAGE_INTERVAL_CONFIG_KEY = 'codexSessionTracker.usageInterval.v2';
let keepAwake = null, pendingUsageDialog = '';
const USAGE_INTERVAL_KEY = 'codexSessionTracker.usageIntervalMinutes.v1';
const USAGE_ALERT_SETTINGS_KEY = 'codexSessionTracker.usageAlertSettings.v1';
const USAGE_ALERT_STATE_KEY = 'codexSessionTracker.usageAlertState.v1';
const USAGE_VOICE_SETTINGS_KEY = 'codexSessionTracker.usageVoiceSettings.v1';
const USAGE_VOICE_STATE_KEY = 'codexSessionTracker.usageVoiceState.v1';
const CONTEXT_COMPACT_SETTINGS_KEY = 'codexSessionTracker.contextCompactSettings.v1';
const CONTEXT_COMPACT_STATE_KEY = 'codexSessionTracker.contextCompactState.v1';
const LOCAL_PROXY_KEY = 'codexSessionTracker.localProxyExecutable.v1';
let localProxy = null;
let localProxyPicker = null;
let pendingProxyDialog = false, proxyOptionsSaving = false;
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
let usageVoiceSettings = normalizeUsageVoiceSettings();
let usageVoiceState = normalizeUsageVoiceState();
let usageVoice = null;
let usageNotifications = null;
let usageVoicePromise = Promise.resolve();
let contextCompactSettings = normalizeContextCompactSettings();
let contextCompactState = normalizeContextCompactState();
let contextCompactBusy = false;
let contextCompactNotice = null;
let contextWatch = null;
let attentionMonitor = null;
let asyncInputs = null;
const RESOLVED_INPUTS_KEY = 'codexSessionTracker.resolvedInputs.v1';
let attentionEntries = {};
const CONTEXT_WATCH_KEY = 'codexSessionTracker.contextWatch.v1';
let usageHistoryState = { schemaVersion: 1, samples: [] };
let usageHistoryPromise = Promise.resolve();
let usageHistoryStore = null;
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
let interruptBusy = false;
let interruptNotice = null;
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
  imageQueue=createImageQueue({file:path.join(context.globalStorageUri.fsPath,'image-queue.json'),imageDirectory:path.join(context.globalStorageUri.fsPath,'attachments'),
    changed:postViewState,
    async readStatus(threadId){await prepareOwnerBridge();return readRecoveryInLocalBackend(threadId);},
    send:job=>continueInLocalBackend({conversationId:job.threadId,expectedPreviousTurnId:job.expectedPreviousTurnId,clientUserMessageId:job.clientUserMessageId,
      input:[...(job.message.trim()?[{type:'text',text:job.message,text_elements:[]}]:[]),...job.images.map(image=>({type:'image',url:image.dataUrl}))]})});
  imageQueue.start();context.subscriptions.push({dispose:()=>imageQueue.dispose()});
  accountManager = createAccountManager(vscode,context,{
    codexHome:()=>config().codexHome,changed:postViewState,persist:persistSelection,
    async describeHost(){
      await prepareOwnerBridge();
      let account=null;try{account=(await readAccountInLocalBackend())?.account;}catch{}
      return {account,ready:Boolean(account&&Date.now()-attentionNativeAt<10000),
        busy:attentionNativeThreads.filter(t=>t.status?.type==='active').map(t=>({threadId:t.id})),
        modelFailures:Object.values(failureRecovery?.snapshot().entries||{}).filter(e=>!e.historical&&e.category==='capacity'&&!['resolved','dismissed'].includes(e.phase)).map(e=>({threadId:e.threadId,turnId:e.turnId})),
        quotaFailures:Object.values(failureRecovery?.snapshot().entries||{}).filter(e=>!e.historical&&e.category==='quota'&&!['resolved','dismissed'].includes(e.phase)).map(e=>({threadId:e.threadId,turnId:e.turnId,model:attentionNativeThreads.find(t=>t.id===e.threadId)?.model||activeChats.concat(nonRunningChats).find(t=>t.threadId===e.threadId)?.runtime?.model||''}))};
    },
    async readNativeQuota(){const before=await readAccountInLocalBackend(),result=await readRateLimitsInLocalBackend(),after=await readAccountInLocalBackend();if(accountKeyFromResult(before)!==accountKeyFromResult(after))throw new Error('Tài khoản vừa thay đổi.');return {account:after.account,result};},
    readStatus:readRecoveryInLocalBackend,
    interrupt:turn=>interruptInLocalBackend({threadId:turn.threadId,conversationId:turn.threadId}),
    resume:task=>continueInLocalBackend({conversationId:task.threadId,expectedPreviousTurnId:task.turnId,clientUserMessageId:task.requestId,input:[{type:'text',text:'Tiếp tục công việc còn dang dở từ trạng thái đã lưu. Kiểm tra kết quả trước khi thực hiện lại.',text_elements:[]}]}),
    async fallbackModel(threadId,allowed){
      const live=await readRecoveryInLocalBackend(threadId);if(live.active||live.waiting||live.goalPaused||live.status!=='failed')throw new Error('Chat chưa ở trạng thái lỗi có thể tiếp tục.');
      const backend=contextHandoffBackend(threadId),models=await backend.listModels(),model=allowed.find(id=>models.some(m=>m.id===id));if(!model)throw new Error('Không có model được phép đang khả dụng.');
      return continueInLocalBackend({conversationId:threadId,expectedPreviousTurnId:live.turnId,model,clientUserMessageId:require('node:crypto').randomUUID(),input:[{type:'text',text:'Tiếp tục công việc còn dang dở từ trạng thái đã lưu.',text_elements:[]}]});
    }
  });
  accountManager.start().catch(error=>console.warn('[Codex Tracker] Account settings: '+friendlyError(error)));

  keepAwake = createKeepAwake({ onChange: () => postViewState() });
  context.subscriptions.push(keepAwake);
  if (context.globalState.get(KEEP_AWAKE_KEY, false)) keepAwake.setEnabled(true);
  configureChatContextStore(path.join(context.globalStorageUri.fsPath, 'chat-contexts'));
  configureAutoAllowStore(path.join(context.globalStorageUri.fsPath, 'chat-permissions'));
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
      if (contextWatch?.blocks(task.threadId)) throw Object.assign(new Error('Chat đã dừng để chuyển tiếp context.'), { delivery: 'not_sent' });
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
    proxySnapshot: () => ({ ...localProxy.snapshot(), busy: localProxy.snapshot().busy || proxyOptionsSaving }),
    saveSettings: settings => context.globalState.update(PROXY_WATCHDOG_KEY, settings),
    saveAttempt: at => context.globalState.update(PROXY_ATTEMPT_KEY, at),
    restart: () => localProxy.restart('auto'),
    onChange: () => postViewState()
  });
  getAsyncInputs(context);
  currentChatTracker = createCurrentChatTracker(vscode, {
    extensionUri: context.extensionUri,
    onChange(threadId) {
      codexCurrentThreadId = threadId;
      trackerView?.webview.postMessage({ type: 'codexCurrentChat', threadId });
    },
    onPlanPrompt(event) {
      if (event.visible) planState.ready(event.threadId, event.turnId);
      else planState.resolved(event.threadId, event.turnId);
    },
    onInputResolved: event => asyncInputs.resolve(event.threadId, event.ids)
  });
  context.subscriptions.push(currentChatTracker);
  const savedUsageInterval = context.globalState.get(USAGE_INTERVAL_KEY, 5);
  usageAlertSettings = normalizeUsageAlertSettings(context.globalState.get(USAGE_ALERT_SETTINGS_KEY));
  usageAlertState = context.globalState.get(USAGE_ALERT_STATE_KEY) || { schemaVersion: 1, initialized: false, windows: {} };
  usageVoiceSettings = normalizeUsageVoiceSettings(context.globalState.get(USAGE_VOICE_SETTINGS_KEY));
  usageVoiceState = normalizeUsageVoiceState(context.globalState.get(USAGE_VOICE_STATE_KEY));
  usageNotifications = createUsageNotifications(path.join(context.globalStorageUri.fsPath, 'usage-notifications.json'), { voice: usageVoiceState, alerts: usageAlertState });
  contextCompactSettings = normalizeContextCompactSettings(context.globalState.get(CONTEXT_COMPACT_SETTINGS_KEY));
  contextCompactState = normalizeContextCompactState(context.globalState.get(CONTEXT_COMPACT_STATE_KEY));
  startContextWatching(context);
  await startFailureRecovery(context);
  usageVoice = createUsageVoiceController({ assetsDirectory: path.join(context.extensionPath, 'media', 'usage_voice') });
  usageHistoryStore = createUsageHistoryStore(context.globalStorageUri.fsPath);
  usageHistoryState = { samples: await usageHistoryStore.load().catch(error => { console.warn('[Codex Session Tracker] Usage history read: ' + friendlyError(error)); return []; }) };
  usageMonitor = createUsageMonitor({
    interval: context.globalState.get(USAGE_INTERVAL_CONFIG_KEY),
    intervalMinutes: Number.isInteger(savedUsageInterval) && savedUsageInterval >= 0 && savedUsageInterval <= 1440 ? savedUsageInterval : 5,
    async read() {
      await prepareOwnerBridge();
      let before;
      try { before = await readAccountInLocalBackend(); }
      catch { return { pending: true }; }
      if (!before?.account) return { pending: true };
      if (before.account.type !== 'chatgpt') return { pending: true, terminal: true };
      let rateLimits;
      try {
        rateLimits = await readRateLimitsInLocalBackend();
        const account = await readAccountInLocalBackend();
        if (accountKeyFromResult(before) !== accountKeyFromResult(account)) return { pending: true };
        accountManager?.observeNative(account.account,rateLimits).catch(()=>{});
        return { ...rateLimits, accountKey: accountKeyFromResult(account) };
      } catch (error) {
        if (!installedBridgeInfo().length) return { pending: true };
        throw error;
      }
    },
    onChange: () => {
      const snapshot = usageMonitor?.snapshot();
      if (snapshot?.checkedAt && snapshot.checkedAt !== usageAlertCheckedAt) {
        usageAlertCheckedAt = snapshot.checkedAt;
        usageHistoryState = recordUsageSample(snapshot, usageHistoryState, snapshot.checkedAt);
        usageHistoryPromise = usageHistoryPromise.then(() => usageHistoryStore?.append(snapshot, snapshot.checkedAt)).catch(error => console.warn('[Codex Session Tracker] Usage history write: ' + friendlyError(error)));
        processUsageNotifications(snapshot);
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
  storageMaintenance=createStorageMaintenance({directory:context.globalStorageUri.fsPath,trafficDirectory:()=>trafficSettings.directory,changed:postViewState,
    memoryStats:()=>sessionReader.cacheStats?.(),
    clearMemory:async()=>{await sessionReader.clearCaches?.();await refreshAll(true);},
    budget:({traceCap,trafficBytes})=>{if(gateway){if(traceCap)gateway.trace.maxBytes=traceCap;gateway.server.trafficLogs.setMaintenanceBudget(trafficBytes);}}});
  storageMaintenance.start();context.subscriptions.push({dispose:()=>storageMaintenance.dispose()});

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
  if (vscode.window.onDidChangeWindowState) context.subscriptions.push(vscode.window.onDidChangeWindowState(event => {
    if (event.focused && trackerView?.visible) refreshAll(true);
  }));

  context.subscriptions.push(
    vscode.commands.registerCommand('codexSessionTracker.openTracker', openTracker),
    vscode.commands.registerCommand('codexSessionTracker.openDashboard', openTracker),
    vscode.commands.registerCommand('codexSessionTracker.selectChat', openTracker),
    vscode.commands.registerCommand('codexSessionTracker.newChat', () => openNewChatDialog()),
    vscode.commands.registerCommand('codexSessionTracker.transferChat', () => openHandoffDialog(selected?.threadId)),
    vscode.commands.registerCommand('codexSessionTracker.configureNewChat', () => configureNewChatContext()),
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

function newChatDefault() {
  try { return normalizeContextPreset(contextRef?.globalState.get(NEW_CHAT_SETTINGS_KEY, 'default')); }
  catch { return 'default'; }
}

async function creationMetadata(cwd, model) {
  const extension = vscode.extensions.getExtension('openai.chatgpt');
  if (extension && !extension.isActive) await extension.activate();
  await prepareOwnerBridge();
  const backend = newChatBackend();
  const creation = await backend.readCreationConfig(cwd);
  const metadata = await readModelContext(config().codexHome, model || creation.model, creation.catalogFile);
  return { backend, metadata, creation };
}

function newChatModelDefault() {
  const value = contextRef?.globalState.get(NEW_CHAT_MODEL_KEY, '');
  return typeof value === 'string' ? value : '';
}

function newChatSpeedDefault() {
  try { return normalizeSpeed(contextRef?.globalState.get(NEW_CHAT_SPEED_KEY, 'default')); }
  catch { return 'default'; }
}

async function newChatMetadata(cwd, requestedModel) {
  const { backend, creation } = await creationMetadata(cwd);
  const models = await backend.listModels();
  // Keep a custom provider's configured model available even outside the catalog.
  if (creation.model && !models.some(item => item.id === creation.model)) models.unshift({ id: creation.model, label: creation.model });
  if (requestedModel !== undefined && (typeof requestedModel !== 'string' || !models.some(item => item.id === requestedModel))) {
    throw new Error('Model không còn có sẵn.');
  }
  const preferred = requestedModel || newChatModelDefault();
  const model = models.some(item => item.id === preferred) ? preferred : creation.model || models.find(item => item.isDefault)?.id || models[0]?.id;
  if (!model) throw new Error('Chưa có model.');
  return { backend, models, metadata: await readModelContext(config().codexHome, model, creation.catalogFile) };
}

async function pickContext(metadata, current, title) {
  const items = contextChoices(metadata).map(choice => ({...choice,
    description: choice.preset === current || choice.preset === 'custom' && customPresetK(current) !== null ? 'Đang chọn' : '',
    detail: choice.detail + (choice.note ? ' ? ' + choice.note : '')}));
  const picked = await new Promise(resolve => {
    const picker = vscode.window.createQuickPick();
    picker.title = title;
    picker.placeholder = metadata.model;
    picker.matchOnDetail = true;
    picker.items = items;
    // A label alone does not preselect the saved item in a native QuickPick.
    picker.activeItems = [items.find(item => item.preset === current || item.preset==='custom'&&customPresetK(current)!==null) || items[0]];
    let settled = false;
    const listeners = [];
    const finish = item => {
      if (settled) return;
      settled = true;
      for (const listener of listeners) listener.dispose();
      picker.dispose();
      resolve(item);
    };
    listeners.push(picker.onDidAccept(() => finish(picker.selectedItems[0] || picker.activeItems[0])));
    listeners.push(picker.onDidHide(() => finish(undefined)));
    picker.show();
  });
  if (!picked) return;
  if(picked.preset==='custom'){
    const value=await vscode.window.showInputBox({title:'Context tự đặt (K)',value:String(customPresetK(current)||Math.ceil((metadata.defaultTokens||400000)/1000)),validateInput:value=>{try{normalizeContextPreset('custom:'+value);return undefined;}catch{return 'Nhập số K nguyên dương.';}}});
    if(value===undefined)return;
    return normalizeContextPreset('custom:'+value);
  }
  contextConfig(picked.preset, metadata);
  return picked.preset;
}

async function configureNewChatContext(threadId) {
  if (!threadId) return openNewChatDialog(true);
  try {
    const entry = threadId && contextWatch?.snapshot().entries[threadId];
    const session = threadId && (activeChats.concat(nonRunningChats).find(chat => chat.threadId === threadId)
      || (selected?.threadId === threadId ? selected : null) || entry);
    if (threadId && !session) throw new Error('Không tìm thấy chat để cấu hình.');
    const cwd = session?.cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const model = session?.runtime?.model || contextWatch?.snapshot().readings?.[threadId]?.model;
    const { metadata } = await creationMetadata(cwd, model);
    const preset = await pickContext(metadata, entry?.contextPreset || newChatDefault(), threadId ? 'Context cho chat kế tiếp trong chuỗi' : 'Context mặc định khi tạo chat mới');
    if (!preset) return;
    if (threadId) await contextWatch.setContextPreset(threadId, preset, session);
    else await contextRef.globalState.update(NEW_CHAT_SETTINGS_KEY, preset);
    postViewState();
  } catch (error) { vscode.window.showErrorMessage('Context chat mới: ' + friendlyError(error)); }
}

function getNewChatForm() {
  if (!newChatForm) newChatForm = createNewChatForm({
    post: message => trackerView?.webview.postMessage(message),
    folders: () => (vscode.workspace.workspaceFolders || []).map(folder => ({ name: folder.name, cwd: folder.uri.fsPath })),
    defaultPreset: newChatDefault,
    defaultSpeed: newChatSpeedDefault,
    autoContext: () => getNewChatContextRule().snapshot(),
    async savePreset(preset) { await contextRef.globalState.update(NEW_CHAT_SETTINGS_KEY, preset); postViewState(); },
    async saveModel(model) { await contextRef.globalState.update(NEW_CHAT_MODEL_KEY, model); postViewState(); },
    async saveSpeed(serviceTier) { await contextRef.globalState.update(NEW_CHAT_SPEED_KEY, serviceTier); postViewState(); },
    metadata: newChatMetadata,
    async browse(cwd) {
      const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
        ...(cwd ? { defaultUri: vscode.Uri.file(cwd) } : {}), openLabel: 'Chọn thư mục làm việc' });
      return picked?.[0]?.fsPath;
    },
    busy: value => { newChatBusy = value; postViewState(); },
    async created(thread, preset, cwd, serviceTier) {
      await getNewChatContextRule().apply({ threadId: thread.id, cwd, file: thread.path, title: 'Chat mới' }, 'tracker');
      await contextWatch.setContextPreset(thread.id, preset, { cwd, file: thread.path, title: 'Chat mới' });
      await contextWatch.setEntry(thread.id, { ...contextWatch.snapshot().entries[thread.id], serviceTier });
      await openCodexConversation(thread.id);
      await refreshActiveChats(true);
    },
    open: openCodexConversation
  });
  return newChatForm;
}

function getNewChatContextRule() {
  if (!newChatContextRule) newChatContextRule = createNewChatContextRule({
    value: contextRef?.globalState.get(NEW_CHAT_CONTEXT_RULE_KEY), defaultThreshold: contextWatch?.snapshot().thresholdPercent ?? 80,
    save: value => contextRef.globalState.update(NEW_CHAT_CONTEXT_RULE_KEY, value), watch: () => contextWatch, onChange: postViewState
  });
  return newChatContextRule;
}

async function saveNewChatContextRule(message) {
  try {
    const autoContext = await getNewChatContextRule().update(message.settings || {});
    trackerView?.webview.postMessage({ type: 'newChatAutoContextSaved', requestId: message.requestId, autoContext });
  } catch (error) { trackerView?.webview.postMessage({ type: 'newChatAutoContextSaved', requestId: message.requestId, error: friendlyError(error) }); }
}

async function applyNativeNewChatContext(event) {
  if (event.origin !== 'native' || !getNewChatContextRule().snapshot().enabled) return;
  const thread = await event.readThread();
  const meta = thread.path ? await tracker.readSessionMeta(thread.path).catch(() => null) : null;
  if (!meta || meta.parentThreadId || meta.source === 'subagent') return;
  await getNewChatContextRule().apply({ threadId: thread.id, cwd: thread.cwd || meta.cwd, file: thread.path, title: thread.name || 'Chat mới' }, 'native');
}

function showPendingNewChatDialog() {
  if (trackerView && newChatDialogReady && pendingUsageDialog) { trackerView.webview.postMessage({ type: pendingUsageDialog }); pendingUsageDialog = ''; }
  if (trackerView && newChatDialogReady && pendingProxyDialog) { trackerView.webview.postMessage({type:'openProxyOptions'}); pendingProxyDialog=false; }
  if (trackerView && newChatDialogReady && pendingHandoffDialog) {
    trackerView.webview.postMessage({ type: 'openHandoffDialog', threadId: pendingHandoffDialog });
    pendingHandoffDialog = null;
  }
  if (!trackerView || !newChatDialogReady || !pendingNewChatDialog) return;
  trackerView.webview.postMessage({ type: 'openNewChatDialog', ...pendingNewChatDialog });
  pendingNewChatDialog = null;
}

async function openNewChatDialog(settingsOnly = false) {
  pendingNewChatDialog = { settingsOnly };
  await openTracker();
  showPendingNewChatDialog();
}

async function openHandoffDialog(threadId) {
  if (!threadId) { vscode.window.showErrorMessage('Chọn chat gốc trong Tracker.'); return; }
  pendingHandoffDialog = threadId;
  await openTracker();
  showPendingNewChatDialog();
}

function getHandoffForm() {
  if (!handoffForm) handoffForm = createHandoffForm({
    post: message => trackerView?.webview.postMessage(message), watch: () => contextWatch,
    defaultPreset: newChatDefault, changed: postViewState,
    async beforeTransfer(threadId,series,session){
      if(!series)return;
      const backend=chatPermissionsBackend(threadId),title=await backend.readChatTitle(threadId,session.title),identity=identityFromTitle(title);
      const entries=contextWatch.snapshot().entries;
      for(const id of familyMembers(entries,threadId)){
        let name=title;
        if(id!==threadId)try{name=await backend.readChatTitle(id,entries[id]?.title);}catch(error){if(/not found|does not exist|no saved thread/i.test(error.message))continue;throw error;}
        const existing=identityFromTitle(name);
        if(existing&&BigInt(existing.number)===BigInt(series.nextNumber))throw new Error('Số kế tiếp đã có trong dãy. Chọn STT chưa dùng.');
      }
      if(!identity||identity.code===series.code)return;
      await contextWatch.setChatOptions(threadId,contextWatch.getChatOptions(threadId),session,{
        members:familyMembers(entries,threadId),
        prepare:()=>prepareFamilyIdentityEdit({backend,threadId,identity:{code:series.code,number:identity.number},hasIdentity:true,
          entries,sessions:[...activeChats,...nonRunningChats,selected,session].filter(Boolean),expectedIdentity:identity})
      });
      const updated=contextWatch.snapshot().entries;
      for(const chat of [...activeChats,...nonRunningChats,selected].filter(Boolean))if(updated[chat.threadId]?.title)chat.title=updated[chat.threadId].title;
    },
    async describe(threadId, requestedModel) {
      const session = activeChats.concat(nonRunningChats).find(chat => chat.threadId === threadId)
        || (selected?.threadId === threadId ? selected : null) || contextWatch?.snapshot().entries[threadId];
      if (!session) throw new Error('Không tìm thấy chat gốc.');
      await prepareOwnerBridge();
      const backend = contextHandoffBackend(threadId);
      const latest = await sessionReader.findLatestRolloutForThread(config().sessionsDir, threadId, { scanLimit: config().treeScanLimit });
      const runtime = latest ? await tracker.readSessionRuntimeProfile(latest.file, latest) : session.runtime;
      const creation = await backend.readCreationConfig(latest?.cwd || session.cwd);
      const models = await backend.listModels();
      for (const model of [runtime?.model, creation.model]) {
        if (model && !models.some(item => item.id === model)) models.unshift({ id: model, label: model });
      }
      const model = requestedModel ?? (runtime?.model || creation.model);
      if (typeof model !== 'string' || !models.some(item => item.id === model)) throw new Error('Model không còn có sẵn.');
      return { session, models, serviceTier: runtime?.serviceTier || contextWatch?.snapshot().entries[threadId]?.serviceTier || creation.serviceTier || 'default',
        ...await backend.handoffModes(threadId), metadata: await readModelContext(config().codexHome, model, creation.catalogFile) };
    }
  });
  return handoffForm;
}

function startContextWatching(context) {
  const read = createContextReader({
    async resolveFile(entry) {
      const session = await sessionReader.findLatestRolloutForThread(config().sessionsDir, entry.threadId, { scanLimit: config().treeScanLimit });
      return session?.file || entry.file;
    }
  });
  contextWatch = createContextWatch({
    state: context.workspaceState.get(CONTEXT_WATCH_KEY),
    save: value => context.workspaceState.update(CONTEXT_WATCH_KEY, value),
    async read(entry) {
      const reading = await read(entry);
      try { contextHandoffBackend(entry.threadId); }
      catch (error) { reading.error = error.message; }
      return reading;
    },
    async readManual(entry) {
      const live = await contextHandoffBackend(entry.threadId).readHandoffState(entry.threadId);
      const session = await sessionReader.findLatestRolloutForThread(config().sessionsDir, entry.threadId, { scanLimit: config().treeScanLimit });
      const runtime = session ? await tracker.readSessionRuntimeProfile(session.file, session) : null;
      return { ...live, model: runtime?.model || live.model, reasoning: runtime?.reasoning || live.reasoning, serviceTier: runtime?.serviceTier || live.serviceTier };
    },
    isBusy(threadId) {
      if (authSessionBusy || contextCompactBusy || interruptBusy || steerBusy || queueBusy || continueBusy) return true;
      try { contextHandoffBackend(threadId); return false; } catch { return true; }
    },
    async handoff(entry, onProgress) {
      await prepareOwnerBridge();
      const backend = contextHandoffBackend(entry.threadId);
      const prepare = async () => {
        const session = await sessionReader.findLatestRolloutForThread(config().sessionsDir, entry.threadId, { scanLimit: config().treeScanLimit });
        if (!session) throw new Error('Không tìm thấy chat gốc để chuyển tiếp.');
        const preset = normalizeContextPreset(entry.contextPreset || newChatDefault());
        const creation = await backend.readCreationConfig(session.cwd || entry.cwd);
        const runtime = entry.trigger === 'auto_compact' ? await tracker.readSessionRuntimeProfile(session.file, session) : null;
        const model = entry.successorModel || runtime?.model || entry.model || creation.model;
        const tier = runtime?.serviceTier || entry.serviceTier || creation.serviceTier || 'default';
        if (entry.manual && tier !== 'default') {
          try { requireSpeed(tier, (await backend.listModels()).find(item => item.id === model)); }
          catch (error) { error.handoffSkipped = true; throw error; }
        }
        const metadata = await readModelContext(config().codexHome, model, creation.catalogFile);
        const overrides = contextConfig(preset, metadata);
        const tree = await sessionReader.scanSessionTree(config().sessionsDir, session, { scanLimit: config().treeScanLimit });
        const children = [];
        for (const child of tree) {
          if (child.threadId === entry.threadId) continue;
          const status = await tracker.readLatestTaskEvent(child.file);
          if (status?.kind === 'running' && status.turnId) children.push({ threadId: child.threadId, turnId: status.turnId });
        }
        return { ...entry, model, reasoning: runtime?.reasoning || entry.reasoning, serviceTier: tier,
          contextPreset: preset, contextConfig: overrides, file: session.file, cwd: session.cwd || entry.cwd, children };
      };
      const names = [...activeChats, ...nonRunningChats, ...Object.values(contextWatch.snapshot().entries)];
      const reservedCodes = names.map(chat => parseSeries(chat.title)?.code).filter(Boolean);
      // Interrupt native compaction before model/catalog/tree reads. Prepare
      // the successor only after the source is confirmed stopped.
      const automaticCompaction = entry.trigger === 'auto_compact';
      return runContextHandoff({ entry: automaticCompaction ? entry : await prepare(), backend,
        ...(automaticCompaction ? { prepareSuccessor: async () => {
          const prepared = await prepare();
          for (const child of prepared.children) await backend.stopForHandoff({ ...child, children: [] });
          return { ...prepared, children: [] };
        } } : {}),
        directory: path.join(context.globalStorageUri.fsPath, 'context-handoffs'), reservedCodes, onProgress });
    },
    async onTransferred(result) {
      const inherited = contextWatch.snapshot().entries[result.nextThreadId];
      if (inherited?.enabled && result.trigger !== 'manual') await getNewChatContextRule().apply(inherited, 'successor', true);
      await refreshActiveChats(true);
      await selectThread(result.nextThreadId);
    },
    onChange: data => trackerView?.webview.postMessage({ type: 'contextWatch', data })
  });
  context.subscriptions.push(contextWatch);
  context.subscriptions.push(subscribeCompactionStarted(event => contextWatch?.compactionStarted(event)));
  context.subscriptions.push(subscribeGoalUpdates(event => contextWatch?.goalUpdated(event)));
  contextWatch.start();
}

async function setContextWatch(message) {
  try {
    const threadId = String(message.threadId || '');
    const existing = contextWatch.snapshot().entries[threadId];
    const session = activeChats.concat(nonRunningChats).find(chat => chat.threadId === threadId)
      || (selected?.threadId === threadId ? selected : null) || existing;
    if (!session) throw new Error('Không tìm thấy chat để theo dõi.');
    await contextWatch.setEntry(threadId, { enabled: message.enabled === true,
      title: session.title, cwd: session.cwd, file: session.file, thresholdPercent: message.thresholdPercent ?? existing?.thresholdPercent });
    const snapshot = contextWatch.snapshot();
    const saved = snapshot.entries[threadId];
    trackerView?.webview.postMessage({ type: 'contextWatchSaved', threadId, thresholdPercent: saved.thresholdPercent, enabled: saved.enabled, data: snapshot });
  } catch (error) {
    trackerView?.webview.postMessage({ type: 'contextWatchSaved', threadId: String(message.threadId || ''), error: friendlyError(error) });
    vscode.window.showErrorMessage('Context: ' + friendlyError(error));
  }
  postViewState();
}

async function handleChatOptions(message, save) {
  const threadId = String(message.threadId || ''), requestId = String(message.requestId || '');
  let locked = false, permissionNotice = '';
  try {
    if (!THREAD_ID.test(threadId)) throw new Error('ID chat không hợp lệ.');
    const session = activeChats.concat(nonRunningChats).find(chat => chat.threadId === threadId)
      || (selected?.threadId === threadId ? selected : null) || contextWatch?.snapshot().entries[threadId];
    if (!session) throw new Error('Không tìm thấy chat để cài đặt.');
    let title = session.title;
    if (save) {
      if (chatOptionsSaving.has(threadId)) throw new Error('Đang lưu tuỳ chọn chat; chờ hoàn tất.');
      chatOptionsSaving.add(threadId); locked = true;
      const { autoAllow, ...otherOptions } = message.options || {};
      validateChatOptions(otherOptions);
      if (autoAllow !== undefined && typeof autoAllow !== 'boolean') throw new Error('Auto Allow không hợp lệ.');
      const hasIdentity = Object.hasOwn(message, 'identity'), hasLabel = Object.hasOwn(message, 'displayLabel');
      const identity = hasIdentity ? normalizeIdentity(message.identity) : undefined;
      const expectedIdentity = Object.hasOwn(message, 'expectedIdentity') ? normalizeIdentity(message.expectedIdentity) : undefined;
      const displayLabel = hasLabel ? normalizeDisplayLabel(message.displayLabel) : undefined;
      const before = currentAutoAllowStore()?.get(threadId)?.enabled === true;
      const changing = autoAllow !== undefined && autoAllow !== before;
      let backend;
      const getBackend = async () => {
        if (!backend) { await prepareOwnerBridge(); backend = chatPermissionsBackend(threadId); }
        return backend;
      };
      await contextWatch.setChatOptions(threadId, otherOptions, session, {
        members:familyMembers(contextWatch.snapshot().entries,threadId),
        prepare: async () => {
          const prepared=await prepareFamilyIdentityEdit({backend:hasIdentity?await getBackend():null,threadId,identity,hasIdentity,displayLabel,hasLabel,
            entries:contextWatch.snapshot().entries,sessions:[...activeChats,...nonRunningChats,selected,session].filter(Boolean),expectedIdentity});
          title = prepared.patch.title || session.title;
          return prepared;
        },
        afterSave: async () => {
          if (changing) {
            await (await getBackend()).setAutoAllow({ threadId, enabled: autoAllow, file: session.file });
            permissionNotice = autoAllow ? 'Đã bật Auto Allow.' : 'Đã tắt Auto Allow. Quyền trước đó áp dụng từ lượt kế tiếp.';
          }
        }
      });
      if (hasIdentity) {
        const updated=contextWatch.snapshot().entries;
        for (const chat of [...activeChats, ...nonRunningChats, selected].filter(Boolean)) if (updated[chat.threadId]?.title) chat.title=updated[chat.threadId].title;
      }
    } else {
      // A loaded native name is fresher than the scan cache. Label editing
      // remains available when Codex is unavailable.
      try { title = await chatPermissionsBackend(threadId).readChatTitle(threadId, title); } catch {}
    }
    const entry = contextWatch.snapshot().entries[threadId];
    const currentIdentity = identityFromTitle(title);
    trackerView?.webview.postMessage({ type: save ? 'chatOptionsSaved' : 'chatOptionsLoaded', threadId, requestId,
      title, identity: currentIdentity, displayLabel: entry?.displayLabel || '',
      nextSeries: entry?.series || (currentIdentity ? identityPlan(title, currentIdentity).series : null),
      options: { ...contextWatch.getChatOptions(threadId), autoAllow: currentAutoAllowStore()?.get(threadId)?.enabled === true },
      ...(save ? { data: contextWatch.snapshot(), notice: permissionNotice, identityUpdated: Object.hasOwn(message, 'identity') } : {}) });
    if (save) { renderStatus(); postViewState(); }
  } catch (error) {
    trackerView?.webview.postMessage({ type: save ? 'chatOptionsSaved' : 'chatOptionsLoaded', threadId, requestId, error: friendlyError(error) });
  } finally { if (locked) chatOptionsSaving.delete(threadId); }
}

async function setContextSeries(message) {
  const threadId = String(message.threadId || '');
  const requestId = String(message.requestId || '');
  try {
    const existing = contextWatch.snapshot().entries[threadId];
    const session = activeChats.concat(nonRunningChats).find(chat => chat.threadId === threadId)
      || (selected?.threadId === threadId ? selected : null) || existing;
    if (!session) throw new Error('Không tìm thấy chat để chỉnh mã chuỗi.');
    await contextWatch.setSeries(threadId, message.series, session);
    const snapshot = contextWatch.snapshot();
    trackerView?.webview.postMessage({ type: 'contextSeriesSaved', threadId, requestId,
      series: snapshot.entries[threadId].series, data: snapshot });
  } catch (error) {
    trackerView?.webview.postMessage({ type: 'contextSeriesSaved', threadId, requestId, error: friendlyError(error) });
    vscode.window.showErrorMessage('Mã chuỗi: ' + friendlyError(error));
  }
  postViewState();
}

function getAsyncInputs(context) {
  if (!asyncInputs) {
    asyncInputs = createAsyncInputReader({
      resolved: context.globalState.get(RESOLVED_INPUTS_KEY, []),
      save: value => context.globalState.update(RESOLVED_INPUTS_KEY, value),
      onChange: ({ threadId, ids }) => { attentionMonitor?.resolveInputs(threadId, ids); attentionMonitor?.poll(); },
      onError: error => console.warn('[Codex Session Tracker] Async questions: ' + friendlyError(error))
    });
    context.subscriptions.push(asyncInputs);
  }
  return asyncInputs;
}

async function startFailureRecovery(context) {
  failureRecovery = createFailureRecovery({
    file: path.join(context.globalStorageUri.fsPath, 'failure-recovery.json'), onChange: postViewState,
    onError: error => console.warn('[Codex Session Tracker] Recovery: ' + friendlyError(error)),
    async diagnose(entry) {
      const targets = await connectionTargets(config().codexHome);
      const connection = await diagnoseConnection({ targets });
      const relayConfigured = targets.local && new URL(targets.local).port === '11500' && /[\\/]\.ch-relay[\\/]/i.test(localProxy?.snapshot().executablePath || '');
      const failure = relayConfigured ? readRelayFailure(path.join(require('node:os').homedir(), '.ch-relay', 'ch-relay.sqlite'), entry.occurredAt) : null;
      return { connection, failure };
    },
    async readStatus(threadId) { await prepareOwnerBridge(); return readRecoveryInLocalBackend(threadId); },
    blocked: threadId => Boolean(contextWatch?.blocks(threadId) || contextWatch?.snapshot().busy.includes(threadId) || attentionEntries[threadId]?.flags?.length || continueBusy || steerBusy || queueBusy || contextCompactBusy || newChatBusy),
    async compact(threadId, turnId) {
      contextCompactBusy = true; postViewState();
      try { await prepareOwnerBridge(); return await compactInLocalBackend({ threadId, conversationId: threadId, expectedPreviousTurnId: turnId }); }
      finally { contextCompactBusy = false; postViewState(); }
    },
    async send(task) {
      if (continueBusy || steerBusy || queueBusy) throw Object.assign(new Error('Đang gửi một tin khác.'), { delivery: 'not_sent' });
      continueBusy = true; postViewState();
      try { return await continueThread(task); }
      finally { continueBusy = false; postViewState(); }
    },
    async restart() {
      const observation = await readProxyObservation();
      if (!observation?.complete || observation.tasks?.some(task => task.stateKind === 'running')) throw Object.assign(new Error('Còn chat đang chạy hoặc chưa kiểm tra đủ; không restart proxy.'), { delivery: 'not_sent' });
      if (!await localProxy.restart('manual')) throw new Error('Proxy chưa xác nhận restart thành công.');
    }
  });
  context.subscriptions.push(failureRecovery, subscribeTurnLifecycle(async event => {
    if (event.turn?.status === 'failed' && event.turn.error) {
      await failureRecovery?.observe({ threadId: event.threadId, turnId: event.turn.id, error: event.turn.error, occurredAt: Date.now() });
      await failureRecovery?.diagnose(event.threadId, event.turn.id);
    } else await failureRecovery?.settle(event);
  }));
  await failureRecovery.ready;
}

async function handleFailureAction(message) {
  if (!failureRecovery) return;
  const threadId = String(message.threadId || ''), turnId = String(message.turnId || '');
  try {
    if (message.action === 'auto') { await failureRecovery.setAutoResume(message.enabled === true); return; }
    if (failureRecovery.snapshot().entries?.[threadId]?.turnId !== turnId) return;
    if (message.action === 'diagnose') await failureRecovery.diagnose(threadId, turnId);
    else if (message.action === 'dismiss') await failureRecovery.dismiss(threadId, turnId);
    else if (message.action === 'transfer') await openHandoffDialog(threadId);
    else await failureRecovery.act(threadId, turnId, message.action);
  } catch (error) { vscode.window.showErrorMessage('Không xử lý được lỗi chat: ' + friendlyError(error)); }
  postViewState();
}

function startErrorMonitoring(context) {
  getAsyncInputs(context);
  soundSettings = createSoundSettings({ value: context.globalState.get(SOUND_SETTINGS_KEY),
    legacy: context.globalState.get(USAGE_VOICE_SETTINGS_KEY),
    save: value => context.globalState.update(SOUND_SETTINGS_KEY, value), onChange: () => postViewState() });
  completionSounds = createCompletionSounds({
    state: context.globalState.get(COMPLETION_SOUNDS_KEY),
    settings: threadId => soundsForChat(soundSettings.snapshot(), contextWatch?.getChatOptions(threadId)),
    save: value => context.globalState.update(COMPLETION_SOUNDS_KEY, value),
    async describe(event) {
      let thread;
      try { thread = await event.readThread?.(); } catch { /* A crashed runtime can still have local metadata. */ }
      let meta;
      if (thread?.path) meta = await tracker.readSessionMeta(thread.path).catch(() => null);
      if (!meta) meta = await sessionReader.findLatestRolloutForThread(config().sessionsDir, event.threadId, { scanLimit: config().treeScanLimit });
      return { isRoot: Boolean(meta && !meta.parentThreadId && meta.source !== 'subagent'), active: thread?.status?.type === 'active' || thread?.goalActive === true };
    },
    notify: (type, event) => playSoundType(type, event), onError: reportSoundError,
    onPlanReady: event => planState.ready(event.threadId, event.turnId)
  });
  context.subscriptions.push(completionSounds, subscribeTurnLifecycle(event => completionSounds.handle(event)));
  context.subscriptions.push(subscribeNewChats(applyNativeNewChatContext));
  context.subscriptions.push(planState.subscribe(() => attentionMonitor?.poll()));
  attentionDismissals = createAttentionDismissals({ initial: context.globalState.get('attentionHidden.v1', []), save: value => context.globalState.update('attentionHidden.v1', value), onError: reportSoundError });
  attentionMonitor = createAttentionMonitor({
    read: async () => { const threads=await readAttentionInLocalBackend();attentionNativeThreads=threads;attentionNativeAt=Date.now();return mergePlanAttention(await asyncInputs.read(threads),planState.snapshot()); },
    notify: notifyAttentionSound,
    onChange: entries => { attentionEntries = entries; attentionDismissals?.observe(entries); postViewState(); renderStatus(); },
    onError: error => console.warn('[Codex Session Tracker] Waiting status: ' + friendlyError(error))
  });
  context.subscriptions.push(attentionMonitor);
  attentionMonitor.start();
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
    onEvent: event => {
      if (!event.historical && event.alertType !== 'user_input_required') failureRecovery?.observe({ ...event, error: event.message }).then(() => failureRecovery?.diagnose(event.threadId, event.turnId)).catch(error => console.warn('[Codex Session Tracker] Failure: ' + friendlyError(error)));
    },
    notify: event => {
      if (event.alertType === 'user_input_required') {
        // The live monitor handles waiting sounds and clears the badge when
        // resolved. Keep the history entry without a second, delayed sound.
        return attentionMonitor.poll();
      }
      return completionSounds.handle({ threadId: event.threadId,
        turn: { id: event.turnId || event.id, status: 'failed', error: {
          message: event.message, codexErrorInfo: event.alertType === 'turn_failure' ? event.code : event.soundKey === 'model_capacity' ? 'serverOverloaded'
            : { responseTooManyFailedAttempts: { httpStatusCode: 429 } }
        } } });
    },
    onError: error => console.warn('[Codex Session Tracker] Error alert: ' + friendlyError(error))
  });
  context.subscriptions.push(errorMonitor);
  errorMonitor.poll(config().sessionsDir);
}

function reportSoundError(error) {
  soundNotice = error.message || String(error);
  console.warn('[Codex Tracker] Sound: ' + soundNotice); postViewState();
}

async function playSoundType(type, event, preview = false) {
  return soundSettings?.play(type, async () => {
    if (!preview && type === 'chat_completed' && contextWatch?.getChatOptions(event?.threadId).completionSound === false) return;
    if (type === 'chat_completed' || type === 'chat_failed') return speakCompletion(type);
    if (type === 'retry_429' || type === 'model_capacity') return errorSound.play(type);
    if (type === 'quota_change' || type === 'quota_large_change') {
      if (!usageVoice) throw new Error('Âm quota chưa sẵn sàng.');
      return usageVoice.speak(event || { remainingPercent: 50, largeChange: type === 'quota_large_change' });
    }
    const flag = type.startsWith('approval_') ? 'waitingOnApproval' : 'waitingOnUserInput';
    if (type.endsWith('_reminder')) return speakAttentionReminder(event || { waits: [{ flag, elapsedMinutes: 5 }] });
    if (event?.newFlags?.includes('waitingOnPlanImplementation')) return speakAttentionInitial(event);
    if (contextRef?.globalState.get(USER_INPUT_SOUND_KEY, '')) return errorSound.play('user_input');
    return speakAttentionInitial(event || { flags: [flag] });
  }, preview);
}

async function notifyAttentionSound(event) {
  const filtered = filterAttentionSound(event, soundSettings.snapshot());
  if (!filtered) return;
  const waits = event.isReminder ? filtered.waits : filtered.newFlags.map(flag => ({ flag }));
  // A custom MP3 is shared by both initial waiting types and plays only once.
  if (!event.isReminder && !filtered.newFlags?.includes('waitingOnPlanImplementation') && contextRef?.globalState.get(USER_INPUT_SOUND_KEY, '')) {
    return playSoundType(waits[0].flag === 'waitingOnApproval' ? 'approval_initial' : 'input_initial');
  }
  for (const wait of waits) {
    const type = (wait.flag === 'waitingOnApproval' ? 'approval' : 'input') + (event.isReminder ? '_reminder' : '_initial');
    await playSoundType(type, event.isReminder ? { ...filtered, waits: [wait] } : { ...filtered, newFlags: [wait.flag] });
  }
}

async function saveSoundSettings(message) {
  try {
    const settings = await soundSettings.update(message.patch || {});
    trackerView?.webview.postMessage({ type: 'soundSettingsSaved', requestId: message.requestId, settings });
  } catch (error) {
    trackerView?.webview.postMessage({ type: 'soundSettingsSaved', requestId: message.requestId, error: friendlyError(error) });
  }
}

function usageSoundOptions() {
  if (!soundSettings) return usageVoiceSettings;
  const types = soundSettings.snapshot().types;
  return { ...usageVoiceSettings, enabled: types.quota_change || types.quota_large_change,
    speakOnChange: types.quota_change, speakOnLargeChange: types.quota_large_change };
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
  try {
    if (contextRef?.globalState.get(USER_INPUT_SOUND_KEY, '')) await errorSound?.play('user_input');
    else await speakAttentionInitial({ flags: ['waitingOnApproval', 'waitingOnUserInput'] });
  }
  catch (error) { vscode.window.showErrorMessage('Không phát được âm báo chờ trả lời: ' + friendlyError(error)); }
}

async function processUsageNotifications(snapshot) {
  try {
    const result = await usageNotifications.process(snapshot, { voice: usageSoundOptions(), alerts: usageAlertSettings });
    if (!result) return;
    await Promise.all([processUsageAlerts(snapshot, result.alerts, result.voice.events.length > 0), processUsageVoice(snapshot, result.voice)]);
  } catch (error) { console.warn('[Codex Session Tracker] Usage notifications: ' + friendlyError(error)); }
}

function processUsageAlerts(snapshot, prepared, voiceAnnouncement = false) {
  usageAlertPromise = usageAlertPromise.then(async () => {
    const result = prepared || evaluateUsageAlerts(snapshot.groups, usageAlertSettings, usageAlertState, () => snapshot.checkedAt || Date.now());
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
      if (errorHistory && !await errorHistory.append(historyEvent)) continue;
      if (usageMonitor && JSON.stringify(usageMonitor.snapshot().groups) !== JSON.stringify(snapshot.groups)) continue;
      if (event.notify) vscode.window.showWarningMessage(event.message);
      if (event.soundKey && !(voiceAnnouncement && ['quota_change', 'quota_large_change'].includes(event.soundKey))) await playSoundType(event.soundKey);
    }
  }).catch(error => console.warn('[Codex Session Tracker] Usage alert: ' + friendlyError(error)));
  return usageAlertPromise;
}

function processUsageVoice(snapshot, prepared) {
  const result = prepared || evaluateUsageVoice(snapshot, usageVoiceState, usageSoundOptions(), snapshot?.checkedAt || Date.now());
  usageVoiceState = result.state;
  usageVoicePromise = usageVoicePromise.then(async () => {
    await contextRef?.globalState.update(USAGE_VOICE_STATE_KEY, usageVoiceState);
    for (const event of result.events) {
      const isCurrent = () => {
        const settings = usageSoundOptions();
        if (!settings.enabled || !(settings.speakOnChange || (settings.speakOnLargeChange && event.largeChange))) return false;
        return usageNotifications ? usageNotifications.isCurrent(event) :
          usageVoiceState.activeKey === event.key && usageVoiceState.samples[event.key]?.remainingPercent === event.remainingPercent && usageVoiceState.samples[event.key]?.changedAt === event.changedAt;
      };
      if (!await isCurrent()) continue;
      const large = event.largeChange && soundSettings?.enabled('quota_large_change');
      await playSoundType(large ? 'quota_large_change' : 'quota_change', { ...event, largeChange: Boolean(large), isCurrent });
    }
  }).catch(error => console.warn('[Codex Session Tracker] Usage voice: ' + friendlyError(error)));
  return usageVoicePromise;
}

function parseUsageAlertList(value, kind, allowEmpty = false) {
  const text = String(value ?? '').trim();
  if (!text) return allowEmpty ? [] : null;
  const values = text.split(',').map(item => Number(item.trim()));
  const valid = values.length > 0 && values.every(item => {
    if (!Number.isFinite(item)) return false;
    if (kind === 'percent') return item > 0 && item < 100;
    return item > 0 && item <= 1000;
  });
  return valid ? values : null;
}

async function saveUsageAlertSettings(input) {
  if (!contextRef) return false;
  const current = usageAlertSettings || normalizeUsageAlertSettings();
  const primaryInput = input.primary && typeof input.primary === 'object' ? input.primary : {};
  const secondaryInput = input.secondary && typeof input.secondary === 'object' ? input.secondary : {};
  const listValue = (value, fallback) => value === undefined ? fallback : value;
  const primaryThresholds = parseUsageAlertList(
    listValue(primaryInput.thresholds, current.primary.thresholds.map(item => item.usedPercent).join(',')),
    'percent'
  );
  const primaryRates = parseUsageAlertList(
    listValue(primaryInput.rateThresholds, current.primary.rateThresholds.map(item => item.percentPerHour).join(',')),
    'rate',
    true
  );
  const secondaryThresholds = parseUsageAlertList(
    listValue(secondaryInput.thresholds, current.secondary.thresholds.map(item => item.usedPercent).join(',')),
    'percent',
    true
  );
  const secondaryRates = parseUsageAlertList(
    listValue(secondaryInput.rateThresholds, current.secondary.rateThresholds.map(item => item.percentPerHour).join(',')),
    'rate',
    true
  );
  if (!primaryThresholds) {
    vscode.window.showErrorMessage('Mốc quota 5h phải là các số từ 1 đến 99, cách nhau bằng dấu phẩy.');
    return false;
  }
  if (!primaryRates || !secondaryThresholds || !secondaryRates) {
    vscode.window.showErrorMessage('Mốc tốc độ phải là các số lớn hơn 0, tối đa 1000, cách nhau bằng dấu phẩy.');
    return false;
  }
  let interval;
  try { interval = usageInterval(input.interval || (input.intervalMinutes === undefined ? usageMonitor?.snapshot().interval : { value: input.intervalMinutes, unit: 'm' })); }
  catch (error) { vscode.window.showErrorMessage(error.message); return false; }
  const enabled = input.enabled !== false;
  const voiceInput = input.voice && typeof input.voice === 'object' ? input.voice : {};
  const contextInput = input.context && typeof input.context === 'object' ? input.context : {};
  usageVoiceSettings = normalizeUsageVoiceSettings({
    ...usageSoundOptions(),
    ...(Object.prototype.hasOwnProperty.call(voiceInput, 'enabled') ? { enabled: voiceInput.enabled === true } : {}),
    ...(Object.prototype.hasOwnProperty.call(voiceInput, 'speakOnChange') ? { speakOnChange: voiceInput.speakOnChange !== false } : {}),
    ...(Object.prototype.hasOwnProperty.call(voiceInput, 'speakOnLargeChange') ? { speakOnLargeChange: voiceInput.speakOnLargeChange !== false } : {}),
    ...(Object.prototype.hasOwnProperty.call(voiceInput, 'largeChangePercent') ? { largeChangePercent: voiceInput.largeChangePercent } : {})
  });
  contextCompactSettings = normalizeContextCompactSettings({
    ...contextCompactSettings,
    ...(Object.prototype.hasOwnProperty.call(contextInput, 'enabled') ? { enabled: contextInput.enabled === true } : {}),
    ...(Object.prototype.hasOwnProperty.call(contextInput, 'resumeAfterCompact') ? { resumeAfterCompact: contextInput.resumeAfterCompact !== false } : {}),
    ...(Object.prototype.hasOwnProperty.call(contextInput, 'thresholdPercent') ? { thresholdPercent: contextInput.thresholdPercent } : {})
  });
  usageAlertSettings = normalizeUsageAlertSettings({
    ...current,
    enabled,
    primary: {
      ...current.primary,
      enabled: enabled && primaryInput.enabled !== false,
      thresholds: primaryThresholds.map(usedPercent => ({ usedPercent, notify: true, soundKey: '' })),
      rateThresholds: primaryRates.map(percentPerHour => ({ percentPerHour, notify: true, soundKey: '' }))
    },
    secondary: {
      ...current.secondary,
      enabled: enabled && secondaryInput.enabled === true,
      thresholds: secondaryThresholds.map(usedPercent => ({ usedPercent, notify: true, soundKey: '' })),
      rateThresholds: secondaryRates.map(percentPerHour => ({ percentPerHour, notify: true, soundKey: '' }))
    }
  });
  try {
    await contextRef.globalState.update(USAGE_ALERT_SETTINGS_KEY, usageAlertSettings);
    await contextRef.globalState.update(USAGE_INTERVAL_CONFIG_KEY, interval);
    await contextRef.globalState.update(USAGE_VOICE_SETTINGS_KEY, usageVoiceSettings);
    if (soundSettings && input.voice) await soundSettings.update({ types: {
      quota_change: usageVoiceSettings.enabled && usageVoiceSettings.speakOnChange,
      quota_large_change: usageVoiceSettings.enabled && usageVoiceSettings.speakOnLargeChange
    } });
    await contextRef.globalState.update(CONTEXT_COMPACT_SETTINGS_KEY, contextCompactSettings);
    usageMonitor?.setIntervalConfig(interval);
  } catch (error) {
    vscode.window.showErrorMessage(error.message);
    return false;
  }
  postViewState();
  return true;
}

async function configureUsageAlerts() {
  pendingUsageDialog = 'openUsageAlerts';
  await openTracker();
  showPendingNewChatDialog();
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
  require('./src/codex_account_barrier').disposeAccountBarriers();
  await accountManager?.dispose();
  await sessionReader.dispose?.();
  keepAwake?.dispose();
  keepAwake = null;
  selectionRequestId += 1;
  completionSounds?.dispose();
  completionSounds = null;
  attentionMonitor?.dispose();
  attentionMonitor = null;
  attentionEntries = {};
  contextWatch?.dispose();
  contextWatch = null;
  errorMonitor?.dispose();
  errorMonitor = null;
  errorHistory = null;
  errorSound = null;
  usageVoice?.dispose?.(); usageVoice = null;
  usageNotifications = null;
  failureRecovery?.dispose(); failureRecovery = null;
  usageVoicePromise = Promise.resolve();
  usageHistoryStore = null;
  currentChatTracker?.dispose();
  currentChatTracker = null;
  planState.clear();
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
    showNonRunning = false;
    newChatDialogReady = false;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = dashboardHtml();

    webviewView.webview.onDidReceiveMessage(async message => {
      if (!message || typeof message !== 'object') return;
      if(message.command==='failureAction'&&['accounts','model'].includes(message.action)){
        await accountManager?.action({action:message.action==='model'?'fallbackModel':'switch',threadId:message.threadId});
        return;
      }
      if (message.command === 'accountAction') {
        let error = '', result;
        try {
          if (!accountManager) throw new Error('Quản lý account chưa sẵn sàng.');
          result = await accountManager.action(message);
          error = result?.error || '';
        } catch (failure) { error = String(failure.message || failure); }
        if (message.requestId) webviewView.webview.postMessage({type:'accountActionResult',requestId:message.requestId,error,launcherId:result?.launcherId,data:accountManager?.snapshot()});
        return;
      }
      if (message.command === 'dismissAttention' && attentionEntries[message.threadId]) {
        await attentionDismissals?.dismiss(message.threadId, attentionEntries[message.threadId], message.key);
        postViewState();
      }
      if (message.command === 'implementPlan') {
        const id = String(message.threadId || ''), turnId = String(message.turnId || '');
        if (attentionEntries[id]?.planTurnId !== turnId || planAccepting.has(id)) return;
        planAccepting.add(id); postViewState();
        try {
          await openCodexConversation(id);
          const deadline = Date.now() + 10000;
          while (currentChatTracker?.threadId !== id && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
          await currentChatTracker.implementPlan(id, turnId);
        } catch (error) { vscode.window.showErrorMessage(friendlyError(error)); }
        finally { planAccepting.delete(id); postViewState(); }
      }
      if (message.command === 'selectChat' && message.threadId) await selectThread(String(message.threadId));
      if (message.command === 'refresh') await refreshAll(true);
      if (message.command === 'clear') await clearSelection();
      if (message.command === 'queueMessage') await sendComposerRequest('queue', message, () => sendQueuedMessage(message.text, message.images, message.requestId));
      if (message.command === 'cancelQueuedImage') { await imageQueue?.cancel(message.id); postViewState(); }
      if (message.command === 'storageAction') {
        let error='';try{
          if(!storageMaintenance)throw new Error('Bộ dọn dữ liệu chưa sẵn sàng.');
          if(message.action==='configure')await storageMaintenance.configure(message.policy);
          else if(message.action==='clean')await storageMaintenance.clean(true);
          else if(message.action==='memory')await storageMaintenance.clearMemory();
          else await storageMaintenance.inspect();
        }catch(failure){error=failure.message;}
        webviewView.webview.postMessage({type:'storageResult',requestId:message.requestId,action:message.action,error,data:storageMaintenance?.snapshot()});return;
      }
      if (message.command === 'steerMessage') await sendComposerRequest('steer', message, () => sendSteeredMessage(message.text, message.images));
      if (message.command === 'interruptChat') await interruptSelectedChat(message.threadId);
      if (message.command === 'pauseGoal') await interruptSelectedChat(message.threadId, true);
      if (message.command === 'compactContext') await compactSelectedChat(message.threadId);
      if (message.command === 'setContextWatch') await setContextWatch(message);
      if (message.command === 'loadHandoffOptions') await getHandoffForm().load(message);
      if (message.command === 'submitHandoff') await getHandoffForm().submit(message);
      if (message.command === 'setContextSeries') await setContextSeries(message);
      if (message.command === 'loadChatOptions') await handleChatOptions(message, false);
      if (message.command === 'saveChatOptions') await handleChatOptions(message, true);
      if (message.command === 'createNewChat') await openNewChatDialog();
      if (message.command === 'newChatDialogReady') { newChatDialogReady = true; showPendingNewChatDialog(); }
      if (message.command === 'loadNewChatOptions') await getNewChatForm().load(message);
      if (message.command === 'browseNewChatWorkspace') await getNewChatForm().load(message, true);
      if (message.command === 'saveNewChatPreset') await getNewChatForm().save(message);
      if (message.command === 'saveNewChatSpeed') await getNewChatForm().saveSpeed(message);
      if (message.command === 'saveNewChatAutoContext') await saveNewChatContextRule(message);
      if (message.command === 'submitNewChat') await getNewChatForm().submit(message);
      if (message.command === 'openCreatedChat') await getNewChatForm().openResult(message);
      if (message.command === 'configureNewChat') await configureNewChatContext();
      if (message.command === 'saveSoundSettings') await saveSoundSettings(message);
      if (message.command === 'previewSound') {
        let errorText = '';
        try { await playSoundType(message.soundType, undefined, true); }
        catch (error) { errorText = friendlyError(error); reportSoundError(error); }
        trackerView?.webview.postMessage({ type: 'soundPreviewDone', requestId: message.requestId, error: errorText });
      }
      if (message.command === 'configureSuccessorContext') await configureNewChatContext(String(message.threadId || ''));
      if (message.command === 'openContextSuccessor') {
        const next = contextWatch?.snapshot().entries[message.threadId]?.handoff?.nextThreadId;
        if (next) await selectThread(next);
      }
      if (message.command === 'copyChatText' && typeof message.text === 'string') {
        let error = '';
        try { await vscode.env.clipboard.writeText(message.text); }
        catch (failure) { error = friendlyError(failure); }
        trackerView?.webview.postMessage({ type: 'chatCopyResult', field: String(message.field || ''), error });
      }
      if (message.command === 'copyChatDeeplink') await copyChatDeeplink(message);
      if (message.command === 'continueMessage') await sendContinuedMessage(message.text, message.images, message.threadId, message.requestId);
      if (message.command === 'setShowNonRunning') await setShowNonRunning(Boolean(message.enabled));
      if (message.command === 'deleteChat' && message.threadId) await deleteChat(String(message.threadId));
      if (message.command === 'failureAction') await handleFailureAction(message);
      if (message.command === 'deactivateSession') await deactivateCodexSession();
      if (message.command === 'checkUsage') await usageMonitor?.refresh();
      if (message.command === 'configureUsageInterval') await configureUsageInterval();
      if (message.command === 'configureUsageAlerts') await configureUsageAlerts();
      if (message.command === 'saveUsageAlertSettings') await saveUsageAlertSettings(message.settings || {});
      if (message.command === 'configureLocalProxy') await configureLocalProxy();
      if (message.command === 'restartLocalProxy') await restartLocalProxy();
      if (message.command === 'configureProxyWatchdog') await configureProxyWatchdog();
      if (message.command === 'loadProxyOptions') await handleProxyOptions(message, 'load');
      if (message.command === 'browseProxyOptions') await handleProxyOptions(message, 'browse');
      if (message.command === 'saveProxyOptions') await handleProxyOptions(message, 'save');
      if (message.command === 'setUsageInterval') await saveUsageInterval(message.interval || { value: message.minutes, unit: 'm' }, message.requestId);
      if (message.command === 'setKeepAwake') {
        const result = await keepAwake.setEnabled(message.enabled === true);
        try { if (!result.error) await contextRef.globalState.update(KEEP_AWAKE_KEY, result.enabled); }
        catch (error) { await keepAwake.setEnabled(false); vscode.window.showErrorMessage(error.message); }
        postViewState();
      }
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
      if (webviewView.visible) {
        if (!deleteBusy) {
          showNonRunning = false;
          webviewView.webview.postMessage({ type: 'trackerShown' });
        }
        refreshAll(true);
      }
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

async function saveUsageInterval(value, requestId) {
  let error = '';
  try {
    const interval = usageInterval(typeof value === 'number' ? { value, unit: 'm' } : value);
    await contextRef.globalState.update(USAGE_INTERVAL_CONFIG_KEY, interval);
    usageMonitor?.setIntervalConfig(interval);
  } catch (failure) { error = failure.message; }
  trackerView?.webview.postMessage({ type: 'usageIntervalSaved', requestId, error });
  return !error;
}

async function configureUsageInterval() {
  pendingUsageDialog = 'openUsageInterval';
  await openTracker();
  showPendingNewChatDialog();
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
  if (!localProxy || localProxy.snapshot().busy || proxyOptionsSaving) return;
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
  pendingProxyDialog = true;
  await openTracker();
  showPendingNewChatDialog();
}

async function handleProxyOptions(message, action) {
  const type = action === 'save' ? 'proxyOptionsSaved' : action === 'browse' ? 'proxyOptionsBrowsed' : 'proxyOptionsLoaded';
  const reply = data => trackerView?.webview.postMessage({ type, requestId: message.requestId, ...data });
  let claimed = false;
  try {
    if (!localProxy || !proxyWatchdog) throw new Error('Proxy chưa sẵn sàng.');
    if (action === 'browse') {
      const picked = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
        filters: { Executable: ['exe'] }, openLabel: 'Chọn proxy EXE' });
      reply(picked?.[0] ? { executablePath: picked[0].fsPath } : { cancelled: true }); return;
    }
    if (action === 'save') {
      if (proxyOptionsSaving || localProxy.snapshot().busy || localProxyPicker) throw new Error('Proxy đang có thao tác khác; chờ hoàn tất.');
      const settings = message.settings || {};
      if (typeof settings.enabled !== 'boolean' || thresholdError(settings.minutes)) throw new Error(thresholdError(settings.minutes) || 'Thiết lập proxy không hợp lệ.');
      if (typeof settings.executablePath !== 'string' || (settings.enabled && !settings.executablePath.trim())) throw new Error('Chọn EXE proxy trước khi bật tự khởi động lại.');
      proxyOptionsSaving = true; claimed = true;
      const configure = () => proxyWatchdog.configure({ enabled: settings.enabled, minutes: Number(settings.minutes) });
      if (settings.executablePath !== localProxy.snapshot().executablePath) {
        if (!settings.executablePath.trim()) throw new Error('Chọn một EXE proxy hợp lệ.');
        if (!await localProxy.setExecutable(settings.executablePath, configure)) throw new Error(localProxy.snapshot().notice?.text || 'Không lưu được EXE proxy.');
      } else await configure();
    }
    const current = proxyWatchdog.snapshot();
    reply({ settings: { enabled: current.enabled, minutes: current.minutes, executablePath: localProxy.snapshot().executablePath } });
  } catch (error) { reply({ error: friendlyError(error) }); }
  finally { if (claimed) { proxyOptionsSaving = false; postViewState(); } }
}

async function readProxyObservation() {
  const cfg = config();
  const conversations = await sessionReader.scanConversationSessions({
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
      interrupt: async input => interruptInLocalBackend({
        threadId: input.threadId,
        turnId: input.turnId,
        conversationId: input.threadId
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
          images: input.images,
          imageDirectory:path.join(contextRef.globalStorageUri.fsPath,'attachments'),
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
  const template = fs.readFileSync(path.join(__dirname, 'media/traffic_monitor.html'), 'utf8').replace('/*__UI_BASE_CSS__*/',()=>fs.readFileSync(path.join(__dirname,'media/ui_base.css'),'utf8'));
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
  failureRecovery?.tick().catch(error => console.warn('[Codex Session Tracker] Recovery poll: ' + friendlyError(error)));
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
    const conversations = await sessionReader.scanConversationSessions({
      codexHome: cfg.codexHome,
      sessionsDir: cfg.sessionsDir,
      historyLimit: cfg.historyLimit,
      includeNonVsCodeSessions: cfg.includeNonVsCodeSessions,
      scanLimit: cfg.treeScanLimit,
      includeNonRunning: true,
      lightweight: true,
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
  await refreshActiveChats(true);
  postViewState();
}

async function copyChatDeeplink(message) {
  const threadId = String(message.threadId || '');
  let error = '';
  try {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(threadId)) throw new Error('ID cuộc trò chuyện không hợp lệ.');
    await vscode.env.clipboard.writeText('codex://threads/' + threadId);
  } catch (failure) { error = friendlyError(failure); }
  trackerView?.webview.postMessage({ type: 'chatDeeplinkCopied', threadId, requestId: message.requestId, error });
}

async function deleteChat(threadId) {
  if (deleteBusy) return;
  deleteBusy = true;
  deleteNotice = null;
  try {
    // The displayed row already supplies the title. Do not scan rollout files
    // before prompting: a large history can otherwise delay even Cancel.
    const listedSession = nonRunningChats.find(chat => chat.threadId === threadId);
    if (activeChats.some(chat => chat.threadId === threadId)) throw new Error('Chat đang chạy, không thể xóa.');
    if (!listedSession) throw new Error('Không tìm thấy chat không chạy này. Hãy làm mới danh sách.');
    const confirmation = vscode.window.showWarningMessage(
      `Xóa vĩnh viễn cuộc trò chuyện “${humanChatTitle(listedSession)}” khỏi Codex?`,
      { modal: true }, 'Xóa chat'
    );
    postViewState();
    if (await confirmation !== 'Xóa chat') return;

    const cfg = config();
    // The list is only a display cache. A queued turn can start while the
    // confirmation is open, so recheck the root and all children before deletion.
    const conversations = await sessionReader.scanConversationSessions({
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
    const tree = await sessionReader.scanSessionTree(cfg.sessionsDir, session, { scanLimit: 10000 });
    const snapshot = await sessionReader.buildSessionSnapshot(cfg.sessionsDir, session, { ...snapshotOptions, tree });
    if (snapshot.overallStatus.kind === 'running') throw new Error('Chat vừa chạy lại, không thể xóa.');
    const resolved = await codexQueue.resolveCodexExecutable({
      configuredPath: cfg.codexCliPath,
      extensionRoots: openAiExtensionRoots()
    });
    if (!resolved.executable) throw new Error(resolved.error || 'Không tìm thấy Codex CLI để xóa chat.');
    await codexDelete.deleteThread({ executable: resolved.executable, codexHome: cfg.codexHome, threadId });
    await contextWatch?.markDeleted?.(threadId);
    if (selected && selected.threadId === threadId) await clearSelection();
    deleteNotice = { kind: 'success', text: 'Đã xóa chat khỏi Codex.', at: Date.now() };
    await refreshAll(true);
  } catch (error) {
    deleteNotice = { kind: 'error', text: 'Không xoá được cuộc trò chuyện: ' + friendlyError(error), threadId, at: Date.now() };
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
    session = await sessionReader.findLatestRolloutForThread(cfg.sessionsDir, threadId, { scanLimit: cfg.treeScanLimit });
  }
  if (!isCurrent()) return;
  if (!session) {
    vscode.window.showErrorMessage('Không tìm thấy cuộc trò chuyện Codex này. Hãy làm mới danh sách.');
    return;
  }

  const cfg = config();
  const indexed = null;
  const stateTimes = new Map();
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
  persistSelection().catch(error => console.warn('[Codex Tracker] Selection: ' + friendlyError(error)));
  if (!isCurrent()) return;
  renderStatus();
  postViewState();
  try {
    if (currentChatContextStore()?.get(session.threadId)) {
      const extension = vscode.extensions.getExtension('openai.chatgpt');
      if (extension && !extension.isActive) await extension.activate();
      await prepareOwnerBridge();
      if (ownerBridgeNotice) throw new Error(ownerBridgeNotice);
    }
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
      const tree = await sessionReader.scanSessionTree(cfg.sessionsDir, target, { scanLimit: cfg.treeScanLimit });
      if (!isCurrent()) return;
      selectedTree = tree;
      const latestRoot = selectedTree.find(node => node.threadId === selected.threadId);
      if (latestRoot) {
        selected.file = latestRoot.file || selected.file;
        selected.sessionId = latestRoot.sessionId || selected.threadId;
        selected.cwd = latestRoot.cwd || selected.cwd;
        selected.source = latestRoot.source || selected.source;
      }
      const names = await sessionReader.readThreadNames(cfg.codexHome, new Set([selected.threadId]));
      if (!isCurrent()) return;
      const indexed = names.get(selected.threadId);
      if (indexed && indexed.name) selected.title = indexed.name;
      const stateTimes = await sessionReader.readStateThreadActivity(cfg.codexHome, new Set([selected.threadId]));
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
    const snapshot = await sessionReader.buildSessionSnapshot(cfg.sessionsDir, target, {
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
    maybeAutoCompact(snapshot).catch(error => console.warn('[Codex Session Tracker] Context compact: ' + friendlyError(error)));
    selected.status = snapshot.overallStatus;
    if (failureRecovery && selected.status.kind === 'error' && selected.status.error && selected.status.turnId) {
      const failedThreadId = selected.threadId, failedTurnId = selected.status.turnId;
      await failureRecovery.observe({ threadId: failedThreadId, turnId: failedTurnId, error: selected.status.error,
        occurredAt: selected.status.completedAt || selected.status.eventAt, historical: true });
      if (!failureRecovery.snapshot().entries?.[failedThreadId]?.connection) failureRecovery.diagnose(failedThreadId, failedTurnId).catch(error => console.warn('[Codex Session Tracker] Recovery diagnosis: ' + friendlyError(error)));
    }
    if (!isCurrent()) return;
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

async function sendQueuedMessage(rawText, rawImages, requestId) {
  if (contextWatch?.snapshot().busy.includes(selected?.threadId)) {
    queueNotice = { kind: 'error', text: 'Chat đang chuyển tiếp context; chờ chat kế tiếp.', at: Date.now() }; postViewState(); return;
  }
  const requestedThreadId = selected?.threadId || '';
  if (queueBusy || steerBusy || continueBusy) return;
  const text = String(rawText || '').trim();
  let images;
  try { images=codexSteer.normalizeImageAttachments(rawImages); }
  catch(error){queueNotice={kind:'error',text:error.message,at:Date.now()};postViewState();return;}
  if (!text && !images.length) return;
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
  if(images.length){
    queueBusy=true;queueNotice=null;postViewState();
    try{
      if(!imageQueue)throw new Error('Hàng chờ ảnh chưa sẵn sàng.');
      await prepareOwnerBridge();
      const live=await readRecoveryInLocalBackend(requestedThreadId);
      if(selected?.threadId!==requestedThreadId)throw new Error('Chat đã đổi; chưa xếp tin ảnh.');
      await imageQueue.enqueue({threadId:requestedThreadId,sourceTurnId:live.turnId,message:text,images,requestId});
      queueNotice={kind:'success',text:'Đã xếp tin kèm ảnh. Giữ Tracker mở để gửi sau khi lượt hiện tại hoàn tất.',at:Date.now()};
    }catch(error){queueNotice={kind:'error',text:error.message,at:Date.now()};}
    finally{queueBusy=false;postViewState();}
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
    images, imagesAvailable:queueCapability.imagesAvailable,
    imageDirectory:path.join(contextRef.globalStorageUri.fsPath,'attachments'),
    codexHome: config().codexHome,
    cwd: target.cwd || undefined
  });
  try {
    let result;
    try {
      const activeGateway = gateway || await startGateway();
      result = activeGateway
        ? await activeGateway.queue({ threadId: target.threadId, message: text, images, cwd: target.cwd || undefined })
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
        ? await activeGateway.queue({ threadId: target.threadId, message: text, images, cwd: target.cwd || undefined })
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
  if (contextWatch?.snapshot().busy.includes(selected?.threadId)) {
    steerNotice = { kind: 'error', text: 'Chat đang chuyển tiếp context; chờ chat kế tiếp.', at: Date.now() }; postViewState(); return;
  }
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

async function interruptSelectedChat(threadId, pauseGoal = false) {
  if (contextWatch?.snapshot().busy.includes(threadId)) return;
  if (interruptBusy || steerBusy || queueBusy || continueBusy || !selected || selected.threadId !== threadId) return;
  await refreshTrackedStatus(true);
  if (!selected || selected.threadId !== threadId || selected.status?.kind !== 'running') return;
  interruptBusy = true;
  interruptNotice = null;
  postViewState();
  const turnId = String(selected.status?.turnId || latestSnapshot?.overallStatus?.turnId || '').trim();
  try {
    await prepareOwnerBridge();
    const activeGateway = gateway || await startGateway();
    const result = activeGateway
      ? await activeGateway.interrupt({ threadId, turnId })
      : await interruptInLocalBackend({ threadId, conversationId: threadId, turnId });
    interruptNotice = {
      kind: result?.supported === false ? 'error' : 'success',
      text: result?.supported === false ? 'Bản Codex hiện tại chưa hỗ trợ dừng qua app-server.' : (pauseGoal ? 'Đã gửi yêu cầu Pause goal; lượt hiện tại đang được tạm dừng.' : 'Đã gửi yêu cầu dừng lượt đang chạy.'),
      at: Date.now()
    };
    await refreshTrackedStatus(true);
  } catch (error) {
    interruptNotice = { kind: 'error', text: 'Không dừng được lượt đang chạy: ' + friendlyError(error), at: Date.now() };
  } finally {
    interruptBusy = false;
    postViewState();
  }
}

function contextCompactKey(snapshot) {
  const runtime = snapshot?.runtime || {};
  return [selected?.threadId || '', snapshot?.overallStatus?.turnId || runtime.turnId || '', runtime.contextWindowTokens || 0].join(':');
}

async function compactSelectedChat(threadId, automatic = false) {
  if (contextWatch?.tracks(threadId) || contextWatch?.blocks(threadId)) return;
  if (contextCompactBusy || interruptBusy || steerBusy || queueBusy || continueBusy || !selected || selected.threadId !== threadId) return;
  if (selected.status?.kind !== 'running') return;
  const key = contextCompactKey(latestSnapshot);
  if (!key) return;
  contextCompactBusy = true;
  contextCompactNotice = null;
  contextCompactState = markContextCompactStarted(automatic ? contextCompactState : { ...contextCompactState, attempts: 0 }, key);
  await contextRef?.globalState.update(CONTEXT_COMPACT_STATE_KEY, contextCompactState);
  postViewState();
  try {
    await prepareOwnerBridge();
    const runtime = latestSnapshot?.runtime || {};
    const params = {
      threadId,
      conversationId: threadId,
      turnId: selected.status?.turnId || latestSnapshot?.overallStatus?.turnId || '',
      resumeMessage: 'Tiếp tục tác vụ đang làm dở sau khi compact context.'
    };
    let result;
    if (contextCompactSettings.resumeAfterCompact) result = await compactAndResumeInLocalBackend(params);
    else {
      const interrupted = await interruptInLocalBackend(params);
      const compacted = await compactInLocalBackend(params);
      result = { interrupted, compacted };
    }
    const resumed = contextCompactSettings.resumeAfterCompact !== false;
    contextCompactState = markContextCompactSucceeded(contextCompactState, key);
    await contextRef?.globalState.update(CONTEXT_COMPACT_STATE_KEY, contextCompactState);
    contextCompactNotice = {
      kind: 'success',
      text: automatic
        ? (resumed ? 'Context đã vượt ngưỡng; đã dừng, compact và tiếp tục tác vụ.' : 'Context đã vượt ngưỡng; đã dừng và compact context.')
        : (resumed ? 'Đã dừng, compact context và tiếp tục tác vụ.' : 'Đã dừng và compact context.'),
      percent: contextPercent(runtime),
      at: Date.now()
    };
    await refreshTrackedStatus(true);
  } catch (error) {
    contextCompactState = markContextCompactFailed(contextCompactState, key);
    await contextRef?.globalState.update(CONTEXT_COMPACT_STATE_KEY, contextCompactState).catch(() => {});
    contextCompactNotice = { kind: 'error', text: 'Không compact/resume được context: ' + friendlyError(error), at: Date.now() };
  } finally {
    contextCompactBusy = false;
    postViewState();
  }
}

async function maybeAutoCompact(snapshot) {
  if (contextWatch?.tracks(selected?.threadId) || contextWatch?.blocks(selected?.threadId)) return;
  if (contextCompactBusy || interruptBusy || !contextCompactSettings.enabled || !selected || snapshot?.overallStatus?.kind !== 'running') return;
  const runtime = snapshot.runtime || {};
  const key = contextCompactKey(snapshot);
  const decision = contextCompactDecision(runtime, contextCompactSettings, { ...contextCompactState, key });
  if (!decision.should) return;
  await compactSelectedChat(selected.threadId, true);
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
  if (contextWatch?.snapshot().busy.includes(threadId)) {
    continueNotice = { kind: 'error', text: 'Chat đang chuyển tiếp context; chờ chat kế tiếp.', threadId, requestId, at: Date.now() }; postViewState(); return;
  }
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
      accountManager: accountManager?.snapshot(),
      storage:storageMaintenance?.snapshot(),
      keepAwake: keepAwake?.snapshot(),
      attention: attentionEntries,
      attentionPresentation: attentionDismissals?.snapshot(attentionEntries),
      planAccepting: [...planAccepting],
      sounds: { settings: soundSettings?.snapshot(), types: SOUND_TYPES, notice: soundNotice },
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
      failureRecovery: failureRecovery?.snapshot(),
      localProxy: { ...(localProxy?.snapshot() || { executablePath: '', busy: false, notice: null }),
        watchdog: proxyWatchdog?.snapshot(), recovery: proxyRecovery?.snapshot() },
      authSession: {
        busy: authSessionBusy,
        accountLabel: authAccount.label,
        planType: authAccount.planType || '',
        canDeactivate: !authSessionBusy
      },
      selectedThreadId: selected && selected.threadId || '',
      contextWatch: contextWatch?.snapshot(),
      newChat: { contextPreset: newChatDefault(), model: newChatModelDefault(), serviceTier: newChatSpeedDefault(), busy: newChatBusy, autoContext: getNewChatContextRule().snapshot() },
      codexCurrentThreadId,
      usage: (() => {
        const state = usageMonitor?.snapshot() || { intervalMinutes: 5, groups: [] };
        const runtime = latestSnapshot?.runtime || null;
        return { ...state, display: usageStatus(state), chart: usageHistoryChart(usageHistoryState), alerts: { settings: usageAlertSettings, state: usageAlertState, summary: usageAlertSummary(usageAlertState, usageAlertSettings) }, voice: usageSoundOptions(), context: { ...(runtime || {}), settings: contextCompactSettings, state: contextCompactState, busy: contextCompactBusy, notice: contextCompactNotice, compactAvailable: Boolean(selected && !contextWatch?.tracks(selected.threadId) && !contextWatch?.blocks(selected.threadId) && selected.status?.kind === 'running' && runtime?.contextWindowTokens) } };
      })(),
      selected: selected && latestSnapshot ? serializeSnapshot(latestSnapshot) : (selected ? serializeSelectedShell() : null),
      queue: {
        checked: Boolean(queueCapability.checked),
        available: Boolean(queueCapability.available),
        imagesAvailable: Boolean(imageQueue?.snapshot().ready),
        imageJobs: (imageQueue?.snapshot().jobs||[]).filter(job=>job.threadId===selected?.threadId&&!['sent','cancelled'].includes(job.phase)),
        imageQueueError: imageQueue?.snapshot().error||'',
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
      interrupt: { busy: interruptBusy, notice: interruptNotice },
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
    state: displayState(chat.status || { kind: 'unknown' }),
    runtime: chat.runtime || null
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
    runtime: null,
    timeline: [],
    conversation: [],
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
    runtime: snapshot.runtime || null,
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
    conversation: (Array.isArray(snapshot.conversation) ? snapshot.conversation : [])
      .slice(-20)
      .map(item => ({
        kind: String(item.kind || ''),
        label: String(item.label || ''),
        detail: String(item.detail || ''),
        text: String(item.text || ''),
        images: Array.isArray(item.images) ? item.images : [],
        actor: String(item.actor || 'Main'),
        threadId: String(item.threadId || ''),
        at: Number.isFinite(item.at) ? item.at : 0,
        terminal: Boolean(item.terminal)
      })),
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
      runtime: node.runtime || null,
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

  const waiting = Object.values(attentionEntries);
  if (waiting.length) {
    const approval = waiting.some(entry => entry.flags.includes('waitingOnApproval'));
    const plan = waiting.some(entry => entry.flags.includes('waitingOnPlanImplementation'));
    statusBar.color = new vscode.ThemeColor('editorWarning.foreground');
    statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    statusBar.text = `$(bell) ${waiting.length} chat · ${approval ? 'Cần duyệt' : plan ? 'Kế hoạch đã xong' : 'Cần trả lời'}`;
    statusBar.tooltip = waiting.map(entry => `${entry.title}: ${entry.flags.map(flag => flag === 'waitingOnApproval' ? 'Cần duyệt' : flag === 'waitingOnPlanImplementation' ? PLAN_READY_TEXT : 'Cần trả lời').join(' · ')}`).join('\n');
    statusBar.show();
    return;
  }

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
  const title = tracker.cleanTitle(displayChatTitle(selected,contextWatch?.snapshot().entries),34) || path.basename(selected.cwd || '') || 'Codex';
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
  md.appendMarkdown(`**${escapeMarkdown(displayChatTitle(session,contextWatch?.snapshot().entries))}**\n\n`);
  md.appendMarkdown(`- **State:** ${escapeMarkdown(displayState(status))}\n`);
  if (status.runningChildren) md.appendMarkdown(`- **Running child agents:** ${status.runningChildren}\n`);
  if (session.cwd) md.appendMarkdown(`- **Workspace:** \`${escapeInlineCode(session.cwd)}\`\n`);
  if (status.mtimeMs) md.appendMarkdown(`- **Last activity:** ${escapeMarkdown(tracker.formatRelativeTime(status.mtimeMs))}\n`);
  md.appendMarkdown('\nClick to open the tracker panel.');
  return md;
}

function dashboardHtml() {
  const nonce = String(Date.now());
  const template = fs.readFileSync(path.join(__dirname, 'media/dashboard.html'), 'utf8');
  return template.replace('__NEW_CHAT_DIALOG_HTML__', () => fs.readFileSync(path.join(__dirname, 'media/new_chat_dialog.html'), 'utf8'))
    .replace('/*__UI_BASE_CSS__*/', () => fs.readFileSync(path.join(__dirname, 'media/ui_base.css'), 'utf8'))
    .replace('__PROXY_OPTIONS_HTML__', () => fs.readFileSync(path.join(__dirname, 'media/proxy_options.html'), 'utf8'))
    .replace('/*__PROXY_OPTIONS_JS__*/', () => fs.readFileSync(path.join(__dirname, 'media/proxy_options.js'), 'utf8'))
    .replace('__CHAT_OPTIONS_HTML__', () => fs.readFileSync(path.join(__dirname, 'media/chat_options.html'), 'utf8'))
    .replace('/*__CHAT_OPTIONS_JS__*/', () => fs.readFileSync(path.join(__dirname, 'media/chat_options.js'), 'utf8'))
    .replace('__HANDOFF_DIALOG_HTML__', () => fs.readFileSync(path.join(__dirname, 'media/handoff_dialog.html'), 'utf8'))
    .replace('/*__HANDOFF_DIALOG_JS__*/', () => fs.readFileSync(path.join(__dirname, 'media/handoff_dialog.js'), 'utf8'))
    .replace('/*__NEW_CHAT_DIALOG_JS__*/', () => fs.readFileSync(path.join(__dirname, 'media/new_chat_dialog.js'), 'utf8'))
    .replace('/*__SOUND_SETTINGS_CSS__*/', () => fs.readFileSync(path.join(__dirname, 'media/sound_settings.css'), 'utf8'))
    .replace('/*__SOUND_SETTINGS_JS__*/', () => fs.readFileSync(path.join(__dirname, 'media/sound_settings.js'), 'utf8'))
    .replace('/*__CHAT_LIST_LAYOUT_JS__*/', () => fs.readFileSync(path.join(__dirname, 'media/chat_list_layout.js'), 'utf8'))
    .replace('/*__ACCOUNT_MANAGER_JS__*/', () => fs.readFileSync(path.join(__dirname, 'media/account_manager.js'), 'utf8'))
    .replace('/*__SCROLLBARS_JS__*/', () => fs.readFileSync(path.join(__dirname, 'media/scrollbars.js'), 'utf8'))
    .replace('/*__IMAGE_ATTACHMENTS_JS__*/', () => fs.readFileSync(path.join(__dirname, 'media/image_attachments.js'), 'utf8'))
    .replace('/*__CONTEXT_CHOICES_JS__*/', () => fs.readFileSync(path.join(__dirname, 'media/context_choices.js'), 'utf8'))
    .replace('<!--__STORAGE_MANAGER_HTML__-->', () => fs.readFileSync(path.join(__dirname, 'media/storage_manager.html'), 'utf8'))
    .replace('/*__STORAGE_MANAGER_JS__*/', () => fs.readFileSync(path.join(__dirname, 'media/storage_manager.js'), 'utf8'))
    .replace('<!--__ACCOUNT_MANAGER_HTML__-->', () => fs.readFileSync(path.join(__dirname, 'media/account_manager.html'), 'utf8'))
    .replace('/*__FAILURE_RECOVERY_JS__*/', () => fs.readFileSync(path.join(__dirname, 'media/failure_recovery.js'), 'utf8'))
    .replaceAll('__NONCE__', nonce);
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
