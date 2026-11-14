import net from 'node:net';
import { readFile, mkdir, open, unlink,stat,rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join,resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { coreHome, endpoint } from './paths.js';
import { CoreError } from './errors.js';
import {Diagnostics} from './diagnostics.js';
import {resolveRuntime} from './runtime-resolver.js';
const inspectionActions=new Set(['health.check','launcher.list','service.status',
  'conversation.inspect','conversation.usage','conversation.tabs','conversation.observe',
  'turn.inspect','request.inspect','attachment.list','artifact.list','project.list',
  'output.readText','output.readJson','account.list','account.inspect','quota.snapshot']);
export {runValidatedTurn} from './responses.js';
export {validateCodeBlock} from './code-blocks.js';

export class ChatGPTClient {
  constructor({ consumer,home=coreHome(),nodePath=process.execPath,autoStart=true,requiredCapabilities=[],runtimePath,runtimeHome } = {}) {
    if(!consumer) throw new CoreError('CONSUMER_REQUIRED','Consumer name is required');
    if(!Array.isArray(requiredCapabilities)||!requiredCapabilities.every(value=>typeof value==='string'&&value))throw new CoreError('INVALID_CAPABILITIES','Capabilities must be an array of action names');
    this.consumer=consumer; this.home=resolve(home); this.nodePath=nodePath; this.autoStart=autoStart;
    this.requiredCapabilities=[...new Set(requiredCapabilities)];
    this.runtimePath=runtimePath;
    this.runtimeHome=runtimeHome;
    this.description=null;
  }
  async negotiate(requiredCapabilities=this.requiredCapabilities) {
    if(!Array.isArray(requiredCapabilities)||!requiredCapabilities.every(value=>typeof value==='string'&&value))throw new CoreError('INVALID_CAPABILITIES','Capabilities must be an array of action names');
    const description=await this.request('health.check',{}, {timeoutMs:15000});
    if(description.protocolVersion!=='1'||description.contractVersion!=='1')throw new CoreError('CORE_CONTRACT_UNSUPPORTED','The runtime does not provide the required public contract',{version:description.version,requiredContract:'1',actualContract:description.contractVersion||null});
    const missing=requiredCapabilities.filter(action=>!(description.capabilities?.[action]>=1));
    if(missing.length)throw new CoreError('CORE_CAPABILITY_MISSING','The runtime is missing required capabilities',{version:description.version,missing});
    this.description=description;
    return description;
  }
  async request(action,args = {},{ requestId=randomUUID(),timeoutMs } = {}) {
    // Each independent IPC command can reach a newly restarted runtime. Check
    // its contract before dispatch rather than trusting a previous process.
    if(action!=='health.check'&&this.requiredCapabilities.length)await this.negotiate();
    timeoutMs ??= 600000;
    const command={ protocolVersion:'1',consumer:this.consumer,requestId,action,args };
    try { return await this.exchange(command,timeoutMs); }
    catch(error) {
      if(this.autoStart && !error.fromRuntime && (['ENOENT','ECONNREFUSED','CORE_NOT_RUNNING'].includes(error.code)||error.code==='CONNECTION_LOST'&&inspectionActions.has(action))) {
        await this.start();
        if(action!=='health.check'&&this.requiredCapabilities.length)await this.negotiate();
        return this.exchange(command,timeoutMs);
      }
      throw error;
    }
  }
  async exchange(command,timeoutMs) {
    let token; try { token=(await readFile(join(this.home,'runtime.token'),'utf8')).trim(); } catch { throw new CoreError('CORE_NOT_RUNNING','Core runtime is not running'); }
    return new Promise((resolve,reject)=>{
      const socket=net.createConnection(endpoint(this.home)); let buffer='',settled=false;
      const finish=(error,value)=>{ if(settled)return;settled=true;socket.destroy();error?reject(error):resolve(value); };
      socket.setEncoding('utf8'); socket.setTimeout(timeoutMs,()=>finish(new CoreError('CLIENT_TIMEOUT','Runtime request timed out; reuse the same requestId to recover',{requestId:command.requestId,action:command.action,requestMayBeRunning:true})));
      socket.once('connect',()=>socket.write(JSON.stringify({ token,command })+'\n'));
      socket.on('data',chunk=>{buffer+=chunk;if(Buffer.byteLength(buffer)>64*1024*1024)return finish(new CoreError('RESPONSE_TOO_LARGE','Runtime response too large'));const end=buffer.indexOf('\n');if(end<0)return;try{const value=JSON.parse(buffer.slice(0,end)); if(value.status==='failed'){const error=new CoreError(value.error.code,value.error.message,value.error.details);error.fromRuntime=true;finish(error);}else finish(null,value.result);}catch(error){finish(error);}});
      socket.once('error',error=>finish(error));socket.once('end',()=>{if(!settled)finish(new CoreError('CONNECTION_LOST','Runtime disconnected; do not blindly resend'));});
    });
  }
  async start() {
    this.description=null;
    const diagnostics=new Diagnostics(this.home),stderrPath=join(this.home,'logs','startup-stderr.log');
    await mkdir(this.home,{ recursive:true }); const path=join(this.home,'startup.lock'); let lock;
    try { lock=await open(path,'wx'); await lock.writeFile(JSON.stringify({pid:process.pid,time:Date.now()})); }
    catch(error) {
      if(error.code!=='EEXIST')throw error;
      let data; try{data=JSON.parse(await readFile(path,'utf8'));}catch{}
      let alive=true;try{if(!data?.pid)alive=false;else process.kill(data.pid,0);}catch(failure){if(failure.code==='ESRCH')alive=false;}
      if(!alive) {await unlink(path).catch(()=>{});return this.start();}
    }
    let exited=null,lastFailure=null,stderrStart=0;
    try {
      if(lock) {
        const installation=await resolveRuntime({runtimePath:this.runtimePath,runtimeHome:this.runtimeHome});
        const script=join(installation.runtimePath,'src','server.js');
        await mkdir(join(this.home,'logs'),{recursive:true});
        if(await stat(stderrPath).then(s=>s.size>=5*1024*1024,()=>false)){
          for(let i=3;i>=1;i--){await unlink(stderrPath+'.'+i).catch(e=>{if(e.code!=='ENOENT')throw e;});await rename(i===1?stderrPath:stderrPath+'.'+(i-1),stderrPath+'.'+i).catch(e=>{if(e.code!=='ENOENT')throw e;});}
        }
        const stderr=await open(stderrPath,'a');
        stderrStart=(await stderr.stat()).size;
        try{await new Promise((resolve,reject)=>{const child=spawn(this.nodePath,[script],{detached:true,stdio:['ignore','ignore',stderr.fd],windowsHide:true,env:{...process.env,AHUST_CHATGPT_HOME:this.home}});child.once('error',reject);child.once('exit',(code,signal)=>{exited={code,signal};});child.once('spawn',()=>{child.unref();resolve();});});}
        finally{await stderr.close();}
        diagnostics.event('startup.spawned',{nodePath:this.nodePath,home:this.home,stderrPath,runtimePath:installation.runtimePath,version:installation.version,source:installation.source});
      }
      const deadline=Date.now()+15000;
      while(Date.now()<deadline){try{await this.exchange({protocolVersion:'1',consumer:this.consumer,requestId:randomUUID(),action:'health.check',args:{}},2000);return;}catch(error){lastFailure=error;}if(exited)break;await new Promise(r=>setTimeout(r,200));}
      const stderr=lock?await readFile(stderrPath).then(s=>s.subarray(stderrStart).toString('utf8').slice(-2500),()=>null):null;
      throw new CoreError('CORE_START_FAILED','Core không khởi động được'+(exited?' (exit '+exited.code+')':' trong thời gian chờ')+'. '+(stderr?.trim()||lastFailure?.message||'Runtime startup lock is busy'),{nodePath:this.nodePath,home:this.home,stderrPath,exit:exited,cause:lastFailure?.code,waitingForStartupLock:!lock});
    }catch(error){diagnostics.error(error,{stage:'runtime.startup',nodePath:this.nodePath,home:this.home});throw error;
    } finally {if(lock){await lock.close();await unlink(path).catch(()=>{});}}
  }
}
