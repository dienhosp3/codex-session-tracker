'use strict';
const assert=require('assert/strict'),fs=require('fs/promises'),os=require('os'),path=require('path'),{spawn}=require('child_process');
async function main(){
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'tracker-runtime-smoke-'));
  const env={...process.env,CODEX_HOME:home};delete env.CODEX_TRACKER_GATEWAY_PORT;delete env.CODEX_TRACKER_GATEWAY_TOKEN;
  const executable=path.resolve(process.argv[2]||'runtime/bin/windows-x86_64/codex.exe');
  let child;
  try{
    const result=await new Promise((resolve,reject)=>{
      child=spawn(executable,['app-server'],{cwd:home,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
      let pending='',errorText='';const timeout=setTimeout(()=>reject(new Error('Runtime initialization timed out')),15000);
      child.on('error',error=>{clearTimeout(timeout);reject(error);});child.stderr.on('data',bytes=>errorText+=bytes);
      child.stdout.on('data',bytes=>{
        pending+=bytes.toString('utf8');let end;
        while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);let message;try{message=JSON.parse(line);}catch{continue;}
          if(message.id===1){clearTimeout(timeout);message.error?reject(new Error(JSON.stringify(message.error))):resolve(message.result);}
        }
      });
      child.on('exit',code=>{clearTimeout(timeout);if(code!==null)reject(new Error('Runtime exited before initialization: '+errorText.slice(-1000)));});
      child.stdin.write(JSON.stringify({id:1,method:'initialize',params:{clientInfo:{name:'tracker-runtime-smoke',version:'0.12.0'},capabilities:{experimentalApi:true}}})+'\n');
    });
    assert.ok(result&&typeof result==='object');
    console.log(JSON.stringify({passed:true,appServerInitialize:true,isolatedCodexHome:true,modelRequestsSent:0,runtimeVersion:'0.159.2'}));
  }finally{
    if(child&&child.exitCode===null){await new Promise(resolve=>{child.once('exit',resolve);child.kill();});}
    await fs.rm(home,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
