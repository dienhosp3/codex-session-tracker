'use strict';

const fs = require('node:fs');
const readline = require('node:readline');

// Only actual settings records count. Text quoted by a user/tool is never a
// permission source, and the stopped source thread must match the rollout.
async function readThreadSettings(file, threadId) {
  if (!file) throw new Error('Không tìm thấy quyền đã chọn của chat gốc.');
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let identity, settings;
  try {
    for await (const line of lines) {
      if (!/session_meta|turn_context|thread_settings_applied/.test(line)) continue;
      let record; try { record = JSON.parse(line); } catch { continue; }
      const p = record.payload || {};
      if (record.type === 'session_meta') identity = p.id;
      if (record.type === 'turn_context') settings = p;
      if (record.type === 'event_msg' && p.type === 'thread_settings_applied') settings = p.thread_settings;
    }
  } finally { lines.close(); stream.destroy(); }
  if (identity !== threadId) throw new Error('Rollout quyền không thuộc chat gốc.');
  return settings;
}

async function readThreadPermissions(file, threadId) { return permissionSettings(await readThreadSettings(file, threadId)); }

function permissionSettings(settings) {
  const approvalPolicy = settings?.approval_policy;
  if (!approvalPolicy || (typeof approvalPolicy !== 'string' && typeof approvalPolicy !== 'object')) {
    throw new Error('Chưa xác nhận được chế độ duyệt lệnh của chat gốc.');
  }
  const common = { approvalPolicy: structuredClone(approvalPolicy) };
  if (settings.approvals_reviewer) common.approvalsReviewer = settings.approvals_reviewer;
  const profile = settings.active_permission_profile?.id;
  if (profile) return { start: { ...common, permissions: profile }, turn: { ...common, permissions: profile } };
  const raw = settings.sandbox_policy;
  if (settings.permission_profile?.type === 'disabled' && !raw) {
    return { start: { ...common, sandbox: 'danger-full-access' }, turn: { ...common, sandboxPolicy: { type: 'dangerFullAccess' } } };
  }
  const modes = { 'danger-full-access': 'dangerFullAccess', 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'external-sandbox': 'externalSandbox' };
  const mode = Object.keys(modes).find(key => key === raw?.type || modes[key] === raw?.type);
  if (!mode) throw new Error('Không nhận diện được quyền của chat gốc; chưa gửi chat kế tiếp.');
  const policy = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), value]));
  policy.type = modes[mode];
  // External sandbox has no thread/start SandboxMode. Start inert/read-only;
  // the exact source policy is applied before the first turn can execute.
  return { start: { ...common, sandbox: mode === 'external-sandbox' ? 'read-only' : mode }, turn: { ...common, sandboxPolicy: policy } };
}

module.exports = { readThreadPermissions, readThreadSettings, permissionSettings };
