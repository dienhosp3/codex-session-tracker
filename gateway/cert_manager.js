'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const tls = require('tls');

function encodePowerShell(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

function runPowerShell(script, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(script)],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error('PowerShell certificate operation timed out.'));
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error((stderr || stdout || ('PowerShell exited with ' + code)).trim()));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function derToPem(der) {
  const body = Buffer.from(der).toString('base64').match(/.{1,64}/g)?.join('\n') || '';
  return '-----BEGIN CERTIFICATE-----\n' + body + '\n-----END CERTIFICATE-----\n';
}

function safeHost(value) {
  const host = String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host.length > 253) throw new Error('Invalid CONNECT host.');
  if (!/^[a-z0-9.-]+$/.test(host) || host.includes('..') || host.startsWith('.') || host.endsWith('.')) {
    throw new Error('Unsupported CONNECT host for TLS inspection: ' + host);
  }
  return host;
}

function safePsLiteral(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

class MitmCertificateManager {
  constructor(options = {}) {
    this.dir = String(options.dir || '');
    this.metaFile = path.join(this.dir, 'mitm-ca.json');
    this.rootDerFile = path.join(this.dir, 'mitm-root.cer');
    this.rootPemFile = path.join(this.dir, 'mitm-root.pem');
    this.leafDir = path.join(this.dir, 'leaf');
    this.meta = null;
    this.contexts = new Map();
    this.leafOptions = new Map();
    this.pending = new Map();
  }

  async init() {
    await fsp.mkdir(this.leafDir, { recursive: true });
    try {
      this.meta = JSON.parse(await fsp.readFile(this.metaFile, 'utf8'));
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }

    if (!this.meta || !this.meta.thumbprint || !(await this.rootPemExists())) {
      await this.createRoot();
    }
    return this.info();
  }

  async rootPemExists() {
    try {
      await fsp.access(this.rootPemFile);
      return true;
    } catch {
      return false;
    }
  }

  info() {
    return {
      rootPemFile: this.rootPemFile,
      thumbprint: this.meta && this.meta.thumbprint || '',
      createdAt: this.meta && this.meta.createdAt || ''
    };
  }

  async createRoot() {
    await fsp.mkdir(this.dir, { recursive: true });
    const subject = 'CN=Codex Session Tracker Local MITM Root';
    const script = [
      "$ErrorActionPreference='Stop'",
      "$cert=New-SelfSignedCertificate -Type Custom -Subject " + safePsLiteral(subject)
        + " -CertStoreLocation 'Cert:\\CurrentUser\\My' -KeyAlgorithm RSA -KeyLength 2048"
        + " -HashAlgorithm SHA256 -KeyExportPolicy Exportable -KeyUsage CertSign,CRLSign,DigitalSignature"
        + " -TextExtension @('2.5.29.19={critical}{text}ca=1&pathlength=1')"
        + " -NotAfter (Get-Date).AddYears(2)",
      "Export-Certificate -Cert $cert -FilePath " + safePsLiteral(this.rootDerFile) + " -Force | Out-Null",
      "Write-Output $cert.Thumbprint"
    ].join(';');
    const thumbprint = (await runPowerShell(script)).split(/\r?\n/).filter(Boolean).pop().trim();
    if (!/^[A-F0-9]{40,}$/i.test(thumbprint)) throw new Error('Failed to create local MITM root certificate.');
    const der = await fsp.readFile(this.rootDerFile);
    await fsp.writeFile(this.rootPemFile, derToPem(der), 'utf8');
    this.meta = {
      schemaVersion: 1,
      thumbprint,
      createdAt: new Date().toISOString()
    };
    await fsp.writeFile(this.metaFile, JSON.stringify(this.meta, null, 2) + '\n', 'utf8');
    return this.info();
  }

  leafPaths(host) {
    const id = crypto.createHash('sha256').update(host).digest('hex').slice(0, 24);
    return {
      pfx: path.join(this.leafDir, id + '.pfx'),
      meta: path.join(this.leafDir, id + '.json')
    };
  }

  async tlsOptionsForHost(value) {
    const host = safeHost(value);
    if (this.leafOptions.has(host)) return this.leafOptions.get(host);
    if (this.pending.has(host)) return this.pending.get(host);
    const pending = this.loadOrCreateLeaf(host).finally(() => this.pending.delete(host));
    this.pending.set(host, pending);
    const options = await pending;
    this.leafOptions.set(host, options);
    return options;
  }

  async secureContextForHost(value) {
    const host = safeHost(value);
    if (this.contexts.has(host)) return this.contexts.get(host);
    const options = await this.tlsOptionsForHost(host);
    const context = tls.createSecureContext({ pfx: options.pfx, passphrase: options.passphrase, minVersion: 'TLSv1.2' });
    this.contexts.set(host, context);
    return context;
  }

  async loadOrCreateLeaf(host) {
    await this.init();
    const paths = this.leafPaths(host);
    let meta = null;
    try { meta = JSON.parse(await fsp.readFile(paths.meta, 'utf8')); } catch {}
    if (!meta || meta.host !== host || !(await this.fileExists(paths.pfx))) {
      meta = await this.createLeaf(host, paths);
    }
    const pfx = await fsp.readFile(paths.pfx);
    return { pfx, passphrase: meta.password, host };
  }

  async fileExists(file) {
    try { await fsp.access(file); return true; } catch { return false; }
  }

  async createLeaf(host, paths) {
    const password = crypto.randomBytes(24).toString('base64url');
    const thumbprint = this.meta && this.meta.thumbprint;
    if (!thumbprint) throw new Error('MITM root certificate is unavailable.');
    const script = [
      "$ErrorActionPreference='Stop'",
      "$root=Get-Item " + safePsLiteral('Cert:\\CurrentUser\\My\\' + thumbprint),
      "$leaf=New-SelfSignedCertificate -Type Custom -Subject " + safePsLiteral('CN=' + host)
        + " -DnsName " + safePsLiteral(host)
        + " -Signer $root -CertStoreLocation 'Cert:\\CurrentUser\\My'"
        + " -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy Exportable"
        + " -KeyUsage DigitalSignature,KeyEncipherment"
        + " -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.1')"
        + " -NotAfter (Get-Date).AddDays(90)",
      "$pw=ConvertTo-SecureString -String " + safePsLiteral(password) + " -AsPlainText -Force",
      "Export-PfxCertificate -Cert $leaf -FilePath " + safePsLiteral(paths.pfx) + " -Password $pw -Force | Out-Null",
      "Remove-Item ('Cert:\\CurrentUser\\My\\' + $leaf.Thumbprint) -Force"
    ].join(';');
    await runPowerShell(script, 45000);
    const meta = { host, password, createdAt: new Date().toISOString() };
    await fsp.writeFile(paths.meta, JSON.stringify(meta), 'utf8');
    return meta;
  }

  async removeRootFromStore() {
    if (!this.meta || !this.meta.thumbprint) return;
    const script = [
      "$ErrorActionPreference='SilentlyContinue'",
      "$p=" + safePsLiteral('Cert:\\CurrentUser\\My\\' + this.meta.thumbprint),
      "if(Test-Path $p){Remove-Item $p -Force}"
    ].join(';');
    await runPowerShell(script).catch(() => {});
  }
}

module.exports = {
  MitmCertificateManager,
  runPowerShell,
  safeHost,
  derToPem
};
