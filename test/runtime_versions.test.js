'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const runtime = require('../runtime_versions');
const checkpoint = require('../scripts/checkpoint');

async function fakeExtensionRoot(t, version = '26.928.31416') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-runtime-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ publisher: 'openai', name: 'chatgpt', version }));
  const bin = path.join(root, 'bin', 'windows-x86_64');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, 'codex.exe'), 'test-binary');
  return root;
}

function fakeExec(file, args, options, callback) {
  assert.equal(args[0], '--version');
  assert.equal(options.windowsHide, true);
  callback(null, 'codex-cli 0.155.0-alpha.16.3\r\n', '');
}

test('collectRuntimeVersions reads the installed Extension and Windows bundled CLI without exposing root paths', async t => {
  const root = await fakeExtensionRoot(t);
  const result = await runtime.collectRuntimeVersions({ extensionRoots: [root], platform: 'win32', execFileImpl: fakeExec });
  assert.deepEqual(result.installedExtension, { id: 'openai.chatgpt', version: '26.928.31416' });
  assert.deepEqual(result.bundledCli, { version: 'codex-cli 0.155.0-alpha.16.3', source: 'bundled', error: '' });
  assert.equal(JSON.stringify(result).includes(root), false);
});

test('collectRuntimeVersions prefers the OpenAI Extension root', async t => {
  const first = await fakeExtensionRoot(t, '1.0.0');
  const second = await fakeExtensionRoot(t, '26.928.31416');
  await fs.writeFile(path.join(second, 'package.json'), JSON.stringify({ publisher: 'openai', name: 'chatgpt', version: '26.928.31416' }));
  const result = await runtime.collectRuntimeVersions({ extensionRoots: [first, second], platform: 'win32', execFileImpl: fakeExec });
  assert.equal(result.installedExtension.id, 'openai.chatgpt');
  assert.equal(result.installedExtension.version, '1.0.0');
});

test('createCheckpoint captures repository and runtime provenance with explicit rollout fields', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-checkpoint-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.7.0' }));
  const result = await checkpoint.createCheckpoint({
    repoRoot: root,
    label: 'test checkpoint',
    recordedAt: '2026-10-01T03:04:05.000Z',
    runtimeVersions: {
      installedExtension: { id: 'openai.chatgpt', version: '26.928.31416' },
      bundledCli: { version: 'codex-cli 0.155.0-alpha.16.3', source: 'bundled', error: '' }
    },
    rolloutCliVersion: '0.155.0-alpha.16.3',
    model: 'gpt-6',
    gitRunner: (args) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'abc123';
      if (args[0] === 'rev-parse') return 'abc123';
      return '';
    }
  });
  assert.equal(result.repository.revision, 'abc123');
  assert.equal(result.repository.trackerVersion, '0.7.0');
  assert.equal(result.versions.installedExtension.version, '26.928.31416');
  assert.equal(result.versions.bundledCli.version, 'codex-cli 0.155.0-alpha.16.3');
  assert.equal(result.versions.rollout.cliVersion, '0.155.0-alpha.16.3');
  assert.equal(result.versions.rollout.model, 'gpt-6');
  assert.equal(JSON.stringify(result).includes(root), false);
});

test('gitMetadata reports untracked and staged files even when Git hides untracked files by default', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-checkpoint-git-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'status.showUntrackedFiles', 'no');

  assert.equal(checkpoint.gitMetadata(root).dirty, false);
  await fs.writeFile(path.join(root, 'artifact.json'), '{}');
  assert.equal(checkpoint.gitMetadata(root).dirty, true);

  git('add', 'artifact.json');
  assert.equal(checkpoint.gitMetadata(root).dirty, true);
});

test('stableJson produces repeatable output', () => {
  const value = { schemaVersion: 1, versions: { tracker: '0.7.0' } };
  assert.equal(checkpoint.stableJson(value), checkpoint.stableJson(value));
  assert.match(checkpoint.stableJson(value), /\n$/);
});
