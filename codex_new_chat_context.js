'use strict';

const SCOPES = Object.freeze(['all', 'tracker', 'successor']);
function normalizeNewChatContext(value = {}, threshold = 80) {
  const scope = value.scope ?? 'all', thresholdPercent = Number(value.thresholdPercent ?? threshold);
  if (!SCOPES.includes(scope)) throw new Error('Phạm vi không hợp lệ.');
  if (!Number.isInteger(thresholdPercent) || thresholdPercent < 1 || thresholdPercent > 99) throw new Error('Ngưỡng từ 1 đến 99%.');
  return { enabled: value.enabled === true, scope, thresholdPercent };
}
function createNewChatContextRule(options) {
  let settings;
  try { settings = normalizeNewChatContext(options.value, options.defaultThreshold); }
  catch { settings = normalizeNewChatContext({}, options.defaultThreshold); }
  let saving = Promise.resolve();
  const pending = new Map();
  const snapshot = () => ({ ...settings });
  return {
    snapshot,
    update(value) {
      const operation = saving.catch(() => {}).then(async () => {
        const next = normalizeNewChatContext({ ...settings, ...value });
        await options.save(next); settings = next; options.onChange?.(); return snapshot();
      });
      saving = operation; return operation;
    },
    apply(entry, origin, inherited = false) {
      if (pending.has(entry.threadId)) return pending.get(entry.threadId);
      const operation = saving.catch(() => {}).then(async () => {
        const rule = snapshot(), watch = options.watch();
        if (!watch || !rule.enabled || (rule.scope !== 'all' && rule.scope !== origin)) return false;
        const existing = watch.snapshot().entries[entry.threadId];
        if (existing && (!inherited || existing.autoContextRuleApplied)) return false;
        await watch.setEntry(entry.threadId, { ...existing, ...entry, enabled: true,
          thresholdPercent: rule.thresholdPercent, autoContextRuleApplied: true });
        return true;
      }).finally(() => pending.delete(entry.threadId));
      pending.set(entry.threadId, operation); return operation;
    }
  };
}

module.exports = { SCOPES, normalizeNewChatContext, createNewChatContextRule };
