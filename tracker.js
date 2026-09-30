'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const fsp = fs.promises;
const SUMMARY_PREFIX_BYTES = 2 * 1024 * 1024;
const META_PREFIX_BYTES = 256 * 1024;
const BACKWARD_CHUNK_BYTES = 256 * 1024;
const ACTIVITY_TAIL_BYTES = 6 * 1024 * 1024;
const sessionMetaCache = new Map();
const activityCache = new Map();

function getCodexHome(configuredHome = '') {
  const explicit = String(configuredHome || '').trim();
  if (explicit) return path.resolve(expandHome(explicit));
  if (process.env.CODEX_HOME && process.env.CODEX_HOME.trim()) {
    return path.resolve(expandHome(process.env.CODEX_HOME.trim()));
  }
  return path.join(os.homedir(), '.codex');
}

function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function parseRolloutFileName(file) {
  const name = path.basename(file);
  const match = /^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-([0-9a-fA-F-]{20,})(?:_([0-9a-fA-F-]{20,}))?\.jsonl(?:\.gz|\.zst)?$/i.exec(name);
  if (!match) return null;
  return {
    timestamp: match[1],
    threadId: match[2],
    rolloutId: match[3] || match[2]
  };
}

async function listRolloutFiles(sessionsDir) {
  const results = [];
  const stack = [sessionsDir];

  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'EACCES')) continue;
      throw error;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) {
        try {
          const stat = await fsp.stat(full);
          const parsedName = parseRolloutFileName(full);
          results.push({
            file: full,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            fileThreadId: parsedName ? parsedName.threadId : ''
          });
        } catch {
          // File may disappear while Codex rotates it.
        }
      }
    }
  }

  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results;
}

