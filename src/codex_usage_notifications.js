'use strict';
const { createStateStore } = require('./codex_state_store');
const { evaluateUsageVoice, normalizeUsageVoiceState } = require('./codex_usage_voice');
const { evaluateUsageAlerts } = require('./codex_usage_alerts');

function createUsageNotifications(file, initial = {}, now = Date.now) {
  const store = createStateStore(file, { voice: normalizeUsageVoiceState(initial.voice), alerts: initial.alerts || {} });
  return {
    async process(snapshot, settings) {
      if (snapshot.error || !snapshot.checkedAt) return null;
      return store.transaction(state => {
        const voice = evaluateUsageVoice(snapshot, state.voice, settings.voice, snapshot.checkedAt);
        const alerts = evaluateUsageAlerts(snapshot.groups, settings.alerts, state.alerts, () => snapshot.checkedAt);
        state.voice = voice.state; state.alerts = alerts.state;
        return { voice, alerts };
      });
    },
    async isCurrent(event) {
      if (now() - event.checkedAt > 120000 || event.checkedAt > now()) return false;
      const state = await store.read(), sample = state.voice?.samples?.[event.key];
      return state.voice?.activeKey === event.key && sample?.remainingPercent === event.remainingPercent && sample.changedAt === event.changedAt;
    }
  };
}
module.exports = { createUsageNotifications };
