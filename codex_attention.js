'use strict';

const { speakAttentionInitial, speakAttentionReminder } = require('./codex_attention_voice');
const REMINDER_INTERVAL_MS = 5 * 60 * 1000;

function attentionFromStatus(status) {
  if (status?.type !== 'active') return [];
  const flags = new Set(status.activeFlags || []);
  return ['waitingOnApproval', 'waitingOnUserInput'].filter(flag => flags.has(flag));
}

// Live status is authoritative, including approvals not written to JSONL.
// Speak on a new wait, then remind every five minutes until it is resolved.
function createAttentionMonitor(options) {
  let entries = {}, disposed = false, timer, polling = null, pollAgain = false;
  const notified = new Map();
  const waitStarts = new Map();
  const now = options.now || Date.now;
  async function scan() {
    if (disposed) return;
    try {
      const threads = await options.read();
      if (disposed) return;
      const next = {};
      for (const thread of threads) {
        const flags = attentionFromStatus(thread.status);
        if (thread.planTurnId) {
          const generic = flags.indexOf('waitingOnUserInput');
          if (generic >= 0) flags.splice(generic, 1);
          flags.push('waitingOnPlanImplementation');
        }
        if (flags.length) next[thread.id] = { flags, title: thread.name || 'Codex chat', ...(thread.planTurnId ? { planTurnId: thread.planTurnId } : {}) };
      }
      for (const id of waitStarts.keys()) if (!next[id]) { waitStarts.delete(id); notified.delete(id); }
      for (const [id, entry] of Object.entries(next)) {
        const previous = waitStarts.get(id) || {};
        waitStarts.set(id, Object.fromEntries(entry.flags.map(flag => [flag,
          flag === 'waitingOnPlanImplementation' && entries[id]?.planTurnId !== entry.planTurnId ? now() : previous[flag] ?? now()])));
      }
      if (JSON.stringify(entries) !== JSON.stringify(next)) {
        entries = next;
        options.onChange?.(structuredClone(entries));
      }
      for (const [id, entry] of Object.entries(next)) {
        const key = entry.flags.join(',');
        const previousNotice = notified.get(id);
        const previous = new Set((previousNotice?.key || '').split(','));
        const newFlags = entry.flags.filter(flag => !previous.has(flag) ||
          (flag === 'waitingOnPlanImplementation' && previousNotice?.planTurnId !== entry.planTurnId));
        const newWait = newFlags.length > 0;
        const reminderDue = previousNotice && now() - previousNotice.at >= REMINDER_INTERVAL_MS;
        if (newWait || reminderDue) {
          const notificationAt = now();
          const waits = entry.flags.map(flag => ({ flag, startedAt: waitStarts.get(id)[flag],
            elapsedMinutes: Math.max(0, Math.floor((notificationAt - waitStarts.get(id)[flag]) / 60000)) }));
          const event = { threadId: id, ...entry, newFlags,
            isReminder: !newWait && Boolean(reminderDue), waits };
          await (options.notify || (event.isReminder ? speakAttentionReminder : speakAttentionInitial))(event);
          notified.set(id, { key, at: notificationAt, planTurnId: entry.planTurnId });
        } else if (previousNotice && previousNotice.key !== key) {
          notified.set(id, { ...previousNotice, key });
        }
      }
    } catch (error) { options.onError?.(error); }
  }
  function poll() {
    if (disposed) return Promise.resolve();
    if (polling) { pollAgain = true; return polling; }
    polling = (async () => {
      do { pollAgain = false; await scan(); } while (pollAgain && !disposed);
    })().finally(() => { polling = null; });
    return polling;
  }
  return {
    poll,
    snapshot: () => structuredClone(entries),
    start() { if (!timer && !disposed) { poll(); timer = setInterval(poll, 1000); timer.unref?.(); } },
    dispose() { disposed = true; clearInterval(timer); }
  };
}

module.exports = { attentionFromStatus, createAttentionMonitor, REMINDER_INTERVAL_MS };