async function readRange(file, start, length) {
  const handle = await fsp.open(file, 'r');
  try {
    if (length <= 0) return '';
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function readPrefix(file, maxBytes = SUMMARY_PREFIX_BYTES) {
  const stat = await fsp.stat(file);
  return readRange(file, 0, Math.min(stat.size, maxBytes));
}

async function readTail(file, maxBytes = ACTIVITY_TAIL_BYTES) {
  const stat = await fsp.stat(file);
  const length = Math.min(stat.size, maxBytes);
  const start = Math.max(0, stat.size - length);
  let text = await readRange(file, start, length);
  if (start > 0) {
    const newline = text.indexOf('\n');
    if (newline >= 0) text = text.slice(newline + 1);
  }
  return { text, stat, truncated: start > 0 };
}

function parseJsonLine(line) {
  const value = String(line || '').trim();
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractText(value) {
  if (typeof value === 'string') return value;
  if (!value) return '';
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join('\n');
  if (typeof value !== 'object') return '';

  if (typeof value.text === 'string') return value.text;
  if (typeof value.message === 'string') return value.message;

  if (Array.isArray(value.content)) {
    const content = value.content.map(item => {
      if (typeof item === 'string') return item;
      if (!item || typeof item !== 'object') return '';
      if (typeof item.text === 'string') return item.text;
      if (typeof item.input_text === 'string') return item.input_text;
      if (typeof item.output_text === 'string') return item.output_text;
      return '';
    }).filter(Boolean).join('\n');
    if (content) return content;
  }

  return '';
}

function firstUserTextFromItem(item) {
  if (!item || typeof item !== 'object') return '';
  if (item.type === 'event_msg' && item.payload && item.payload.type === 'user_message') {
    return extractText(item.payload.message || item.payload.content || item.payload.text || item.payload);
  }
  if (item.type === 'event_msg' && item.payload && item.payload.type === 'item_completed' && item.payload.item && item.payload.item.type === 'UserMessage') {
    return extractText(item.payload.item.content || item.payload.item.message || item.payload.item.text || item.payload.item);
  }
  if (item.type === 'response_item' && item.payload && item.payload.role === 'user') {
    return extractText(item.payload.content || item.payload.message || item.payload.text || item.payload);
  }
  if (item.type === 'response_item' && item.payload && item.payload.type === 'message' && item.payload.role === 'user') {
    return extractText(item.payload.content || item.payload.message || item.payload.text || item.payload);
  }
  return '';
}

function cleanTitle(text, maxLength = 100) {
  let value = String(text || '')
    .replace(/<recommended_plugins>[\s\S]*?(?:<\/recommended_plugins>|$)/gi, ' ')
    .replace(/<environment_context>[\s\S]*?(?:<\/environment_context>|$)/gi, ' ')
    .replace(/<user_editable_context>[\s\S]*?(?:<\/user_editable_context>|$)/gi, ' ')
    .replace(/<developer>[\s\S]*?(?:<\/developer>|$)/gi, ' ')
    .replace(/<system>[\s\S]*?(?:<\/system>|$)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!value) return '';
  if (value.length <= maxLength) return value;
  return value.slice(0, Math.max(1, maxLength - 1)).trimEnd() + '\u2026';
}

function parseSessionSource(source) {
  const result = {
    kind: '',
    subagentKind: '',
    parentThreadId: '',
    agentDepth: null,
    agentPath: '',
    agentNickname: '',
    agentRole: ''
  };

  if (typeof source === 'string') {
    result.kind = source.toLowerCase();
    return result;
  }
  if (!source || typeof source !== 'object') return result;

  if (Object.prototype.hasOwnProperty.call(source, 'custom')) {
    result.kind = String(source.custom || '').toLowerCase();
    return result;
  }
  if (Object.prototype.hasOwnProperty.call(source, 'internal')) {
    result.kind = 'internal';
    result.subagentKind = typeof source.internal === 'string' ? source.internal : Object.keys(source.internal || {})[0] || '';
    return result;
  }
  if (Object.prototype.hasOwnProperty.call(source, 'subagent')) {
    result.kind = 'subagent';
    const sub = source.subagent;
    if (typeof sub === 'string') {
      result.subagentKind = sub;
      return result;
    }
    if (sub && typeof sub === 'object') {
      if (sub.thread_spawn && typeof sub.thread_spawn === 'object') {
        const spawn = sub.thread_spawn;
        result.subagentKind = 'thread_spawn';
        result.parentThreadId = String(spawn.parent_thread_id || '');
        result.agentDepth = Number.isFinite(spawn.depth) ? spawn.depth : null;
        result.agentPath = stringifyAgentPath(spawn.agent_path);
        result.agentNickname = String(spawn.agent_nickname || '');
        result.agentRole = String(spawn.agent_role || '');
      } else if (Object.prototype.hasOwnProperty.call(sub, 'other')) {
        result.subagentKind = String(sub.other || 'other');
      } else {
        result.subagentKind = Object.keys(sub)[0] || '';
      }
    }
    return result;
  }

  if (typeof source.type === 'string') result.kind = source.type.toLowerCase();
  else result.kind = (Object.keys(source)[0] || '').toLowerCase();
  return result;
}

function stringifyAgentPath(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(String).join('/');
  if (!value || typeof value !== 'object') return '';
  if (Array.isArray(value.segments)) return value.segments.map(String).join('/');
  return JSON.stringify(value);
}

function sessionMetaFromItem(item) {
  if (!item || item.type !== 'session_meta' || !item.payload || typeof item.payload !== 'object') return null;
  const meta = item.payload;
  const sourceInfo = parseSessionSource(meta.source);
  const threadId = String(meta.id || meta.thread_id || meta.session_id || '').trim();
  if (!threadId) return null;
  return {
    threadId,
    sessionId: String(meta.session_id || threadId),
    parentThreadId: String(meta.parent_thread_id || sourceInfo.parentThreadId || ''),
    cwd: typeof meta.cwd === 'string' ? meta.cwd : '',
    source: sourceInfo.kind,
    sourceInfo,
    originator: typeof meta.originator === 'string' ? meta.originator : '',
    createdAt: typeof meta.timestamp === 'string' ? meta.timestamp : '',
    threadSource: typeof meta.thread_source === 'string' ? meta.thread_source : '',
    agentNickname: String(meta.agent_nickname || sourceInfo.agentNickname || ''),
    agentRole: String(meta.agent_role || sourceInfo.agentRole || ''),
    agentPath: stringifyAgentPath(meta.agent_path || sourceInfo.agentPath || '')
  };
}

async function readSessionMeta(file, knownStat = null) {
  let stat = knownStat;
  if (!stat || typeof stat.mtimeMs !== 'number') {
    const fsStat = await fsp.stat(file);
    stat = { mtimeMs: fsStat.mtimeMs, size: fsStat.size };
  }
  const prefix = await readPrefix(file, META_PREFIX_BYTES);
  for (const line of prefix.split(/\r?\n/)) {
    const item = parseJsonLine(line);
    const meta = sessionMetaFromItem(item);
    if (meta) return { ...meta, file, mtimeMs: stat.mtimeMs, size: stat.size };
  }
  return null;
}

async function readCachedSessionMeta(file, knownStat = null) {
  let stat = knownStat;
  if (!stat || typeof stat.mtimeMs !== 'number') {
    const fsStat = await fsp.stat(file);
    stat = { mtimeMs: fsStat.mtimeMs, size: fsStat.size };
  }
  const cached = sessionMetaCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.value;
  const value = await readSessionMeta(file, stat);
  sessionMetaCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  return value;
}

async function readSessionSummary(file, knownStat = null) {
  let stat = knownStat;
  if (!stat || typeof stat.mtimeMs !== 'number') {
    const fsStat = await fsp.stat(file);
    stat = { mtimeMs: fsStat.mtimeMs, size: fsStat.size };
  }

  const prefix = await readPrefix(file, SUMMARY_PREFIX_BYTES);
  let meta = null;
  let firstUserText = '';
  for (const line of prefix.split(/\r?\n/)) {
    const item = parseJsonLine(line);
    if (!item) continue;
    if (!meta) meta = sessionMetaFromItem(item);
    if (!firstUserText) firstUserText = firstUserTextFromItem(item);
    if (meta && firstUserText) break;
  }
  if (!meta) return null;

  const title = cleanTitle(firstUserText) || path.basename(meta.cwd || '') || 'Codex chat';
  return {
    ...meta,
    file,
    title,
    preview: cleanTitle(firstUserText, 220),
    mtimeMs: stat.mtimeMs,
    size: stat.size
  };
}

function taskEventFromLine(line) {
  const item = parseJsonLine(line);
  if (!item) return null;
  let payload = item;
  if (item.type === 'event_msg' && item.payload && typeof item.payload === 'object') payload = item.payload;
  if (!payload || typeof payload !== 'object') return null;
  const type = String(payload.type || '');
  const eventAt = timestampValue(
    payload.occurred_at_ms || payload.timestamp_ms || payload.occurred_at || payload.timestamp,
    item.timestamp
  );

  if (type === 'task_started' || type === 'turn_started') {
    return { kind: 'running', type, turnId: String(payload.turn_id || payload.id || ''), startedAt: timestampValue(payload.started_at_ms, payload.started_at) || eventAt, eventAt, raw: payload };
  }
  if (type === 'task_complete' || type === 'turn_complete') {
    return {
      kind: payload.error ? 'error' : 'completed',
      type,
      turnId: String(payload.turn_id || payload.id || ''),
      startedAt: timestampValue(payload.started_at_ms, payload.started_at),
      completedAt: timestampValue(payload.completed_at_ms, payload.completed_at) || eventAt,
      eventAt,
      error: payload.error || null,
      raw: payload
    };
  }
  if (type === 'turn_aborted' || type === 'task_aborted' || type === 'turn_cancelled' || type === 'task_cancelled') {
    return {
      kind: 'aborted',
      type,
      turnId: String(payload.turn_id || payload.id || ''),
      startedAt: timestampValue(payload.started_at_ms, payload.started_at),
      completedAt: timestampValue(payload.completed_at_ms, payload.completed_at) || eventAt,
      eventAt,
      error: payload.reason || payload.error || null,
      raw: payload
    };
  }
  if (type === 'error') {
    return { kind: 'error', type, turnId: String(payload.turn_id || payload.id || ''), eventAt, error: payload, raw: payload };
  }
  return null;
}

function timestampValue(primary, fallback) {
  const value = primary !== undefined && primary !== null ? primary : fallback;
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
    const number = Number(value);
    if (Number.isFinite(number)) return number > 1e12 ? number : number * 1000;
  }
  return null;
}

async function readLatestTaskEvent(file) {
  const handle = await fsp.open(file, 'r');
  try {
    const stat = await handle.stat();
    let position = stat.size;
    let carry = '';
    while (position > 0) {
      const start = Math.max(0, position - BACKWARD_CHUNK_BYTES);
      const length = position - start;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      const text = buffer.subarray(0, bytesRead).toString('utf8') + carry;
      const lines = text.split(/\r?\n/);
      carry = lines.shift() || '';
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const event = taskEventFromLine(lines[i]);
        if (event) return { ...event, mtimeMs: event.eventAt || stat.mtimeMs, rolloutMtimeMs: stat.mtimeMs, size: stat.size };
      }
      position = start;
    }
    if (carry) {
      const event = taskEventFromLine(carry);
      if (event) return { ...event, mtimeMs: event.eventAt || stat.mtimeMs, rolloutMtimeMs: stat.mtimeMs, size: stat.size };
    }
    return { kind: 'idle', type: '', turnId: '', mtimeMs: stat.mtimeMs, rolloutMtimeMs: stat.mtimeMs, size: stat.size };
  } finally {
    await handle.close();
  }
}

function timestampFromItem(item, payload = null) {
  const candidates = [
    payload && payload._startedAtMs,
    payload && payload._completedAtMs,
    payload && payload.started_at_ms,
    payload && payload.completed_at_ms,
    payload && payload.occurred_at_ms,
    payload && payload.timestamp_ms,
    payload && payload.started_at,
    payload && payload.completed_at,
    payload && payload.timestamp,
    item && item.completed_at_ms,
    item && item.started_at_ms,
    item && item.completed_at,
    item && item.started_at
  ];
  for (const value of candidates) {
    const parsed = timestampValue(value, undefined);
    if (parsed !== null) return parsed;
  }
  if (item && typeof item.timestamp === 'number') return timestampValue(item.timestamp, undefined) || 0;
  if (item && typeof item.timestamp === 'string') return timestampValue(item.timestamp, undefined) || 0;
  return 0;
}

function payloadFromItem(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.type === 'event_msg' && item.payload && typeof item.payload === 'object') {
    const payload = item.payload;
    if (payload.type === 'item_completed' && payload.item && typeof payload.item === 'object') {
      return normalizeCompletedItem(payload.item, payload);
    }
    return payload;
  }
  if (item.type === 'response_item' && item.payload && typeof item.payload === 'object') return item.payload;
  return null;
}

