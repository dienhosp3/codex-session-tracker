'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

class TraceStore {
  constructor(options = {}) {
    this.dir = String(options.dir || '');
    this.maxBytes = Math.max(256 * 1024, Number(options.maxBytes || 64 * 1024 * 1024));
    this.memoryLimit = Math.max(100, Number(options.memoryLimit || 2500));
    this.events = [];
    this.file = this.dir ? path.join(this.dir, 'gateway-trace.jsonl') : '';
    this.ready = false;
    this.seq = 0;
    this.writeChain = Promise.resolve();
  }

  async loadRecentFromFile() {
    if (!this.file) return;
    try {
      const stat = await fsp.stat(this.file);
      if (!stat.size) return;
      const maxRead = Math.min(stat.size, Math.max(4 * 1024 * 1024, Math.min(this.maxBytes, 8 * 1024 * 1024)));
      const start = Math.max(0, stat.size - maxRead);
      const handle = await fsp.open(this.file, 'r');
      let text = '';
      try {
        const buffer = Buffer.alloc(stat.size - start);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
        text = buffer.subarray(0, bytesRead).toString('utf8');
      } finally {
        await handle.close();
      }
      if (start > 0) {
        const firstNl = text.indexOf('\n');
        text = firstNl >= 0 ? text.slice(firstNl + 1) : '';
      }
      const parsed = [];
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try { parsed.push(JSON.parse(line)); } catch {}
      }
      this.events = parsed.slice(-this.memoryLimit);
      for (const event of this.events) this.seq = Math.max(this.seq, Number(event && event.traceId || 0));
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }

  async init() {
    if (this.ready) return;
    if (this.dir) await fsp.mkdir(this.dir, { recursive: true });
    await this.loadRecentFromFile();
    this.ready = true;
  }

  async rotateIfNeeded() {
    if (!this.file) return;
    try {
      const stat = await fsp.stat(this.file);
      if (stat.size < this.maxBytes) return;
      const rotated = path.join(this.dir, 'gateway-trace.previous.jsonl');
      await fsp.rm(rotated, { force: true });
      await fsp.rename(this.file, rotated);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }

  async append(event) {
    await this.init();
    const safe = JSON.parse(JSON.stringify(event || {}));
    if (!safe.traceId) safe.traceId = ++this.seq;
    else this.seq = Math.max(this.seq, Number(safe.traceId || 0));
    this.events.push(safe);
    if (this.events.length > this.memoryLimit) this.events.splice(0, this.events.length - this.memoryLimit);
    if (!this.file) return safe;
    this.writeChain = this.writeChain.then(async () => {
      await this.rotateIfNeeded();
      await fsp.appendFile(this.file, JSON.stringify(safe) + '\n', 'utf8');
    });
    await this.writeChain;
    return safe;
  }

  recent(limit = 200) {
    const n = Math.max(1, Math.min(this.memoryLimit, Number(limit || 200)));
    return this.events.slice(-n);
  }

  byTraceId(traceId) {
    const id = Number(traceId || 0);
    if (!id) return null;
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (Number(this.events[i] && this.events[i].traceId || 0) === id) return this.events[i];
    }
    return null;
  }
}

module.exports = { TraceStore };
