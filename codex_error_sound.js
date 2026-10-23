'use strict';

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const DEFAULT_ERROR_SOUND = 'error_429.mp3';
const DEFAULT_MODEL_CAPACITY_SOUND = 'error_model_capacity.mp3';
const MP3_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class CodexRetryMp3 {
    [DllImport("winmm.dll", EntryPoint = "mciSendStringW", CharSet = CharSet.Unicode)]
    private static extern uint SendString(string command, StringBuilder result, int length, IntPtr callback);
    [DllImport("winmm.dll", EntryPoint = "mciGetErrorStringW", CharSet = CharSet.Unicode)]
    private static extern bool GetErrorString(uint code, StringBuilder result, uint length);
    public static void Send(string command) {
        uint code = SendString(command, null, 0, IntPtr.Zero);
        if (code != 0) {
            var message = new StringBuilder(512);
            GetErrorString(code, message, 512);
            throw new InvalidOperationException("MP3 playback failed: " + message + " (" + code + ")");
        }
    }
}
'@
$opened = $false
try {
    [CodexRetryMp3]::Send('open "' + $env:CODEX_TRACKER_ERROR_MP3 + '" type mpegvideo alias codexRetryError')
    $opened = $true
    [CodexRetryMp3]::Send('play codexRetryError wait')
} finally {
    if ($opened) {
        try { [CodexRetryMp3]::Send('close codexRetryError') } catch {}
    }
}
`;

async function validateErrorSound(value) {
  const file = String(value || '').trim();
  if (!file) throw new Error('Chưa chọn file error_429.mp3.');
  if (!path.isAbsolute(file) || /[\0\r\n"]/.test(file)) throw new Error('Đường dẫn file MP3 không hợp lệ.');
  if (path.extname(file).toLowerCase() !== '.mp3') throw new Error('Hãy chọn file âm thanh MP3.');
  const stat = await fs.promises.stat(file);
  if (!stat.isFile() || stat.size === 0) throw new Error('File MP3 trống hoặc không hợp lệ.');
  return path.resolve(file);
}

async function playErrorSound(options = {}) {
  if ((options.platform || process.platform) !== 'win32') throw new Error('Codex MP3 alerts require Windows.');
  const file = await (options.validate || validateErrorSound)(options.file);
  const execFile = options.execFile || childProcess.execFile;
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', MP3_SCRIPT], {
      windowsHide: true,
      timeout: 0,
      maxBuffer: 64 * 1024,
      encoding: 'utf8',
      env: { ...process.env, CODEX_TRACKER_ERROR_MP3: file }
    }, error => error ? reject(error) : resolve());
  });
}

function createErrorSoundController(options = {}) {
  let file = String(options.file || '');
  const files = { ...(options.files || {}) };
  if (!files.retry_429 && file) files.retry_429 = file;
  let queue = Promise.resolve();
  return {
    snapshot() { return { file: files.retry_429 || file, files: { ...files } }; },
    async setFile(value, soundKey = 'retry_429') {
      const validated = await (options.validate || validateErrorSound)(value);
      await options.save?.(validated, soundKey);
      files[soundKey] = validated;
      if (soundKey === 'retry_429') file = validated;
      return validated;
    },
    play(soundKey = 'retry_429') {
      const selected = files[soundKey] || (soundKey === 'retry_429' ? file : '');
      const operation = queue.then(() => (options.play || playErrorSound)({ file: selected, soundKey }));
      queue = operation.catch(() => {});
      return operation;
    }
  };
}

module.exports = { DEFAULT_ERROR_SOUND, DEFAULT_MODEL_CAPACITY_SOUND, MP3_SCRIPT, validateErrorSound, playErrorSound, createErrorSoundController };