function normalizeCompletedItem(item, wrapper) {
  const type = String(item.type || '').toLowerCase();
  const common = {
    _completedAtMs: wrapper && wrapper.completed_at_ms,
    _startedAtMs: wrapper && wrapper.started_at_ms,
    _turnId: wrapper && wrapper.turn_id,
    _itemId: item.id || ''
  };
  if (type === 'commandexecution') {
    return {
      ...common,
      type: 'command_execution_completed',
      call_id: item.id || item.call_id || '',
      command: item.command,
      cwd: item.cwd,
      status: item.status,
      exit_code: item.exit_code,
      stdout: item.stdout || item.aggregated_output || item.formatted_output || '',
      stderr: item.stderr || ''
    };
  }
  if (type === 'filechange') {
    return {
      ...common,
      type: 'file_change_completed',
      call_id: item.id || item.call_id || '',
      changes: item.changes || {},
      status: item.status,
      stdout: item.stdout || '',
      stderr: item.stderr || ''
    };
  }
  if (type === 'imageview') {
    return { ...common, type: 'image_viewed', path: item.path || item.uri || item.file || '', call_id: item.id || '' };
  }
  if (type === 'usermessage') {
    return { ...common, type: 'user_message', message: extractText(item.content || item.message || item.text || item), images: item.images || [] };
  }
  if (type === 'agentmessage') {
    return { ...common, type: 'agent_message', message: extractText(item.content || item.message || item.text || item), phase: item.phase || '' };
  }
  if (type === 'subagentactivity') {
    return { ...common, type: 'sub_agent_activity', kind: item.kind || 'activity', agent_thread_id: item.agent_thread_id || '', agent_path: item.agent_path || '' };
  }
  if (type === 'reasoning') return { ...common, type: 'reasoning' };
  return { ...common, type: `item_completed:${String(item.type || 'activity')}`, detail: item.status || '', rawItemType: item.type || '' };
}

function compactText(text, maxLength = 180) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength - 1).trimEnd() + '\u2026';
}

function stringifyCommand(command) {
  if (Array.isArray(command)) return command.map(part => String(part)).join(' ');
  if (command && typeof command === 'object') return extractText(command) || JSON.stringify(command);
  return String(command || '');
}

function patchFiles(payload) {
  const changes = payload && payload.changes;
  if (changes && typeof changes === 'object') return Array.isArray(changes) ? changes.map(change => String(change.path || change.file || change)) : Object.keys(changes);
  const files = payload && (payload.files || payload.paths || payload.file_paths);
  if (Array.isArray(files)) return files.map(file => String(file));
  if (payload && (payload.path || payload.file_path)) return [String(payload.path || payload.file_path)];
  return [];
}

function imageCount(value) {
  if (!value) return 0;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + (typeof item === 'string' ? 1 : imageCount(item)), 0);
  if (typeof value !== 'object') return 0;
  const type = String(value.type || '').toLowerCase();
  let count = ['image', 'input_image', 'image_url', 'local_image', 'imageview'].includes(type) ? 1 : 0;
  for (const key of ['content', 'images', 'local_images', 'image_url', 'image']) count += imageCount(value[key]);
  return count;
}

function mcpLabel(payload) {
  const invocation = payload && payload.invocation;
  const server = invocation && invocation.server ? String(invocation.server) : '';
  const tool = invocation && invocation.tool ? String(invocation.tool) : '';
  const app = payload && payload.app_name ? String(payload.app_name) : '';
  const action = payload && payload.action_name ? String(payload.action_name) : '';
  if (app || action) return [app, action].filter(Boolean).join(' / ');
  return [server, tool].filter(Boolean).join(' / ');
}

