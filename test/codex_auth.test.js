'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { deactivateSession, currentAccount } = require('../codex_auth');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cst-deactivate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('deactivation clears file credentials without reading them or touching history/config/other homes', async t => {
  const root = fixture(t), home = path.join(root, 'custom-home');
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  const originals = {
    'sessions/rollout.jsonl': 'fixture conversation',
    'session_index.jsonl': 'fixture index',
    'config.toml': 'fixture config'
  };
  for (const [name, content] of Object.entries(originals)) fs.writeFileSync(path.join(home, name), content);
  fs.writeFileSync(path.join(root, 'auth.json'), 'unrelated home');
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'fixture-only', tokens: { access_token: 'fixture-only' }, auth_mode: 'chatgpt' }));
  await deactivateSession({ codexHome: home, fsImpl: { ...fs.promises, readFile() { throw new Error('must never read credentials'); } } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8')), { OPENAI_API_KEY: null, tokens: null });
  for (const [name, content] of Object.entries(originals)) assert.equal(fs.readFileSync(path.join(home, name), 'utf8'), content);
  assert.equal(fs.readFileSync(path.join(root, 'auth.json'), 'utf8'), 'unrelated home');
  assert.deepEqual(fs.readdirSync(home).sort(), ['auth.json', 'config.toml', 'session_index.jsonl', 'sessions']);
  await deactivateSession({ codexHome: home }); // Already deactivated is safe.
});

test('missing Codex Home is created with the empty login payload', async t => {
  const home = path.join(fixture(t), 'new-home');
  await deactivateSession({ codexHome: home });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8')), { OPENAI_API_KEY: null, tokens: null });
});

for (const operation of ['writeFile', 'rename']) {
  test(`failed ${operation} preserves existing credentials and removes temporary files`, async t => {
    const home = fixture(t), original = 'fixture original credentials';
    fs.writeFileSync(path.join(home, 'auth.json'), original);
    const fsImpl = { ...fs.promises, async [operation](...args) {
      if (operation === 'writeFile') await fs.promises.writeFile(args[0], 'partial fixture');
      throw Object.assign(new Error('fixture access denied'), { code: 'EACCES' });
    } };
    await assert.rejects(deactivateSession({ codexHome: home, fsImpl }), /access denied/);
    assert.equal(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'), original);
    assert.deepEqual(fs.readdirSync(home), ['auth.json']);
  });
}

test('missing/relative Codex Home is rejected before filesystem mutation', async () => {
  for (const codexHome of [undefined, '', 'relative-home']) await assert.rejects(deactivateSession({ codexHome }), /absolute directory/);
});

function extensionHarness(home, { choice = 'Để sau', clear = deactivateSession, reloadError = false, readCurrentAccount = async () => ({ label: 'fixture@example.test', signedIn: true }) } = {}) {
  const file = path.join(__dirname, '../extension.js'), localRequire = createRequire(file);
  const prompts = [], commands = [], errors = [];
  const context = vm.createContext({
    require(name) {
      if (name === 'vscode') return {
        extensions: { getExtension: () => undefined },
        workspace: { getConfiguration: () => ({ get: (key, fallback) => key === 'codexHome' ? home : fallback }) },
        window: {
          async showInformationMessage(...args) { prompts.push(args); return choice; },
          showErrorMessage(message) { errors.push(message); }
        },
        commands: { async executeCommand(command) { commands.push(command); if (reloadError) throw new Error('fixture reload failed'); } }
      };
      if (name === './codex_auth') return { deactivateSession: clear, currentAccount: readCurrentAccount };
      return localRequire(name);
    },
    process, module: { exports: {} }, setInterval, clearInterval, setTimeout, clearTimeout, console
  });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return { prompts, commands, errors, run: expression => vm.runInContext(expression, context) };
}

test('extension clears the resolved home on explicit action, defers reload, then supports later reload', async t => {
  const home = fixture(t), extension = extensionHarness(home);
  assert.deepEqual(fs.readdirSync(home), []); // Loading Tracker never deactivates a login.
  await extension.run('deactivateCodexSession()');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8')), { OPENAI_API_KEY: null, tokens: null });
  assert.equal(extension.prompts.length, 1);
  assert.deepEqual(extension.commands, []);
  assert.equal(extension.run('authSessionBusy'), false);
  assert.equal(extension.run('authSessionReloadRequired'), true);
  assert.equal(extension.run('authSessionNotice.kind'), 'success');
  await extension.run('reloadAfterDeactivation()');
  assert.deepEqual(extension.commands, ['workbench.action.reloadWindow']);
});

test('Reload ngay uses the VS Code reload command and reports reload failure separately', async t => {
  for (const reloadError of [false, true]) {
    const extension = extensionHarness(fixture(t), { choice: 'Reload ngay', reloadError });
    await extension.run('deactivateCodexSession()');
    assert.deepEqual(extension.commands, ['workbench.action.reloadWindow']);
    assert.equal(extension.run('authSessionNotice.kind'), 'success');
    assert.equal(extension.errors.length, reloadError ? 1 : 0);
  }
});

test('extension suppresses duplicate requests and does not offer reload after a failed clear', async t => {
  let release, count = 0;
  const extension = extensionHarness(fixture(t), { clear: async () => {
    count += 1;
    await new Promise(resolve => { release = resolve; });
    throw new Error('fixture locked auth');
  } });
  const pending = extension.run('deactivateCodexSession()');
  assert.equal(extension.run('authSessionBusy'), true);
  await extension.run('deactivateCodexSession()');
  assert.equal(count, 1);
  release();
  await pending;
  assert.equal(extension.run('authSessionBusy'), false);
  assert.equal(extension.run('authSessionReloadRequired'), false);
  assert.equal(extension.run('authSessionNotice.kind'), 'error');
  assert.deepEqual(extension.prompts, []);
  assert.deepEqual(extension.commands, []);
  assert.match(extension.errors[0], /fixture locked auth/);
});

test('dashboard combines account and usage without a login heading and blocks duplicate deactivation clicks', () => {
  const html = fs.readFileSync(path.join(__dirname, '../dashboard.html'), 'utf8');
  const messages = [], elements = new Map();
  const context = vm.createContext({
    document: { getElementById: id => elements.get(id) },
    vscode: { postMessage: message => messages.push(message) },
    state: { authSession: { accountLabel: '<owner>@example.test', canDeactivate: true } },
    esc: s => String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;')
  });
  vm.runInContext(html.slice(html.indexOf('function usageChartPlot('), html.indexOf('function renderComposer(')), context);
  const rendered = vm.runInContext('renderAuthSession()', context);
  assert.match(rendered, />Deactive<\/button>/);
  assert.match(rendered, /&lt;owner&gt;@example.test/);
  assert.doesNotMatch(rendered, /Phiên đăng nhập Codex|Codex Home|giữ nguyên|Reload|Đăng xuất|Xoá phiên/);
  assert.equal((rendered.match(/auth-session-card/g) || []).length, 1);
  assert.equal((rendered.match(/class="usage-alert-dialog"/g) || []).length, 1);
  assert.equal((rendered.match(/class="usage-alert-section(?:["\s])/g) || []).length, 5);
  assert.match(rendered, /auth-session-card/);
  assert.match(rendered, /usage-head usage-card/);
  assert.match(rendered, /id="checkUsage"/);
  assert.match(rendered, /id="usageSettings"/);
  assert.equal((rendered.match(/id="deactivateSession"/g) || []).length, 1);
  elements.set('deactivateSession', { disabled: false });
  vm.runInContext('bindAuthSessionUi()', context);
  elements.get('deactivateSession').onclick();
  elements.get('deactivateSession').onclick();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].command, 'deactivateSession');
  context.state.authSession.busy = true;
  assert.match(vm.runInContext('renderAuthSession()', context), /id="deactivateSession"[^>]*disabled/);
  context.state.authSession = { accountLabel: 'Chưa đăng nhập', canDeactivate: false };
  assert.match(vm.runInContext('renderAuthSession()', context), /Chưa đăng nhập/);
  assert.match(vm.runInContext('renderAuthSession()', context), /id="deactivateSession"[^>]*disabled/);
});

