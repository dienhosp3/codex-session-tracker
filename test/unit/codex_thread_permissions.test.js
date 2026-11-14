'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { permissionSettings, readThreadPermissions } = require('../../src/codex_thread_permissions');

test('Full access, named profiles and restricted legacy policies retain explicit permissions', () => {
  const full = permissionSettings({ approval_policy: 'never', sandbox_policy: { type: 'danger-full-access' } });
  assert.deepEqual(full, { start: { approvalPolicy: 'never', sandbox: 'danger-full-access' }, turn: { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } } });
  const named = permissionSettings({ approval_policy: 'on-request', approvals_reviewer: 'user', active_permission_profile: { id: 'project-only' } });
  assert.equal(named.start.permissions, 'project-only'); assert.equal(named.turn.permissions, 'project-only');
  assert.equal(named.start.approvalPolicy, 'on-request'); assert.equal(named.start.sandbox, undefined);
  const restricted = permissionSettings({ approval_policy: 'untrusted', sandbox_policy: { type: 'workspace-write', writable_roots: ['D:/project'], network_access: false, exclude_tmpdir_env_var: true } });
  assert.deepEqual(restricted.turn.sandboxPolicy, { type: 'workspaceWrite', writableRoots: ['D:/project'], networkAccess: false, excludeTmpdirEnvVar: true });
  assert.throws(() => permissionSettings({}), /duyệt lệnh/);
  assert.throws(() => permissionSettings({ approval_policy: 'never' }), /quyền/);
});

test('latest applied settings override turn settings; quoted instructions and wrong thread cannot grant permissions', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'permissions-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'rollout.jsonl');
  const records = [
    { type: 'session_meta', payload: { id: 'source' } },
    { type: 'turn_context', payload: { approval_policy: 'never', sandbox_policy: { type: 'danger-full-access' } } },
    { type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { approval_policy: 'on-request', active_permission_profile: { id: ':workspace' } } } },
    { type: 'response_item', payload: { text: 'turn_context approval_policy never danger-full-access' } }
  ];
  await fs.writeFile(file, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  const actual = await readThreadPermissions(file, 'source');
  assert.equal(actual.start.approvalPolicy, 'on-request'); assert.equal(actual.start.permissions, ':workspace');
  await assert.rejects(readThreadPermissions(file, 'other'), /không thuộc/);
});