function activityFromItem(item, actor = {}) {
  const payload = payloadFromItem(item);
  if (!payload) return null;
  const type = String(payload.type || '');
  const at = timestampFromItem(item, payload);
  const base = { at, type, threadId: actor.threadId || '', actor: actor.label || 'Root', detail: '', text: '', terminal: false, heartbeat: false };

  switch (type) {
    case 'task_started':
    case 'turn_started':
      return { ...base, kind: 'turn', label: 'Bat dau turn' };
    case 'task_complete':
    case 'turn_complete':
      return { ...base, kind: payload.error ? 'error' : 'complete', label: payload.error ? 'Turn ket thuc voi loi' : 'Turn hoan tat', terminal: true, detail: payload.error ? compactText(JSON.stringify(payload.error), 260) : '' };
    case 'turn_aborted':
    case 'task_aborted':
    case 'turn_cancelled':
    case 'task_cancelled':
      return { ...base, kind: 'error', label: 'Turn da dung', terminal: true, detail: compactText(payload.reason || payload.error || '', 260) };
    case 'error':
      return { ...base, kind: 'error', label: 'Loi', terminal: true, detail: compactText(payload.message || payload.error || JSON.stringify(payload), 260) };
    case 'warning':
    case 'guardian_warning':
      return { ...base, kind: 'warning', label: 'Canh bao', detail: compactText(payload.message || payload.text || JSON.stringify(payload), 260) };
    case 'agent_reasoning':
      return { ...base, kind: 'thinking', label: 'Dang suy nghi', heartbeat: true, text: String(payload.text || ''), detail: compactText(payload.text || '', 220) };
    case 'reasoning_content_delta':
      return { ...base, kind: 'thinking', label: 'Dang suy nghi', heartbeat: true, text: String(payload.delta || payload.text || '') };
    case 'agent_reasoning_section_break':
      return { ...base, kind: 'thinking', label: 'Dang suy nghi', heartbeat: true };
    case 'reasoning_raw_content_delta':
    case 'agent_reasoning_raw_content':
      return { ...base, kind: 'thinking', label: 'Dang suy nghi', heartbeat: true };
    case 'agent_message':
      return { ...base, kind: 'message', label: 'Dang tra loi', text: String(payload.message || ''), detail: compactText(payload.message || '', 220), heartbeat: true };
    case 'agent_message_content_delta':
      return { ...base, kind: 'message', label: 'Dang tra loi', text: String(payload.delta || payload.text || ''), detail: compactText(payload.delta || payload.text || '', 220), heartbeat: true };
    case 'user_message':
      return { ...base, kind: 'user', label: 'Nguoi dung gui', text: String(payload.message || ''), detail: compactText(payload.message || '', 220), heartbeat: true };
    case 'message':
      if (String(payload.role || '').toLowerCase() === 'user') return { ...base, kind: 'user', label: 'Nguoi dung gui', text: extractText(payload.content || payload.message || payload.text || ''), detail: compactText(extractText(payload.content || payload.message || payload.text || ''), 220), heartbeat: true };
      return { ...base, kind: 'message', label: 'Da tra loi', text: extractText(payload.content || payload.message || payload.text || ''), detail: compactText(extractText(payload.content || payload.message || payload.text || ''), 220), heartbeat: true };
    case 'command_execution_completed': {
      const command = stringifyCommand(payload.command);
      const exit = Number.isFinite(payload.exit_code) ? ` (exit ${payload.exit_code})` : '';
      const output = compactText(payload.stdout || payload.stderr || '', 700);
      return { ...base, kind: 'command', phase: 'end', callId: String(payload.call_id || payload._itemId || ''), label: payload.status && String(payload.status).toLowerCase() !== 'completed' ? 'Lenh that bai' : 'Da chay lenh', detail: `${compactText(command, 420)}${exit}${output ? `\n${output}` : ''}` };
    }
    case 'file_change_completed': {
      const files = patchFiles(payload);
      const output = compactText(payload.stdout || payload.stderr || '', 500);
      return { ...base, kind: 'patch', phase: 'end', callId: String(payload.call_id || payload._itemId || ''), label: payload.status && String(payload.status).toLowerCase() !== 'completed' ? 'Sua tep that bai' : 'Da chinh sua cac tep', detail: output, children: files.map(file => ({ label: 'Tep da chinh sua', detail: file })) };
    }
    case 'image_viewed':
      return { ...base, kind: 'image', phase: 'end', callId: String(payload.call_id || payload._itemId || ''), label: 'Da xem anh', detail: compactText(payload.path || payload.uri || payload.file || '', 320) };
    case 'reasoning':
      return { ...base, kind: 'thinking', label: 'Dang suy nghi', heartbeat: true };
    case 'exec_command_begin':
      return { ...base, kind: 'command', phase: 'begin', callId: String(payload.call_id || ''), label: 'Dang chay lenh', detail: compactText(stringifyCommand(payload.command), 320) };
    case 'exec_command_output_delta':
      return { ...base, kind: 'command', phase: 'progress', callId: String(payload.call_id || ''), label: 'Dang chay lenh', heartbeat: true };
    case 'exec_command_end':
      return { ...base, kind: 'command', phase: 'end', callId: String(payload.call_id || ''), label: 'Lenh da xong', detail: `${compactText(stringifyCommand(payload.command), 260)}${Number.isFinite(payload.exit_code) ? ` (exit ${payload.exit_code})` : ''}` };
    case 'function_call':
    case 'custom_tool_call': {
      const name = String(payload.name || payload.tool || '').toLowerCase();
      const input = payload.input || payload.arguments || payload.command || '';
      const detail = compactText(typeof input === 'string' ? input : JSON.stringify(input), 420);
      if (name === 'exec' || name === 'exec_command' || name.includes('command')) {
        return { ...base, kind: 'command', phase: 'begin', callId: String(payload.call_id || payload.id || ''), label: 'Dang chay lenh', detail };
      }
      if (name === 'spawn_agent' || name.includes('agent')) {
        return { ...base, kind: 'agent', phase: 'begin', callId: String(payload.call_id || payload.id || ''), label: 'Dang tao sub-agent', detail };
      }
      return { ...base, kind: 'tool', phase: 'begin', callId: String(payload.call_id || payload.id || ''), label: 'Dang goi tool', detail: compactText(name || detail, 260) };
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const output = payload.output;
      const detail = compactText(typeof output === 'string' ? output : JSON.stringify(output || ''), 700);
      return { ...base, kind: 'tool', phase: 'end', callId: String(payload.call_id || payload.id || ''), label: 'Tool da xong', detail };
    }
    case 'terminal_interaction':
      return { ...base, kind: 'command', label: 'Dang tuong tac terminal', heartbeat: true, detail: compactText(payload.stdin || payload.input || '', 220) };
    case 'patch_apply_begin': {
      const files = patchFiles(payload);
      return { ...base, kind: 'patch', phase: 'begin', callId: String(payload.call_id || ''), label: 'Dang sua code', detail: compactText(files.join(', '), 320) };
    }
    case 'patch_apply_updated': {
      const files = patchFiles(payload);
      return { ...base, kind: 'patch', phase: 'progress', callId: String(payload.call_id || ''), label: 'Dang sua code', heartbeat: true, detail: compactText(files.join(', '), 320) };
    }
    case 'patch_apply_end': {
      const files = patchFiles(payload);
      return { ...base, kind: 'patch', phase: 'end', callId: String(payload.call_id || ''), label: payload.success === false ? 'Sua code that bai' : 'Da sua code', detail: '', children: files.map(file => ({ label: 'Tep da chinh sua', detail: file })) };
    }
    case 'mcp_tool_call_begin':
      return { ...base, kind: 'mcp', phase: 'begin', callId: String(payload.call_id || ''), label: 'Dang goi MCP', detail: compactText(mcpLabel(payload), 260) };
    case 'mcp_tool_call_end':
      return { ...base, kind: 'mcp', phase: 'end', callId: String(payload.call_id || ''), label: 'MCP da xong', detail: compactText(mcpLabel(payload), 260) };
    case 'dynamic_tool_call_request':
      return { ...base, kind: 'tool', phase: 'begin', callId: String(payload.call_id || ''), label: 'Dang goi tool', detail: compactText(payload.tool || payload.name || '', 260) };
    case 'dynamic_tool_call_response':
      return { ...base, kind: 'tool', phase: 'end', callId: String(payload.call_id || ''), label: 'Tool da xong', detail: compactText(payload.tool || payload.name || '', 260) };
    case 'web_search_begin':
      return { ...base, kind: 'web', phase: 'begin', callId: String(payload.call_id || ''), label: 'Dang tim web' };
    case 'web_search_end':
      return { ...base, kind: 'web', phase: 'end', callId: String(payload.call_id || ''), label: 'Tim web da xong', detail: compactText(payload.query || '', 260) };
    case 'image_generation_begin':
      return { ...base, kind: 'image', phase: 'begin', callId: String(payload.call_id || ''), label: 'Dang tao anh' };
    case 'image_generation_end':
      return { ...base, kind: 'image', phase: 'end', callId: String(payload.call_id || ''), label: 'Tao anh da xong', detail: compactText(payload.status || '', 120) };
    case 'exec_approval_request':
    case 'apply_patch_approval_request':
    case 'request_permissions':
      return { ...base, kind: 'waiting', label: 'Dang cho phep', detail: compactText(payload.reason || payload.command || payload.message || '', 260) };
    case 'request_user_input':
    case 'elicitation_request':
      return { ...base, kind: 'waiting', label: 'Dang cho ban tra loi', detail: compactText(payload.question || payload.message || '', 260) };
    case 'stream_error':
      return { ...base, kind: 'network', label: 'Loi stream / dang thu lai', detail: compactText(payload.message || payload.error || '', 260) };
    case 'collab_agent_spawn_begin':
      return { ...base, kind: 'agent', phase: 'begin', callId: String(payload.call_id || ''), label: 'Dang tao sub-agent', detail: compactText(payload.prompt || payload.agent_role || '', 260) };
    case 'collab_agent_spawn_end':
      return { ...base, kind: 'agent', phase: 'end', callId: String(payload.call_id || ''), label: 'Da tao sub-agent', detail: compactText(payload.new_agent_nickname || payload.new_agent_role || payload.new_thread_id || '', 260) };
    case 'collab_agent_interaction_begin':
      return { ...base, kind: 'agent', phase: 'begin', callId: String(payload.call_id || ''), label: 'Dang tuong tac sub-agent', detail: compactText(payload.prompt || payload.receiver_thread_id || '', 260) };
    case 'collab_agent_interaction_end':
      return { ...base, kind: 'agent', phase: 'end', callId: String(payload.call_id || ''), label: 'Sub-agent phan hoi', detail: compactText(payload.receiver_agent_nickname || payload.receiver_agent_role || payload.receiver_thread_id || '', 260) };
    case 'collab_waiting_begin':
      return { ...base, kind: 'agent', phase: 'begin', callId: String(payload.call_id || ''), label: 'Dang cho sub-agent', detail: Array.isArray(payload.receiver_thread_ids) ? `${payload.receiver_thread_ids.length} agent` : '' };
    case 'collab_waiting_end':
      return { ...base, kind: 'agent', phase: 'end', callId: String(payload.call_id || ''), label: 'Da nhan sub-agent' };
    case 'collab_close_begin':
      return { ...base, kind: 'agent', phase: 'begin', callId: String(payload.call_id || ''), label: 'Dang dong sub-agent', detail: compactText(payload.receiver_thread_id || '', 120) };
    case 'collab_close_end':
      return { ...base, kind: 'agent', phase: 'end', callId: String(payload.call_id || ''), label: 'Da dong sub-agent', detail: compactText(payload.receiver_agent_nickname || payload.receiver_thread_id || '', 160) };
    case 'collab_resume_begin':
      return { ...base, kind: 'agent', phase: 'begin', callId: String(payload.call_id || ''), label: 'Dang resume sub-agent' };
    case 'collab_resume_end':
      return { ...base, kind: 'agent', phase: 'end', callId: String(payload.call_id || ''), label: 'Da resume sub-agent' };
    case 'sub_agent_activity':
      return { ...base, kind: 'agent', label: `Sub-agent: ${String(payload.kind || 'activity')}`, detail: compactText(stringifyAgentPath(payload.agent_path) || payload.agent_thread_id || '', 180) };
    case 'hook_started':
      return { ...base, kind: 'hook', phase: 'begin', callId: String(payload.call_id || payload.id || ''), label: 'Dang chay hook', detail: compactText(payload.name || payload.hook_name || '', 180) };
    case 'hook_completed':
      return { ...base, kind: 'hook', phase: 'end', callId: String(payload.call_id || payload.id || ''), label: 'Hook da xong', detail: compactText(payload.name || payload.hook_name || '', 180) };
    default:
      return null;
  }
}

