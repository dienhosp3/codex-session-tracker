'use strict';

// Preloaded only by test.ps1. Use mkdir with inherited ACLs, not a private
// temporary-directory DACL. Applies to existing tests as well as new tests.
if (process.platform === 'win32') {
  const fs = require('node:fs');
  const path = require('node:path');
  const { randomUUID } = require('node:crypto');
  const { execFileSync } = require('node:child_process');
  const root = path.resolve(process.env.TEMP || '');
  if (!/[\\/]AHUST-Work[\\/]codex-session-tracker[\\/]test-[a-f0-9]+$/i.test(root)) {
    throw new Error('Run Windows tests with scripts/test.ps1 so ordinary-user scratch access is verified first.');
  }
  function create(prefix, options) {
    const directory = path.resolve(String(prefix) + randomUUID());
    if (!directory.toLowerCase().startsWith(root.toLowerCase() + path.sep)) throw new Error('Test scratch outside the verified root.');
    fs.mkdirSync(directory);
    try {
      execFileSync('icacls.exe', [directory, '/inheritance:e', '/grant:r', '*S-1-5-21-1313641305-1280216474-2821017480-1001:(OI)(CI)F'], { windowsHide: true, stdio: 'pipe' });
      const probe = path.join(directory, 'acl-probe');
      fs.mkdirSync(probe);
      try {
        const file = path.join(probe, 'file');
        fs.writeFileSync(file, 'read');
        if (fs.readFileSync(file, 'utf8') !== 'read') throw new Error('Scratch read probe failed.');
        fs.appendFileSync(file, '-edit');
        if (fs.readFileSync(file, 'utf8') !== 'read-edit') throw new Error('Scratch edit probe failed.');
        fs.renameSync(file, file + '-renamed');
        fs.unlinkSync(file + '-renamed');
      } finally { fs.rmdirSync(probe); }
      return options === 'buffer' || options?.encoding === 'buffer' ? Buffer.from(directory) : directory;
    } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
  }
  fs.mkdtempSync = create;
  fs.promises.mkdtemp = async (prefix, options) => create(prefix, options);
  fs.mkdtemp = (prefix, options, callback) => {
    if (typeof options === 'function') { callback = options; options = undefined; }
    try { const value = create(prefix, options); queueMicrotask(() => callback(null, value)); }
    catch (error) { queueMicrotask(() => callback(error)); }
  };
}

require('node:module').syncBuiltinESMExports();
