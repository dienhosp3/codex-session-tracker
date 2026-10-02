'use strict';

const { randomUUID } = require('crypto');
const { DeliveryState } = require('./state_machine');
const { TraceStore } = require('./trace_store');
const { GatewayServer } = require('./server');
const { observeRolloutEvidence, correlateNetwork } = require('./correlation');

class CodexGateway {
  constructor(options = {}) {
    this.version=String(options.version||'dev');
    this.trace=new TraceStore({dir:options.traceDir,maxBytes:options.traceMaxBytes,memoryLimit:options.traceMemoryLimit});
    this.commands=new Map();
    this.networkFingerprints=new Map();
    this.lastModelNetworkAt=0;
    this.handlers=options.handlers||{};
    this.server=new GatewayServer({
      port:options.port,
      version:this.version,
      trace:this.trace,
      modelProxyEnabled:Boolean(options.modelProxyEnabled),
      upstreamBaseUrl:options.upstreamBaseUrl,
      captureContent:Boolean(options.captureContent),
      captureMaxBytes:options.captureMaxBytes,
      diagnostics:()=>this.diagnostics(),
      onNetworkEvent:event=>this.onNetworkEvent(event),
      handlers:{
        steer:body=>this.steer(body),
        queue:body=>this.queue(body),
        interrupt:body=>this.interrupt(body)
      }
    });
  }

  async start(){
    await this.trace.init();
    this.seedFromTrace();
    return this.server.start();
  }
  async stop(){ return this.server.stop(); }
  seedFromTrace() {
    this.lastModelNetworkAt=0;
    this.networkFingerprints.clear();
    for(const event of this.trace.recent(this.trace.memoryLimit)) {
      const isModel=event && (event.kind==='MODEL_REQUEST'||event.kind==='MODEL_STREAM');
      if(!isModel)continue;
      this.lastModelNetworkAt=Math.max(this.lastModelNetworkAt,Number(event.at||0));
      if(event.bodySha256) this.networkFingerprints.set(event.bodySha256,{at:Number(event.at||0),requestId:event.requestId||'',connectionId:event.connectionId||''});
    }
  }

  trafficIndex(limit=80) {
    return this.trace.recent(Math.max(20,Math.min(250,Number(limit||80))))
      .filter(event=>event && ['http_upstream','ws_connection','ws_frame','gateway_error','ws_upgrade_rejected'].includes(event.type))
      .map(event=>({
        traceId:event.traceId,
        type:event.type,
        stage:event.stage||'',
        at:event.at||0,
        kind:event.kind||'',
        method:event.method||'',
        path:event.path||'',
        requestId:event.requestId||'',
        connectionId:event.connectionId||'',
        statusCode:event.statusCode||0,
        direction:event.direction||'',
        opcode:event.opcode,
        size:event.size||0,
        requestBytes:event.requestBytes||0,
        responseBytes:event.responseBytes||0,
        totalMs:event.totalMs||0,
        bodySha256:event.bodySha256||'',
        error:event.error||'',
        hasContent:Boolean(event.contentCapture),
        capturedBytes:event.contentCapture&&event.contentCapture.capturedBytes||0,
        totalContentBytes:event.contentCapture&&event.contentCapture.totalBytes||0,
        truncated:Boolean(event.contentCapture&&event.contentCapture.truncated),
        encoding:event.contentCapture&&event.contentCapture.encoding||''
      }));
  }

  payloadByTraceId(traceId, options = {}) {
    const event=this.trace.byTraceId(traceId);
    if(!event)return null;
    const content=event.contentCapture&&typeof event.contentCapture.content==='string'
      ? event.contentCapture.content
      : '';
    const offset=Math.max(0,Number(options.offset||0));
    const limit=Math.max(4096,Math.min(1024*1024,Number(options.limit||512*1024)));
    const chunk=content.slice(offset,offset+limit);
    const nextOffset=offset+chunk.length;
    const capture=event.contentCapture?{
      ...event.contentCapture,
      content:chunk,
      contentLengthChars:content.length,
      offset,
      nextOffset,
      complete:nextOffset>=content.length
    }:null;
    return {
      traceId:event.traceId,
      type:event.type,
      stage:event.stage||'',
      at:event.at||0,
      kind:event.kind||'',
      method:event.method||'',
      path:event.path||'',
      requestId:event.requestId||'',
      connectionId:event.connectionId||'',
      direction:event.direction||'',
      opcode:event.opcode,
      statusCode:event.statusCode||0,
      headers:event.headers||null,
      bodySha256:event.bodySha256||'',
      contentCapture:capture
    };
  }

  exportSnapshot(extra = {}) {
    const allowed = new Set([
      'type','stage','at','kind','method','path','requestId','connectionId',
      'statusCode','requestBytes','responseBytes','totalMs','bodySha256',
      'direction','opcode','size','wireBytes','oversized','error','elapsedMs',
      'frameSize','confidence','source','detail','classification'
    ]);
    const events=this.trace.recent(2000).map(event=>{
      const out={};
      for(const [key,value] of Object.entries(event||{})) {
        if(allowed.has(key) && value !== undefined) out[key]=value;
      }
      return out;
    });
    return {
      schemaVersion:1,
      generatedAt:new Date().toISOString(),
      gatewayVersion:this.version,
      ...extra,
      diagnostics:this.diagnostics(),
      events
    };
  }

  diagnostics() {
    return {
      modelProxyConfigured:this.server.modelProxyEnabled,
      modelProxyReady:Boolean(this.server.modelProxyEnabled&&this.server.upstreamBaseUrl),
      modelTrafficObserved:Boolean(this.lastModelNetworkAt),
      lastModelNetworkAt:this.lastModelNetworkAt,
      websocketProxyReady:Boolean(this.server.modelProxyEnabled&&this.server.upstreamBaseUrl),
      captureContent:Boolean(this.server.captureContent),
      captureMaxBytes:Number(this.server.captureMaxBytes||0),
      recentCommands:Array.from(this.commands.values()).sort((a,b)=>b.createdAt-a.createdAt).slice(0,20).map(c=>this.commandSnapshot(c))
    };
  }
}

module.exports={CodexGateway};
