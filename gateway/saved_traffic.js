'use strict';
const fs=require('fs/promises'),path=require('path');
const {isUtf8}=require('buffer');
function inside(root,target){const relative=path.relative(root,target);return relative===''||!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);}
class SavedTraffic{
  constructor(){this.root='';this.items=new Map();this.total=0;this.scannedDirectories=0;}
  async open(directory,limit=1000){
    this.root=await fs.realpath(directory);this.items.clear();this.total=0;this.scannedDirectories=0;
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
    const selected=records.slice(0,limit).reverse();let id=1;
    for(const {folder,meta}of selected){
      const response=await this.smallJson(path.join(folder,'response.json'));
      let requestBytes=0,responseBytes=0;try{requestBytes=(await fs.stat(path.join(folder,'request.body'))).size;}catch{}try{responseBytes=(await fs.stat(path.join(folder,'response.body'))).size;}catch{}
      this.items.set(id,{folder,event:{traceId:id,type:'saved_request',stage:'SAVED_REQUEST',at:Date.parse(meta.requestStartedAt)||0,method:meta.method,path:meta.path,targetHost:meta.backend,targetPort:meta.port,protocol:meta.protocol,requestId:meta.requestId,direction:'out',statusCode:response?.statusCode||0,hasContent:true,size:requestBytes+responseBytes,requestBytes,responseBytes,modified:meta.modified,bodySha256:meta.bodySha256,originalSha256:meta.originalSha256,session:meta.sessionStartedAt,threadId:meta.threadId}});id++;
    }
    return this.snapshot();
  }
  async smallJson(file){try{if((await fs.stat(file)).size>1024*1024)return null;return JSON.parse(await fs.readFile(file,'utf8'));}catch{return null;}}
  snapshot(){return {directory:this.root,total:this.total,loaded:this.items.size,traffic:Array.from(this.items.values(),value=>value.event)};}
  async payload(id,part='request',offset=0){
    const item=this.items.get(Number(id));if(!item)return {missing:true,traceId:id};
    const fileNames={request:'request.body',response:'response.body',events:'response.events.jsonl',timeline:'timeline.jsonl',captures:'captures.jsonl'};
    if(!Object.hasOwn(fileNames,part))throw new Error('Invalid saved payload part.');
    const file=path.join(item.folder,fileNames[part]);if(!inside(this.root,await fs.realpath(item.folder)))throw new Error('Log folder moved outside selected directory.');
    let handle;try{
      const stat=await fs.lstat(file);if(stat.isSymbolicLink())throw new Error('Symbolic log payload is not supported.');
      handle=await fs.open(file,'r');const position=Math.max(0,Number(offset)||0),length=Math.min(512*1024,Math.max(0,stat.size-position));
      const bytes=Buffer.alloc(length);const read=await handle.read(bytes,0,length,position);let buffer=bytes.subarray(0,read.bytesRead);
      if(position+buffer.length<stat.size&&!isUtf8(buffer))for(let trim=1;trim<=3&&trim<buffer.length;trim++)if(isUtf8(buffer.subarray(0,buffer.length-trim))){buffer=buffer.subarray(0,buffer.length-trim);break;}
      const encoding=isUtf8(buffer)?'utf8':'base64';
      return {...item.event,part,contentCapture:{content:buffer.toString(encoding),encoding,contentType:part==='events'||part==='timeline'?'application/x-ndjson':'text/plain',capturedBytes:buffer.length,totalBytes:stat.size,offset:position,nextOffset:position+buffer.length,complete:position+buffer.length>=stat.size}};
    }catch(error){if(error.code==='ENOENT')return {...item.event,part,contentCapture:{content:'',encoding:'utf8',complete:true,totalBytes:0}};throw error;}finally{await handle?.close();}
  }
}
module.exports={SavedTraffic};
