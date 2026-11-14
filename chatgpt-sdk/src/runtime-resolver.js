import {access, readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, isAbsolute, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CoreError, invariant} from './errors.js';

export function sharedRuntimeHome(env = process.env) {
  if (env.AHUST_CHATGPT_RUNTIME_HOME) return resolve(env.AHUST_CHATGPT_RUNTIME_HOME);
  const base = process.platform === 'win32'
    ? env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    : join(homedir(), '.local', 'share');
  return join(base, 'AHUST', 'ChatGPTCore', 'runtime');
}

async function inspectRuntime(root, expectedVersion) {
  try {
    const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    invariant(metadata.name === '@ahust/chatgpt-core', 'CORE_RUNTIME_INVALID', 'This path is not a ChatGPT Core runtime', {runtimePath: root});
    invariant(!expectedVersion || metadata.version === expectedVersion, 'CORE_RUNTIME_INVALID', 'The installed runtime version does not match its activation manifest', {runtimePath: root, expectedVersion, version: metadata.version});
    await access(join(root, 'src', 'server.js'));
    return {runtimePath: root, version: metadata.version};
  } catch (error) {
    if (error instanceof CoreError) throw error;
    throw new CoreError('CORE_RUNTIME_INVALID', 'The selected ChatGPT Core installation is incomplete', {runtimePath: root, cause: error.code || error.name});
  }
}

export async function resolveRuntime({runtimePath, runtimeHome = sharedRuntimeHome(),
  fallbackRoot = dirname(dirname(fileURLToPath(import.meta.url))), env = process.env} = {}) {
  const explicit = runtimePath || env.AHUST_CHATGPT_CORE_PATH;
  if (explicit) return {...await inspectRuntime(resolve(explicit)), source: 'explicit'};
  const manifestPath = join(runtimeHome, 'current.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new CoreError('CORE_RUNTIME_MANIFEST_INVALID', 'Cannot read the shared runtime activation manifest', {manifestPath, cause: error.code || error.name});
    // Existing bundled consumers retain their original startup route. A thin
    // SDK has no server here and therefore requires a shared installation.
    if (fallbackRoot) {
      try { await access(join(fallbackRoot, 'src', 'server.js')); }
      catch { throw new CoreError('CORE_RUNTIME_MISSING', 'Install the shared ChatGPT Core runtime before starting this application', {manifestPath}); }
      return {...await inspectRuntime(resolve(fallbackRoot)), source: 'legacy_bundle'};
    }
    throw new CoreError('CORE_RUNTIME_MISSING', 'No shared ChatGPT Core runtime is activated', {manifestPath});
  }
  invariant(manifest?.manifestVersion === 1 && manifest.contractVersion === '1' &&
    typeof manifest.version === 'string' && typeof manifest.runtimePath === 'string' &&
    !isAbsolute(manifest.runtimePath), 'CORE_RUNTIME_MANIFEST_INVALID', 'Unsupported shared runtime activation manifest', {manifestPath});
  const root = resolve(runtimeHome, manifest.runtimePath);
  const contained = relative(resolve(runtimeHome, 'versions'), root);
  invariant(contained && !contained.startsWith('..') && !isAbsolute(contained),
    'CORE_RUNTIME_MANIFEST_INVALID', 'The activated runtime must belong to its versions directory', {manifestPath});
  return {...await inspectRuntime(root, manifest.version), source: 'shared', manifestPath};
}
