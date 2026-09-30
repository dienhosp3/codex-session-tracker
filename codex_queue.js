'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const childProcess = require('child_process');

const DEFAULT_TIMEOUT_MS = 20_000;

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

async function isFile(file) {
  if (!file) return false;
  try {
    const stat = await fsp.stat(file);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function findOnPath(platform = process.platform, execFileImpl = childProcess.execFile) {
  const cmd = platform === 'win32' ? 'where.exe' : 'which';
  try {
    const { stdout } = await execFileAsync(cmd, ['codex'], {
      windowsHide: true,
      timeout: 4000,
      maxBuffer: 512 * 1024
    }, execFileImpl);
    const found = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)[0];
    return found && await isFile(found) ? found : '';
  } catch {
    return '';
  }
}

function candidateNames(platform = process.platform) {
  return platform === 'win32' ? new Set(['codex.exe', 'codex']) : new Set(['codex']);
}

function isCompatibleBundledPath(file, platform = process.platform) {
  const lower = String(file || '').toLowerCase().replace(/\\/g, '/');
  // The OpenAI extension ships several platform builds side by side. Never
  // return a Unix executable to Windows (or a Windows executable to Unix):
  // spawning the wrong artifact fails with a misleading ENOENT/EACCES.
  if (platform === 'win32') {
    if (/\/(?:linux|linux-[^/]+|darwin|macos|freebsd|openbsd)[^/]*\//.test(lower)) return false;
    if (lower.endsWith('/codex') && !/(?:win32|windows|win)-[^/]*\//.test(lower)) return false;
    return lower.endsWith('.exe') || /(?:win32|windows|win)-[^/]*\//.test(lower);
  }
  if (/(?:^|\/)(?:win32|windows|win)-[^/]*\//.test(lower) || lower.endsWith('.exe')) return false;
  return true;
}

async function findBundledCodex(extensionRoot, platform = process.platform, maxDepth = 6) {
  if (!extensionRoot) return '';
  const root = path.resolve(extensionRoot);
  const names = candidateNames(platform);
  const skip = new Set(['node_modules', '.git', 'syntaxes', 'media', 'images', 'webview', 'webviews', 'localization', 'l10n']);
  const queue = [{ dir: root, depth: 0 }];
  const preferred = [];

  while (queue.length) {
    const { dir, depth } = queue.shift();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { continue; }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && names.has(entry.name.toLowerCase())) {
        if (!isCompatibleBundledPath(full, platform)) continue;
        const lower = full.toLowerCase();
        const score = (lower.includes(`${path.sep}bin${path.sep}`) ? 4 : 0)
          + (lower.includes('windows') || lower.includes('win32') || lower.includes('x86_64') || lower.includes('x64') ? 2 : 0)
          - depth;
        preferred.push({ full, score });
        continue;
      }
      if (!entry.isDirectory() || depth >= maxDepth) continue;
      if (skip.has(entry.name.toLowerCase())) continue;
      queue.push({ dir: full, depth: depth + 1 });
    }
  }

  preferred.sort((a, b) => b.score - a.score || a.full.length - b.full.length);
  return preferred.length ? preferred[0].full : '';
}

async function resolveCodexExecutable(options = {}) {
  const configuredPath = String(options.configuredPath || '').trim();
  if (configuredPath) {
    const resolved = path.resolve(configuredPath.replace(/^~(?=$|[\\/])/, process.env.USERPROFILE || process.env.HOME || '~'));
    if (await isFile(resolved)) return { executable: resolved, source: 'setting' };
    return { executable: '', source: 'setting', error: `Configured Codex CLI was not found: ${resolved}` };
  }

  // Prefer the binary bundled with the installed OpenAI VS Code extension.
  // It is the best version match for the app-server that owns the running chat.
  for (const root of options.extensionRoots || []) {
    const bundled = await findBundledCodex(root, options.platform || process.platform, options.maxDepth || 6);
    if (bundled) return { executable: bundled, source: 'openai-extension' };
  }

  const fromPath = await findOnPath(options.platform || process.platform, options.execFileImpl || childProcess.execFile);
  if (fromPath) return { executable: fromPath, source: 'PATH' };

  return { executable: '', source: 'none', error: 'Codex CLI binary was not found in the OpenAI VS Code extension or PATH.' };
}

async function probeQueueSupport(executable, options = {}) {
  if (!executable) return { available: false, reason: 'Codex CLI binary is unavailable.' };
  const execFileImpl = options.execFileImpl || childProcess.execFile;
  try {
    const [help, version] = await Promise.all([
      execFileAsync(executable, ['queue', '--help'], {
        windowsHide: true,
        timeout: options.timeoutMs || 7000,
        maxBuffer: 1024 * 1024
      }, execFileImpl),
      execFileAsync(executable, ['--version'], {
        windowsHide: true,
        timeout: options.timeoutMs || 7000,
        maxBuffer: 256 * 1024
      }, execFileImpl).catch(() => ({ stdout: '', stderr: '' }))
    ]);
    const text = `${help.stdout}\n${help.stderr}`;
    const supported = /--thread\b/.test(text) && /--message\b/.test(text);
    return {
      available: supported,
      reason: supported ? '' : 'This Codex CLI does not expose the queue command required for safe message delivery.',
      version: String(version.stdout || version.stderr || '').trim(),
      executable
    };
  } catch (error) {
    return {
      available: false,
      reason: compactError(error),
      version: '',
      executable
    };
  }
}

function compactError(error) {
  if (!error) return 'Unknown Codex CLI error.';
  const stderr = String(error.stderr || '').trim();
  const stdout = String(error.stdout || '').trim();
  const message = stderr || stdout || error.message || String(error);
  const lines = message.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return lines.slice(-4).join(' | ');
}

function parseQueueResult(stdout, threadId) {
  const text = String(stdout || '').trim();
  const match = text.match(/Queued message\s+(\S+)\s+for thread\s+(\S+)/i);
  return {
    queuedId: match ? match[1] : '',
    threadId: match ? match[2].replace(/[.]+$/, '') : String(threadId || ''),
    raw: text
  };
}

async function queueMessage(options = {}) {
  const executable = String(options.executable || '').trim();
  const threadId = String(options.threadId || '').trim();
  const message = String(options.message || '').trim();
  if (!executable) throw new Error('Codex CLI binary is unavailable.');
  if (!threadId) throw new Error('No Codex thread is selected.');
  if (!message) throw new Error('Message is empty.');

  const env = { ...process.env, ...(options.env || {}) };
  if (options.codexHome) env.CODEX_HOME = options.codexHome;
  const result = await execFileAsync(executable, [
    'queue',
    '--thread', threadId,
    '--message', message
  ], {
    env,
    cwd: options.cwd || undefined,
    windowsHide: true,
    timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024
  }, options.execFileImpl || childProcess.execFile);
  return parseQueueResult(result.stdout, threadId);
}

module.exports = {
  execFileAsync,
  findOnPath,
  findBundledCodex,
  resolveCodexExecutable,
  probeQueueSupport,
  parseQueueResult,
  queueMessage,
  compactError
};
