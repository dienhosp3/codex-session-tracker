import {mkdirSync,appendFileSync,statSync,renameSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

const quiet=new Set(['health.check','launcher.list','service.status','conversation.inspect',
  'conversation.usage','conversation.tabs','turn.inspect','request.inspect',
  'attachment.list','artifact.list','project.list']);
const identifiers=['conversationRef','attemptId','turnRef','projectRef','launcherId','targetId','operation'];
export function diagnosticContext(command={}){
  const result={action:command.action,consumer:command.consumer,requestId:command.requestId};
  for(const key of identifiers)if(typeof command.args?.[key]==='string')result[key]=command.args[key];
  return result;
}
export class Diagnostics{
  constructor(home,{maxBytes=5*1024*1024,backups=3}={}){this.path=join(home,'logs','core.jsonl');this.folder=join(home,'logs');this.maxBytes=maxBytes;this.backups=backups;this.lastWriteError=null;}
  event(event,fields={}){
    try{
      mkdirSync(this.folder,{recursive:true});
      if((()=>{try{return statSync(this.path).size;}catch{return 0;}})()>=this.maxBytes){
        for(let i=this.backups;i>=1;i--){const destination=this.path+'.'+i,source=i===1?this.path:this.path+'.'+(i-1);try{unlinkSync(destination);}catch(e){if(e.code!=='ENOENT')throw e;}try{renameSync(source,destination);}catch(e){if(e.code!=='ENOENT')throw e;}}
      }
      appendFileSync(this.path,JSON.stringify({time:new Date().toISOString(),pid:process.pid,event,...fields})+'\n',{encoding:'utf8',mode:0o600});this.lastWriteError=null;
    }catch(error){this.lastWriteError={code:error.code,message:error.message};}
  }
  error(error,fields={}){
    if(error.diagnostic)return error.diagnostic;
    const diagnostic={id:randomUUID(),logPath:this.path};
    this.event('error',{...fields,diagnosticId:diagnostic.id,code:error.code||'CORE_FAILED',message:error.message||String(error),stack:error.stack});
    error.diagnostic=diagnostic;
    if(error.details)error.details={...error.details,diagnosticId:diagnostic.id,logPath:this.path};
    return diagnostic;
  }
  async trace(command,operation){
    const context=diagnosticContext(command),started=Date.now(),silent=quiet.has(command?.action);
    if(!silent)this.event('request.started',context);
    try{const result=await operation();if(!silent)this.event('request.completed',{...context,durationMs:Date.now()-started,status:result?.status});return result;}
    catch(error){this.error(error,{...context,durationMs:Date.now()-started});throw error;}
  }
}
