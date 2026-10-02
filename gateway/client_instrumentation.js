'use strict';
const {JsonFilters}=require('./json_filters');
const {ResponseEvents}=require('./response_events');
const {classifyRequest}=require('./classifier');
const {sanitizePath,redactHeaders}=require('./redaction');
const {ContentCapture}=require('./content_capture');

class ClientInstrumentation{
  constructor(options={}){
    this.record=options.record||(()=>{});this.maxBytes=64*1024*1024;
    this.filters=new JsonFilters();this.lastSeenAt=0;this.runtimeVersion='';this.observedEvents=0;this.droppedEvents=0;this.requests=new Map();
    this.pendingRecords=[];
    this.events=new ResponseEvents(event=>{
      const {data,...meta}=event;this.observedEvents++;
      this.pendingRecords.push(Promise.resolve(this.record({...meta,type:'client_response_event',stage:'RESPONSE_EVENT',direction:'in',at:Date.now(),
        contentCapture:this.capture(data,'application/json')},{bytes:Buffer.from(data)})));
    },{maxBytes:this.maxBytes});
  }
  capture(text,contentType){const bytes=Buffer.from(text);const c=new ContentCapture({enabled:true,maxBytes:Math.max(1,bytes.length),contentType});c.add(bytes);return c.finish();}
  meta(input){
    const url=new URL(input.url);
    if(!['http:','https:','ws:','wss:'].includes(url.protocol))throw new Error('Unsupported client URL.');
    if(!/^[A-Z]+$/.test(input.method)||!input.requestId||String(input.requestId).length>200)throw new Error('Invalid client request metadata.');
    return {requestId:String(input.requestId),method:input.method,path:sanitizePath(url.pathname),targetHost:url.hostname,
      targetPort:Number(url.port||(url.protocol==='http:'||url.protocol==='ws:'?80:443)),protocol:input.protocol||'http',
      source:'codex-client-hook',confidence:'authoritative',inspected:true,
      kind:classifyRequest({method:input.method,path:url.pathname,upgrade:input.protocol==='websocket'})};
  }
  async outbound(input){
    if(input.schemaVersion!==1||typeof input.bodyJson!=='string')throw new Error('Invalid client hook request.');
    const meta=this.meta(input);this.lastSeenAt=Date.now();this.runtimeVersion=String(input.runtimeVersion||'');
    try{const json=JSON.parse(input.bodyJson);meta.threadId=String(json.client_metadata?.thread_id||json.client_metadata?.session_id||'').slice(0,200);meta.turnId=String(json.client_metadata?.turn_id||'').slice(0,200);}catch{}
    const result=this.filters.apply({host:meta.targetHost,...meta},input.bodyJson);
    const bytes=typeof input.bodyBase64==='string'?Buffer.from(input.bodyBase64,'base64'):Buffer.from(result.bodyJson);
    if(typeof input.bodyBase64==='string'){const {sha256}=require('./redaction');result.originalSha256=result.bodySha256=sha256(bytes);}
    const event={...meta,type:'client_request',stage:'CLIENT_JSON_PREPARED',direction:'out',at:this.lastSeenAt,
      originalSha256:result.originalSha256,bodySha256:result.bodySha256,modified:result.modified,appliedRules:result.appliedRules,
      size:bytes.length,captureUnavailable:Boolean(input.captureUnavailable),contentCapture:this.capture(bytes,input.bodyBase64!==undefined?'application/octet-stream':'application/json')};
    await this.record(event,{bytes,originalBytes:Buffer.from(input.bodyJson)});
    if(this.requests.size>=500){const oldest=this.requests.keys().next().value;this.requests.delete(oldest);this.events.end(oldest);}
    this.requests.set(meta.requestId,{...meta,bodySha256:result.bodySha256,originalSha256:result.originalSha256,modified:result.modified});
    return {schemaVersion:1,requestId:meta.requestId,bodyJson:result.bodyJson,bodySha256:result.bodySha256};
  }
  async observe(input){
    this.lastSeenAt=Date.now();
    if(input.kind==='dropped'){this.droppedEvents+=Number(input.count||0);await this.record({type:'client_hook_status',stage:'CAPTURE_GAP',at:this.lastSeenAt,size:Number(input.count||0)});return;}
    const meta=this.requests.get(String(input.requestId))||this.meta(input);
    if(input.kind==='response_headers'){
      meta.contentType=String(input.headers?.['content-type']||'');meta.statusCode=Number(input.statusCode||0);
      this.requests.set(meta.requestId,meta);
      await this.record({...meta,type:'client_response',stage:'CLIENT_RESPONSE_HEADERS',direction:'in',at:this.lastSeenAt,headers:redactHeaders(input.headers)});
    }else if(input.kind==='response_chunk'){
      const bytes=Buffer.from(input.bytes||'','base64');
      await this.record({...meta,type:'client_response',stage:'CLIENT_RESPONSE_CHUNK',direction:'in',at:this.lastSeenAt,
        size:bytes.length,chunkIndex:input.chunkIndex,captureBoundary:input.captureBoundary||'legacy-client-chunk',
        contentCapture:this.capture(bytes,meta.contentType||'application/octet-stream')},{bytes});
      try{
        if(meta.protocol==='websocket')this.events.websocket(meta,bytes.toString('utf8'));
        else if(meta.contentType?.includes('event-stream'))this.events.chunk(meta,bytes);
      }catch(error){
        this.events.end(meta.requestId);
        await this.record({...meta,type:'client_hook_status',stage:'RESPONSE_EVENT_PARSE_ERROR',direction:'in',at:this.lastSeenAt,error:String(error.message||error).slice(0,200)});
      }
      const pending=this.pendingRecords.splice(0);await Promise.all(pending);
    }else if(input.kind==='finished'){
      this.events.end(meta.requestId);this.requests.delete(meta.requestId);
      await this.record({...meta,type:'client_response',stage:'CLIENT_RESPONSE_FINISHED',direction:'in',at:this.lastSeenAt});
    }else if(input.kind==='sent')await this.record({...meta,type:'client_request',stage:'CLIENT_TRANSPORT_SENT',direction:'out',at:this.lastSeenAt});
    else if(input.kind==='error')await this.record({...meta,type:'client_hook_status',stage:'CLIENT_TRANSPORT_ERROR',direction:'in',at:this.lastSeenAt,error:String(input.error||'transport error').slice(0,200)});
  }
  diagnostics(){return {clientHookObserved:Boolean(this.lastSeenAt),clientHookLastSeenAt:this.lastSeenAt,clientHookRuntimeVersion:this.runtimeVersion,
    responseEventsObserved:this.observedEvents,clientCaptureGaps:this.droppedEvents,jsonFilterRules:this.filters.rules.length};}
}
module.exports={ClientInstrumentation};
