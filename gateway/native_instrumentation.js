'use strict';

const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { createInterface } = require('readline');
const { PlaintextStream } = require('./plaintext_stream');

function run(executable,args,options={}) {
  return new Promise((resolve,reject)=>execFile(executable,args,{windowsHide:true,timeout:10000,maxBuffer:1024*1024,...options},
    (error,stdout)=>error?reject(error):resolve(stdout)));
}

async function discoverOwners(executable) {
  if(process.platform!=='win32' || !executable)return [];
  // Only process metadata; never inspect rollouts, auth files, or environment.
  const source="$items = @(Get-CimInstance Win32_Process -Filter \"Name = 'codex.exe'\" | Where-Object { $_.CommandLine -match '(?:^|\\s)app-server(?:\\s|$)' } | Select-Object ProcessId,ParentProcessId,ExecutablePath); ConvertTo-Json -InputObject $items -Compress";
  const encoded=Buffer.from(source,'utf16le').toString('base64');
  const values=JSON.parse(await run('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',encoded]));
  return values.filter(item=>item.ExecutablePath && path.resolve(item.ExecutablePath).toLowerCase()===path.resolve(executable).toLowerCase())
    .map(item=>({pid:Number(item.ProcessId),parentPid:Number(item.ParentProcessId)}));
}

class NativeInstrumentation {
  constructor(options={}) {
    this.record=options.record || (()=>{});
    this.onChange=options.onChange || (()=>{});
    this.storageDir=options.storageDir || '';
    this.python=options.python || 'python';
    this.child=null;
    this.state={attached:false,configured:false,starting:false,plaintextObserved:false,outBytes:0,inBytes:0,backend:'schannel',error:'',pid:0};
    this.parser=new PlaintextStream({capture:true,maxBytes:options.maxBytes,record:event=>Promise.resolve(this.record(event)).catch(()=>{})});
  }

  snapshot(){return {...this.state};}
  update(patch){
    Object.assign(this.state,patch);
    if(!this.changeTimer)this.changeTimer=setTimeout(()=>{this.changeTimer=null;this.onChange(this.snapshot());},100);
  }

  setOutboundRules(rules) {
    if(!this.child || !this.state.configured)throw new Error('Native hook is not ready.');
    for(const rule of rules){
      if(!rule.host || !Array.isArray(rule.find) || !Array.isArray(rule.replace) || !rule.find.length || rule.find.length!==rule.replace.length || rule.find.length>4096 || [...rule.find,...rule.replace].some(v=>!Number.isInteger(v)||v<0||v>255))throw new Error('TLS replacement requires a host and equal-length byte arrays.');
    }
    if(rules.length>32)throw new Error('At most 32 outbound rules.');
    this.child.stdin.write(JSON.stringify({action:'configure',options:{capture:true,rules}})+'\n');
  }
  pythonExecutable(){
    const bundled=path.join(this.storageDir,'native-hook-python','Scripts','python.exe');
    return fs.existsSync(bundled)?bundled:this.python;
  }

  async setup() {
    if(process.platform!=='win32')throw new Error('Native Schannel hook requires Windows.');
    this.update({error:'',setup:'creating-environment'});
    const dir=path.join(this.storageDir,'native-hook-python');
    try {
      await run(this.python,['-m','venv',dir],{timeout:60000});
      this.update({setup:'installing-frida'});
      await run(this.pythonExecutable(),['-m','pip','install','--disable-pip-version-check','-r',path.join(__dirname,'hook-requirements.txt')],{timeout:180000});
      this.update({setup:'ready'});
    } catch {
      this.update({setup:'failed',error:'Không cài được Frida. Kiểm tra Python và kết nối tải gói.'});
      throw new Error(this.state.error);
    }
  }

