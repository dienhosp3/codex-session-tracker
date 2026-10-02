'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {PlaintextStream}=require('../gateway/plaintext_stream');
const {NativeInstrumentation}=require('../gateway/native_instrumentation');

function fixture(){
  const events=[];
  const parser=new PlaintextStream({capture:true,record:event=>events.push(event)});
  let sequence=0;
  const feed=(direction,data)=>parser.feed({connectionId:'fixture',direction,sequence:++sequence,at:100,targetHost:'localhost'},Buffer.from(data));
  return {events,parser,feed};
}

test('TLS fragments reconstruct HTTP endpoints while keeping auth out of captured content',()=>{
  const {events,feed}=fixture();
  const request='POST /backend-api/codex/responses?token=secret-query HTTP/1.1\r\nAuthorization: Bearer secret-auth\r\nCookie: secret-cookie\r\nContent-Type: application/json\r\nContent-Length: 15\r\n\r\n{"value":"old"}';
  for(let i=0;i<request.length;i+=3)feed('out',request.slice(i,i+3));
  feed('in','HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nSet-Cookie: secret-cookie\r\n\r\n');
  feed('in','4\r\ndata\r');feed('in','\n3\r\n: x\r\n0\r\nSecret-Trailer: secret-trailer\r\n\r\n');
  assert.equal(events[0].method,'POST');
  assert.equal(events[0].path,'/backend-api/codex/responses');
  const response=events.filter(e=>e.stage==='PLAINTEXT_RESPONSE_BODY');
  assert.equal(response.map(e=>e.contentCapture.content).join(''),'data: x');
  assert.ok(response.every(e=>e.path==='/backend-api/codex/responses'));
  const logged=JSON.stringify(events);
  for(const secret of ['secret-query','secret-auth','secret-cookie','secret-trailer'])assert.ok(!logged.includes(secret),secret);
});

test('mid-connection attach discards unsynchronized plaintext rather than leaking credentials',()=>{
  const {feed,events}=fixture();
  feed('out','authorization: Bearer secret\r\n\r\nsensitive');
  assert.equal(events.length,0);
});

test('HTTP/2 DATA uses decoded endpoint for the correct stream and strips padding',()=>{
  const {parser,feed,events}=fixture();
  feed('out','PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n');
  parser.headers({connectionId:'fixture',direction:'out',at:100,streamId:3,headers:{':method':'POST',':path':'/v1/responses',':authority':'localhost','content-type':'application/json'}});
  const data=Buffer.from('{"hello":1}');
  const frame=Buffer.alloc(9+1+data.length+2);
  frame.writeUIntBE(frame.length-9,0,3);frame[3]=0;frame[4]=8;frame.writeUInt32BE(3,5);frame[9]=2;data.copy(frame,10);
  feed('out',frame.subarray(0,7));feed('out',frame.subarray(7));
  const body=events.find(e=>e.stage==='PLAINTEXT_REQUEST_BODY');
  assert.equal(body.path,'/v1/responses');assert.equal(body.method,'POST');assert.equal(body.contentCapture.content,'{"hello":1}');
});

test('WebSocket handshake endpoint is retained and masked JSON is decoded without auth headers',()=>{
  const {feed,events}=fixture();
  feed('out','GET /codex/responses HTTP/1.1\r\nAuthorization: secret\r\nUpgrade: websocket\r\n\r\n');
  feed('in','HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  const text=Buffer.from('{"type":"response.create"}');const mask=Buffer.from([1,2,3,4]);
  const frame=Buffer.concat([Buffer.from([0x81,0x80|text.length]),mask,Buffer.from(text.map((v,i)=>v^mask[i%4]))]);
  feed('out',frame);
  const event=events.at(-1);assert.equal(event.stage,'PLAINTEXT_WEBSOCKET_FRAME');assert.equal(event.path,'/codex/responses');assert.equal(event.contentCapture.content,text.toString());
});

test('outbound rule validation rejects length-changing TLS edits before reaching the hook',()=>{
  const hook=new NativeInstrumentation();const commands=[];
  hook.state.configured=true;hook.child={stdin:{write:value=>commands.push(JSON.parse(value))}};
  assert.throws(()=>hook.setOutboundRules([{host:'localhost',find:[1],replace:[1,2]}]),/equal-length/);
  assert.equal(commands.length,0);
  hook.setOutboundRules([{host:'localhost',find:[1],replace:[2]}]);
  assert.equal(commands[0].options.rules[0].replace[0],2);
});
