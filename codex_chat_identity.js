'use strict';

const { normalizeSeries, parseSeries } = require('./codex_context_handoff');

function normalizeDisplayLabel(value) {
  if (typeof value !== 'string') throw new Error('Nhãn hiển thị không hợp lệ.');
  const label = value.trim().normalize('NFC');
  if ([...label].length > 120 || /[\u0000-\u001f\u007f]/u.test(label)) throw new Error('Nhãn tối đa 120 ký tự, trên một dòng.');
  return label;
}
function normalizeIdentity(value) {
  if (value == null) return null;
  const series = normalizeSeries({ code: value.code, nextNumber: value.number });
  return { code: series.code, number: series.nextNumber };
}
function identityFromTitle(title) {
  const series = parseSeries(title);
  return series ? { code: series.code, number: String(series.number).padStart(series.width, '0') } : null;
}
function identityPlan(title, value) {
  const identity = normalizeIdentity(value), original = String(title || '').normalize('NFC');
  const suffix = parseSeries(original) ? original.replace(/^\[[\p{L}\p{N}]{1,30}-\d{4,}\](?:\s+|$)/u, '') : original;
  const name = suffix.trim() || 'Hội thoại';
  return { title: identity ? `[${identity.code}-${identity.number}] ${name}` : name,
    series: identity ? { code: identity.code, nextNumber: String(BigInt(identity.number) + 1n).padStart(identity.number.length, '0') } : null };
}

// Only metadata changes: never resume/interrupt/start a turn. Native names stay
// authoritative; the Tracker label is a separate local property.
async function prepareIdentityEdit(backend, threadId, value, fallbackTitle, expectedIdentity) {
  const before = await backend.readChatTitle(threadId, fallbackTitle);
  if (expectedIdentity !== undefined && JSON.stringify(identityFromTitle(before)) !== JSON.stringify(normalizeIdentity(expectedIdentity))) {
    throw new Error('ID chat đã thay đổi; mở lại Tuỳ chọn chat để chỉnh.');
  }
  const plan = identityPlan(before, value);
  if (plan.title === before) return { patch: { title: before, series: plan.series } };
  let failure;
  try { await backend.renameThread(threadId, plan.title); } catch (error) { failure = error; }
  const confirmed = await backend.readChatTitle(threadId, fallbackTitle);
  if (confirmed !== plan.title) throw failure || new Error('Chưa xác nhận được ID mới của chat.');
  return { patch: { title: confirmed, series: plan.series }, async rollback() {
    if (await backend.readChatTitle(threadId, fallbackTitle) !== plan.title) throw new Error('Tên gốc đã đổi ở nơi khác; không ghi đè.');
    await backend.renameThread(threadId, before);
    if (await backend.readChatTitle(threadId, fallbackTitle) !== before) throw new Error('Chưa khôi phục được tên gốc.');
  } };
}

module.exports = { normalizeDisplayLabel, normalizeIdentity, identityFromTitle, identityPlan, prepareIdentityEdit };
