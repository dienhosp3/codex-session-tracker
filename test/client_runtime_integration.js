'use strict';
const assert=require('assert/strict'),http=require('http'),https=require('https'),fs=require('fs/promises'),path=require('path'),os=require('os'),zlib=require('zlib'),crypto=require('crypto'),{spawn,execFileSync}=require('child_process');
const {GatewayServer}=require('../gateway/server');
const {frameParser}=require('../gateway/websocket_proxy');
const {SavedTraffic}=require('../gateway/saved_traffic');
const types=['response.created','response.in_progress','response.output_item.added','response.output_item.done','response.completed'];
const replacement='Nội dung steer mới dài hơn bản gốc ✓ '.repeat(30);
function frame(value){const body=Buffer.from(value),head=Buffer.alloc(body.length<126?2:4);head[0]=0x81;head[1]=body.length<126?body.length:126;if(head.length===4)head.writeUInt16BE(body.length,2);return Buffer.concat([head,body]);}
async function run(executable,base,port,token,mode='',certificate=''){
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,[base,mode,...certificate?[certificate]:[]],{windowsHide:true,env:{...process.env,CODEX_TRACKER_GATEWAY_PORT:String(port),CODEX_TRACKER_GATEWAY_TOKEN:token}});
    let out='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>out+=c);
    const timeout=setTimeout(()=>{child.kill();reject(new Error('Runtime fixture timed out'));},20000);
    child.on('error',reject);child.on('close',code=>{clearTimeout(timeout);code===0?resolve(out.trim()):reject(new Error(out));});
  });
}
async function main(){
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'tracker-client-tls-'));
  const certificate=path.join(temporary,'cert.pem'),key=path.join(temporary,'key.pem'),logs=path.join(temporary,'logs');
  execFileSync(process.env.TRACKER_TEST_OPENSSL||'C:/Program Files/Git/mingw64/bin/openssl.exe',['req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-addext','basicConstraints=critical,CA:FALSE','-keyout',key,'-out',certificate],{windowsHide:true,stdio:'ignore'});
  const trace=[],received=[],sockets=new Set(),errors=[];
  const upstream=https.createServer({key:await fs.readFile(key),cert:await fs.readFile(certificate)},async(req,res)=>{
    try{
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      let bytes=Buffer.concat(chunks);const compressed=req.headers['content-encoding']==='zstd';if(compressed)bytes=zlib.zstdDecompressSync(bytes);
      received.push({method:req.method,path:req.url,compressed,body:bytes.toString('utf8')});
      if(req.url==='/backend-api/codex/responses'){
        res.writeHead(200,{'content-type':'text/event-stream'});
        for(const [index,type]of types.entries()){
          const wire=Buffer.from(`event: ${type}\r\ndata: ${JSON.stringify({type,sequence_number:index,response:{id:'http-response'},item:{id:'item',text:'Tiếng Việt ✓'}})}\r\n\r\n`);
          for(let offset=0;offset<wire.length;offset+=7)res.write(wire.subarray(offset,offset+7));
        }res.end();
      }else{res.writeHead(200,{'content-type':'application/json'});res.end('{"ok":true}');}
    }catch(error){errors.push(error);res.destroy();}
  });
  upstream.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',error=>{if(error.code!=='ECONNRESET')errors.push(error);});});
  upstream.on('upgrade',(req,socket,head)=>{
    const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const parse=frameParser('out',event=>{
      if(event.opcode===8){socket.end(Buffer.from([0x88,0]));return;}
      if(event.opcode!==1)return;
      received.push({method:'GET',path:req.url,protocol:'websocket',body:event.contentCapture.content});
      for(const [index,type]of types.entries())socket.write(frame(JSON.stringify({type,sequence_number:index,response:{id:'ws-response'},item:{id:'ws-item'}})));
    },{captureContent:true});socket.on('data',parse);if(head.length)parse(head);
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const gateway=new GatewayServer({port:0,captureMaxBytes:1024,trafficLogsDirectory:logs,trafficCaptureMode:'post-get',trace:{append:async event=>trace.push(event)}});const address=await gateway.start();
  const base=`https://127.0.0.1:${upstream.address().port}`;
  const rule=(method,path,pointer)=>({host:'127.0.0.1',method,path,operations:[{op:'replace',path:pointer,value:replacement}]});
  gateway.clientHook.filters.configure([rule('POST','/backend-api/codex/responses','/input/0/content/0/text'),rule('GET','/backend-api/codex/responses','/input/0/content/0/text'),rule('PUT','/metadata/update','/text')]);
  try{
    const executable=process.argv[2]||'.runtime-build/target/dev-small/examples/tracker_client_fixture.exe';
    const output=await run(executable,base,address.port,address.token,'',certificate);
    assert.deepEqual(errors,[]);assert.equal(received.length,5);
    const httpRequest=received.find(e=>e.path==='/backend-api/codex/responses'&&e.method==='POST');
    assert.equal(httpRequest.compressed,true);assert.equal(JSON.parse(httpRequest.body).input[0].content[0].text,replacement);
    const wsRequest=received.find(e=>e.protocol==='websocket');assert.equal(JSON.parse(wsRequest.body).input[0].content[0].text,replacement);
    for(const request of [httpRequest,wsRequest]){
      const captured=trace.find(e=>e.type==='client_request'&&e.stage==='CLIENT_JSON_PREPARED'&&e.method===request.method&&e.path===request.path);
      assert.equal(captured.bodySha256,crypto.createHash('sha256').update(request.body).digest('hex'));
    }
    assert.equal(JSON.parse(received.find(e=>e.method==='PUT').body).text,replacement);
    assert.ok(received.filter(e=>e.path!=='/raw'&&e.path!=='/metadata/list').every(e=>JSON.parse(e.body).model==='fixture-model'));
    for(const protocol of ['http','websocket'])assert.deepEqual(trace.filter(e=>e.type==='client_response_event'&&e.protocol===protocol).map(e=>e.eventType),types);
    assert.ok(trace.some(e=>e.method==='GET'&&e.path==='/metadata/list'&&e.direction==='in'));
    assert.ok(trace.some(e=>e.path==='/raw'&&e.type==='client_request'&&Buffer.from(e.contentCapture.content,'base64').toString()==='raw body fixture'));
    assert.ok(!trace.some(e=>e.stage==='CAPTURE_GAP'));
    await gateway.trafficLogs.flush();const reader=new SavedTraffic();await reader.open(logs,1000);assert.equal(reader.total,4);
    const saved=reader.snapshot().traffic.find(e=>e.method==='POST'&&e.path==='/backend-api/codex/responses');
    assert.equal((await reader.payload(saved.traceId,'request')).contentCapture.content,httpRequest.body);
    const savedEvents=(await reader.payload(saved.traceId,'events')).contentCapture.content.trim().split('\n').map(line=>JSON.parse(line).eventType);
    assert.deepEqual(savedEvents,types);
    gateway.clientHook.filters.configure([rule('POST','/backend-api/codex/responses','/missing/field')]);
    const before=received.length;await run(executable,base,address.port,address.token,'blocked',certificate);assert.equal(received.length,before);
    await run(executable,base,address.port,'wrong-token-123456789','blocked',certificate);assert.equal(received.length,before);
    console.log(JSON.stringify({passed:true,tls:true,fixtureOutput:output,upstreamRequests:received.length,httpMethod:'POST',websocketMethod:'GET',endpoint:'/backend-api/codex/responses',httpZstdEdited:true,websocketEdited:true,sharedHttpEdited:true,wireHashesMatch:true,eventsPerTransport:types,rejectedBeforeSend:true,captureGaps:0,savedPostGetRequests:reader.total,completeLogBodyDespiteUiLimit:true},null,2));
  }finally{await gateway.stop();for(const socket of sockets)socket.destroy();await new Promise(resolve=>upstream.close(resolve));await fs.rm(temporary,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
