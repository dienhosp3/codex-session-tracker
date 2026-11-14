'use strict';

const { spawn } = require('node:child_process');

// The request belongs to this helper thread. EOF (including extension-host
// crashes) releases it; no power-plan or registry settings are changed.
const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class TrackerPower { [DllImport("kernel32.dll", SetLastError=true)] public static extern uint SetThreadExecutionState(uint flags); }'
try {
  if ([TrackerPower]::SetThreadExecutionState([uint32]2147483651) -eq 0) { throw 'Windows rejected the power request.' }
  [Console]::Out.WriteLine('READY')
  [Console]::Out.Flush()
  [Console]::In.ReadLine() | Out-Null
} finally {
  [TrackerPower]::SetThreadExecutionState([uint32]2147483648) | Out-Null
}
`;

function createKeepAwake(options = {}) {
  let child = null, pending = null, disposed = false;
  const state = { enabled: false, busy: false, error: '' };
  const snapshot = () => ({ ...state });
  const changed = () => { if (!disposed) options.onChange?.(snapshot()); };
  const stop = () => { const old = child; child = null; old?.stdin.end(); return old; };
  async function setEnabled(enabled) {
    if (disposed) throw new Error('Tracker đã đóng.');
    if (pending) return pending;
    if (enabled === state.enabled) return snapshot();
    state.busy = true; state.error = ''; changed();
    pending = (async () => {
      try {
        if (!enabled) {
          const old = child;
          if (old) await new Promise(resolve => { old.once('close', resolve); stop(); });
          state.enabled = false;
        } else {
          if ((options.platform || process.platform) !== 'win32') throw new Error('Giữ máy thức hiện hỗ trợ Windows.');
          const processChild = (options.spawn || spawn)('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
          child = processChild;
          processChild.stdin.on('error', () => {});
          await new Promise((resolve, reject) => {
            let output = '', errorOutput = '';
            const timer = setTimeout(() => { processChild.kill(); reject(new Error('Windows chưa xác nhận giữ máy thức.')); }, 15000);
            const done = error => { clearTimeout(timer); error ? reject(error) : resolve(); };
            processChild.stdout.on('data', data => { output += data; if (output.includes('READY')) done(); });
            processChild.stderr.on('data', data => { errorOutput = (errorOutput + data).slice(-500); });
            processChild.once('error', error => done(error));
            processChild.once('close', () => {
              if (child === processChild) {
                child = null; state.enabled = false;
                state.error = errorOutput.trim() || 'Tiến trình giữ máy thức đã dừng.'; changed();
              }
              done(new Error(errorOutput.trim() || 'Không bật được giữ máy thức.'));
            });
          });
          if (disposed) { stop(); return snapshot(); }
          state.enabled = true;
        }
      } catch (error) { stop(); state.enabled = false; state.error = error.message; }
      finally { state.busy = false; pending = null; changed(); }
      return snapshot();
    })();
    return pending;
  }
  return { snapshot, setEnabled, dispose() { disposed = true; stop(); state.enabled = false; } };
}

module.exports = { createKeepAwake };
