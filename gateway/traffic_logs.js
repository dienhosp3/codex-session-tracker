'use strict';
const fs=require('fs/promises'),path=require('path'),crypto=require('crypto');
const digest=value=>crypto.createHash('sha256').update(String(value)).digest('hex').slice(0,12);
const stamp=time=>new Date(time).toISOString().replace(/[:.]/g,'-');
const segment=value=>String(value||'unknown').replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,90).replace(/^\.+$/,'unknown');
function capturedBytes(capture){return !capture?null:Buffer.from(capture.content||'',capture.encoding==='base64'?'base64':'utf8');}
class TrafficLogs{
  constructor(options={}){
    this.root=options.directory||'';this.enabled=options.enabled!==false;this.sessionStartedAt=options.sessionStartedAt||Date.now();
    this.session=stamp(this.sessionStartedAt)+'-'+crypto.randomBytes(3).toString('hex');
    this.requests=new Map();this.sequence=0;this.written=0;this.error='';this.chain=Promise.resolve();
  }
  configure({directory,enabled}){
    // Existing requests finish in their original folders; new requests use this root.
    if(directory!==undefined)this.root=path.resolve(directory);if(enabled!==undefined)this.enabled=Boolean(enabled);
    this.error='';
  }
  newSession(){this.sessionStartedAt=Date.now();this.session=stamp(this.sessionStartedAt)+'-'+crypto.randomBytes(3).toString('hex');}
  snapshot(){return {trafficLogsEnabled:this.enabled,trafficLogsDirectory:this.root,trafficLogsSession:this.session,trafficLogsWritten:this.written,trafficLogsError:this.error};}
  append(event,payload={}){
    if(!this.enabled||!this.root)return Promise.resolve();
    const task=this.chain.then(()=>this.write(event,payload));
    this.chain=task.catch(()=>{});
    return task.catch(error=>{this.error=`Không ghi được log (${error.code||'IO_ERROR'}).`;});
  }
  async flush(){await this.chain;}
  async write(event,payload){
    if(event.stage==='CAPTURE_GAP'){
      const folder=path.join(this.root,new Date(this.sessionStartedAt).toISOString().slice(0,10),this.session);
      await fs.mkdir(folder,{recursive:true});await fs.appendFile(path.join(folder,'capture.gaps.jsonl'),JSON.stringify(event)+'\n');return;
    }
    if(!['client_request','client_response','client_response_event','client_hook_status','http_upstream','native_plaintext','ws_frame','ws_connection'].includes(event.type))return;
    const key=event.requestId||event.connectionId;
    if(!key)return;
    let request=this.requests.get(key);
    const method=event.method||request?.method;
    if(!['POST','GET'].includes(method))return;
    if(!request){
      if(!event.path||!event.targetHost)return;
      const at=Number(event.at)||Date.now();
      const backend=segment(event.targetHost)+(event.targetPort&&!([80,443].includes(event.targetPort))?'-'+event.targetPort:'');
      const endpoint=event.path==='/backend-api/codex/responses'?'codex-responses':path.join('endpoints',segment(event.path.replace(/^\//,''))+'-'+digest(event.path));
      const folder=path.join(this.root,new Date(this.sessionStartedAt).toISOString().slice(0,10),this.session,'backends',backend,endpoint,stamp(at)+'-'+method+'-'+digest(key));
      request={folder,method,requestId:key,requestBytes:0,responseBytes:0};
      this.requests.set(key,request);
      if(this.requests.size>10000)this.requests.delete(this.requests.keys().next().value);
      await fs.mkdir(folder,{recursive:true});
      await fs.writeFile(path.join(folder,'request.json'),JSON.stringify({schemaVersion:1,sessionStartedAt:new Date(this.sessionStartedAt).toISOString(),requestStartedAt:new Date(at).toISOString(),requestId:key,method,backend:event.targetHost,port:event.targetPort,path:event.path,protocol:event.protocol,source:event.source,kind:event.kind,threadId:event.threadId||'',originalSha256:event.originalSha256||'',bodySha256:event.bodySha256||'',modified:Boolean(event.modified)},null,2)+'\n');
    }
    const {contentCapture,...metadata}=event;
    const entry={...metadata,logSequence:++this.sequence};
    await fs.appendFile(path.join(request.folder,'timeline.jsonl'),JSON.stringify(entry)+'\n');
    if(event.type==='client_response_event'){
      const content=payload.bytes||capturedBytes(contentCapture);
      let data;try{data=JSON.parse(content.toString('utf8'));}catch{data=content?.toString('utf8')||'';}
      await fs.appendFile(path.join(request.folder,'response.events.jsonl'),JSON.stringify({...entry,data})+'\n');
    }else if(event.type==='client_request'&&event.stage==='CLIENT_JSON_PREPARED'){
      const bytes=payload.bytes||capturedBytes(contentCapture)||Buffer.alloc(0);
      await fs.writeFile(path.join(request.folder,'request.body'),bytes);request.requestBytes=bytes.length;
      if(payload.originalBytes&&event.modified)await fs.writeFile(path.join(request.folder,'request.original.body'),payload.originalBytes);
    }else if(event.type==='client_response'&&event.stage==='CLIENT_RESPONSE_CHUNK'){
      const bytes=payload.bytes||capturedBytes(contentCapture)||Buffer.alloc(0);
      await fs.appendFile(path.join(request.folder,'response.body'),bytes);request.responseBytes+=bytes.length;
    }else if(event.type==='client_response'&&event.stage==='CLIENT_RESPONSE_HEADERS'){
      await fs.writeFile(path.join(request.folder,'response.json'),JSON.stringify(entry,null,2)+'\n');
    }else if(event.type!=='client_request'&&event.type!=='client_response'&&contentCapture){
      // Preserve the captured proxy/native representation, including encoding and truncation.
      await fs.appendFile(path.join(request.folder,'captures.jsonl'),JSON.stringify({...entry,contentCapture})+'\n');
    }
    if(event.captureUnavailable||contentCapture?.truncated&&!payload.bytes){
      await fs.appendFile(path.join(request.folder,'gaps.jsonl'),JSON.stringify({at:event.at,stage:event.stage,reason:event.captureUnavailable?'streaming request body unavailable':'capture truncated'})+'\n');
    }
    this.written++;
  }
}
module.exports={TrafficLogs};
