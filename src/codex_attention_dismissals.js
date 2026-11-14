'use strict';

// Presentation only: never changes native waits, sound reminders or recovery.
function attentionKey(threadId, entry) {
  const epoch=entry.planTurnId||entry.inputIds?.length?'':entry.notificationEpoch||'';
  return JSON.stringify([threadId, entry.planTurnId || '', entry.inputIds || [], epoch, entry.flags || []]);
}
function createAttentionDismissals(options = {}) {
  let hidden = new Set((options.initial || []).filter(value => typeof value === 'string'));
  let writes = Promise.resolve();
  const save = () => { const snapshot = [...hidden].slice(-512); writes = writes.catch(() => {}).then(() => options.save?.(snapshot)); return writes; };
  return {
    async dismiss(threadId, entry, expectedKey) {
      const key = attentionKey(threadId, entry);
      if (key !== expectedKey) return false;
      hidden.add(key); await save(); return true;
    },
    observe(entries) {
      const present = new Set(Object.entries(entries).map(([id, entry]) => attentionKey(id, entry)));
      let changed = false;
      for (const key of hidden) if (!present.has(key)) { hidden.delete(key); changed = true; }
      if (changed) save().catch(options.onError || (() => {}));
    },
    snapshot(entries) { return Object.fromEntries(Object.entries(entries).map(([id, entry]) => [id, { key: attentionKey(id, entry), hidden: hidden.has(attentionKey(id, entry)) }])); }
  };
}
module.exports = { attentionKey, createAttentionDismissals };
