'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createLocalProxyController, validateExecutable, restartExecutable, RESTART_SCRIPT } = require('../local_proxy');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-proxy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, "Proxy [$()] ' tiếng Việt.exe");
  fs.writeFileSync(executable, 'fixture only, never execute');
  return { root, executable };
}

test('validates real absolute EXE files and preserves special characters', async t => {
  const { executable } = fixture(t);
  assert.equal(await validateExecutable(executable), fs.realpathSync(executable));
  for (const value of ['', 'proxy.exe', executable + '.txt']) {
    await assert.rejects(validateExecutable(value), /đường dẫn/);
  }
  await assert.rejects(validateExecutable(executable, { protectedPaths: [executable] }), /đang chạy Tracker/);
});

test('rejects directories and missing files', async t => {
  const { root } = fixture(t);
  const directory = path.join(root, 'directory.exe');
  fs.mkdirSync(directory);
  await assert.rejects(validateExecutable(directory), /file .exe/);
  await assert.rejects(validateExecutable(path.join(root, 'missing.exe')), /ENOENT/);
});

test('persists validated path and restores it in a new controller', async () => {
  let saved = '';
  const first = createLocalProxyController({ validate: async value => value.toUpperCase(), save: async value => { saved = value; } });
  assert.equal(await first.setExecutable('fixture.exe'), true);
  assert.equal(saved, 'FIXTURE.EXE');
  const second = createLocalProxyController({ executablePath: saved });
  assert.equal(second.snapshot().executablePath, saved);
});

test('failed persistence or validation preserves the previous path', async () => {
  for (const failure of ['validate', 'save']) {
    const controller = createLocalProxyController({
      executablePath: 'old.exe',
      validate: async value => { if (failure === 'validate') throw new Error('invalid EXE'); return value; },
      save: async () => { throw new Error('storage unavailable'); }
    });
    assert.equal(await controller.setExecutable('new.exe'), false);
    assert.equal(controller.snapshot().executablePath, 'old.exe');
    assert.equal(controller.snapshot().busy, false);
    assert.equal(controller.snapshot().notice.kind, 'error');
  }
});

test('restart is single flight and configuration cannot change during restart', async () => {
  let release;
  let restarts = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const changes = [];
  const controller = createLocalProxyController({
    executablePath: 'saved.exe',
    validate: async value => value,
    restart: async value => { assert.equal(value, 'saved.exe'); restarts += 1; return pending; },
    onChange: snapshot => changes.push(snapshot.busy)
  });
  const first = controller.restart();
  const second = controller.restart();
  assert.equal(first, second);
  assert.equal(controller.snapshot().busy, true);
  assert.equal(await controller.setExecutable('other.exe'), false);
  release({ processId: 77, stoppedCount: 1 });
  assert.equal(await first, true);
  assert.equal(restarts, 1);
  assert.equal(controller.snapshot().executablePath, 'saved.exe');
  assert.ok(controller.snapshot().lastRestartAt > 0);
  assert.deepEqual(changes, [true, false]);
});

test('deleted executable never reaches restart and launch failure retains configuration', async () => {
  let called = false;
  const invalid = createLocalProxyController({ executablePath: 'gone.exe', validate: async () => { throw new Error('missing file'); }, restart: async () => { called = true; } });
  assert.equal(await invalid.restart(), false);
  assert.equal(called, false);
  const denied = createLocalProxyController({ executablePath: 'saved.exe', validate: async value => value, restart: async () => { throw new Error('access denied'); } });
  assert.equal(await denied.restart(), false);
  assert.equal(denied.snapshot().executablePath, 'saved.exe');
  assert.equal(denied.snapshot().notice.text, 'access denied');
});

test('PowerShell receives path only in environment and restores pre gateway proxy variables', async () => {
  const executable = "C:\\Proxy $([bad])\\o'ne.exe";
  let captured;
  const result = await restartExecutable(executable, {
    platform: 'win32',
    env: { HTTP_PROXY: 'tracker-route', HTTPS_PROXY: 'tracker-route', OTHER: 'preserved' },
    originalProxyEnv: { HTTP_PROXY: 'original-route', HTTPS_PROXY: undefined },
    execFileImpl(file, args, options, done) {
      captured = { file, args, options };
      done(null, '{"processId":88,"stoppedCount":1}', '');
    }
  });
  assert.deepEqual(result, { processId: 88, stoppedCount: 1 });
  assert.equal(captured.file, 'powershell.exe');
  assert.equal(captured.options.env.CODEX_TRACKER_PROXY_EXE, executable);
  assert.equal(captured.options.env.HTTP_PROXY, 'original-route');
  assert.equal(captured.options.env.HTTPS_PROXY, undefined);
  assert.equal(captured.options.env.OTHER, 'preserved');
  assert.equal(captured.options.windowsHide, true);
  assert.equal(Buffer.from(captured.args.at(-1), 'base64').toString('utf16le'), RESTART_SCRIPT);
  assert.equal(RESTART_SCRIPT.includes(executable), false);
});

