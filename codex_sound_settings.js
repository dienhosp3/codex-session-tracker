'use strict';

const SOUND_TYPES = Object.freeze([
  { id: 'chat_completed', label: 'Hoàn tất', group: 'Chat' },
  { id: 'chat_failed', label: 'Dừng do lỗi', group: 'Chat' },
  { id: 'approval_initial', label: 'Chờ duyệt', group: 'Chat' },
  { id: 'input_initial', label: 'Chờ trả lời', group: 'Chat' },
  { id: 'approval_reminder', label: 'Nhắc chờ duyệt', group: 'Nhắc chờ' },
  { id: 'input_reminder', label: 'Nhắc chờ trả lời', group: 'Nhắc chờ' },
  { id: 'retry_429', label: 'Lỗi 429', group: 'Lỗi riêng' },
  { id: 'model_capacity', label: 'Model quá tải', group: 'Lỗi riêng' },
  { id: 'quota_change', label: 'Quota thay đổi', group: 'Quota' },
  { id: 'quota_large_change', label: 'Quota đổi mạnh', group: 'Quota' }
]);
const IDS = new Set(SOUND_TYPES.map(item => item.id));

function normalizeSoundSettings(value, legacy = {}) {
  const types = Object.fromEntries(SOUND_TYPES.map(item => [item.id, true]));
  types.quota_change = legacy.enabled === true && legacy.speakOnChange !== false;
  types.quota_large_change = legacy.enabled === true && legacy.speakOnLargeChange !== false;
  for (const id of IDS) if (typeof value?.types?.[id] === 'boolean') types[id] = value.types[id];
  return { schemaVersion: 1, enabled: value?.enabled !== false, types };
}

function createSoundSettings(options) {
  let settings = normalizeSoundSettings(options.value, options.legacy), saving = Promise.resolve(), playing = Promise.resolve();
  const snapshot = () => structuredClone(settings);
  const enabled = id => IDS.has(id) && settings.enabled && settings.types[id];
  return {
    snapshot, enabled,
    update(patch) {
      const operation = saving.catch(() => {}).then(async () => {
        const next = snapshot();
        if (Object.hasOwn(patch, 'enabled')) {
          if (typeof patch.enabled !== 'boolean') throw new Error('Công tắc âm thanh không hợp lệ.');
          next.enabled = patch.enabled;
        }
        for (const [id, value] of Object.entries(patch.types || {})) {
          if (!IDS.has(id) || typeof value !== 'boolean') throw new Error('Loại âm thanh không hợp lệ.');
          next.types[id] = value;
        }
        await options.save(next);
        settings = next; options.onChange?.(snapshot()); return snapshot();
      });
      saving = operation; return operation;
    },
    play(id, action, preview = false) {
      if (!IDS.has(id)) return Promise.reject(new Error('Loại âm thanh không hợp lệ.'));
      if (!preview && !enabled(id)) return Promise.resolve(false);
      const operation = playing.catch(() => {}).then(async () => {
        if (!preview && !enabled(id)) return false;
        await action(); return true;
      });
      playing = operation; return operation;
    }
  };
}

function filterAttentionSound(event, settings) {
  if (!settings.enabled) return null;
  const allowed = flag => ['waitingOnApproval', 'waitingOnUserInput', 'waitingOnPlanImplementation'].includes(flag) && settings.types[(flag === 'waitingOnApproval' ? 'approval' : 'input') + (event.isReminder ? '_reminder' : '_initial')];
  if (event.isReminder) {
    const waits = event.waits.filter(wait => allowed(wait.flag));
    return waits.length ? { ...event, waits } : null;
  }
  const newFlags = (event.newFlags || event.flags || []).filter(allowed);
  return newFlags.length ? { ...event, newFlags } : null;
}

function terminalSoundType(status, error, settings) {
  if (!['completed', 'failed'].includes(status)) return null;
  if (!settings.enabled) return null;
  if (status === 'completed' && !error) return settings.types.chat_completed ? 'chat_completed' : null;
  if (status !== 'failed' && !error) return null;
  const info = error?.codexErrorInfo || error?.codex_error_info;
  const message = typeof error === 'string' ? error : String(error?.message || '');
  const attempts = info?.responseTooManyFailedAttempts || info?.response_too_many_failed_attempts;
  const capacity = ['serverOverloaded', 'server_overloaded'].includes(info) || /Selected model is at capacity/i.test(message);
  const retry = attempts?.httpStatusCode === 429 || attempts?.http_status_code === 429 || /exceeded retry limit.*429/i.test(message);
  if (capacity && settings.types.model_capacity) return 'model_capacity';
  if (retry && settings.types.retry_429) return 'retry_429';
  return settings.types.chat_failed ? 'chat_failed' : null;
}

module.exports = { SOUND_TYPES, normalizeSoundSettings, createSoundSettings, filterAttentionSound, terminalSoundType };