function activityKey(activity) {
  return `${activity.kind}:${activity.callId || ''}`;
}

function computeCurrentActivity(activities, status) {
  const open = new Map();
  let latestMeaningful = null;
  for (const activity of activities) {
    if (!activity) continue;
    if (activity.phase === 'begin' && activity.callId) open.set(activityKey(activity), activity);
    else if (activity.phase === 'end' && activity.callId) open.delete(activityKey(activity));
    else if (activity.phase === 'progress' && activity.callId && open.has(activityKey(activity))) {
      const started = open.get(activityKey(activity));
      open.set(activityKey(activity), { ...started, at: activity.at || started.at });
    }
    if (activity.heartbeat || activity.phase === 'begin' || ['thinking', 'message', 'waiting', 'network'].includes(activity.kind)) latestMeaningful = activity;
  }

  const openItems = Array.from(open.values()).sort((a, b) => (b.at || 0) - (a.at || 0));
  if (openItems.length) return openItems[0];
  if (status && status.kind === 'running') {
    if (latestMeaningful && !latestMeaningful.terminal) return latestMeaningful;
    return { kind: 'running', label: 'Dang xu ly', detail: '', at: status.mtimeMs || 0 };
  }
  if (status && status.kind === 'completed') return { kind: 'complete', label: 'Da hoan tat', detail: '', at: status.completedAt || status.mtimeMs || 0 };
  if (status && status.kind === 'error') return { kind: 'error', label: 'Da dung voi loi', detail: '', at: status.completedAt || status.mtimeMs || 0 };
  if (status && status.kind === 'aborted') return { kind: 'error', label: 'Turn da dung', detail: compactText(status.error || '', 260), at: status.completedAt || status.mtimeMs || 0 };
  return { kind: 'idle', label: 'Dang ranh', detail: '', at: status && status.mtimeMs || 0 };
}

function looksLikeOpaqueId(value) {
  const text = String(value || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(text) || /^[0-9a-f]{24,}$/i.test(text);
}

function humanizeRole(value) {
  const text = String(value || '').trim();
  if (!text || looksLikeOpaqueId(text)) return '';
  return text
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, ch => ch.toUpperCase())
    .trim();
}

function taskNameFromPrompt(value, maxLength = 58) {
  let text = cleanTitle(value, 240);
  if (!text) return '';
  text = text
    .replace(/^you are (?:a|an|the)\s+/i, '')
    .replace(/^(?:please\s+)?(?:investigate|check|review|analyze|analyse|fix|implement|update|refactor|test|verify)\s+/i, match => match.trim() + ' ')
    .split(/\r?\n|[.!?](?:\s|$)/)[0]
    .replace(/^[#>*\-\s]+/, '')
    .trim();
  if (!text || looksLikeOpaqueId(text)) return '';
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1).trimEnd() + '\u2026';
}

function agentDisplayName(session, rootThreadId, taskPreview = '', ordinal = 1) {
  if (!session || session.threadId === rootThreadId) return 'Main';
  const nickname = cleanTitle(session.agentNickname || '', 48);
  if (nickname && !looksLikeOpaqueId(nickname)) return nickname;
  const role = humanizeRole(session.agentRole || session.sourceInfo && session.sourceInfo.agentRole || '');
  if (role && role.toLowerCase() !== 'worker') return role;
  const task = taskNameFromPrompt(taskPreview, 58);
  if (task) return task;
  if (role) return role;
  return `Sub-agent ${Math.max(1, Number(ordinal) || 1)}`;
}

function actorLabel(session, rootThreadId) {
  if (!session || session.threadId === rootThreadId) return 'Main';
  return agentDisplayName(session, rootThreadId, session.taskPreview || '', session.agentOrdinal || 1);
}

async function readRecentActivity(file, session, rootThreadId, options = {}) {
  const maxBytes = clampInt(options.maxBytes, ACTIVITY_TAIL_BYTES, 128 * 1024, 32 * 1024 * 1024);
  const timelineLimit = clampInt(options.timelineLimit, 40, 5, 200);
  const currentStat = await fsp.stat(file);
  const cacheKey = `${file}|${maxBytes}|${timelineLimit}`;
  const cached = activityCache.get(cacheKey);
  if (cached && cached.mtimeMs === currentStat.mtimeMs && cached.size === currentStat.size) return cached.value;
  const { text, stat, truncated } = await readTail(file, maxBytes);
  const actor = { threadId: session.threadId, label: actorLabel(session, rootThreadId) };
  const activities = [];
  let latestUserText = '';
  let latestAssistantText = '';
  let streamingAssistantText = '';
  let latestReasoningText = '';
  let streamingReasoningText = '';
  const operationKinds = new Map();

  for (const line of text.split(/\r?\n/)) {
    const item = parseJsonLine(line);
    if (!item) continue;
    const userText = firstUserTextFromItem(item);
    if (userText) latestUserText = userText;

    if (item.type === 'event_msg' && item.payload) {
      const eventType = item.payload.type;
      if (eventType === 'agent_message') {
        const msg = extractText(item.payload.message || item.payload);
        if (msg) latestAssistantText = msg;
        streamingAssistantText = '';
      } else if (eventType === 'agent_message_content_delta') {
        streamingAssistantText += String(item.payload.delta || item.payload.text || '');
      } else if (eventType === 'agent_reasoning') {
        const reasoning = String(item.payload.text || '');
        if (reasoning) latestReasoningText = reasoning;
        streamingReasoningText = '';
      } else if (eventType === 'reasoning_content_delta') {
        streamingReasoningText += String(item.payload.delta || item.payload.text || '');
      } else if (eventType === 'agent_reasoning_section_break') {
        if (streamingReasoningText) streamingReasoningText += '\n';
      }
    } else if (item.type === 'response_item' && item.payload && item.payload.role === 'assistant') {
      const msg = extractText(item.payload.content || item.payload);
      if (msg) latestAssistantText = msg;
    }

    let activity = activityFromItem(item, actor);
    // Current Codex emits an `exec` custom_tool_call followed by a generic
    // custom_tool_call_output. Keep the call identity so the completed row is
    // rendered as a command result instead of an unrelated generic tool row.
    if (activity && activity.callId) {
      if (activity.phase === 'begin') operationKinds.set(activity.callId, activity.kind);
      else if (activity.phase === 'end' && operationKinds.get(activity.callId) === 'command' && activity.kind === 'tool') {
        activity = { ...activity, kind: 'command', label: 'Da chay lenh' };
      }
      if (activity.phase === 'end') operationKinds.delete(activity.callId);
    }
    if (activity) {
      activities.push(activity);
      if (activity.kind === 'user' && activity.text) latestUserText = activity.text;
      if (activity.kind === 'message' && activity.text && activity.type !== 'agent_message_content_delta') {
        latestAssistantText = activity.text;
        streamingAssistantText = '';
      }
      const activityPayload = payloadFromItem(item);
      const viewed = activityPayload && activityPayload.type === 'user_message'
        ? imageCount(activityPayload.images || activityPayload.local_images || activityPayload.content)
        : 0;
      if (viewed > 0) {
        activities.push({
          at: activity.at,
          type: 'image_viewed',
          kind: 'image',
          phase: 'end',
          callId: '',
          threadId: actor.threadId || '',
          actor: actor.label || 'Root',
          detail: `${viewed} image${viewed === 1 ? '' : 's'}`,
          text: '',
          terminal: false,
          heartbeat: false,
          label: viewed === 1 ? 'Da xem anh' : `Da xem ${viewed} anh`
        });
      }
    }
  }

  const status = await readLatestTaskEvent(file);
  const current = computeCurrentActivity(activities, status);
  const noisyTypes = new Set(['exec_command_output_delta', 'reasoning_content_delta', 'reasoning_raw_content_delta', 'agent_message_content_delta', 'reasoning']);
  const timeline = activities.filter(activity => !noisyTypes.has(activity.type) && (!activity.heartbeat || ['agent_message', 'agent_reasoning', 'message', 'user_message'].includes(activity.type))).slice(-timelineLimit);
  let currentText = '';
  if (current && current.kind === 'message') currentText = streamingAssistantText || latestAssistantText || current.text || '';
  else if (current && current.kind === 'thinking') currentText = streamingReasoningText || latestReasoningText || current.text || '';

  const value = {
    status,
    current: { ...current, text: currentText },
    timeline,
    latestUserText,
    latestAssistantText: streamingAssistantText || latestAssistantText,
    latestReasoningText: streamingReasoningText || latestReasoningText,
    truncated,
    mtimeMs: stat.mtimeMs,
    size: stat.size
  };
  activityCache.set(cacheKey, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  return value;
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      try { results[index] = await mapper(items[index], index); }
      catch (error) { results[index] = { __error: error }; }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, worker));
  return results;
}

