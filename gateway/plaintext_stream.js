'use strict';

const { redactHeaders, sanitizePath, sha256 } = require('./redaction');
const { classifyRequest } = require('./classifier');
const { ContentCapture } = require('./content_capture');
const { frameParser } = require('./websocket_proxy');
const PREFACE = Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n');
const MAX_HEADER = 64 * 1024;

// TLS records are not HTTP messages. Retain framing state across records and
// persist only parsed headers/body; unknown bytes may contain credentials.
class PlaintextStream {
  constructor(options = {}) {
    this.record = options.record || (() => {});
    this.capture = Boolean(options.capture);
    this.maxBytes = options.maxBytes || 16 * 1024 * 1024;
    this.connections = new Map();
  }

  close(id) {
    const conn=this.connections.get(id);
    if(conn)for(const direction of ['out','in']){
      const stream=conn[direction];
      if(stream.message?.remaining===Infinity && stream.lastBodyEvent)this.finishBody(stream,stream.lastBodyEvent);
    }
    this.connections.delete(id);
  }
  clear() { this.connections.clear(); }

  feed(event, chunk) {
    const key = event.connectionId;
    if (!this.connections.has(key)) {
      // Bound connection state even if we miss DeleteSecurityContext.
      if (this.connections.size >= 256) this.connections.delete(this.connections.keys().next().value);
      this.connections.set(key, {protocol:'', out:{buffer:Buffer.alloc(0)}, in:{buffer:Buffer.alloc(0)}, requests:[], h2Headers:new Map()});
    }
    const conn = this.connections.get(key);
    const stream = conn[event.direction];
    if (!stream || stream.unsynchronized) return;
    stream.buffer = Buffer.concat([stream.buffer, chunk]);
    if (conn.protocol === 'ws') return this.websocket(conn, stream, event);
    if(!conn.protocol && event.direction==='out' && stream.buffer.length<PREFACE.length && PREFACE.subarray(0,stream.buffer.length).equals(stream.buffer))return;
    if (!conn.protocol && stream.buffer.length >= PREFACE.length && stream.buffer.subarray(0,PREFACE.length).equals(PREFACE)) {
      conn.protocol = 'h2'; stream.buffer = stream.buffer.subarray(PREFACE.length);
    }
    if (conn.protocol === 'h2') return this.http2(conn, stream, event);
    this.http1(conn, stream, event);
  }

  base(event, extra = {}) {
    return {type:'native_plaintext', source:'native-schannel-hook', confidence:'authoritative',
      inspected:true, at:event.at, direction:event.direction, connectionId:event.connectionId,
      targetHost:event.targetHost || '', ...extra};
  }

  body(event, meta, data) {
    const stream=this.connections.get(event.connectionId)?.[event.direction];
    if(stream?.message?.capture){stream.message.capture.add(data);stream.lastBodyEvent=event;}
    const capture = new ContentCapture({enabled:this.capture,maxBytes:this.maxBytes,
      contentType:meta.contentType || 'application/octet-stream',contentEncoding:meta.contentEncoding || ''});
    capture.add(data);
    this.record(this.base(event, {...meta, stage:event.direction === 'out' ? 'PLAINTEXT_REQUEST_BODY' : 'PLAINTEXT_RESPONSE_BODY',
      size:data.length, bodySha256:sha256(data), ...(this.capture ? {contentCapture:capture.finish()} : {})}));
  }

  finishBody(stream,event) {
    const message=stream.message;
    if(message?.capture)this.record(this.base(event,{...message.meta,stage:'PLAINTEXT_HTTP_BODY_FINISHED',
      size:message.capture.totalBytes,contentCapture:message.capture.finish()}));
    stream.message=null;
  }

