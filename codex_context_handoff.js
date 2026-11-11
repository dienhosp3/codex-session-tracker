'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomInt, randomUUID } = require('node:crypto');
const { validateContextConfig } = require('./codex_new_chat');
const { normalizeHandoffMode, validateGoalText } = require('./codex_handoff_modes');
const { normalizeSpeed } = require('./codex_speed');

const THREAD_ID = /^[A-Za-z0-9_-]{1,200}$/;
const CHAT_ID_NOTE = 'Mã ID và nhãn chỉ để nhận diện chat, không đưa vào repo.';
function parseSeries(title) {
  const match = /^\[([\p{L}\p{N}]{1,30})-(\d{4,})\](?:\s|$)/u.exec(String(title || '').normalize('NFC'));
  if (!match) return null;
  return { code: match[1], number: BigInt(match[2]), width: match[2].length };
}

function normalizeSeries(value) {
  if (value == null) return null;
  const code = String(value.code ?? '').trim().normalize('NFC');
  const nextNumber = String(value.nextNumber ?? '').trim();
  if (!/^[\p{L}\p{N}]{1,30}$/u.test(code)) throw new Error('ID phải có 1–30 chữ hoặc số.');
  if (!/^\d+$/.test(nextNumber) || BigInt(nextNumber) < 1n) throw new Error('Số bắt đầu phải là số nguyên dương.');
  return { code, nextNumber: nextNumber.padStart(4, '0') };
}

function continuationPlan(threadId, title, reservedCodes = [], choose = randomInt, customSeries = null) {
  if (!THREAD_ID.test(threadId)) throw new Error('ID chat không hợp lệ.');
  const custom = normalizeSeries(customSeries);
  if (custom) {
    const nextTitle = `[${custom.code}-${custom.nextNumber}] Tiếp tục`;
    const deeplink = `codex://threads/${threadId}`;
    return { code: custom.code, sourceTitle: title, renameSource: false, nextTitle, deeplink,
      message: `${nextTitle} ${deeplink}\n\n${CHAT_ID_NOTE}`,
      successorSeries: { code: custom.code, nextNumber: String(BigInt(custom.nextNumber) + 1n).padStart(custom.nextNumber.length, '0') } };
  }
  let series = parseSeries(title);
  const renameSource = !series;
  if (!series) {
    const reserved = new Set(reservedCodes);
    let code;
    for (let attempt = 0; attempt < 1000; attempt++) {
      code = Array.from({ length: 4 }, () => String.fromCharCode(65 + choose(26))).join('');
      if (!reserved.has(code)) break;
      code = '';
    }
    if (!code) throw new Error('Không tạo được mã hội thoại riêng.');
    series = { code, number: 1n, width: 4 };
  }
  const prefix = number => `[${series.code}-${String(number).padStart(series.width, '0')}]`;
  const deeplink = `codex://threads/${threadId}`;
  const nextTitle = `${prefix(series.number + 1n)} Tiếp tục`;
  return {
    code: series.code, sourceTitle: renameSource ? `${prefix(series.number)} ${String(title || 'Hội thoại').trim()}` : title,
    renameSource, nextTitle, deeplink, message: `${nextTitle} ${deeplink}\n\n${CHAT_ID_NOTE}`
  };
}

