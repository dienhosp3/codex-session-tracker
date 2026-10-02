'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

class TraceStore {
  constructor(options = {}) {
    this.dir = String(options.dir || '');
    this.maxBytes = Math.max(256 * 1024, Number(options.maxBytes || 8 * 1024 * 1024));
    this.memoryLimit = Math.max(100, Number(options.memoryLimit || 2000));
    this.events = [];
    this.file = this.dir ? path.join(this.dir, 'gateway-trace.jsonl') : '';
    this.ready = false;
  }

  async init() {
    if (this.ready) return;
    if (this.dir) await fsp.mkdir(this.dir, { recursive: true });
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
    const safe = JSON.parse(JSON.stringify(event || {}));
    this.events.push(safe);
    if (this.events.length > this.memoryLimit) this.events.splice(0, this.events.length - this.memoryLimit);
    if (!this.file) return;
    await this.init();
    await this.rotateIfNeeded();
    await fsp.appendFile(this.file, JSON.stringify(safe) + '\n', 'utf8');
  }

  recent(limit = 200) {
    const n = Math.max(1, Math.min(2000, Number(limit || 200)));
    return this.events.slice(-n);
  }
}

module.exports = { TraceStore };
