'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

// The selected path travels only through the environment, never through shell code.
const RESTART_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  $item = Get-Item -LiteralPath $env:CODEX_TRACKER_PROXY_EXE -Force -ErrorAction Stop
  if ($item.PSIsContainer -or $item.Extension -ine '.exe') {
    throw 'The configured proxy is not an EXE file.'
  }
  $target = [System.IO.Path]::GetFullPath($item.FullName)
  $matches = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
    $_.ExecutablePath -and [string]::Equals(
      [System.IO.Path]::GetFullPath($_.ExecutablePath), $target,
      [System.StringComparison]::OrdinalIgnoreCase)
  })
  $stopped = 0
  foreach ($entry in $matches) {
    $candidate = Get-Process -Id $entry.ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $candidate) { continue }
    if (-not $candidate.Path) { throw 'Cannot verify the executable path of the proxy process.' }
    if (-not [string]::Equals(
      [System.IO.Path]::GetFullPath($candidate.Path), $target,
      [System.StringComparison]::OrdinalIgnoreCase)) { continue }
    # Keep the verified process handle so a reused PID cannot target another process.
    $null = $candidate.Handle
    $candidate.Kill()
    if (-not $candidate.WaitForExit(10000)) { throw 'The proxy process did not stop within 10 seconds.' }
    $stopped += 1
  }
  $started = Start-Process -FilePath $target -WorkingDirectory $item.DirectoryName -WindowStyle Hidden -PassThru -ErrorAction Stop
  if ($null -eq $started -or $started.Id -le 0) { throw 'Windows did not return a launched proxy process.' }
  @{ processId = $started.Id; stoppedCount = $stopped } | ConvertTo-Json -Compress
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

async function validateExecutable(value, options = {}) {
  const pathImpl = options.pathImpl || path;
  const fsImpl = options.fsImpl || fs.promises;
  if (typeof value !== 'string' || !pathImpl.isAbsolute(value) || pathImpl.extname(value).toLowerCase() !== '.exe') {
    throw new Error('Hãy chọn đường dẫn đầy đủ đến file proxy .exe.');
  }
  const executable = await fsImpl.realpath(value);
  if (!(await fsImpl.stat(executable)).isFile() || pathImpl.extname(executable).toLowerCase() !== '.exe') {
    throw new Error('Đường dẫn proxy phải là một file .exe có thật.');
  }
  for (const protectedPath of options.protectedPaths || [process.execPath]) {
    const canonical = await fsImpl.realpath(protectedPath).catch(() => protectedPath);
    if (pathImpl.normalize(canonical).toLowerCase() === pathImpl.normalize(executable).toLowerCase()) {
      throw new Error('Không thể dùng chương trình đang chạy Tracker làm proxy.');
    }
  }
  return executable;
}

function restartExecutable(executable, options = {}) {
  if ((options.platform || process.platform) !== 'win32') {
    return Promise.reject(new Error('Khởi động lại proxy EXE chỉ hỗ trợ Windows.'));
  }
  const environment = { ...(options.env || process.env) };
  // Restore the environment captured before Tracker applied its own gateway route.
  for (const [key, value] of Object.entries(options.originalProxyEnv || {})) {
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
  environment.CODEX_TRACKER_PROXY_EXE = executable;
  const encoded = Buffer.from(RESTART_SCRIPT, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    (options.execFileImpl || execFile)('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', encoded
    ], {
      windowsHide: true,
      timeout: 45000,
      maxBuffer: 64 * 1024,
      encoding: 'utf8',
      env: environment
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || '').trim().slice(0, 800);
        reject(new Error(detail || (error.killed ? 'Quá thời gian khởi động lại proxy.' : 'Windows không thể khởi động lại proxy.')));
        return;
      }
      try {
        const result = JSON.parse(String(stdout).replace(/^\uFEFF/, '').trim());
        if (!Number.isInteger(result.processId) || result.processId <= 0 || !Number.isInteger(result.stoppedCount) || result.stoppedCount < 0) {
          throw new Error('invalid result');
        }
        resolve(result);
      } catch {
        reject(new Error('Không nhận được kết quả hợp lệ khi khởi động lại proxy.'));
      }
    });
  });
}

function createLocalProxyController(options = {}) {
  let executablePath = typeof options.executablePath === 'string' ? options.executablePath : '';
  let busy = false;
  let notice = null;
  let pending = null;
  let lastRestartAt = 0;
  const validate = options.validate || validateExecutable;
  const restart = options.restart || restartExecutable;
  const snapshot = () => ({ executablePath, busy, notice, lastRestartAt });
  const notify = () => options.onChange?.(snapshot());

  function run(operation) {
    if (pending) return pending;
    busy = true;
    notice = null;
    // Install the promise before notifying consumers, including synchronous callbacks.
    pending = Promise.resolve().then(operation).catch(error => {
      notice = { kind: 'error', text: error.message || 'Không thể khởi động lại proxy.' };
      return false;
    }).finally(() => {
      busy = false;
      pending = null;
      notify();
    });
    notify();
    return pending;
  }

  return {
    snapshot,
    setExecutable(value) {
      if (pending) return Promise.resolve(false);
      return run(async () => {
        const canonical = await validate(value);
        await options.save?.(canonical);
        executablePath = canonical;
        notice = { kind: 'success', text: 'Đã lưu đường dẫn proxy.' };
        return true;
      });
    },
    restart() {
      return run(async () => {
        const canonical = await validate(executablePath);
        const result = await restart(canonical);
        lastRestartAt = Date.now();
        notice = { kind: 'success', text: 'Đã mở lại proxy (PID ' + result.processId + ').' };
        return true;
      });
    }
  };
}

module.exports = { createLocalProxyController, validateExecutable, restartExecutable, RESTART_SCRIPT };
