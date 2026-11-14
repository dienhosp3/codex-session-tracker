'use strict';

// Shared subscription quota decoder. Local conversation message budgets are unrelated.
function normalizeAccountKey(value) {
  const key = String(value || '').trim().toLowerCase();
  return !key || key.length > 200 ? 'account:unknown' : key.replace(/[^a-z0-9._:@-]/g, '_');
}
function accountKeyFromResult(result) {
  if(result?.accountKey)return normalizeAccountKey(result.accountKey);
  const account = result?.account || {};
  const explicit = result?.accountKey || result?.accountId || account.accountId || account.account_id || account.email || account.id || account.uuid;
  return normalizeAccountKey(explicit ? (String(explicit).includes(':') ? explicit : `${account.type || 'account'}:${explicit}`) : account.type || result?.accountType);
}
function normalizeUsage(result) {
  if (!result || typeof result !== 'object') throw new Error('Codex chưa trả dữ liệu Usage.');
  const buckets = Object.entries(result.rateLimitsByLimitId || {});
  if (result.rateLimits && !buckets.some(([id]) => id === (result.rateLimits.limitId || 'codex'))) buckets.unshift([result.rateLimits.limitId || 'codex', result.rateLimits]);
  const groups = [];
  for (const [id, bucket] of buckets) {
    if (!bucket || typeof bucket !== 'object') continue;
    const windows = [];
    for (const key of ['primary', 'secondary']) {
      const value = bucket[key];
      if (!Number.isFinite(value?.usedPercent)) continue;
      windows.push({ key, usedPercent: Math.max(0, Math.min(100, value.usedPercent)),
        durationMinutes: Number.isFinite(value.windowDurationMins) && value.windowDurationMins > 0 ? value.windowDurationMins : null,
        resetsAt: Number.isFinite(value.resetsAt) && value.resetsAt > 0 ? value.resetsAt * 1000 : null });
    }
    if (windows.length) groups.push({ id, name: typeof bucket.limitName === 'string' ? bucket.limitName : '', windows, accountKey: accountKeyFromResult(result) });
  }
  if (!groups.length) throw Object.assign(new Error('Tài khoản này chưa có dữ liệu cửa sổ hạn mức Codex.'), { code:'QUOTA_WINDOWS_UNAVAILABLE' });
  return groups.sort((a,b) => Number(b.id === 'codex') - Number(a.id === 'codex'));
}
function quotaSnapshot(raw, account, now = Date.now()) {
  let groups = [];
  try { groups = normalizeUsage({ ...raw, accountKey: account.id }); }
  catch (error) { if (error.code !== 'QUOTA_WINDOWS_UNAVAILABLE') throw error; }
  return { accountRef:account.id, groups, checkedAt:now, source:'codex-app-server',
    planType:raw?.rateLimits?.planType || account.planType || 'unknown',
    credits:raw?.rateLimits?.credits || null,
    reached:raw?.rateLimits?.rateLimitReachedType || null,
    state:groups.length ? 'available' : 'no_windows' };
}
module.exports = { normalizeUsage, normalizeAccountKey, accountKeyFromResult, quotaSnapshot };
