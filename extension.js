'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const tracker = require('./tracker');
const codexQueue = require('./codex_queue');
const codexSteer = require('./codex_steer');

let contextRef = null;
let statusBar = null;
let trackerView = null;
let pollTimer = null;
let selected = null;
let selectedTree = [];
let latestSnapshot = null;
let activeChats = [];
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
let steerBusy = false;
let steerNotice = null;

function activate(context) {
  contextRef = context;

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
    vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('codexSessionTracker')) return;
      restartPolling();
      refreshAll(true);
    })
  );

  restoreSelection(context);
  renderStatus();
  restartPolling();
  refreshTrackedStatus(true);
}

function deactivate() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  trackerView = null;
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
      if (message.command === 'queueMessage') await sendQueuedMessage(message.text);
      if (message.command === 'steerMessage') await sendSteeredMessage(message.text);
      if (message.command === 'reprobeQueue' || message.command === 'reprobeCodex') { await refreshQueueCapability(true); await refreshSteerCapability(true); postViewState(); }
    }, null, contextRef.subscriptions);

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) refreshAll(true);
    }, null, contextRef.subscriptions);

    postViewState();
    refreshAll(true);
  }
}

function config() {
  const cfg = vscode.workspace.getConfiguration('codexSessionTracker');
  const codexHome = tracker.getCodexHome(cfg.get('codexHome', ''));
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
    codexCliPath: cfg.get('codexCliPath', '')
  };
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
    activeChats = await tracker.scanActiveSessions({
      codexHome: cfg.codexHome,
      sessionsDir: cfg.sessionsDir,
      historyLimit: cfg.historyLimit,
      includeNonVsCodeSessions: cfg.includeNonVsCodeSessions,
      scanLimit: cfg.treeScanLimit
    });

    if (selected) {
      const activeSelected = activeChats.find(chat => chat.threadId === selected.threadId);
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

async function selectThread(threadId) {
  let session = activeChats.find(chat => chat.threadId === threadId) || null;
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


function openAiExtensionRoots() {
  const roots = [];
  for (const extension of vscode.extensions.all || []) {
    const id = String(extension.id || '').toLowerCase();
    const displayName = String(extension.packageJSON && extension.packageJSON.displayName || '').toLowerCase();
    if (id === 'openai.chatgpt' || (id.startsWith('openai.') && (id.includes('chatgpt') || id.includes('codex'))) || displayName.includes('codex')) {
      if (extension.extensionPath) roots.push(extension.extensionPath);
    }
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
  if (!force && steerCapability.checked && now - steerCapabilityCheckedAt < 60_000) return steerCapability;
  steerCapabilityCheckedAt = now;
  const cfg = config();
  try {
    const resolved = await codexQueue.resolveCodexExecutable({
      configuredPath: cfg.codexCliPath,
      extensionRoots: openAiExtensionRoots(),
      platform: process.platform
    });
    if (!resolved.executable) {
      steerCapability = {
        checked: true,
        available: false,
        executable: '',
        source: resolved.source || '',
        version: '',
        reason: resolved.error || 'Codex CLI binary was not found.'
      };
      return steerCapability;
    }
    const probe = await codexSteer.probeSteerSupport(resolved.executable, { codexHome: cfg.codexHome });
    steerCapability = {
      checked: true,
      available: Boolean(probe.available),
      executable: resolved.executable,
      source: probe.source || resolved.source || '',
      version: probe.version || '',
      reason: probe.reason || ''
    };
  } catch (error) {
    steerCapability = {
      checked: true,
      available: false,
      executable: '',
      source: '',
      version: '',
      reason: codexSteer.compactError(error)
    };
  }
  return steerCapability;
}

async function sendQueuedMessage(rawText) {
  const text = String(rawText || '').trim();
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
      result = await codexQueue.queueMessage(queueArgs());
    } catch (error) {
      // An extension update can leave a cached path pointing at a removed
      // binary. Re-probe once on ENOENT and retry with the newly selected
      // platform-matched executable; never duplicate a successful enqueue.
      if (!error || error.code !== 'ENOENT') throw error;
      const previous = queueCapability.executable;
      await refreshQueueCapability(true);
      if (!queueCapability.available || !queueCapability.executable || queueCapability.executable === previous) throw error;
      result = await codexQueue.queueMessage(queueArgs());
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

function selectedActiveTurnId() {
  const root = latestSnapshot && latestSnapshot.root;
  return String(root && root.status && root.status.turnId
    || latestSnapshot && latestSnapshot.overallStatus && latestSnapshot.overallStatus.turnId
    || '').trim();
}

async function sendSteeredMessage(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return;
  if (!selected) {
    steerNotice = { kind: 'error', text: 'Chưa chọn chat Codex.', at: Date.now() };
    postViewState();
    return;
  }
  // Re-read lifecycle state immediately before steering. The expected turn id
  // is an app-server precondition, so a stale composer can never steer a newer
  // turn accidentally.
  await refreshTrackedStatus(true);
  if (!selected.status || selected.status.kind !== 'running') {
    steerNotice = { kind: 'error', text: 'Chat này không còn chạy nên tracker không steer.', at: Date.now() };
    postViewState();
    return;
  }
  const expectedTurnId = selectedActiveTurnId();
  if (!expectedTurnId) {
    steerNotice = { kind: 'error', text: 'Không đọc được active turn id; tracker không gửi để tránh chèn nhầm turn.', at: Date.now() };
    postViewState();
    return;
  }
  await refreshSteerCapability(false);
  if (!steerCapability.available || !steerCapability.executable) {
    steerNotice = { kind: 'error', text: steerCapability.reason || 'Steer chưa khả dụng với app-server owner hiện tại.', at: Date.now() };
    postViewState();
    return;
  }

  steerBusy = true;
  steerNotice = null;
  postViewState();
  const steerArgs = () => ({
    executable: steerCapability.executable,
    threadId: selected.threadId,
    expectedTurnId,
    message: text,
    codexHome: config().codexHome,
    cwd: selected.cwd || undefined
  });
  try {
    let result;
    try {
      result = await codexSteer.steerMessage(steerArgs());
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
      const previous = steerCapability.executable;
      await refreshSteerCapability(true);
      if (!steerCapability.available || !steerCapability.executable || steerCapability.executable === previous) throw error;
      result = await codexSteer.steerMessage(steerArgs());
    }
    steerNotice = {
      kind: 'success',
      text: result && result.turnId ? 'Đã steer vào turn đang chạy.' : 'Đã gửi yêu cầu steer vào app-server owner.',
      turnId: result && result.turnId || '',
      at: Date.now()
    };
    await refreshTrackedStatus(true);
  } catch (error) {
    // Never silently turn a failed steer into a queued message. The user chose
    // an immediate intervention and must see the app-server rejection.
    steerNotice = { kind: 'error', text: codexSteer.compactError(error), at: Date.now() };
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
  if (!trackerView) return;
  trackerView.webview.postMessage({
    type: 'state',
    data: {
      activeChats: activeChats.map(serializeActiveChat),
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
    runningCount: chat.status && chat.status.runningCount || 1
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
    latestAssistantText: '',
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
    current: snapshot.current ? {
      label: localizeActivity(snapshot.current.label),
      detail: snapshot.current.detail || '',
      actor: snapshot.current.actor || 'Root',
      at: snapshot.current.at || 0,
      text: snapshot.current.text || ''
    } : null,
    latestUserText: snapshot.latestUserText || '',
    latestAssistantText: snapshot.latestAssistantText || '',
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