  http1(conn, stream, event) {
    while (stream.buffer.length) {
      if (!stream.message) {
        const end = stream.buffer.indexOf('\r\n\r\n');
        if (end < 0) {
          if (stream.buffer.length > MAX_HEADER) {stream.buffer=Buffer.alloc(0); stream.unsynchronized=true;}
          return;
        }
        const header = stream.buffer.subarray(0,end).toString('latin1');
        const lines = header.split('\r\n');
        const first = lines.shift();
        const request = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT) (\S+) HTTP\/1\.[01]$/.exec(first);
        const response = /^HTTP\/1\.[01] (\d{3})(?: |$)/.exec(first);
        if ((!request && !response) || (event.direction==='out' && !request) || (event.direction==='in' && !response)) {
          stream.buffer=Buffer.alloc(0);stream.unsynchronized=true;return;
        }
        const headers = {};
        for (const line of lines) {
          const colon = line.indexOf(':');
          if (colon > 0) headers[line.slice(0,colon).toLowerCase()] = line.slice(colon+1).trim();
        }
        stream.buffer = stream.buffer.subarray(end+4);
        let meta;
        if (request) {
          meta={method:request[1],path:sanitizePath(request[2]),requestId:event.connectionId+':'+event.sequence};
          conn.requests.push(meta);
          if (conn.requests.length>100) conn.requests.shift();
        } else {
          const statusCode = Number(response[1]);
          meta={...(conn.requests[0] || {}),statusCode};
          if (statusCode>=200 || statusCode===101) conn.requests.shift();
        }
        meta.contentType=headers['content-type'] || 'application/octet-stream';
        meta.contentEncoding=headers['content-encoding'] || '';
        meta.kind=classifyRequest({method:meta.method,path:meta.path || '',upgrade:meta.statusCode===101});
        this.record(this.base(event,{...meta,stage:'PLAINTEXT_HTTP_HEADERS',headers:redactHeaders(headers)}));
        if (meta.statusCode===101 && /^websocket$/i.test(headers.upgrade || '')) {
          conn.protocol='ws';conn.wsMeta=meta;return this.websocket(conn,stream,event);
        }
        const noBody=response && (meta.statusCode<200 || [204,304].includes(meta.statusCode) || meta.method==='HEAD');
        const chunked=/\bchunked\b/i.test(headers['transfer-encoding'] || '');
        const length=headers['content-length'];
        if (length !== undefined && !/^\d+$/.test(length)) {stream.unsynchronized=true;stream.buffer=Buffer.alloc(0);return;}
        const remaining=noBody?0:length!==undefined?Number(length):request?0:Infinity;
        if (!Number.isSafeInteger(remaining) && remaining!==Infinity) {stream.unsynchronized=true;return;}
        stream.message={meta,remaining,chunked,chunkRemaining:null,chunkEnding:false,trailer:false,
          capture:this.capture?new ContentCapture({enabled:true,maxBytes:this.maxBytes,contentType:meta.contentType,contentEncoding:meta.contentEncoding}):null};
        if (remaining===0 && !chunked) {this.finishBody(stream,event);continue;}
      }
      const m=stream.message;
      if (m.chunked) {
        if (m.trailer) {
          const end=stream.buffer.subarray(0,2).equals(Buffer.from('\r\n'))?0:stream.buffer.indexOf('\r\n\r\n');
          if (end<0) {if(stream.buffer.length>MAX_HEADER){stream.unsynchronized=true;stream.buffer=Buffer.alloc(0);}return;}
          stream.buffer=stream.buffer.subarray(end===0?2:end+4);this.finishBody(stream,event);continue;
        }
        if (m.chunkEnding) {
          if (stream.buffer.length<2)return;
          if (stream.buffer.toString('latin1',0,2)!=='\r\n') {stream.unsynchronized=true;stream.buffer=Buffer.alloc(0);return;}
          stream.buffer=stream.buffer.subarray(2);m.chunkEnding=false;m.chunkRemaining=null;
        }
        if (m.chunkRemaining===null) {
          const end=stream.buffer.indexOf('\r\n');if(end<0){if(stream.buffer.length>MAX_HEADER){stream.unsynchronized=true;stream.buffer=Buffer.alloc(0);}return;}
          const line=stream.buffer.toString('latin1',0,end).split(';')[0];
          if (!/^[0-9a-f]+$/i.test(line) || line.length>13) {stream.unsynchronized=true;stream.buffer=Buffer.alloc(0);return;}
          m.chunkRemaining=parseInt(line,16);stream.buffer=stream.buffer.subarray(end+2);
          if(m.chunkRemaining===0){m.trailer=true;continue;}
        }
        const size=Math.min(m.chunkRemaining,stream.buffer.length);if(!size)return;
        this.body(event,m.meta,stream.buffer.subarray(0,size));
        stream.buffer=stream.buffer.subarray(size);m.chunkRemaining-=size;
        if(m.chunkRemaining===0)m.chunkEnding=true;
      } else {
        const size=Math.min(m.remaining,stream.buffer.length);if(!size)return;
        this.body(event,m.meta,stream.buffer.subarray(0,size));
        stream.buffer=stream.buffer.subarray(size);m.remaining-=size;
        if(m.remaining===0)this.finishBody(stream,event);
      }
    }
  }

  headers(event) {
    let conn=this.connections.get(event.connectionId);
    if(!conn){
      this.feed({...event,sequence:0},Buffer.alloc(0));
      conn=this.connections.get(event.connectionId);
    }
    conn.protocol='h2';
    const h=event.headers || {};
    const previous=conn.h2Headers.get(event.streamId) || {};
    const meta={...previous,protocol:'h2',streamId:event.streamId,requestId:event.connectionId+':h2:'+event.streamId,
      method:h[':method'] || previous.method || '',path:h[':path'] || previous.path || '',
      targetHost:h[':authority'] || previous.targetHost || '',
      statusCode:Number(h[':status'] || 0),contentType:h['content-type'] || previous.contentType || 'application/octet-stream',
      contentEncoding:h['content-encoding'] || previous.contentEncoding || ''};
    meta.kind=classifyRequest({method:meta.method,path:meta.path});
    conn.h2Headers.set(event.streamId,meta);
    if(conn.h2Headers.size>200)conn.h2Headers.delete(conn.h2Headers.keys().next().value);
    this.record(this.base(event,{...meta,stage:'PLAINTEXT_HTTP_HEADERS',headers:h}));
  }

  http2(conn,stream,event) {
    // HPACK metadata can precede the first raw TLS record on this bridge.
    if(stream.buffer.length>=PREFACE.length && stream.buffer.subarray(0,PREFACE.length).equals(PREFACE))stream.buffer=stream.buffer.subarray(PREFACE.length);
    while (stream.buffer.length>=9) {
      const length=stream.buffer.readUIntBE(0,3);
      if(length>this.maxBytes){stream.unsynchronized=true;stream.buffer=Buffer.alloc(0);return;}
      if(stream.buffer.length<9+length)return;
      const type=stream.buffer[3],flags=stream.buffer[4],id=stream.buffer.readUInt32BE(5)&0x7fffffff;
      const frame=stream.buffer.subarray(9,9+length);
      // HPACK headers may contain authentication. Never persist their raw bytes.
      if(type===0 && id){
        const padding=(flags&8)?frame[0]:0,offset=(flags&8)?1:0;
        if(offset+padding<=frame.length)this.body(event,{kind:'UNKNOWN',requestId:event.connectionId+':h2:'+id,
          protocol:'h2',streamId:id,contentType:'application/octet-stream',...(conn.h2Headers.get(id) || {})},frame.subarray(offset,frame.length-padding));
      }
      stream.buffer=stream.buffer.subarray(9+length);
    }
  }

  websocket(conn,stream,event) {
    if(!stream.ws)stream.ws=frameParser(event.direction,frame=>this.record(this.base(stream.lastEvent,{...conn.wsMeta,
      ...frame,stage:'PLAINTEXT_WEBSOCKET_FRAME'})),{captureContent:this.capture,captureMaxBytes:this.maxBytes});
    stream.lastEvent=event;
    const data=stream.buffer;stream.buffer=Buffer.alloc(0);stream.ws(data);
  }
}

module.exports = { PlaintextStream };
