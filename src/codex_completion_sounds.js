'use strict';

const { terminalSoundType } = require('./codex_sound_settings');

// Only terminal lifecycle events are eligible, never individual tool errors,
// token notifications or a disappearing connection without an active turn.
function createCompletionSounds(options) {
  const seen = new Set(Array.isArray(options.state?.seen) ? options.state.seen.slice(-512) : []);
  const capacityLast = new Map(Object.entries(options.state?.capacityLast || {}).filter(([, at]) => Number.isFinite(at)));
  const now = options.now || Date.now, cooldown = 5 * 60 * 1000;
  const savedState = () => ({ schemaVersion: 1, seen: [...seen], capacityLast: Object.fromEntries([...capacityLast].filter(([, at]) => now() - at < cooldown).slice(-512)) });
  const pending = new Set();
  let queue = Promise.resolve(), disposed = false;
  function handle(event) {
    const threadId = event.threadId || event.params?.threadId;
    let turn = event.turn || event.params?.turn;
    if (turn?.status === 'interrupted' && turn.error) {
      const detail = JSON.stringify(turn.error);
      if (!/interrupted by user|cancelled by user|canceled by user|user[_ -]?(?:cancel|interrupt)|user requested/i.test(detail)) turn = { ...turn, status: 'failed' };
    }
    if (!threadId || !turn?.id || !['completed', 'failed'].includes(turn.status)) return Promise.resolve();
    if (turn.items?.some(item => item.type === 'contextCompaction') && !turn.items.some(item => item.type === 'userMessage' || item.type === 'agentMessage')) return Promise.resolve();
    const key = threadId + ':' + turn.id;
    if (disposed || seen.has(key) || pending.has(key)) return Promise.resolve();
    pending.add(key);
    const operation = queue.catch(() => {}).then(async () => {
      try {
        if (disposed) return;
        const description = await options.describe({ ...event, threadId });
        if (description?.isRoot !== true) return;
        // This is a completed planning phase, still awaiting the user's choice.
        // Use the input notification, not a second "whole task finished" sound.
        if (event.planReady === true && turn.status === 'completed' && !turn.error) {
          options.onPlanReady?.({ threadId, turnId: turn.id });
          return;
        }
        // Auto-continued goals and a newly started turn are not an idle chat.
        if (turn.status === 'completed' && description.active) return;
        let type = terminalSoundType(turn.status, turn.error, options.settings(threadId));
        const previousCapacity = capacityLast.get(threadId);
        if (type === 'model_capacity' && previousCapacity !== undefined && now() - previousCapacity < cooldown) type = null;
        seen.add(key);
        if (type === 'model_capacity') capacityLast.set(threadId, now());
        const rollback = () => {
          seen.delete(key);
          if (type === 'model_capacity') {
            if (previousCapacity === undefined) capacityLast.delete(threadId); else capacityLast.set(threadId, previousCapacity);
          }
        };
        while (seen.size > 512) seen.delete(seen.values().next().value);
        try { await options.save(savedState()); }
        catch (error) { rollback(); throw error; }
        if (type) {
          try { await options.notify(type, { threadId, turnId: turn.id }); }
          catch (error) {
            rollback();
            await options.save(savedState());
            throw error;
          }
        }
      } finally { pending.delete(key); }
    });
    queue = operation.catch(error => { options.onError?.(error); });
    return operation;
  }
  return { handle, idle: () => queue, dispose() { disposed = true; } };
}

module.exports = { createCompletionSounds };
