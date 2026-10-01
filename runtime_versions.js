'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const childProcess = require('child_process');

const DEFAULT_TIMEOUT_MS = 7000;
const DEFAULT_MAX_DEPTH = 6;
const PLATFORM_CLI_NAMES = process.platform === 'win32' ? new Set(['codex.exe', 'codex']) : new Set(['codex']);
const SKIP_DIRECTORIES = new Set([
  'node_modules', '.git', 'syntaxes', 'media', 'images', 'webview', 'webviews', 'localization', 'l10n'
]);

function execFileAsync(executable, args, options = {}, execFileImpl = childProcess.execFile) {
  return new Promise((resolve, reject) => {
    execFileImpl(executable, args, options, (error, stdout = '', stderr = '') => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function firstOutputLine(stdout, stderr) {
  return `${String(stdout || '')}\n${String(stderr || '')}`
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean) || '';
}

async function isFile(file, fsImpl = fsp) {
  try {
    const stat = await fsImpl.stat(file);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function findBundledCli(extensionRoot, options = {}) {
  if (!extensionRoot) return '';
  const root = path.resolve(String(extensionRoot));
  const platform = options.platform || process.platform;
  const names = options.cliNames || (platform === 'win32' ? new Set(['codex.exe', 'codex']) : PLATFORM_CLI_NAMES);
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : DEFAULT_MAX_DEPTH;
  const fsImpl = options.fsImpl || fsp;
  const queue = [{ dir: root, depth: 0 }];
  const candidates = [];

  while (queue.length) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = await fsImpl.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && names.has(entry.name.toLowerCase())) {
        const lower = full.toLowerCase();
        const incompatible = platform === 'win32' ? /(?:^|[\\/])(?:linux|darwin|macos|freebsd)[-_]/.test(lower) : platform === 'darwin' ? /(?:^|[\\/])(?:linux|windows|win32)[-_]/.test(lower) : /(?:^|[\\/])(?:windows|win32|darwin|macos)[-_]/.test(lower);
        if (incompatible) continue;
        const score = (lower.includes(`${path.sep}bin${path.sep}`) ? 4 : 0)
          + (lower.includes('windows') || lower.includes('win32') || lower.includes('x86_64') || lower.includes('x64') ? 2 : 0)
          - depth;
        if (await isFile(full, fsImpl)) candidates.push({ file: full, score });
        continue;
      }
      if (!entry.isDirectory() || depth >= maxDepth || SKIP_DIRECTORIES.has(entry.name.toLowerCase())) continue;
      queue.push({ dir: full, depth: depth + 1 });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.file.length - b.file.length);
  return candidates.length ? candidates[0].file : '';
}

async function readExtensionPackage(extensionRoot, fsImpl = fsp) {
  const packageFile = path.join(extensionRoot, 'package.json');
  try {
    const text = await fsImpl.readFile(packageFile, 'utf8');
    const value = JSON.parse(text);
    return {
      id: [value.publisher, value.name].filter(Boolean).join('.') || '',
      version: typeof value.version === 'string' ? value.version : ''
    };
  } catch {
    return { id: '', version: '' };
  }
}

async function inspectExtensionRoot(extensionRoot, options = {}) {
  const fsImpl = options.fsImpl || fsp;
  const packageInfo = await readExtensionPackage(extensionRoot, fsImpl);
  const executable = await findBundledCli(extensionRoot, options);
  let cliVersion = '';
  let cliError = '';
  if (executable) {
    try {
      const result = await execFileAsync(executable, ['--version'], {
        windowsHide: true,
        timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
        maxBuffer: 256 * 1024
      }, options.execFileImpl || childProcess.execFile);
      cliVersion = firstOutputLine(result.stdout, result.stderr);
    } catch (error) {
      cliError = firstOutputLine(error && error.stdout, error && error.stderr) || String(error && error.message || error);
    }
  }
  return {
    id: packageInfo.id,
    version: packageInfo.version,
    bundledCli: {
      version: cliVersion,
      source: executable ? 'bundled' : 'missing',
      error: cliError
    }
  };
}

async function collectRuntimeVersions(options = {}) {
  const extensionRoots = Array.isArray(options.extensionRoots) ? options.extensionRoots.filter(Boolean) : [];
  const inspected = [];
  for (const root of extensionRoots) {
    const result = await inspectExtensionRoot(String(root), options);
    if (result.id || result.version || result.bundledCli.version || result.bundledCli.source !== 'missing') inspected.push(result);
  }
  const selected = inspected.find(item => item.id === 'openai.chatgpt') || inspected[0] || { id: '', version: '', bundledCli: { version: '', source: 'missing', error: '' } };
  return {
    schemaVersion: 1,
    installedExtension: { id: selected.id, version: selected.version },
    bundledCli: { ...selected.bundledCli },
    inspectedExtensionCount: inspected.length
  };
}

module.exports = {
  execFileAsync,
  firstOutputLine,
  findBundledCli,
  readExtensionPackage,
  inspectExtensionRoot,
  collectRuntimeVersions
};