function isRootSession(summary) {
  if (!summary) return false;
  if (summary.parentThreadId) return false;
  if (summary.source === 'subagent' || summary.source === 'internal') return false;
  return true;
}

async function scanSessions(options = {}) {
  const sessionsDir = options.sessionsDir;
  const historyLimit = clampInt(options.historyLimit, 100, 10, 1000);
  const includeNonVsCodeSessions = Boolean(options.includeNonVsCodeSessions);
  if (!sessionsDir) return [];

  const files = await listRolloutFiles(sessionsDir);
  const candidates = files.slice(0, Math.min(files.length, historyLimit * 4));
  const summaries = await mapLimit(candidates, 8, entry => readSessionSummary(entry.file, entry));
  const byThread = new Map();
  for (const summary of summaries) {
    if (!summary || summary.__error || !isRootSession(summary)) continue;
    if (!includeNonVsCodeSessions && summary.source && summary.source !== 'vscode') continue;
    const existing = byThread.get(summary.threadId);
    if (!existing || summary.mtimeMs > existing.mtimeMs) byThread.set(summary.threadId, summary);
  }
  return Array.from(byThread.values()).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, historyLimit);
}

async function readThreadNames(codexHome, threadIds) {
  const wanted = new Set(Array.from(threadIds || []).map(String).filter(Boolean));
  const result = new Map();
  if (!codexHome || wanted.size === 0) return result;
  const indexFile = path.join(codexHome, 'session_index.jsonl');
  let text = '';
  try {
    text = await fsp.readFile(indexFile, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return result;
    throw error;
  }
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0 && result.size < wanted.size; i -= 1) {
    const item = parseJsonLine(lines[i]);
    if (!item) continue;
    const id = String(item.id || item.thread_id || '');
    if (!wanted.has(id) || result.has(id)) continue;
    const name = cleanTitle(item.thread_name || item.title || '', 140);
    result.set(id, { name, updatedAt: String(item.updated_at || '') });
  }
  return result;
}

// The rollout file is an append-only transport and can be flushed after the
// thread state has already changed.  Newer Codex builds persist the authoritative
// thread update in state_*.sqlite, so use it as a read-only activity clock when
// the host Node runtime exposes the built-in SQLite driver.  Older VS Code
// runtimes simply fall back to session_index.jsonl and rollout event timestamps.
function readStateThreadActivity(codexHome, threadIds) {
  const wanted = Array.from(threadIds || []).map(String).filter(Boolean);
  const result = new Map();
  if (!codexHome || !wanted.length) return result;

  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    return result;
  }

  let files;
  try {
    files = fs.readdirSync(codexHome)
      .filter(name => /^state(?:_\d+)?\.sqlite$/i.test(name))
      .sort()
      .map(name => path.join(codexHome, name));
  } catch {
    return result;
  }

  const placeholders = wanted.map(() => '?').join(',');
  for (const file of files) {
    let db;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      const rows = db.prepare(`SELECT id, updated_at_ms, updated_at FROM threads WHERE id IN (${placeholders})`).all(...wanted);
      for (const row of rows) {
        const id = String(row.id || '');
        const milliseconds = Number(row.updated_at_ms);
        const seconds = Number(row.updated_at);
        const updatedAtMs = Number.isFinite(milliseconds) && milliseconds > 0
          ? milliseconds
          : (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0);
        if (id && updatedAtMs) result.set(id, Math.max(result.get(id) || 0, updatedAtMs));
      }
    } catch {
      // A database can be in the middle of a rotation or use an older schema.
      // The JSONL/index path remains a valid fallback in that case.
    } finally {
      try { if (db) db.close(); } catch {}
    }
  }
  return result;
}

function rootThreadForMeta(meta, byThread) {
  if (!meta) return '';
  if (isRootSession(meta)) return meta.threadId;
  if (meta.sessionId && meta.sessionId !== meta.threadId) return meta.sessionId;
  const seen = new Set();
  let current = meta;
  while (current && current.parentThreadId && !seen.has(current.threadId)) {
    seen.add(current.threadId);
    const parent = byThread.get(current.parentThreadId);
    if (!parent) return current.parentThreadId;
    if (isRootSession(parent)) return parent.threadId;
    current = parent;
  }
  return '';
}

