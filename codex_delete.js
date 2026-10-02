'use strict';

const childProcess = require('child_process');
const codexSteer = require('./codex_steer');

const DEFAULT_TIMEOUT_MS = 20_000;

// Use Codex's own thread/delete operation so its index and rollout files stay
// consistent. The caller must recheck the thread lifecycle before invoking it.
function deleteThread(options = {}) {
  const executable = String(options.executable || '').trim();
  const threadId = String(options.threadId || '').trim();
  if (!executable) return Promise.reject(new Error('Codex CLI binary is unavailable.'));
  if (!threadId) return Promise.reject(new Error('No Codex thread was selected for deletion.'));
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
  const env = { ...process.env, ...(options.env || {}) };
  if (options.codexHome) env.CODEX_HOME = options.codexHome;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = (options.spawnImpl || childProcess.spawn)(executable, ['app-server', '--stdio'], {
        env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (error) { reject(error); return; }

    let buffer = '';
    let stderr = '';
    let settled = false;
    let phase = 'initialize';
    const initialize = codexSteer.buildInitializeRequest(1);
    const request = { id: 2, method: 'thread/delete', params: { threadId } };
    const timer = setTimeout(() => finish(new Error(`Codex thread/delete timed out during ${phase}.`)), timeoutMs);

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (child.stdin && !child.stdin.destroyed) child.stdin.end(); } catch {}
      try { if (!child.killed && child.exitCode === null) child.kill(); } catch {}
      if (error) {
        if (!error.stderr && stderr.trim()) error.stderr = stderr.trim();
        reject(error);
      } else resolve(result || {});
    }

    function send(message) {
      try { child.stdin.write(`${JSON.stringify(message)}\n`); }
      catch (error) { finish(error); }
    }

    function onMessage(message) {
      if (!message || message.id === undefined || message.id === null) return;
      if (message.id === initialize.id && phase === 'initialize') {
        if (message.error) { finish(codexSteer.responseError(message)); return; }
        phase = 'delete';
        send({ method: 'initialized', params: {} });
        send(request);
      } else if (message.id === request.id && phase === 'delete') {
        if (message.error) finish(codexSteer.responseError(message));
        else finish(null, message.result);
      }
    }

    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      const parsed = codexSteer.parseLineMessages(buffer, onMessage);
      buffer = parsed.rest;
      if (buffer.length > 1024 * 1024) finish(new Error('Codex app-server sent an oversized response.'));
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
    child.on('error', error => finish(error));
    child.on('exit', (code, signal) => {
      if (!settled) finish(new Error(`Codex app-server exited before deletion completed (code ${code}, signal ${signal || 'none'}).`));
    });
    send(initialize);
  });
}

module.exports = { deleteThread };
