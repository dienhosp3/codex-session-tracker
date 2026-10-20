'use strict';

// Explicit Windows smoke check. Only launches/stops disposable fixture EXEs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { restartExecutable, validateExecutable } = require('../local_proxy');

function powershell(script, environment) {
  return execFileSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand',
    Buffer.from("$ProgressPreference = 'SilentlyContinue'\n" + script, 'utf16le').toString('base64')
  ], { windowsHide: true, encoding: 'utf8', timeout: 20000, env: { ...process.env, ...environment } });
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Windows only');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-proxy-smoke-'));
  const executable = path.join(root, 'selected', "proxy fixture [$()] ' test.exe");
  const unrelatedExecutable = path.join(root, 'unrelated', path.basename(executable));
  fs.mkdirSync(path.dirname(executable));
  fs.mkdirSync(path.dirname(unrelatedExecutable));
  const compiled = path.join(root, 'fixture.exe');
  const environment = { TRACKER_PROXY_SMOKE_EXE: executable, TRACKER_PROXY_SMOKE_OTHER: unrelatedExecutable, TRACKER_PROXY_SMOKE_COMPILED: compiled };
  try {
    powershell(String.raw`
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    Add-Type -OutputAssembly $env:TRACKER_PROXY_SMOKE_COMPILED -OutputType ConsoleApplication -TypeDefinition 'using System; using System.Threading; public class ProxyFixture { public static void Main() { Thread.Sleep(600000); } }'
  `, environment);
    fs.copyFileSync(compiled, executable);
    fs.copyFileSync(compiled, unrelatedExecutable);
    const original = spawn(executable, [], { windowsHide: true, stdio: 'ignore' });
    const unrelated = spawn(unrelatedExecutable, [], { windowsHide: true, stdio: 'ignore' });
    await Promise.all([original, unrelated].map(child => new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    })));
    assert.equal(await validateExecutable(executable), fs.realpathSync(executable));
    const result = await restartExecutable(executable);
    assert.equal(result.stoppedCount, 1);
    assert.notEqual(result.processId, original.pid);
    const processes = JSON.parse(powershell(String.raw`
      $ErrorActionPreference = 'Stop'
      $items = @(Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -eq $env:TRACKER_PROXY_SMOKE_EXE -or $_.ExecutablePath -eq $env:TRACKER_PROXY_SMOKE_OTHER
      } | Select-Object ProcessId, ExecutablePath)
      ConvertTo-Json -InputObject $items -Compress
    `, environment));
    assert.equal(processes.some(item => item.ProcessId === original.pid), false);
    assert.equal(processes.some(item => item.ProcessId === unrelated.pid && item.ExecutablePath === unrelatedExecutable), true);
    assert.equal(processes.some(item => item.ProcessId === result.processId && item.ExecutablePath === executable), true);
    console.log(JSON.stringify({ passed: true, matchingProcessStopped: true, sameNameOtherPathPreserved: true, replacementStarted: true, specialCharactersPreserved: true }));
  } finally {
    // Match only the two uniquely owned fixture paths; never stop by basename.
    powershell(String.raw`
      $ErrorActionPreference = 'Stop'
      Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -eq $env:TRACKER_PROXY_SMOKE_EXE -or $_.ExecutablePath -eq $env:TRACKER_PROXY_SMOKE_OTHER
      } | ForEach-Object {
        $candidate = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
        if ($candidate -and ($candidate.Path -eq $env:TRACKER_PROXY_SMOKE_EXE -or $candidate.Path -eq $env:TRACKER_PROXY_SMOKE_OTHER)) {
          $candidate.Kill()
          $null = $candidate.WaitForExit(5000)
        }
      }
    `, environment);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(String(error.stderr || error.message)); process.exitCode = 1; });
