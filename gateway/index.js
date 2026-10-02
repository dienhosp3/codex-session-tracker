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

  payloadByTraceId(traceId) {
    const event=this.trace.byTraceId(traceId);
    if(!event)return null;
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
      bodySha256:event.bodySha256||'',
      contentCapture:event.contentCapture||null
    };
  }


  createCommand(action, input={}) {
    const gatewayCommandId=String(input.gatewayCommandId||randomUUID());
    const clientUserMessageId=String(input.clientUserMessageId||randomUUID());
    const state=new DeliveryState({
      gatewayCommandId,clientUserMessageId,threadId:input.threadId,turnId:input.turnId,
      action,createdAt:Date.now()
    });
    state.add('LOCAL_CREATED',{source:'gateway',confidence:'authoritative'});
    const command={gatewayCommandId,clientUserMessageId,threadId:String(input.threadId||''),turnId:String(input.turnId||''),action,createdAt:Date.now(),state,probeMessage:String(input.message||''),rolloutFile:String(input.rolloutFile||'')};
    this.commands.set(gatewayCommandId,command);
    this.trace.append({type:'control',...state.events[0],action,threadId:command.threadId,gatewayCommandId,clientUserMessageId});
    return command;
  }

  async progress(command,event) {
    const snapshot=command.state.add(event.stage,event,event.at);
    command.turnId=snapshot.turnId||command.turnId;
    await this.trace.append({type:'control',action:command.action,gatewayCommandId:command.gatewayCommandId,clientUserMessageId:command.clientUserMessageId,threadId:command.threadId,turnId:command.turnId,...snapshot.events[snapshot.events.length-1]});
  }

  async steer(input={}) {
    const command=this.createCommand('steer',input);
    if(typeof this.handlers.steer!=='function') throw new Error('Steer handler unavailable.');
    try {
      const result=await this.handlers.steer({...input,gatewayCommandId:command.gatewayCommandId,clientUserMessageId:command.clientUserMessageId,onProgress:event=>this.progress(command,event)});
      command.turnId=String(result&&result.turnId||command.turnId||'');
      if(input.rolloutFile) {
        const evidence=await observeRolloutEvidence(input.rolloutFile,{clientUserMessageId:command.clientUserMessageId,message:input.message,afterMs:command.createdAt});
        if(evidence) await this.progress(command,{stage:'LOCAL_PERSISTED',...evidence});
      }
      return {...result,gatewayCommandId:command.gatewayCommandId,clientUserMessageId:command.clientUserMessageId,delivery:this.commandSnapshot(command)};
    } catch(error) {
      const stage=error&&error.delivery==='unknown'?'DELIVERY_UNKNOWN':error&&error.delivery==='not_sent'?'NOT_SENT':'REJECTED';
      await this.progress(command,{stage,source:'gateway-control',confidence:'authoritative',detail:String(error&&error.message||error)});
      error.gatewayCommandId=command.gatewayCommandId;
      error.clientUserMessageId=command.clientUserMessageId;
      throw error;
    }
  }

  async queue(input={}) {
    const command=this.createCommand('queue',input);
    if(typeof this.handlers.queue!=='function') throw new Error('Queue handler unavailable.');
    try {
      const result=await this.handlers.queue({...input,gatewayCommandId:command.gatewayCommandId});
      await this.progress(command,{stage:'CORE_ACCEPTED',source:'codex-queue-cli',confidence:'authoritative',detail:'Codex queue command accepted'});
      return {...result,gatewayCommandId:command.gatewayCommandId,delivery:this.commandSnapshot(command)};
    } catch(error) {
      await this.progress(command,{stage:'REJECTED',source:'codex-queue-cli',confidence:'authoritative',detail:String(error&&error.message||error)});
      throw error;
    }
  }

  async interrupt(input={}) {
    const command=this.createCommand('interrupt',input);
    if(typeof this.handlers.interrupt!=='function') {
      await this.progress(command,{stage:'NOT_SENT',source:'gateway-control',confidence:'authoritative',detail:'Interrupt transport is not verified for the installed Extension owner.'});
      return {gatewayCommandId:command.gatewayCommandId,supported:false,delivery:this.commandSnapshot(command)};
    }
    return this.handlers.interrupt({...input,gatewayCommandId:command.gatewayCommandId,onProgress:event=>this.progress(command,event)});
  }


  async refreshLocalPersistence(threadId, rolloutFile) {
    const candidates=Array.from(this.commands.values()).filter(c=>c.threadId===threadId&&c.action==='steer'&&!c.state.events.some(e=>e.stage==='LOCAL_PERSISTED')).sort((a,b)=>b.createdAt-a.createdAt).slice(0,5);
    for(const command of candidates) {
      const evidence=await observeRolloutEvidence(rolloutFile||command.rolloutFile,{clientUserMessageId:command.clientUserMessageId,message:command.probeMessage,afterMs:command.createdAt});
      if(evidence) await this.progress(command,{stage:'LOCAL_PERSISTED',...evidence});
    }
  }

  async onNetworkEvent(event) {
    const isModel=event && (event.kind==='MODEL_REQUEST'||event.kind==='MODEL_STREAM');
    if(!isModel)return;
    this.lastModelNetworkAt=Math.max(this.lastModelNetworkAt,event.at||Date.now());
    const match=correlateNetwork(Array.from(this.commands.values()),event,event.at||Date.now());
    if(match && ['UPSTREAM_REQUEST_OPENED','UPSTREAM_BYTES_SENT','UPSTREAM_RESPONSE_HEADERS','UPSTREAM_FIRST_EVENT'].includes(event.stage)) {
      await this.progress(match.command,{stage:event.stage,source:'gateway-model-proxy',confidence:match.confidence,connectionId:event.connectionId,requestId:event.requestId,detail:event.kind});
    }
    if(event.bodySha256) {
      const previous=this.networkFingerprints.get(event.bodySha256);
      if(previous && (event.at||Date.now())-previous.at>10000 && match) {
        await this.progress(match.command,{stage:'POSSIBLE_REPLAY',source:'gateway-model-proxy',confidence:'heuristic',requestId:event.requestId,detail:`same outbound model payload fingerprint observed again after ${(event.at||Date.now())-previous.at} ms`});
      }
      this.networkFingerprints.set(event.bodySha256,{at:event.at||Date.now(),requestId:event.requestId});
    }
  }

  commandSnapshot(command) {
    const snap=command.state.snapshot();
    return {...snap,diagnosis:command.state.diagnose()};
  }

  recentForThread(threadId) {
    return Array.from(this.commands.values()).filter(c=>c.threadId===threadId).sort((a,b)=>b.createdAt-a.createdAt).slice(0,10).map(c=>this.commandSnapshot(c));
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