  async start(pid,executable) {
    await this.stop();
    const owners=await discoverOwners(executable);
    if(!owners.some(owner=>owner.pid===pid))throw new Error('Tiến trình đã đổi hoặc không phải app-server của Extension đang cài. Làm mới danh sách.');
    this.parser.clear();
    this.update({attached:false,configured:false,starting:true,plaintextObserved:false,outBytes:0,inBytes:0,error:'',pid});
    return new Promise((resolve,reject)=>{
      let settled=false;
      const child=spawn(this.pythonExecutable(),['-u',path.join(__dirname,'hook_runner.py'),String(pid),executable],{windowsHide:true,stdio:['pipe','pipe','pipe']});
      this.child=child;
      const timeout=setTimeout(()=>fail('Hook chưa xác nhận sẵn sàng sau 15 giây.'),15000);
      const fail=reason=>{
        if(this.child===child)this.update({attached:false,configured:false,starting:false,error:reason});
        if(!settled){settled=true;clearTimeout(timeout);reject(new Error(reason));}
        child.kill();
      };
      child.on('error',()=>fail('Không chạy được Python cho native hook.'));
      child.stderr.on('data',()=>{}); // No paths/process dumps into diagnostics.
      child.stdin.on('error',()=>{});
      const reader=createInterface({input:child.stdout});
      reader.on('line',line=>{
        if(this.child!==child)return;
        try {
          if(line.length>2*1024*1024)return fail('Native hook record vượt giới hạn.');
          const event=JSON.parse(line);
          if(event.type==='ready') {
            this.update({attached:true});
            child.stdin.write(JSON.stringify({action:'configure',options:{capture:true,rules:[]}})+'\n');
          } else if(event.type==='configured') {
            this.update({configured:true,starting:false});
            if(!settled){settled=true;clearTimeout(timeout);resolve(this.snapshot());}
          } else if(event.type==='plaintext')this.accept(event);
          else if(event.type==='h2_headers')this.parser.headers(event);
          else if(event.type==='h2_headers_unavailable')Promise.resolve(this.record({type:'native_hook_status',stage:'ENDPOINT_UNAVAILABLE',at:event.at,connectionId:event.connectionId,streamId:event.streamId})).catch(()=>{});
          else if(event.type==='mutation')Promise.resolve(this.record({type:'native_hook_status',stage:event.stage,at:event.at,
            direction:'out',connectionId:event.connectionId,targetHost:event.targetHost,size:event.size,bodySha256:event.bodySha256,
            originalSha256:event.originalSha256})).catch(()=>{});
          else if(event.type==='context_closed')this.parser.close(event.connectionId);
          else if(event.type==='error')fail(event.reason || 'Native hook lỗi.');
          else if(event.type==='detached')fail('Codex đã ngắt native hook; gắn lại sau khi tiến trình khởi động.');
          else if(event.type==='tls_error')Promise.resolve(this.record({type:'native_hook_status',stage:event.stage,at:event.at,status:event.status})).catch(()=>{});
        } catch {fail('Native hook trả dữ liệu không hợp lệ.');}
      });
      child.on('exit',()=>{
        reader.close();clearTimeout(timeout);
        if(this.child===child){this.child=null;this.update({attached:false,configured:false,starting:false});this.parser.clear();}
        if(!settled){settled=true;reject(new Error(this.state.error || 'Native hook đã thoát.'));}
      });
    });
  }

  accept(event) {
    const direction=event.direction;
    if(!['out','in'].includes(direction))return;
    const key=direction==='out'?'outBytes':'inBytes';
    this.update({plaintextObserved:true,[key]:this.state[key]+Number(event.size || 0)});
    // This metadata is truthful even if attached midway through an existing
    // connection and HTTP framing cannot be reconstructed. No raw bytes saved.
    Promise.resolve(this.record({type:'native_tls_record',stage:event.stage,at:event.at,direction,
      connectionId:event.connectionId,targetHost:event.targetHost || '',size:event.size,inspected:true})).catch(()=>{});
    if(event.bytes)this.parser.feed(event,Buffer.from(event.bytes,'base64'));
  }

  async stop() {
    const child=this.child;this.child=null;
    if(child){
      await new Promise(resolve=>{
        const timer=setTimeout(()=>{child.kill();resolve();},2000);
        child.once('exit',()=>{clearTimeout(timer);resolve();});
        if(child.exitCode!==null){clearTimeout(timer);resolve();return;}
        try{child.stdin.end(JSON.stringify({action:'stop'})+'\n');}catch{child.kill();}
      });
    }
    this.parser.clear();this.update({attached:false,configured:false,starting:false,pid:0});
  }
}

module.exports={NativeInstrumentation,discoverOwners};
