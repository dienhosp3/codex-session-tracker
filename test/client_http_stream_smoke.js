'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),http=require('node:http'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const {GatewayServer}=require('../gateway/server');

async function main(){
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'tracker-http-stream-'));
  const home=path.join(temporary,'home');await fs.mkdir(home);
  const trace=[],received=[],sockets=new Set();let child;
  const types=['response.created','response.output_item.done','response.completed'];
  const upstream=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    if(req.method!=='POST'||req.url!=='/backend-api/codex/responses'){res.writeHead(404);res.end('{}');return;}
    const bytes=Buffer.concat(chunks),body=JSON.parse(bytes.toString('utf8'));received.push({method:req.method,path:req.url,body,bytes});
    res.writeHead(200,{'content-type':'text/event-stream'});
    const events=[{type:types[0],response:{id:'fixture-response'}},
      {type:types[1],item:{id:'fixture-message',type:'message',role:'assistant',content:[{type:'output_text',text:'PING_OK'}]}},
      {type:types[2],response:{id:'fixture-response',usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}];
    for(const event of events)res.write(`data: ${JSON.stringify(event)}\n\n`);res.end();
  });
  upstream.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  const gateway=new GatewayServer({port:0,trafficLogsEnabled:false,trace:{append:async event=>trace.push(event)}});
  try{
    await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));const address=await gateway.start();
    await fs.writeFile(path.join(home,'config.toml'),`model_provider="fixture"\nmodel="fixture-model"\n[model_providers.fixture]\nname="Loopback fixture"\nbase_url="http://127.0.0.1:${upstream.address().port}/backend-api/codex"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\nrequest_max_retries=0\nstream_max_retries=0\n`);
    const executable=path.resolve(process.argv[2]||'runtime/bin/windows-x86_64/codex.exe');
    const env={...process.env,CODEX_HOME:home,CODEX_TRACKER_GATEWAY_PORT:String(address.port),CODEX_TRACKER_GATEWAY_TOKEN:address.token};
    for(const name of ['OPENAI_API_KEY','OPENAI_BASE_URL','CODEX_API_KEY','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY'])delete env[name];
    await new Promise((resolve,reject)=>{
      child=spawn(executable,['exec','--skip-git-repo-check','--ephemeral','Respond exactly PING_OK.'],{cwd:temporary,env,windowsHide:true});
      child.stdin.end();
      let stderr='',stdout='';const timer=setTimeout(()=>{child.kill();reject(new Error(`HTTP stream smoke timed out; requests=${received.length}; traceEvents=${trace.length}\n${stderr}`));},25000);
      child.stdout.on('data',bytes=>stdout+=bytes);child.stderr.on('data',bytes=>stderr=(stderr+bytes).slice(-4000));
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('close',code=>{clearTimeout(timer);if(code!==0)reject(new Error(stderr));else{try{assert.match(stdout,/PING_OK/);resolve();}catch(error){reject(error);}}});
    });
    assert.equal(received.length,1);assert.equal(received[0].body.stream,true);
    const captured=trace.find(e=>e.stage==='CLIENT_JSON_PREPARED'&&e.path==='/backend-api/codex/responses');
    assert.ok(captured);assert.equal(captured.method,'POST');assert.equal(captured.protocol,'http');
    assert.equal(JSON.parse(captured.contentCapture.content).stream,true);
    assert.deepEqual(Buffer.from(captured.contentCapture.content),received[0].bytes);
    assert.deepEqual(trace.filter(e=>e.type==='client_response_event').map(e=>e.eventType),types);
    console.log(JSON.stringify({passed:true,runtimeModelHttpPath:true,method:'POST',endpoint:'/backend-api/codex/responses',stream:true,completeRequestBodyMatches:true,responseEvents:types,isolatedCodexHome:true,externalModelRequestsSent:0}));
  }finally{
    if(child&&child.exitCode===null){await new Promise(resolve=>{child.once('exit',resolve);child.kill();});}
    await gateway.stop();for(const socket of sockets)socket.destroy();if(upstream.listening)await new Promise(resolve=>upstream.close(resolve));
    await fs.rm(temporary,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
