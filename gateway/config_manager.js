'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function codexConfigPath(codexHome) {
  return path.join(String(codexHome || ''), 'config.toml');
}

function metadataFile(storageDir) {
  return path.join(String(storageDir || ''), 'managed-codex-config.json');
}

function newlineOf(text) {
  return String(text || '').includes('\r\n') ? '\r\n' : '\n';
}

function rootRegionEnd(text) {
  const lines = String(text || '').split(/(?<=\n)/);
  let offset = 0;
  for (const line of lines) {
    if (/^[\uFEFF\s]*\[[^\]]+\]\s*(?:#.*)?(?:\r?\n)?$/.test(line)) return offset;
    offset += line.length;
  }
  return String(text || '').length;
}

function findRootAssignment(text, key) {
  const source = String(text || '');
  const end = rootRegionEnd(source);
  const prefix = source.slice(0, end);
  const escaped = String(key).replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  const re = new RegExp('^[\\uFEFF \\t]*' + escaped + '[ \\t]*=.*
  const match = re.exec(prefix);
  if (!match) return null;
  return {
    start: match.index,
    end: match.index + match[0].length,
    line: match[0]
  };
}

function setRootString(text, key, value) {
  const source = String(text || '');
  const nl = newlineOf(source);
  const line = key + ' = ' + JSON.stringify(String(value || ''));
  const found = findRootAssignment(source, key);
  if (found) return source.slice(0, found.start) + line + source.slice(found.end);

  const end = rootRegionEnd(source);
  const before = source.slice(0, end);
  const after = source.slice(end);
  const spacer = before && !before.endsWith('\n') ? nl : '';
  return before + spacer + line + nl + after;
}

function restoreRootAssignment(currentText, key, originalLine) {
  const source = String(currentText || '');
  const found = findRootAssignment(source, key);
  if (originalLine) {
    if (found) return source.slice(0, found.start) + originalLine + source.slice(found.end);
    const end = rootRegionEnd(source);
    const nl = newlineOf(source);
    const before = source.slice(0, end);
    const after = source.slice(end);
    return before + (before && !before.endsWith('\n') ? nl : '') + originalLine + nl + after;
  }
  if (!found) return source;
  let start = found.start;
  let end = found.end;
  if (source.slice(end, end + 2) === '\r\n') end += 2;
  else if (source[end] === '\n') end += 1;
  else if (start > 0 && source.slice(start - 2, start) === '\r\n') start -= 2;
  else if (start > 0 && source[start - 1] === '\n') start -= 1;
  return source.slice(0, start) + source.slice(end);
}

async function readText(file) {
  try {
    return { exists: true, text: await fsp.readFile(file, 'utf8') };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { exists: false, text: '' };
    throw error;
  }
}

async function atomicWrite(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.codex-tracker-' + process.pid + '-' + Date.now() + '.tmp';
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, file);
}

async function readMetadata(storageDir) {
  try {
    return JSON.parse(await fsp.readFile(metadataFile(storageDir), 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeMetadata(storageDir, metadata) {
  await fsp.mkdir(storageDir, { recursive: true });
  await atomicWrite(metadataFile(storageDir), JSON.stringify(metadata, null, 2) + '\n');
}

async function getManagedState(codexHome, storageDir) {
  const file = codexConfigPath(codexHome);
  const current = await readText(file);
  const metadata = await readMetadata(storageDir);
  const currentHash = sha256Text(current.text);
  const relevant = metadata && metadata.configPath === file ? metadata : null;
  return {
    configPath: file,
    configExists: current.exists,
    currentHash,
    active: Boolean(relevant && relevant.active),
    managed: Boolean(relevant && relevant.active && relevant.managedHash === currentHash),
    drifted: Boolean(relevant && relevant.active && relevant.managedHash && relevant.managedHash !== currentHash),
    originalHash: relevant && relevant.originalHash || '',
    originalRootLine: relevant && relevant.originalRootLine || '',
    managedHash: relevant && relevant.managedHash || '',
    appliedAt: relevant && relevant.appliedAt || '',
    revertedAt: relevant && relevant.revertedAt || '',
    managedBaseUrl: relevant && relevant.managedBaseUrl || '',
    backupFile: relevant && relevant.backupFile || '',
    originalTrackerSettings: relevant && relevant.originalTrackerSettings || null
  };
}

async function applyManagedConfig(options = {}) {
  const codexHome = String(options.codexHome || '');
  const storageDir = String(options.storageDir || '');
  const baseUrl = String(options.baseUrl || '').trim();
  if (!codexHome || !storageDir || !baseUrl) throw new Error('codexHome, storageDir and baseUrl are required.');

  const file = codexConfigPath(codexHome);
  const current = await readText(file);
  let metadata = await readMetadata(storageDir);
  const sameActive = metadata && metadata.active && metadata.configPath === file;

  if (!sameActive) {
    await fsp.mkdir(storageDir, { recursive: true });
    const backupFile = path.join(storageDir, 'config-original-' + Date.now() + '.toml');
    if (current.exists) await fsp.writeFile(backupFile, current.text, 'utf8');
    metadata = {
      schemaVersion: 1,
      configPath: file,
      originalExisted: current.exists,
      originalHash: sha256Text(current.text),
      originalRootLine: (findRootAssignment(current.text, 'chatgpt_base_url') || {}).line || '',
      backupFile: current.exists ? backupFile : '',
      originalTrackerSettings: options.originalTrackerSettings || null,
      appliedAt: new Date().toISOString()
    };
  }

  const managedText = setRootString(current.text, 'chatgpt_base_url', baseUrl);
  await atomicWrite(file, managedText);
  metadata.active = true;
  metadata.managedBaseUrl = baseUrl;
  metadata.managedHash = sha256Text(managedText);
  metadata.lastAppliedAt = new Date().toISOString();
  await writeMetadata(storageDir, metadata);
  return getManagedState(codexHome, storageDir);
}

async function revertManagedConfig(options = {}) {
  const codexHome = String(options.codexHome || '');
  const storageDir = String(options.storageDir || '');
  const forceExact = Boolean(options.forceExact);
  const file = codexConfigPath(codexHome);
  const metadata = await readMetadata(storageDir);
  if (!metadata || metadata.configPath !== file) {
    return { ...(await getManagedState(codexHome, storageDir)), reverted: false, reason: 'no-managed-config' };
  }

  const current = await readText(file);
  const currentHash = sha256Text(current.text);
  const safeExact = metadata.managedHash && currentHash === metadata.managedHash;
  let mode = 'merge';

  if (forceExact || safeExact) {
    mode = 'exact';
    if (metadata.originalExisted) {
      const original = metadata.backupFile ? await fsp.readFile(metadata.backupFile, 'utf8') : '';
      await atomicWrite(file, original);
    } else {
      try { await fsp.rm(file, { force: true }); } catch {}
    }
  } else {
    const restored = restoreRootAssignment(current.text, 'chatgpt_base_url', metadata.originalRootLine || '');
    await atomicWrite(file, restored);
  }

  metadata.active = false;
  metadata.revertedAt = new Date().toISOString();
  metadata.revertMode = mode;
  await writeMetadata(storageDir, metadata);
  return { ...(await getManagedState(codexHome, storageDir)), reverted: true, mode, originalTrackerSettings: metadata.originalTrackerSettings || null };
}

module.exports = {
  sha256Text,
  codexConfigPath,
  findRootAssignment,
  setRootString,
  restoreRootAssignment,
  getManagedState,
  applyManagedConfig,
  revertManagedConfig
};
, 'm');
  const match = re.exec(prefix);
  if (!match) return null;
  return {
    start: match.index,
    end: match.index + match[0].length,
    line: match[0]
  };
}

function setRootString(text, key, value) {
  const source = String(text || '');
  const nl = newlineOf(source);
  const line = key + ' = ' + JSON.stringify(String(value || ''));
  const found = findRootAssignment(source, key);
  if (found) return source.slice(0, found.start) + line + source.slice(found.end);

  const end = rootRegionEnd(source);
  const before = source.slice(0, end);
  const after = source.slice(end);
  const spacer = before && !before.endsWith('\n') ? nl : '';
  return before + spacer + line + nl + after;
}

function restoreRootAssignment(currentText, key, originalLine) {
  const source = String(currentText || '');
  const found = findRootAssignment(source, key);
  if (originalLine) {
    if (found) return source.slice(0, found.start) + originalLine + source.slice(found.end);
    const end = rootRegionEnd(source);
    const nl = newlineOf(source);
    const before = source.slice(0, end);
    const after = source.slice(end);
    return before + (before && !before.endsWith('\n') ? nl : '') + originalLine + nl + after;
  }
  if (!found) return source;
  let start = found.start;
  let end = found.end;
  if (source.slice(end, end + 2) === '\r\n') end += 2;
  else if (source[end] === '\n') end += 1;
  else if (start > 0 && source.slice(start - 2, start) === '\r\n') start -= 2;
  else if (start > 0 && source[start - 1] === '\n') start -= 1;
  return source.slice(0, start) + source.slice(end);
}

async function readText(file) {
  try {
    return { exists: true, text: await fsp.readFile(file, 'utf8') };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { exists: false, text: '' };
    throw error;
  }
}

async function atomicWrite(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.codex-tracker-' + process.pid + '-' + Date.now() + '.tmp';
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, file);
}

async function readMetadata(storageDir) {
  try {
    return JSON.parse(await fsp.readFile(metadataFile(storageDir), 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeMetadata(storageDir, metadata) {
  await fsp.mkdir(storageDir, { recursive: true });
  await atomicWrite(metadataFile(storageDir), JSON.stringify(metadata, null, 2) + '\n');
}

async function getManagedState(codexHome, storageDir) {
  const file = codexConfigPath(codexHome);
  const current = await readText(file);
  const metadata = await readMetadata(storageDir);
  const currentHash = sha256Text(current.text);
  const relevant = metadata && metadata.configPath === file ? metadata : null;
  return {
    configPath: file,
    configExists: current.exists,
    currentHash,
    active: Boolean(relevant && relevant.active),
    managed: Boolean(relevant && relevant.active && relevant.managedHash === currentHash),
    drifted: Boolean(relevant && relevant.active && relevant.managedHash && relevant.managedHash !== currentHash),
    originalHash: relevant && relevant.originalHash || '',
    originalRootLine: relevant && relevant.originalRootLine || '',
    managedHash: relevant && relevant.managedHash || '',
    appliedAt: relevant && relevant.appliedAt || '',
    revertedAt: relevant && relevant.revertedAt || '',
    managedBaseUrl: relevant && relevant.managedBaseUrl || '',
    backupFile: relevant && relevant.backupFile || '',
    originalTrackerSettings: relevant && relevant.originalTrackerSettings || null
  };
}

async function applyManagedConfig(options = {}) {
  const codexHome = String(options.codexHome || '');
  const storageDir = String(options.storageDir || '');
  const baseUrl = String(options.baseUrl || '').trim();
  if (!codexHome || !storageDir || !baseUrl) throw new Error('codexHome, storageDir and baseUrl are required.');

  const file = codexConfigPath(codexHome);
  const current = await readText(file);
  let metadata = await readMetadata(storageDir);
  const sameActive = metadata && metadata.active && metadata.configPath === file;

  if (!sameActive) {
    await fsp.mkdir(storageDir, { recursive: true });
    const backupFile = path.join(storageDir, 'config-original-' + Date.now() + '.toml');
    if (current.exists) await fsp.writeFile(backupFile, current.text, 'utf8');
    metadata = {
      schemaVersion: 1,
      configPath: file,
      originalExisted: current.exists,
      originalHash: sha256Text(current.text),
      originalRootLine: (findRootAssignment(current.text, 'chatgpt_base_url') || {}).line || '',
      backupFile: current.exists ? backupFile : '',
      originalTrackerSettings: options.originalTrackerSettings || null,
      appliedAt: new Date().toISOString()
    };
  }

  const managedText = setRootString(current.text, 'chatgpt_base_url', baseUrl);
  await atomicWrite(file, managedText);
  metadata.active = true;
  metadata.managedBaseUrl = baseUrl;
  metadata.managedHash = sha256Text(managedText);
  metadata.lastAppliedAt = new Date().toISOString();
  await writeMetadata(storageDir, metadata);
  return getManagedState(codexHome, storageDir);
}

async function revertManagedConfig(options = {}) {
  const codexHome = String(options.codexHome || '');
  const storageDir = String(options.storageDir || '');
  const forceExact = Boolean(options.forceExact);
  const file = codexConfigPath(codexHome);
  const metadata = await readMetadata(storageDir);
  if (!metadata || metadata.configPath !== file) {
    return { ...(await getManagedState(codexHome, storageDir)), reverted: false, reason: 'no-managed-config' };
  }

  const current = await readText(file);
  const currentHash = sha256Text(current.text);
  const safeExact = metadata.managedHash && currentHash === metadata.managedHash;
  let mode = 'merge';

  if (forceExact || safeExact) {
    mode = 'exact';
    if (metadata.originalExisted) {
      const original = metadata.backupFile ? await fsp.readFile(metadata.backupFile, 'utf8') : '';
      await atomicWrite(file, original);
    } else {
      try { await fsp.rm(file, { force: true }); } catch {}
    }
  } else {
    const restored = restoreRootAssignment(current.text, 'chatgpt_base_url', metadata.originalRootLine || '');
    await atomicWrite(file, restored);
  }

  metadata.active = false;
  metadata.revertedAt = new Date().toISOString();
  metadata.revertMode = mode;
  await writeMetadata(storageDir, metadata);
  return { ...(await getManagedState(codexHome, storageDir)), reverted: true, mode, originalTrackerSettings: metadata.originalTrackerSettings || null };
}

module.exports = {
  sha256Text,
  codexConfigPath,
  findRootAssignment,
  setRootString,
  restoreRootAssignment,
  getManagedState,
  applyManagedConfig,
  revertManagedConfig
};
