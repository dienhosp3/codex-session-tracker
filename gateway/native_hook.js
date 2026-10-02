'use strict';

// Executed inside the target process by Frida. No disk/network I/O and no
// synchronous calls back to the UI from a TLS callback.
const contexts = new Map();
let sequence = 0;
let capture = false;
let rules = [];
const listeners = [];
const MAX_RECORD = 1024 * 1024;

function contextKey(handle) {
  return handle.readPointer().toString() + ':' + handle.add(Process.pointerSize).readPointer().toString();
}

function buffers(desc) {
  if (desc.isNull()) return [];
  const count = desc.add(4).readU32();
  if (count > 64) return [];
  const list = desc.add(8).readPointer();
  const stride = Process.pointerSize === 8 ? 16 : 12;
  const output = [];
  for (let i = 0; i < count; i++) {
    const item = list.add(i * stride);
    const length = item.readU32();
    const type = item.add(4).readU32() & 0x0fffffff;
    const data = item.add(8).readPointer();
    if (type === 1 && length > 0 && length <= MAX_RECORD && !data.isNull()) output.push({data, length});
  }
  return output;
}

function emit(direction, key, desc, stage, status) {
  for (const item of buffers(desc)) {
    const bytes = item.data.readByteArray(item.length);
    send({type:'plaintext', direction, connectionId:key, targetHost:contexts.get(key) || '',
      sequence:++sequence, stage, status, at:Date.now(), size:item.length}, capture ? bytes : null);
  }
}

function attach(module, name, callbacks) {
  const address = module.findExportByName(name);
  if (!address) throw new Error('Missing TLS export: ' + name);
  listeners.push(Interceptor.attach(address, callbacks));
}

function install() {
  const module = Process.getModuleByName('secur32.dll');
  attach(module, 'InitializeSecurityContextW', {
    onEnter(args) {
      this.output = args[8];
      this.host = args[2].isNull() ? '' : args[2].readUtf16String();
    },
    onLeave(result) {
      const status = result.toUInt32();
      if ((status === 0 || status === 0x90312) && !this.output.isNull() && this.host) {
        contexts.set(contextKey(this.output), this.host);
      }
    }
  });
  attach(module, 'EncryptMessage', {
    onEnter(args) {
      this.key = contextKey(args[0]);
      this.desc = args[2];
      // Transform rules are deliberately identity until supplied by the user.
      // A TLS record is already HTTP-framed. Replacements must preserve length.
      for (const item of buffers(this.desc)) {
        const data = new Uint8Array(item.data.readByteArray(item.length));
        let changed = false;
        for (const rule of rules) {
          if (rule.host !== contexts.get(this.key)) continue;
          for (let i = 0; i <= data.length - rule.find.length; i++) {
            if (!rule.find.every((v, j) => data[i + j] === v)) continue;
            data.set(rule.replace, i); changed = true; i += rule.find.length - 1;
          }
        }
        if (changed) {
          const original=item.data.readByteArray(item.length);
          item.data.writeByteArray(data);
          send({type:'mutation',stage:'PLAINTEXT_OUTBOUND_MODIFIED',connectionId:this.key,
            targetHost:contexts.get(this.key) || '',at:Date.now(),size:item.length,
            originalSha256:Checksum.compute('sha256',original),bodySha256:Checksum.compute('sha256',data.buffer)});
        }
      }
      // This is an attempt before encryption, never evidence of server receipt.
      emit('out', this.key, this.desc, 'PLAINTEXT_BEFORE_TLS');
    },
    onLeave(result) {
      if (result.toInt32() !== 0) send({type:'tls_error', direction:'out', stage:'TLS_ENCRYPT_FAILED', status:result.toUInt32(), at:Date.now()});
    }
  });
  attach(module, 'DecryptMessage', {
    onEnter(args) { this.key = contextKey(args[0]); this.desc = args[1]; },
    onLeave(result) {
      const status = result.toUInt32();
      if (status === 0 || status === 0x90321) emit('in', this.key, this.desc, 'PLAINTEXT_AFTER_TLS', status);
    }
  });
  attach(module, 'DeleteSecurityContext', {
    onEnter(args) { this.key = contextKey(args[0]); },
    onLeave() {
      contexts.delete(this.key);
      send({type:'context_closed', connectionId:this.key, at:Date.now()});
    }
  });
  send({type:'ready', backend:'schannel', hooks:['EncryptMessage','DecryptMessage'], at:Date.now()});
}

rpc.exports = {
  identity() { return Process.mainModule.path; },
  configure(options) {
    capture = Boolean(options.capture);
    const next = options.rules || [];
    if (next.length > 32) throw new Error('At most 32 rules.');
    for (const rule of next) {
      if (!rule.host || !Array.isArray(rule.find) || !Array.isArray(rule.replace) || !rule.find.length || rule.find.length !== rule.replace.length) throw new Error('Rules require a host and equal-length byte arrays.');
      if (rule.find.length > 4096 || [...rule.find,...rule.replace].some(v => !Number.isInteger(v) || v < 0 || v > 255)) throw new Error('Invalid rule bytes.');
    }
    rules = next;
  }
};

install();
