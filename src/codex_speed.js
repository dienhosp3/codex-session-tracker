'use strict';

const SPEEDS = Object.freeze([
  { value: 'default', label: 'Standard' },
  { value: 'priority', label: 'Fast' },
  { value: 'ultrafast', label: 'Ultrafast' }
]);
function observedSpeed(value) {
  if (value === null || value === 'standard') return 'default';
  if (value === 'fast') return 'priority';
  return SPEEDS.some(speed => speed.value === value) ? value : undefined;
}
function normalizeSpeed(value = 'default') {
  const speed = observedSpeed(value);
  if (!speed) throw new Error('Chọn tốc độ Standard, Fast hoặc Ultrafast.');
  return speed;
}
function speedFromSettings(settings) {
  if (Object.hasOwn(settings || {}, 'service_tier')) return observedSpeed(settings.service_tier);
  if (Object.hasOwn(settings || {}, 'serviceTier')) return observedSpeed(settings.serviceTier);
  return undefined;
}
function speedChoices(model) {
  const supported = new Set(['default']);
  for (const tier of model?.serviceTiers || []) {
    const id = observedSpeed(typeof tier === 'string' ? tier : tier.id);
    if (id) supported.add(id);
  }
  for (const tier of model?.additionalSpeedTiers || []) {
    const id = observedSpeed(tier); if (id) supported.add(id);
  }
  return SPEEDS.map(speed => ({ ...speed, available: supported.has(speed.value) }));
}
function requireSpeed(value, model) {
  const speed = normalizeSpeed(value);
  if (!speedChoices(model).some(choice => choice.value === speed && choice.available)) {
    throw new Error((SPEEDS.find(choice => choice.value === speed)?.label || speed) + ' chưa khả dụng với model này trong Codex.');
  }
  return speed;
}
function automaticSpeed(value, model) {
  const requestedServiceTier = normalizeSpeed(value);
  const choices = speedChoices(model), index = choices.findIndex(choice => choice.value === requestedServiceTier);
  const chosen = choices.slice(0, index + 1).reverse().find(choice => choice.available);
  return { serviceTier: chosen.value, ...(chosen.value !== requestedServiceTier ? {
    requestedServiceTier,
    speedNotice: `${choices[index].label} chưa khả dụng; chat kế tiếp dùng ${chosen.label}.`
  } : {}) };
}
module.exports = { SPEEDS, normalizeSpeed, observedSpeed, speedFromSettings, speedChoices, requireSpeed, automaticSpeed };
