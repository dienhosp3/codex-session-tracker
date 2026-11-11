'use strict';

const { THREAD_ID, normalizeSeries, parseSeries } = require('./codex_context_handoff');
const { validateSettings } = require('./codex_context_watch');
const { PRESETS, normalizeContextPreset, contextChoice, contextConfig, formatContextK } = require('./codex_new_chat');
const { normalizeHandoffMode, validateGoalText, goalDraft } = require('./codex_handoff_modes');
const { normalizeSpeed, speedChoices, requireSpeed } = require('./codex_speed');

function createHandoffForm(options) {
  const submissions = new Map(), busy = new Set();
  const reply = (type, message, value) => options.post({ type, threadId: message.threadId, requestId: message.requestId, ...value });
  async function describe(message) {
    if (!THREAD_ID.test(message.threadId || '')) throw new Error('Chọn chat gốc trong Tracker.');
    if (options.watch().blocks(message.threadId)) throw new Error('Chat đang hoặc đã chuyển tiếp. Kiểm tra chat kế tiếp.');
    return options.describe(message.threadId, message.model);
  }
  async function load(message) {
    try {
      const { session, metadata, models, modes, sourceGoal, serviceTier } = await describe(message);
      const state = options.watch().snapshot(), entry = state.entries[message.threadId] || {};
      const prefix = parseSeries(session.title);
      const series = entry.series || (prefix ? { code: prefix.code, nextNumber: String(prefix.number + 1n).padStart(prefix.width, '0') } : null);
      const choices = PRESETS.map(preset => {
        const choice = contextChoice(preset, metadata);
        return { preset, label: preset === 'default' ? 'Mặc định · ' + formatContextK(choice.requestedTokens) : preset.toUpperCase(),
          detail: choice.available ? 'Dùng ' + formatContextK(choice.effectiveTokens) : 'Chưa rõ', available: choice.available };
      });
      reply('handoffOptions', message, { title: session.title, cwd: session.cwd, model: metadata.model, models, choices,
        modes, successorMode: entry.continuationMode === 'goal' ? 'goal' : 'normal',
        speeds: speedChoices(models?.find(item => item.id === metadata.model)), serviceTier: serviceTier || entry.serviceTier || 'default',
        goalText: goalDraft(sourceGoal?.objective || entry.goalText),
        preset: entry.contextPreset || options.defaultPreset(), series, enabled: entry.enabled === true,
        thresholdPercent: entry.thresholdPercent ?? state.thresholdPercent,
        handoffDelaySeconds: options.watch().getChatOptions(message.threadId).handoffDelaySeconds });
    } catch (error) { reply('handoffOptions', message, { error: error.message }); }
  }
  async function submit(message) {
    if (typeof message.requestId !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(message.requestId)) return;
    const key = message.threadId + ':' + message.requestId;
    if (submissions.has(key)) { reply('handoffResult', message, await submissions.get(key)); return; }
    if (busy.has(message.threadId)) { reply('handoffResult', message, { error: 'Chat đang chuyển tiếp. Vui lòng chờ.', blocked: true }); return; }
    busy.add(message.threadId);
    const operation = (async () => {
      try {
        const input = message.settings || {};
        if (typeof input.enabled !== 'boolean') throw new Error('Thiết lập tự chuyển không hợp lệ.');
        if (typeof input.extraMessage !== 'string') throw new Error('Nội dung thêm không hợp lệ.');
        if (typeof message.model !== 'string' || !message.model) throw new Error('Chọn model cho chat kế tiếp.');
        const settings = validateSettings({ thresholdPercent: input.thresholdPercent, handoffDelaySeconds: input.handoffDelaySeconds });
        const preset = normalizeContextPreset(input.preset), series = normalizeSeries(input.series);
        const successorMode = normalizeHandoffMode(input.successorMode);
        const serviceTier = normalizeSpeed(input.serviceTier);
        const goalText = successorMode === 'goal' ? validateGoalText(input.goalText) : undefined;
        const { session, metadata, modes, models } = await describe(message);
        requireSpeed(serviceTier, models?.find(item => item.id === metadata.model));
        if (successorMode !== 'normal' && !modes?.[successorMode]?.available) throw new Error(modes?.[successorMode]?.reason || 'Chế độ này chưa khả dụng trong Codex.');
        contextConfig(preset, metadata); // Validate before persisting settings or interrupting.
        const result = await options.watch().transferNow(message.threadId, session, { enabled: input.enabled,
          thresholdPercent: settings.thresholdPercent, handoffDelaySeconds: settings.handoffDelaySeconds,
          contextPreset: preset, series, successorModel: metadata.model, extraMessage: input.extraMessage, successorMode, goalText, serviceTier });
        return { success: result?.phase === 'completed', nextThreadId: result?.nextThreadId };
      } catch (error) {
        const handoff = options.watch().snapshot().entries[message.threadId]?.handoff;
        return { error: error.message, blocked: options.watch().blocks(message.threadId), nextThreadId: handoff?.nextThreadId };
      } finally { busy.delete(message.threadId); options.changed?.(); }
    })();
    submissions.set(key, operation);
    const result = await operation;
    reply('handoffResult', message, result);
    if (submissions.size > 64) submissions.delete(submissions.keys().next().value);
  }
  return { load, submit };
}

module.exports = { createHandoffForm };
