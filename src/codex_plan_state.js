'use strict';

const ID = /^[A-Za-z0-9_-]{1,200}$/;
const PLAN_READY_TEXT = 'Đã lập xong kế hoạch. Có triển khai luôn không?';

// The implementation question is frontend state, not an app-server activeFlag.
// Keep only IDs; never copy plan text or answer/submit the native question.
function createPlanState() {
  const pending = new Map(), latestTurns = new Map(), dismissed = new Set(), listeners = new Set();
  const changed = () => { for (const listener of listeners) listener(); };
  const rememberDismissed = key => { dismissed.add(key); while (dismissed.size > 512) dismissed.delete(dismissed.values().next().value); };
  return {
    ready(threadId, turnId) {
      if (!ID.test(threadId || '') || !ID.test(turnId || '')) return false;
      if (latestTurns.has(threadId) && latestTurns.get(threadId) !== turnId) return false;
      if (dismissed.has(threadId + ':' + turnId) || pending.get(threadId)?.turnId === turnId) return false;
      pending.set(threadId, { threadId, turnId });
      while (pending.size > 512) pending.delete(pending.keys().next().value);
      changed(); return true;
    },
    started(threadId, turnId) {
      if (!ID.test(threadId || '') || !ID.test(turnId || '')) return;
      latestTurns.set(threadId, turnId);
      while (latestTurns.size > 1024) latestTurns.delete(latestTurns.keys().next().value);
      const previous = pending.get(threadId);
      if (previous && previous.turnId !== turnId) {
        rememberDismissed(threadId + ':' + previous.turnId); pending.delete(threadId); changed();
      }
    },
    resolved(threadId, turnId) {
      if (!ID.test(threadId || '') || !ID.test(turnId || '')) return;
      rememberDismissed(threadId + ':' + turnId);
      if (pending.get(threadId)?.turnId === turnId) { pending.delete(threadId); changed(); }
    },
    snapshot: () => [...pending.values()].map(value => ({ ...value })),
    subscribe(listener) { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
    clear() { pending.clear(); latestTurns.clear(); dismissed.clear(); changed(); }
  };
}

function mergePlanAttention(threads, plans) {
  const result = new Map(threads.map(thread => [thread.id, { ...thread }]));
  for (const plan of plans) {
    const thread = result.get(plan.threadId) || { id: plan.threadId, name: 'Codex chat', status: { type: 'idle' } };
    // Native subagent threads cannot own an implementation decision in this UI.
    if (thread.source?.subAgent || thread.source?.sub_agent || thread.parentThreadId) continue;
    result.set(plan.threadId, { ...thread, planTurnId: plan.turnId });
  }
  return [...result.values()];
}

const planState = createPlanState();
module.exports = { createPlanState, mergePlanAttention, planState, PLAN_READY_TEXT };