test('account label comes only from supported public metadata, never credential fields', async () => {
  const account = { type: 'chatgpt', email: '  owner@example.test  ', planType: 'plus' };
  Object.defineProperty(account, 'tokens', { get() { throw new Error('credentials must not be read'); } });
  const result = { account };
  Object.defineProperty(result, 'authToken', { get() { throw new Error('credentials must not be read'); } });
  assert.deepEqual(await currentAccount(async () => result), { label: 'owner@example.test', signedIn: true });
  assert.deepEqual(await currentAccount(async () => ({ account: null })), { label: 'Chưa đăng nhập', signedIn: false });
  assert.deepEqual(await currentAccount(async () => ({ account: { type: 'chatgpt', email: null } })), { label: 'Tài khoản Codex', signedIn: true });
  assert.deepEqual(await currentAccount(async () => ({ account: { type: 'apiKey' } })), { label: 'API key', signedIn: true });
  assert.deepEqual(await currentAccount(async () => ({ account: { type: 'amazonBedrock' } })), { label: 'Amazon Bedrock', signedIn: true });
  for (const value of [null, {}, { account: { type: 'unknown', email: 'untrusted' } }]) {
    await assert.rejects(currentAccount(async () => value), /Không đọc được/);
  }
});

test('account refresh is cached, explicit refresh sees account changes, and a failed read clears stale identity', async t => {
  let reads = 0;
  const extension = extensionHarness(fixture(t), { readCurrentAccount: async () => {
    reads += 1;
    if (reads === 3) throw new Error('fixture disconnected');
    return { label: reads === 1 ? 'first@example.test' : 'second@example.test', signedIn: true };
  } });
  await extension.run('refreshAuthAccount(true)');
  assert.equal(extension.run('authAccount.label'), 'first@example.test');
  await extension.run('refreshAuthAccount(false)');
  assert.equal(reads, 1);
  await extension.run('refreshAuthAccount(true)');
  assert.equal(extension.run('authAccount.label'), 'second@example.test');
  await extension.run('refreshAuthAccount(true)');
  assert.equal(extension.run('authAccount.label'), 'Chưa xác định tài khoản');
  assert.deepEqual(extension.errors, []);
});