async function scanActiveSessions(options = {}) {
  const sessionsDir = options.sessionsDir;
  const codexHome = options.codexHome || (sessionsDir ? path.dirname(sessionsDir) : '');
  const historyLimit = clampInt(options.historyLimit, 100, 10, 1000);
  const scanLimit = clampInt(options.scanLimit, 1200, 50, 10000);
  const includeNonVsCodeSessions = Boolean(options.includeNonVsCodeSessions);
  if (!sessionsDir) return [];

  const files = await listRolloutFiles(sessionsDir);
  const candidates = files.slice(0, Math.min(files.length, Math.max(scanLimit, historyLimit * 6)));
  const metas = await mapLimit(candidates, 12, entry => readCachedSessionMeta(entry.file, entry));
  const byThread = new Map();
  for (const meta of metas) {
    if (!meta || meta.__error) continue;
    const existing = byThread.get(meta.threadId);
    if (!existing || meta.mtimeMs > existing.mtimeMs) byThread.set(meta.threadId, meta);
  }

  const nodes = Array.from(byThread.values());
  const withStatus = await mapLimit(nodes, 10, async meta => {
    const status = await readLatestTaskEvent(meta.file);
    return { ...meta, status };
  });
  const rootNodes = new Map();
  for (const node of withStatus) {
    if (node && !node.__error && isRootSession(node)) rootNodes.set(node.threadId, node);
  }
  const activeRootIds = new Set();
  const treeStats = new Map();
  for (const node of withStatus) {
    if (!node || node.__error) continue;
    const rootId = rootThreadForMeta(node, byThread);
    if (!rootId) continue;
    let stats = treeStats.get(rootId);
    if (!stats) {
      stats = { latestMtime: 0, runningChildren: 0, runningCount: 0 };
      treeStats.set(rootId, stats);
    }
    stats.latestMtime = Math.max(stats.latestMtime, node.mtimeMs || 0);
    const rootNode = rootNodes.get(rootId) || null;
    if (isRunningConversationNode(node, rootNode, rootId)) {
      activeRootIds.add(rootId);
      stats.runningCount += 1;
      if (node.threadId !== rootId) stats.runningChildren += 1;
    }
  }

  const active = [];
  for (const rootId of activeRootIds) {
    let rootMeta = byThread.get(rootId) || null;
    let summary = null;
    if (rootMeta) summary = await readSessionSummary(rootMeta.file, rootMeta);
    if (!summary) summary = await findLatestRolloutForThread(sessionsDir, rootId, { scanLimit });
    if (!summary || !isRootSession(summary)) continue;
    if (!includeNonVsCodeSessions && summary.source && summary.source !== 'vscode') continue;
    const stats = treeStats.get(rootId) || { latestMtime: summary.mtimeMs || 0, runningChildren: 0, runningCount: 1 };
    active.push({
      ...summary,
      mtimeMs: Math.max(summary.mtimeMs || 0, stats.latestMtime || 0),
      status: { kind: 'running', mtimeMs: Math.max(summary.mtimeMs || 0, stats.latestMtime || 0), runningChildren: stats.runningChildren, runningCount: stats.runningCount }
    });
  }

  const names = await readThreadNames(codexHome, new Set(active.map(item => item.threadId)));
  const stateTimes = readStateThreadActivity(codexHome, new Set(active.map(item => item.threadId)));
  for (const session of active) {
    const indexed = names.get(session.threadId);
    if (indexed && indexed.name) {
      session.title = indexed.name;
      session.titleUpdatedAt = indexed.updatedAt;
    }
    const indexedUpdatedAtMs = Math.max(
      parseTimestampMs(indexed && indexed.updatedAt),
      stateTimes.get(session.threadId) || 0
    );
    if (indexedUpdatedAtMs) {
      session.indexedUpdatedAtMs = indexedUpdatedAtMs;
      session.mtimeMs = Math.max(session.mtimeMs || 0, indexedUpdatedAtMs);
      if (session.status) session.status.mtimeMs = Math.max(session.status.mtimeMs || 0, indexedUpdatedAtMs);
    }
  }
  active.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
  return active.slice(0, historyLimit);
}

async function attachStatuses(sessions) {
  const statuses = await mapLimit(sessions, 8, async session => ({ ...session, status: await readLatestTaskEvent(session.file) }));
  return statuses.filter(value => value && !value.__error);
}

function parseTimestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric > 1e12 ? numeric : numeric * 1000;
  }
  return 0;
}

function isTerminalStatus(status) {
  return Boolean(status && ['completed', 'error', 'aborted'].includes(status.kind));
}

// A child rollout is active only when its own task is running and it belongs to
// the current lifecycle of the root.  Old child files can remain open forever
// after a root task completed; their earlier task_started event must not revive
// the conversation.  This compares lifecycle event order, never wall-clock age.
function isRunningConversationNode(node, rootNode, rootThreadId) {
  if (!node || !node.status || node.status.kind !== 'running') return false;
  if (node.threadId === rootThreadId || !rootNode) return true;

  const rootTurnId = String(rootNode.status.turnId || '');
  const childRootTurnId = String(node.status.raw && node.status.raw.root_turn_id || '');
  if (rootTurnId && childRootTurnId && childRootTurnId !== rootTurnId) return false;

  const childStartedAt = Number(node.status.startedAt || node.status.eventAt || 0);
  const rootStartedAt = Number(rootNode.status.startedAt || rootNode.status.eventAt || 0);
  if (childStartedAt && rootStartedAt && childStartedAt < rootStartedAt) return false;
  if (!isTerminalStatus(rootNode.status)) return true;

  const rootEndedAt = Number(rootNode.status.completedAt || rootNode.status.eventAt || 0);
  if (childStartedAt && rootEndedAt && childStartedAt <= rootEndedAt) return false;
  return true;
}

async function findLatestRolloutForThread(sessionsDir, threadId, options = {}) {
  if (!threadId) return null;
  const scanLimit = clampInt(options.scanLimit, 300, 10, 5000);
  const files = await listRolloutFiles(sessionsDir);
  const byName = files.filter(entry => entry.fileThreadId && entry.fileThreadId.toLowerCase() === String(threadId).toLowerCase());
  const candidates = byName.length ? byName : files.slice(0, scanLimit);
  for (const entry of candidates.slice(0, scanLimit)) {
    try {
      const summary = await readSessionSummary(entry.file, entry);
      if (summary && summary.threadId === threadId) return summary;
    } catch {
      // Ignore transient files.
    }
  }
  return null;
}

async function scanSessionTree(sessionsDir, rootSession, options = {}) {
  if (!rootSession || !rootSession.threadId) return [];
  const rootThreadId = rootSession.threadId;
  const rootSessionId = rootSession.sessionId || rootThreadId;
  const scanLimit = clampInt(options.scanLimit, 1200, 50, 10000);
  const files = await listRolloutFiles(sessionsDir);
  const candidates = files.slice(0, Math.min(files.length, scanLimit));
  const metas = await mapLimit(candidates, 12, entry => readCachedSessionMeta(entry.file, entry));

  const matching = [];
  for (const meta of metas) {
    if (!meta || meta.__error) continue;
    const sameRoot = meta.threadId === rootThreadId;
    const sameSession = meta.sessionId === rootSessionId || meta.sessionId === rootThreadId;
    if (sameRoot || sameSession) matching.push(meta);
  }

  // Legacy fallback: recursively include children linked by parent_thread_id even if their
  // old rollout synthesized session_id from the child thread itself.
  const includedIds = new Set(matching.map(item => item.threadId));
  includedIds.add(rootThreadId);
  let changed = true;
  while (changed) {
    changed = false;
    for (const meta of metas) {
      if (!meta || meta.__error || includedIds.has(meta.threadId)) continue;
      if (meta.parentThreadId && includedIds.has(meta.parentThreadId)) {
        matching.push(meta);
        includedIds.add(meta.threadId);
        changed = true;
      }
    }
  }

  const byThread = new Map();
  for (const meta of matching) {
    const existing = byThread.get(meta.threadId);
    if (!existing || meta.mtimeMs > existing.mtimeMs) byThread.set(meta.threadId, meta);
  }
  if (!byThread.has(rootThreadId)) byThread.set(rootThreadId, rootSession);

  return Array.from(byThread.values()).sort((a, b) => {
    if (a.threadId === rootThreadId) return -1;
    if (b.threadId === rootThreadId) return 1;
    const da = a.sourceInfo && Number.isFinite(a.sourceInfo.agentDepth) ? a.sourceInfo.agentDepth : 999;
    const db = b.sourceInfo && Number.isFinite(b.sourceInfo.agentDepth) ? b.sourceInfo.agentDepth : 999;
    return da - db || b.mtimeMs - a.mtimeMs;
  });
}