// Exclusive, durable journal: two VS Code windows and a restarted host must
// never create/send the same successor twice. A partial journal is visible for
// manual recovery; an uncertain request is deliberately never replayed.
async function existingHandoff(file) {
  let previous;
  try { previous = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Chat đã có yêu cầu chuyển tiếp chưa xác nhận; không gửi lặp.');
  }
  if (previous.phase === 'completed') return previous;
  throw Object.assign(new Error('Chuyển tiếp trước chưa hoàn tất (' + previous.phase + '). ' + (previous.error || 'Kiểm tra chat trước khi gửi lại.')),
    { handoff: previous });
}
async function runContextHandoff(options) {
  const { backend, directory } = options;
  let entry = options.entry;
  if (!THREAD_ID.test(entry.threadId)) throw new Error('ID chat không hợp lệ.');
  const file = path.join(directory, entry.threadId + '.json');
  // Completed transfers remain idempotent after their source Goal is cleared.
  const previous = await existingHandoff(file);
  if (previous) return previous;
  const customSeries = normalizeSeries(entry.series);
  let contextConfig = validateContextConfig(entry.contextConfig);
  let successorMode = normalizeHandoffMode(entry.successorMode);
  if (entry.trigger === 'auto_compact') {
    // Pause/interrupt first. stopForHandoff captures the live Goal before its
    // pause, and still interrupts when reading or pausing that Goal fails.
    successorMode = 'normal';
    entry = { ...entry, successorMode };
  }
  if (entry.serviceTier !== undefined) normalizeSpeed(entry.serviceTier);
  let goalText = successorMode === 'goal' && entry.manual ? validateGoalText(entry.goalText) : undefined;
  if (successorMode === 'goal' && !entry.manual) {
    const goal = await backend.readGoal(entry.threadId);
    if (goal?.status !== 'active') throw Object.assign(new Error('Goal đã dừng hoặc đã kết thúc; không tự khởi động lại.'), { handoffSkipped: true, handoffReason: 'goal-inactive' });
    goalText = validateGoalText(goal.objective);
  }
  if (entry.extraMessage !== undefined && typeof entry.extraMessage !== 'string') throw new Error('Nội dung thêm không hợp lệ.');
  await fs.mkdir(directory, { recursive: true });
  let handle;
  try { handle = await fs.open(file, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = await existingHandoff(file);
    if (previous) return previous;
    throw new Error('Nhật ký chuyển chat đã thay đổi; không gửi lặp.');
  }
  let state = { schemaVersion: 1, sourceThreadId: entry.threadId, sourceTurnId: entry.turnId,
    trigger: entry.manual ? 'manual' : entry.trigger || 'threshold', successorMode, ...(goalText ? { goalText } : {}),
    phase: 'claimed', at: Date.now(), clientUserMessageId: randomUUID() };
  const save = async patch => {
    state = { ...state, ...patch, updatedAt: Date.now() };
    const bytes = Buffer.from(JSON.stringify(state, null, 2) + '\n');
    await handle.write(bytes, 0, bytes.length, 0);
    await handle.truncate(bytes.length);
    await handle.sync();
    options.onProgress?.(structuredClone(state));
  };
  try {
    await save({ phase: 'stopping' });
    let source = await backend.stopForHandoff(entry);
    const sourceGoal = source.sourceGoal;
    if (entry.trigger === 'auto_compact') {
      successorMode = sourceGoal?.status === 'active' ? 'goal' : 'normal';
      entry = { ...entry, successorMode };
    }
    if (successorMode === 'goal' && !entry.manual) goalText = validateGoalText(source.sourceGoal?.objective);
    const expectedGoal = source.pausedGoal;
    // Title comes from the stopped target, never from the currently focused tab.
    const plan = continuationPlan(entry.threadId, source.name || entry.title, options.reservedCodes, randomInt, customSeries);
    if (entry.extraMessage?.trim()) plan.message += '\n\n' + entry.extraMessage.trim();
    await save({ phase: 'stopped', successorMode, ...plan, cwd: source.cwd || entry.cwd, ...(goalText ? { goalText } : {}),
      ...(sourceGoal ? { sourceGoal } : {}) });
    if (options.prepareSuccessor) {
      entry = { ...entry, ...await options.prepareSuccessor(source) };
      contextConfig = validateContextConfig(entry.contextConfig);
    }
    if (plan.renameSource) await backend.renameThread(entry.threadId, plan.sourceTitle);
    const delaySeconds = entry.handoffDelaySeconds ?? 10;
    if (!Number.isInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > 3600) throw new Error('Thời gian chờ mở chat mới không hợp lệ.');
    if (delaySeconds > 0) {
      await save({ phase: 'waiting', delaySeconds, opensAt: Date.now() + delaySeconds * 1000 });
      await (options.wait || (ms => new Promise(resolve => setTimeout(resolve, ms))))(delaySeconds * 1000);
    }
    if (backend.confirmHandoffStopped) source = await backend.confirmHandoffStopped({ ...entry, expectedGoal });
    let serviceTier = normalizeSpeed(entry.manual ? entry.serviceTier ?? source.serviceTier : source.serviceTier ?? entry.serviceTier);
    let speedChoice = { serviceTier };
    if (!entry.manual && backend.resolveSuccessorSpeed) {
      speedChoice = await backend.resolveSuccessorSpeed({ model: entry.successorModel || source.model || entry.model, serviceTier });
      serviceTier = normalizeSpeed(speedChoice.serviceTier);
    }
    await save({ phase: 'creating', ...speedChoice, serviceTier });
    const next = await backend.createSuccessor({ cwd: source.cwd || entry.cwd, model: entry.successorModel || source.model || entry.model,
      sourceThreadId: entry.threadId,
      serviceTier,
      permissionSettings: source.permissionSettings, ...(contextConfig ? { contextConfig } : {}) });
    if (!next?.id || next.id === entry.threadId || !THREAD_ID.test(next.id)) throw new Error('Không xác nhận được ID chat mới.');
    await save({ phase: 'created', nextThreadId: next.id, nextFile: next.path || '', cwd: next.cwd || source.cwd || entry.cwd,
      ...(entry.contextPreset ? { contextPreset: entry.contextPreset } : {}) });
    await backend.renameThread(next.id, plan.nextTitle);
    await save({ phase: 'sending' });
    const result = await backend.startSuccessor({ threadId: next.id, message: plan.message,
      clientUserMessageId: state.clientUserMessageId, effort: source.reasoningEffort || entry.reasoning,
      model: entry.successorModel || source.model || entry.model, successorMode, goalText,
      serviceTier,
      onProgress: phase => save({ phase }), permissionSettings: source.permissionSettings,
      ...(sourceGoal ? { beforeStart: async () => {
        await save({ phase: 'clearing_source_goal' });
        await backend.clearHandoffGoal({ ...entry, expectedGoal });
        await save({ phase: 'source_goal_cleared', sourceGoalCleared: true });
      } } : {}) });
    if (!result?.turnId) throw Object.assign(new Error('Chưa xác nhận tin tiếp tục đã được gửi.'), { delivery: 'unknown' });
    await save({ phase: 'completed', nextTurnId: result.turnId });
    return state;
  } catch (error) {
    const failedPhase = state.phase;
    await save({ phase: 'failed', failedPhase, delivery: error.delivery || 'unknown', error: error.message,
      ...(error.createdThread?.id ? { nextThreadId: error.createdThread.id } : {}) }).catch(() => {});
    error.handoff = state;
    throw error;
  } finally { await handle.close(); }
}

module.exports = { THREAD_ID, CHAT_ID_NOTE, parseSeries, normalizeSeries, continuationPlan, runContextHandoff };
