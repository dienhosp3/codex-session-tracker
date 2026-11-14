'use strict';

const dns = require('node:dns/promises');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs/promises');
const path = require('node:path');
const { classifyFailure } = require('./codex_failures');

function probeEndpoint(input, options = {}) {
  const url = new URL(input), started = Date.now();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Địa chỉ kiểm tra kết nối không hợp lệ.');
  return new Promise(resolve => {
    let finished = false, req, timer;
    const result = { host: url.hostname, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)), reachable: false, checkedAt: started };
    const finish = extra => {
      if (finished) return;
      finished = true; clearTimeout(timer); req?.destroy();
      resolve({ ...result, ...extra, durationMs: Date.now() - started });
    };
    timer = setTimeout(() => finish({ error: 'ETIMEDOUT' }), options.timeoutMs || 4000);
    Promise.resolve().then(() => (options.lookup || dns.lookup)(url.hostname)).then(address => {
      if (finished) return;
      result.dns = true;
      req = (url.protocol === 'https:' ? https : http).request(url, {
        method: 'GET', agent: false, headers: { 'User-Agent': 'Codex-Tracker-Connectivity/1', Connection: 'close' },
        lookup: (_host, lookupOptions, callback) => lookupOptions?.all ? callback(null, [address]) : callback(null, address.address, address.family)
      }, response => {
        // No credentials, response body, cookies or headers are retained.
        response.destroy(); finish({ reachable: true, status: response.statusCode });
      });
      req.on('error', error => finish({ error: String(error.code || 'CONNECTION_FAILED') }));
      req.end();
    }).catch(error => finish({ dns: false, error: String(error.code || 'DNS_FAILED') }));
  });
}

async function connectionTargets(codexHome) {
  let baseUrl = '';
  try {
    const config = await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8');
    const match = config.match(/^\s*openai_base_url\s*=\s*["']([^"']+)["']/m);
    if (match) baseUrl = match[1];
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let local = '', service = 'https://api.openai.com/v1/models';
  if (baseUrl) {
    const url = new URL(baseUrl);
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    url.pathname = url.pathname.replace(/\/$/, '') + '/models';
    if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) local = url.href;
    else if (url.protocol === 'https:') service = url.href;
  }
  return { local, service };
}

async function diagnoseConnection(options = {}) {
  const probe = options.probe || probeEndpoint;
  const targets = options.targets || await connectionTargets(options.codexHome);
  const [independent, service, local] = await Promise.all([
    Promise.all(['https://www.microsoft.com/', 'https://www.cloudflare.com/'].map(url => probe(url))),
    probe(targets.service), targets.local ? probe(targets.local) : null
  ]);
  let category = 'stream';
  const external = [...independent, service];
  if (external.every(result => !result.reachable)) category = external.every(result => result.dns === false) ? 'dns' : 'offline';
  else if (local && !local.reachable) category = 'proxy';
  else if (!service.reachable || service.status >= 500) category = 'upstream';
  const online = independent.some(result => result.reachable) && service.reachable && service.status < 500 && (!local || (local.reachable && local.status < 500));
  return { checkedAt: Date.now(), category, online: Boolean(online), independent, service, local };
}

// Read only error/transport columns; never select prompts, responses, accounts,
// credentials or arbitrary settings. Correlation is advisory, not permission to
// compact a chat automatically. An ambiguous time window yields no attribution.
function readRelayFailure(file, occurredAt, options = {}) {
  let DatabaseSync;
  try { DatabaseSync = options.DatabaseSync || require('node:sqlite').DatabaseSync; } catch { return null; }
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare('SELECT ts, duration_ms, error, ended_in, session_key FROM usage WHERE ts BETWEEN ? AND ? ORDER BY ts DESC LIMIT 24').all(occurredAt - 180000, occurredAt + 2000);
    const near = rows.filter(r => Math.abs(r.ts + r.duration_ms - occurredAt) <= 2000);
    if (near.length !== 1 || !near[0].session_key) return null;
    const last = near[0], result = classifyFailure(last.error);
    if (!['context', 'auth', 'quota', 'capacity'].includes(result.category)) return null;
    const matching = rows.filter(r => r.session_key === last.session_key && classifyFailure(r.error).category === result.category);
    if (matching.length < 2) return null;
    return { ...result, confidence: 'correlated', matches: matching.length,
      note: 'Lỗi relay khớp thời gian; chưa có request ID xuyên suốt. Cần xác nhận trước thao tác thay đổi chat.' };
  } catch { return null; }
  finally { db?.close(); }
}

module.exports = { probeEndpoint, connectionTargets, diagnoseConnection, readRelayFailure };