async function buildSessionSnapshot(sessionsDir, rootSession, options = {}) {
  const tree = Array.isArray(options.tree) && options.tree.length ? options.tree : await scanSessionTree(sessionsDir, rootSession, { scanLimit: options.scanLimit });
  const rootThreadId = rootSession.threadId;
  const codexHome = options.codexHome || path.dirname(sessionsDir || '');
  const stateTimes = readStateThreadActivity(codexHome, tree.map(session => session && session.threadId));
  const indexedNames = options.indexedActivity instanceof Map ? options.indexedActivity : new Map();
  const nodes = await mapLimit(tree, 6, async session => {
    const [activity, summary] = await Promise.all([
      readRecentActivity(session.file, session, rootThreadId, {
        maxBytes: options.activityMaxBytes,
        timelineLimit: options.timelinePerNode || 30
      }),
      readSessionSummary(session.file, session).catch(() => null)
    ]);
    return {
      ...session,
      ...activity,
      indexedUpdatedAtMs: Math.max(stateTimes.get(session.threadId) || 0, Number(indexedNames.get(session.threadId) || 0)),
      taskPreview: summary && summary.preview || ''
    };
  });
  const validNodes = nodes.filter(node => node && !node.__error);
  const childrenOldestFirst = validNodes
    .filter(node => node.threadId !== rootThreadId)
    .slice()
    .sort((a, b) => {
      const aCreated = Date.parse(a.createdAt || '') || a.mtimeMs || 0;
      const bCreated = Date.parse(b.createdAt || '') || b.mtimeMs || 0;
      return aCreated - bCreated || String(a.threadId).localeCompare(String(b.threadId));
    });
  const childOrdinal = new Map(childrenOldestFirst.map((node, index) => [node.threadId, index + 1]));
  for (const node of validNodes) {
    node.agentOrdinal = childOrdinal.get(node.threadId) || 0;
    node.displayName = agentDisplayName(node, rootThreadId, node.taskPreview || '', node.agentOrdinal || 1);
  }

  const rootNode = validNodes.find(node => node.threadId === rootThreadId) || null;
  const runningNodes = validNodes.filter(node => isRunningConversationNode(node, rootNode, rootThreadId));
  const latestMtime = validNodes.reduce((max, node) => Math.max(max, node.mtimeMs || 0), 0);
  const latestIndexedActivityMs = validNodes.reduce((max, node) => Math.max(max, node.indexedUpdatedAtMs || 0), 0);
  let overallStatus = rootNode && rootNode.status ? { ...rootNode.status } : { kind: 'unknown', mtimeMs: latestMtime };
  if (runningNodes.length) {
    const latestRunning = runningNodes.reduce((best, node) => !best || (node.mtimeMs || 0) > (best.mtimeMs || 0) ? node : best, null);
    overallStatus = { ...(latestRunning.status || {}), kind: 'running', mtimeMs: latestMtime, runningChildren: runningNodes.filter(node => node.threadId !== rootThreadId).length };
  } else {
    overallStatus.mtimeMs = latestMtime || overallStatus.mtimeMs;
  }
  if (latestIndexedActivityMs) overallStatus.mtimeMs = Math.max(overallStatus.mtimeMs || 0, latestIndexedActivityMs);

  const allTimeline = [];
  for (const node of validNodes) {
    for (const entry of node.timeline || []) {
      allTimeline.push({ ...entry, actor: node.displayName || actorLabel(node, rootThreadId), threadId: node.threadId });
    }
  }
  allTimeline.sort((a, b) => (b.at || 0) - (a.at || 0));

  const currentCandidates = runningNodes.map(node => ({ ...node.current, actor: node.displayName || actorLabel(node, rootThreadId), threadId: node.threadId, nodeStatus: node.status })).filter(Boolean);
  if (!currentCandidates.length && rootNode && rootNode.current) {
    currentCandidates.push({ ...rootNode.current, actor: rootNode.displayName || actorLabel(rootNode, rootThreadId), threadId: rootNode.threadId, nodeStatus: rootNode.status });
  }
  currentCandidates.sort((a, b) => (b.at || 0) - (a.at || 0));
  const current = currentCandidates.find(item => item.nodeStatus && item.nodeStatus.kind === 'running') || currentCandidates[0] || null;

  const latestAssistantNode = validNodes.filter(node => node.latestAssistantText).sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0))[0];
  const latestUserNode = rootNode && rootNode.latestUserText ? rootNode : validNodes.filter(node => node.latestUserText).sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0))[0];

  const activeNodes = runningNodes
    .slice()
    .sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
  const runningIds = new Set(runningNodes.map(node => node.threadId));
  const completedNodes = validNodes.filter(node => !runningIds.has(node.threadId));
  const completedSummary = {
    count: completedNodes.length,
    childCount: completedNodes.filter(node => node.threadId !== rootThreadId).length,
    errorCount: completedNodes.filter(node => node.status && node.status.kind === 'error').length,
    latestAt: completedNodes.reduce((max, node) => Math.max(max, node.status && (node.status.completedAt || node.status.mtimeMs) || node.mtimeMs || 0), 0)
  };

  return {
    root: rootNode || rootSession,
    nodes: validNodes,
    activeNodes,
    completedSummary,
    overallStatus,
    current,
    timeline: allTimeline.slice(0, clampInt(options.timelineLimit, 40, 10, 200)),
    latestAssistantText: latestAssistantNode ? latestAssistantNode.latestAssistantText : '',
    latestUserText: latestUserNode ? latestUserNode.latestUserText : '',
    latestMtime,
    latestIndexedActivityMs,
    truncated: validNodes.some(node => node.truncated)
  };
}

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function statusBarTone(statusOrKind) {
  const kind = typeof statusOrKind === 'string'
    ? statusOrKind
    : statusOrKind && statusOrKind.kind || 'unknown';
  if (kind === 'running') return 'running';
  if (kind === 'completed' || kind === 'error' || kind === 'aborted') return 'stopped';
  return 'default';
}

function shortId(id) {
  const value = String(id || '');
  if (value.length <= 10) return value;
  return `${value.slice(0, 6)}\u2026${value.slice(-4)}`;
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

function formatRelativeTime(timestampMs, now = Date.now()) {
  if (!timestampMs) return 'unknown time';
  const delta = Math.max(0, now - timestampMs);
  if (delta < 5000) return 'just now';
  return `${formatDuration(delta)} ago`;
}

module.exports = {
  getCodexHome,
  parseRolloutFileName,
  listRolloutFiles,
  readSessionMeta,
  readSessionSummary,
  readLatestTaskEvent,
  readRecentActivity,
  scanSessions,
  scanActiveSessions,
  readThreadNames,
  readStateThreadActivity,
  attachStatuses,
  findLatestRolloutForThread,
  scanSessionTree,
  buildSessionSnapshot,
  cleanTitle,
  parseSessionSource,
  taskEventFromLine,
  activityFromItem,
  statusBarTone,
  shortId,
  formatDuration,
  formatRelativeTime,
  looksLikeOpaqueId,
  humanizeRole,
  taskNameFromPrompt,
  agentDisplayName
};
