'use strict';
const fs=require('fs/promises'),path=require('path');
const {isUtf8}=require('buffer');
const {createReadStream}=require('fs');
function inside(root,target){const relative=path.relative(root,target);return relative===''||!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);}
async function* jsonLines(file,start=0){
  try{if((await fs.lstat(file)).isSymbolicLink())throw new Error('Symbolic log payload is not supported.');}
  catch(error){if(error.code==='ENOENT')return;throw error;}
  let pending=Buffer.alloc(0),position=start;
  for await(const chunk of createReadStream(file,{start})){
    pending=Buffer.concat([pending,chunk]);let newline;
    while((newline=pending.indexOf(10))!==-1){
      const line=pending.subarray(0,newline),byteLength=newline+1;
      let value;try{value=JSON.parse(line.toString('utf8'));}catch{}
      yield {value,offset:position,byteLength};position+=byteLength;pending=pending.subarray(byteLength);
    }
  }
  if(pending.length){let value;try{value=JSON.parse(pending.toString('utf8'));}catch{}yield {value,offset:position,byteLength:pending.length};}
}
class SavedTraffic{
  constructor(){this.root='';this.items=new Map();this.total=0;this.loaded=0;this.scannedDirectories=0;this.traffic=[];}
  async open(directory,limit=1000){
    this.root=await fs.realpath(directory);this.items.clear();this.total=0;this.scannedDirectories=0;this.traffic=[];
    const records=[],pending=[{folder:this.root,depth:0}];
    while(pending.length){
      const {folder,depth}=pending.pop();this.scannedDirectories++;
      const entries=await fs.readdir(folder,{withFileTypes:true});
      for(const entry of entries){
        if(entry.isSymbolicLink())continue;
        const full=path.join(folder,entry.name);
        if(entry.isDirectory()&&depth<12&&!['node_modules','.git','.hook-venv'].includes(entry.name))pending.push({folder:full,depth:depth+1});
        else if(entry.isFile()&&entry.name==='request.json'){
          const stat=await fs.stat(full);if(stat.size>1024*1024)continue;
          let meta;try{meta=JSON.parse(await fs.readFile(full,'utf8'));}catch{continue;}
          if(meta.schemaVersion!==1||!['POST','GET'].includes(meta.method)||!meta.path||!meta.backend)continue;
          records.push({folder,meta});
        }
      }
    }
    records.sort((a,b)=>Date.parse(b.meta.requestStartedAt)-Date.parse(a.meta.requestStartedAt));this.total=records.length;
    const selected=records.slice(0,limit).reverse();this.loaded=selected.length;let id=1;
    for(const {folder,meta}of selected){
      const response=await this.smallJson(path.join(folder,'response.json'));
      let requestBytes=0,responseBytes=0;try{requestBytes=(await fs.stat(path.join(folder,'request.body'))).size;}catch{}try{responseBytes=(await fs.stat(path.join(folder,'response.body'))).size;}catch{}
      const requestId=id,shared={folder,payloadIndexes:new Map()};
      const summary={traceId:id,type:'saved_request',stage:'SAVED_REQUEST',at:Date.parse(meta.requestStartedAt)||0,method:meta.method,path:meta.path,targetHost:meta.backend,targetPort:meta.port,protocol:meta.protocol,requestId:meta.requestId,kind:meta.kind,direction:'out',statusCode:response?.statusCode||0,hasContent:true,size:requestBytes+responseBytes,requestBytes,responseBytes,modified:meta.modified,bodySha256:meta.bodySha256,originalSha256:meta.originalSha256,session:meta.sessionStartedAt,threadId:meta.threadId};
      this.items.set(id++,{folder,event:summary,shared});
      let responseOffset=0;
      for await(const {value:entry}of jsonLines(path.join(folder,'timeline.jsonl'))){
        if(!entry||typeof entry!=='object'||Array.isArray(entry))continue;
        const {contentCapture,data,...metadata}=entry;
        const event={...summary,...metadata,traceId:id,originalTraceId:entry.traceId,savedEvent:true,savedRequestTraceId:requestId,session:meta.sessionStartedAt,hasContent:false,
          size:entry.size??entry.requestBytes??entry.responseBytes??0,requestBytes:entry.requestBytes||0,responseBytes:entry.responseBytes||0,statusCode:entry.statusCode||0};
        let source;
        if(entry.headers)source={headers:entry.headers};
        else if(entry.type==='client_response_event')source={file:'response.events.jsonl',sequence:entry.logSequence};
        else if(entry.type==='client_request'&&entry.stage==='CLIENT_JSON_PREPARED')source={file:'request.body'};
        else if(entry.type==='client_response'&&entry.stage==='CLIENT_RESPONSE_CHUNK'){
          const length=Number(entry.size);
          if(Number.isSafeInteger(length)&&length>=0){source={file:'response.body',offset:responseOffset,length};responseOffset+=length;}
          else responseOffset=NaN;
          if(!Number.isSafeInteger(responseOffset))source=undefined;
        }else if(entry.type==='client_response'&&entry.stage==='CLIENT_RESPONSE_HEADERS')source={headers:entry.headers||response?.headers};
        else if(!['client_request','client_response','client_hook_status'].includes(entry.type))source={file:'captures.jsonl',sequence:entry.logSequence};
        event.hasContent=Boolean(source&&!source.headers);
        this.items.set(id++,{folder,event,source,shared});
      }
    }
    this.traffic=Array.from(this.items.values(),value=>value.event).sort((a,b)=>a.at-b.at||(a.logSequence||0)-(b.logSequence||0)||a.traceId-b.traceId);
    return this.snapshot();
  }
  async smallJson(file){try{if((await fs.stat(file)).size>1024*1024)return null;return JSON.parse(await fs.readFile(file,'utf8'));}catch{return null;}}
  snapshot(){return {directory:this.root,total:this.total,loaded:this.loaded,eventCount:this.items.size-this.loaded,traffic:this.traffic};}
  async eventPayload(item){
    const source=item.source;if(!source)return {...item.event,missing:true};
    if(source.headers)return {...item.event,headers:source.headers};
    const file=path.join(item.folder,source.file);
    if((await fs.lstat(file)).isSymbolicLink())throw new Error('Symbolic log payload is not supported.');
    if(source.sequence!==undefined){
      let index=item.shared.payloadIndexes.get(source.file);
      if(!index){index={offset:0,records:new Map()};item.shared.payloadIndexes.set(source.file,index);}
      let location=index.records.get(source.sequence);
      if(!location){
        for await(const record of jsonLines(file,index.offset)){
          if(!record.value)continue;
          index.records.set(record.value.logSequence,{offset:record.offset,length:record.byteLength});index.offset=record.offset+record.byteLength;
          if(record.value.logSequence===source.sequence){location=index.records.get(source.sequence);break;}
        }
      }
      if(!location)return {...item.event,missing:true};
      const handle=await fs.open(file,'r');let bytes;try{bytes=Buffer.alloc(location.length);const read=await handle.read(bytes,0,bytes.length,location.offset);bytes=bytes.subarray(0,read.bytesRead);}finally{await handle.close();}
      const record=JSON.parse(bytes.toString('utf8'));
      if(record.contentCapture)return {...item.event,contentCapture:{...record.contentCapture,complete:true}};
      const content=typeof record.data==='string'?record.data:JSON.stringify(record.data??record,null,2);
      return {...item.event,contentCapture:{content,encoding:'utf8',contentType:'application/json',capturedBytes:Buffer.byteLength(content),totalBytes:Buffer.byteLength(content),complete:true}};
    }
    const handle=await fs.open(file,'r');let bytes;
    try{
      if(source.length===undefined)bytes=await handle.readFile();
      else{bytes=Buffer.alloc(source.length);let read=0;while(read<bytes.length){const result=await handle.read(bytes,read,bytes.length-read,source.offset+read);if(!result.bytesRead)throw new Error('Saved BODY is incomplete.');read+=result.bytesRead;}}
    }finally{await handle.close();}
    const encoding=isUtf8(bytes)?'utf8':'base64';
    return {...item.event,contentCapture:{content:bytes.toString(encoding),encoding,contentType:'application/octet-stream',capturedBytes:bytes.length,totalBytes:bytes.length,complete:true}};
  }
  async payload(id,part='request',offset=0,options={}){
    const item=this.items.get(Number(id));if(!item)return {missing:true,traceId:id};
    if(!inside(this.root,await fs.realpath(item.folder)))throw new Error('Log folder moved outside selected directory.');
    if(part==='event'&&item.event.savedEvent){try{return await this.eventPayload(item);}catch(error){if(error.code==='ENOENT')return {...item.event,missing:true};throw error;}}
    const fileNames={request:'request.body',response:'response.body',events:'response.events.jsonl',timeline:'timeline.jsonl',captures:'captures.jsonl'};
    if(!Object.hasOwn(fileNames,part))throw new Error('Invalid saved payload part.');
    const file=path.join(item.folder,fileNames[part]);if(!inside(this.root,await fs.realpath(item.folder)))throw new Error('Log folder moved outside selected directory.');
    let handle;try{
      const stat=await fs.lstat(file);if(stat.isSymbolicLink())throw new Error('Symbolic log payload is not supported.');
      handle=await fs.open(file,'r');const position=options.whole?0:Math.max(0,Number(offset)||0),length=Math.min(512*1024,Math.max(0,stat.size-position));
      let buffer;
      if(options.whole)buffer=await handle.readFile();
      else{const bytes=Buffer.alloc(length);const read=await handle.read(bytes,0,length,position);buffer=bytes.subarray(0,read.bytesRead);}
      if(!options.whole&&position+buffer.length<stat.size&&!isUtf8(buffer))for(let trim=1;trim<=3&&trim<buffer.length;trim++)if(isUtf8(buffer.subarray(0,buffer.length-trim))){buffer=buffer.subarray(0,buffer.length-trim);break;}
      const encoding=isUtf8(buffer)?'utf8':'base64';
      return {...item.event,part,contentCapture:{content:buffer.toString(encoding),encoding,contentType:part==='events'||part==='timeline'?'application/x-ndjson':'text/plain',capturedBytes:buffer.length,totalBytes:stat.size,offset:position,nextOffset:position+buffer.length,complete:position+buffer.length>=stat.size}};
    }catch(error){if(error.code==='ENOENT')return {...item.event,part,contentCapture:{content:'',encoding:'utf8',complete:true,totalBytes:0}};throw error;}finally{await handle?.close();}
  }
}
module.exports={SavedTraffic};
