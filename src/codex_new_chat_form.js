'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { PRESETS, normalizeContextPreset, contextChoice, contextConfig, formatContextK, contextChoices } = require('./codex_new_chat');
const { normalizeSpeed, speedChoices, requireSpeed } = require('./codex_speed');
const { normalizeImageAttachments } = require('./codex_steer');

// The webview supplies user input only. Resolve the model and config on the host.
function createNewChatForm(options) {
  const submissions = new Map(), results = new Map();
  let busy = false, saving = Promise.resolve(), modelSelection = 0;
  const reply = (type, requestId, data) => options.post({ type, requestId, ...data });
  const folders = () => options.folders().map(folder => ({ name: folder.name, cwd: folder.cwd }));
  const validateDirectory = async value => {
    if (typeof value !== 'string' || !path.isAbsolute(value) || !(await fs.stat(value)).isDirectory()) {
      throw new Error('Chọn một thư mục làm việc hợp lệ.');
    }
    return value;
  };
  const remember = preset => {
    normalizeContextPreset(preset);
    const next = saving.catch(() => {}).then(() => options.savePreset(preset));
    saving = next;
    return next;
  };
  async function load(message, browse = false) {
    const selection = message.model ? ++modelSelection : 0;
    try {
      let cwd = message.cwd || folders()[0]?.cwd || '';
      if (browse) {
        const picked = await options.browse(cwd);
        if (!picked) { reply('newChatOptions', message.requestId, { cancelled: true }); return; }
        cwd = picked;
      }
      if (cwd) await validateDirectory(cwd);
      const { metadata, models } = await options.metadata(cwd || undefined, message.model || undefined);
      if (selection && selection === modelSelection) await options.saveModel(metadata.model);
      const choices = contextChoices(metadata);
      reply('newChatOptions', message.requestId, { cwd, folders: folders(), model: metadata.model, models,
        preset: options.defaultPreset(), serviceTier: options.defaultSpeed?.() || 'default', speeds: speedChoices(models?.find(item => item.id === metadata.model)), choices, autoContext: options.autoContext?.() });
    } catch (error) {
      reply('newChatOptions', message.requestId, { error: error.message, folders: folders(), autoContext: options.autoContext?.() });
    }
  }
  async function save(message) {
    try {
      await remember(message.preset);
      reply('newChatPresetSaved', message.requestId, { preset: message.preset });
    } catch (error) { reply('newChatPresetSaved', message.requestId, { error: error.message }); }
  }
  async function submit(message) {
    const id = message.requestId;
    if (typeof id !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(id)) return;
    if (submissions.has(id)) { reply('newChatResult', id, await submissions.get(id)); return; }
    if (busy) { reply('newChatResult', id, { error: 'Đang tạo chat. Vui lòng chờ hoàn tất.', delivery: 'not_sent' }); return; }
    busy = true;
    options.busy(true);
    const operation = (async () => {
      let created, dispatching = false;
      try {
        const cwd = await validateDirectory(message.cwd);
        const preset = normalizeContextPreset(message.preset);
        const serviceTier = normalizeSpeed(message.serviceTier ?? options.defaultSpeed?.() ?? 'default');
        const images = normalizeImageAttachments(message.images);
        if (typeof message.message !== 'string' || !message.message.trim() && !images.length) throw new Error('Nhập yêu cầu hoặc đính kèm ảnh cho tác vụ mới.');
        ++modelSelection;
        const { backend, metadata, models } = await options.metadata(cwd, message.model || undefined);
        requireSpeed(serviceTier, models?.find(item => item.id === metadata.model));
        const config = contextConfig(preset, metadata);
        await remember(preset);
        await options.saveModel(metadata.model);
        await options.saveSpeed?.(serviceTier);
        dispatching = true;
        created = await backend.createFreshChat({ cwd, model: metadata.model, contextConfig: config, message: message.message.trim(), ...(images.length?{images}:{}), serviceTier });
        await options.created(created, preset, cwd, serviceTier);
        return { threadId: created.id, success: true };
      } catch (error) {
        created ||= error.createdThread;
        return { error: error.message, threadId: created?.id,
          delivery: created ? 'created' : dispatching ? error.delivery || 'unknown' : 'not_sent' };
      } finally { busy = false; options.busy(false); }
    })();
    submissions.set(id, operation);
    const result = await operation;
    results.set(id, result);
    // Retain recent acknowledgements so repeated messages never create twice.
    if (results.size > 64) {
      const oldest = results.keys().next().value;
      results.delete(oldest); submissions.delete(oldest);
    }
    reply('newChatResult', id, result);
  }
  async function openResult(message) {
    const result = results.get(message.requestId);
    if (!result?.threadId) return;
    try { await options.open(result.threadId); }
    catch (error) { reply('newChatResult', message.requestId, { ...result, success: false, error: error.message, delivery: 'created' }); }
  }
  async function saveSpeed(message) {
    try { const serviceTier = normalizeSpeed(message.serviceTier); await options.saveSpeed?.(serviceTier); reply('newChatSpeedSaved', message.requestId, { serviceTier }); }
    catch (error) { reply('newChatSpeedSaved', message.requestId, { error: error.message }); }
  }
  return { load, save, saveSpeed, submit, openResult };
}

module.exports = { createNewChatForm };
