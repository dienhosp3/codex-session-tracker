'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const childProcess = require('child_process');
const runtimeVersions = require('../runtime_versions');

function readTrackerVersion(repoRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '';
  } catch {
    return '';
  }
}

function defaultGitRunner(args, cwd) {
  return childProcess.execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitMetadata(repoRoot, gitRunner = defaultGitRunner) {
  let revision = '';
  let shortRevision = '';
  let dirty = null;
  try { revision = gitRunner(['rev-parse', 'HEAD'], repoRoot); } catch {}
  try { shortRevision = gitRunner(['rev-parse', '--short=12', 'HEAD'], repoRoot); } catch {}
  try {
    // Porcelain includes unstaged, staged, and untracked changes. Only retain
    // whether entries exist; paths must not appear in checkpoint output.
    dirty = Boolean(gitRunner(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none', '--'], repoRoot));
  } catch { dirty = true; }
  return { revision, shortRevision, dirty };
}

async function createCheckpoint(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, '..'));
  const versions = options.runtimeVersions || await runtimeVersions.collectRuntimeVersions({
    extensionRoots: options.extensionRoots || [],
    execFileImpl: options.execFileImpl,
    fsImpl: options.fsImpl
  });
  const checkpoint = {
    schemaVersion: 1,
    recordedAt: String(options.recordedAt || new Date().toISOString()),
    label: String(options.label || 'checkpoint'),
    repository: {
      ...gitMetadata(repoRoot, options.gitRunner),
      trackerVersion: readTrackerVersion(repoRoot)
    },
    versions: {
      installedExtension: versions.installedExtension || { id: '', version: '' },
      bundledCli: versions.bundledCli || { version: '', source: 'missing', error: '' },
      rollout: {
        cliVersion: options.rolloutCliVersion ? String(options.rolloutCliVersion) : '',
        model: options.model ? String(options.model) : ''
      }
    }
  };
  return checkpoint;
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeCheckpoint(file, checkpoint) {
  const target = path.resolve(file);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(temp, stableJson(checkpoint), 'utf8');
  await fsp.rename(temp, target);
  return target;
}

function parseArgs(argv) {
  const result = { label: 'checkpoint', extensionRoots: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--label') result.label = next, i += 1;
    else if (arg === '--output') result.output = next, i += 1;
    else if (arg === '--repo') result.repoRoot = next, i += 1;
    else if (arg === '--extension-root') result.extensionRoots.push(next), i += 1;
    else if (arg === '--rollout-cli-version') result.rolloutCliVersion = next, i += 1;
    else if (arg === '--model') result.model = next, i += 1;
    else if (arg === '--recorded-at') result.recordedAt = next, i += 1;
  }
  return result;
}

if (require.main === module) {
  createCheckpoint(parseArgs(process.argv.slice(2))).then(async checkpoint => {
    const args = parseArgs(process.argv.slice(2));
    if (args.output) await writeCheckpoint(args.output, checkpoint);
    process.stdout.write(stableJson(checkpoint));
  }).catch(error => {
    process.stderr.write(`${error && error.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { createCheckpoint, writeCheckpoint, stableJson, parseArgs, gitMetadata, readTrackerVersion };