test('malformed results, process failure and unsupported OS report bounded errors', async () => {
  for (const output of ['', '{}', '{"processId":0,"stoppedCount":0}', 'not JSON']) {
    await assert.rejects(restartExecutable('fixture', { platform: 'win32', execFileImpl: (_f, _a, _o, done) => done(null, output, '') }), /kết quả hợp lệ/);
  }
  await assert.rejects(restartExecutable('fixture', { platform: 'win32', execFileImpl: (_f, _a, _o, done) => done(new Error('encoded command must not leak'), '', 'fixture denied') }), /fixture denied/);
  await assert.rejects(restartExecutable('fixture', { platform: 'linux' }), /Windows/);
});

function mockPowerShell(t, scenario) {
  const { executable } = fixture(t);
  const setup = String.raw`
    $global:mockStoppedIds = @()
    function Get-CimInstance {
      @(
        [pscustomobject]@{ ExecutablePath = $env:CODEX_TRACKER_PROXY_EXE.ToUpperInvariant(); ProcessId = 11 },
        [pscustomobject]@{ ExecutablePath = 'C:\Other\same-name.exe'; ProcessId = 12 },
        [pscustomobject]@{ ExecutablePath = $null; ProcessId = 13 }
      )
    }
    function Get-Process {
      param($Id, $ErrorAction)
      $candidate = [pscustomobject]@{ Path = $env:CODEX_TRACKER_PROXY_EXE; Handle = 1 }
      if ($env:TRACKER_PROXY_TEST_SCENARIO -eq 'reused') { $candidate.Path = 'C:\Other\same-name.exe' }
      $candidate | Add-Member ScriptMethod Kill {
        if ($env:TRACKER_PROXY_TEST_SCENARIO -eq 'denied') { throw 'fixture denied' }
        $global:mockStoppedIds += 11
      }
      $candidate | Add-Member ScriptMethod WaitForExit { param($Timeout) return $true }
      return $candidate
    }
    function Start-Process {
      param($FilePath, $WorkingDirectory, $WindowStyle, [switch]$PassThru, $ErrorAction)
      $expected = if ($env:TRACKER_PROXY_TEST_SCENARIO -eq 'reused') { 0 } else { 1 }
      if ($global:mockStoppedIds.Count -ne $expected) { throw 'incorrect stopped process count' }
      if ($global:mockStoppedIds | Where-Object { $_ -ne 11 }) { throw 'unrelated process stopped' }
      if ($FilePath -cne $env:CODEX_TRACKER_PROXY_EXE) { throw 'path changed or interpreted' }
      if ($WorkingDirectory -cne [IO.Path]::GetDirectoryName($FilePath)) { throw 'wrong working directory' }
      if ($WindowStyle -ne 'Hidden') { throw 'visible window requested' }
      return [pscustomobject]@{ Id = 99 }
    }
  `;
  return spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(setup + RESTART_SCRIPT, 'utf16le').toString('base64')], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, CODEX_TRACKER_PROXY_EXE: executable, TRACKER_PROXY_TEST_SCENARIO: scenario }
  });
}

test('Windows process script matches full path and treats special path characters literally', { skip: process.platform !== 'win32' }, t => {
  const result = mockPowerShell(t, 'normal');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { processId: 99, stoppedCount: 1 });
});

test('Windows process script rechecks reused PID paths before stopping', { skip: process.platform !== 'win32' }, t => {
  const result = mockPowerShell(t, 'reused');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { processId: 99, stoppedCount: 0 });
});

test('Windows stop failure aborts launch', { skip: process.platform !== 'win32' }, t => {
  const result = mockPowerShell(t, 'denied');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /fixture denied/);
  assert.equal(result.stdout.trim(), '');
});
