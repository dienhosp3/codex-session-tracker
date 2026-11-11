'use strict';

const FIELDS = new Set(['handoffDelaySeconds', 'intervalMs', 'completionSound', 'thresholdPercent']);
function chatOptions(value = {}, defaults = {}) {
  const delay = value?.handoffDelaySeconds, interval = value?.intervalMs;
  return {
    handoffDelaySeconds: Number.isInteger(delay) && delay >= 0 && delay <= 3600 ? delay : defaults.handoffDelaySeconds ?? 10,
    intervalMs: Number.isInteger(interval) && interval >= 100 && interval <= 60000 ? interval : defaults.intervalMs ?? 300,
    completionSound: value?.completionSound !== false
  };
}

function validateChatOptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !FIELDS.has(key))) {
    throw new Error('Tuỳ chọn chat không hợp lệ.');
  }
  if (!Number.isInteger(value.handoffDelaySeconds) || value.handoffDelaySeconds < 0 || value.handoffDelaySeconds > 3600) {
    throw new Error('Thời gian chờ phải từ 0 đến 3600 giây.');
  }
  if (!Number.isInteger(value.intervalMs) || value.intervalMs < 100 || value.intervalMs > 60000) {
    throw new Error('Chu kỳ kiểm tra phải từ 100 đến 60000 ms.');
  }
  if (typeof value.completionSound !== 'boolean') throw new Error('Công tắc âm báo hoàn tất không hợp lệ.');
  if (value.thresholdPercent !== undefined && (!Number.isInteger(value.thresholdPercent) || value.thresholdPercent < 1 || value.thresholdPercent > 99)) {
    throw new Error('Ngưỡng context phải từ 1 đến 99%.');
  }
  return { ...chatOptions(value), ...(value.thresholdPercent !== undefined ? { thresholdPercent: value.thresholdPercent } : {}) };
}

function soundsForChat(settings, value) {
  return { ...settings, types: { ...settings.types, chat_completed: settings.types.chat_completed && chatOptions(value).completionSound } };
}

module.exports = { chatOptions, validateChatOptions, soundsForChat };
