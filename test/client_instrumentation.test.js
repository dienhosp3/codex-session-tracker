'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {JsonFilters}=require('../gateway/json_filters');
const {ResponseEvents}=require('../gateway/response_events');
const {ClientInstrumentation}=require('../gateway/client_instrumentation');
const {GatewayServer}=require('../gateway/server');
const types=['response.created','response.in_progress','response.output_item.added','response.output_item.done','response.completed'];
const meta={requestId:'r1',host:'chatgpt.com',method:'POST',path:'/backend-api/codex/responses',protocol:'http'};
const rule={id:'steer',host:meta.host,method:meta.method,path:meta.path,conditions:[{path:'/type',equals:'response.create'}],operations:[{op:'replace',path:'/input/0/content/0/text',value:'Nội dung mới dài hơn bản gốc rất nhiều ✓'}]};
const body=JSON.stringify({type:'response.create',model:'unchanged',input:[{content:[{text:'old'}]}]});

test('client capture keeps one complete BODY per original frame and preserves binary fragments',async()=>{
  const trace=[],client=new ClientInstrumentation({maxBytes:1024,record:async(event,payload)=>trace.push({event,payload})});
  await client.outbound({schemaVersion:1,...meta,url:'https://chatgpt.com'+meta.path,bodyJson:body});
  await client.observe({...meta,kind:'response_headers',headers:{'content-type':'text/plain'}});
  const frames=[Buffer.from([0xe2,0x9c]),Buffer.from([0x93]),Buffer.alloc(65537,65),Buffer.alloc(262151,66)];
  for(const [index,bytes]of frames.entries())await client.observe({...meta,kind:'response_chunk',bytes:bytes.toString('base64'),chunkIndex:index,captureBoundary:'http-client-body-frame'});
  const chunks=trace.filter(x=>x.event.stage==='CLIENT_RESPONSE_CHUNK');
  assert.equal(chunks.length,frames.length);
  for(const [index,{event,payload}]of chunks.entries()){
    assert.equal(event.chunkIndex,index);assert.equal(event.captureBoundary,'http-client-body-frame');assert.equal(event.contentCapture.truncated,false);
    assert.deepEqual(payload.bytes,frames[index]);assert.deepEqual(Buffer.from(event.contentCapture.content,event.contentCapture.encoding),frames[index]);
  }
});

test('derived SSE parsing failure does not discard the original BODY',async()=>{
  const trace=[],client=new ClientInstrumentation({record:async(event,payload)=>trace.push({event,payload})});
  await client.outbound({schemaVersion:1,...meta,url:'https://chatgpt.com'+meta.path,bodyJson:body});
  await client.observe({...meta,kind:'response_headers',headers:{'content-type':'text/event-stream'}});
  client.events.maxBytes=3;
  const bytes=Buffer.from('data: {"type":"response.completed"}\n\n');
  await client.observe({...meta,kind:'response_chunk',bytes:bytes.toString('base64'),chunkIndex:0,captureBoundary:'http-client-body-frame'});
  assert.deepEqual(trace.find(x=>x.event.stage==='CLIENT_RESPONSE_CHUNK').payload.bytes,bytes);
  assert.equal(trace.at(-1).event.stage,'RESPONSE_EVENT_PARSE_ERROR');
});

test('JSON filters change arbitrary length and preserve model, nested fields and hashes',()=>{
  const filters=new JsonFilters();filters.configure([rule]);const result=filters.apply(meta,body);
  assert.equal(JSON.parse(result.bodyJson).input[0].content[0].text,rule.operations[0].value);
  assert.equal(JSON.parse(result.bodyJson).model,'unchanged');assert.equal(result.modified,true);
  assert.notEqual(result.bodySha256,result.originalSha256);assert.deepEqual(result.appliedRules,['steer']);
});
test('identity and unmatched filters preserve exact bytes',()=>{
  const filters=new JsonFilters();filters.configure([rule]);
  for(const variation of [{method:'GET'},{host:'other.test'},{path:'/other'}])assert.equal(filters.apply({...meta,...variation},body).bodyJson,body);
  assert.equal(filters.apply(meta,' { "type": "other", "n": 1 } ').bodyJson,' { "type": "other", "n": 1 } ');
});
test('JSON patch array insert/remove, escaped pointers and invalid targets',()=>{
  const filters=new JsonFilters();filters.configure([{...rule,conditions:[],operations:[{op:'add',path:'/a/-',value:3},{op:'remove',path:'/a/0'},{op:'replace',path:'/a~1b/~0',value:2}]}]);
  assert.deepEqual(JSON.parse(filters.apply(meta,'{"a":[1,2],"a/b":{"~":0}}').bodyJson),{a:[2,3],'a/b':{'~':2}});
  assert.throws(()=>filters.apply(meta,'{}'),/parent/);
  for(const pointer of ['/__proto__/x','/constructor/x','/model'])assert.throws(()=>filters.configure([{...rule,operations:[{op:'add',path:pointer,value:'x'}]}]));
});
test('SSE keeps every requested event, UTF-8 and CRLF split at every byte',()=>{
  const events=[],parser=new ResponseEvents(event=>events.push(event));
  const wire=Buffer.from(types.map((type,index)=>`event: ${type}\r\ndata: ${JSON.stringify({type,sequence_number:index,response:{id:'res-1'},item:{id:'item-1',text:'Tiếng Việt ✓'}})}\r\n\r\n`).join(''));
  for(const byte of wire)parser.chunk(meta,Buffer.from([byte]));
  assert.deepEqual(events.map(event=>event.eventType),types);assert.deepEqual(events.map(event=>event.sequenceNumber),[0,1,2,3,4]);
  assert.ok(events.every(event=>event.responseId==='res-1'&&event.itemId==='item-1'&&event.data.includes('Tiếng Việt ✓')));
});
test('SSE and WS preserve unknown events and multiline data',()=>{
  const events=[],parser=new ResponseEvents(event=>events.push(event));
  parser.chunk(meta,Buffer.from(': comment\nid: 9\nevent: custom.event\ndata: {"type":\ndata: "custom.event"}\n\n'));
  parser.websocket({...meta,protocol:'websocket'},'{"type":"future.new_event","response_id":"r2"}');
  assert.deepEqual(events.map(event=>event.eventType),['custom.event','future.new_event']);assert.equal(events[0].sseId,'9');assert.equal(events[1].responseId,'r2');
});
test('SSE limits are explicit instead of silently discarding events',()=>{
  const parser=new ResponseEvents(()=>{},{maxBytes:5});assert.throws(()=>parser.chunk(meta,Buffer.from('data: abcdef\n')),/capture/);
});
test('client bridge records real endpoint, changed body, ordered events and explicit gaps',async()=>{
  const trace=[],client=new ClientInstrumentation({record:async event=>trace.push(event)});client.filters.configure([rule]);
  const prepared=await client.outbound({schemaVersion:1,...meta,url:'https://chatgpt.com/backend-api/codex/responses?secret=removed',bodyJson:body,runtimeVersion:'0.159.2'});
  assert.equal(JSON.parse(prepared.bodyJson).input[0].content[0].text,rule.operations[0].value);
  await client.observe({...meta,kind:'response_headers',statusCode:200,headers:{'content-type':'text/event-stream'}});
  await client.observe({...meta,kind:'response_chunk',bytes:Buffer.from(types.map(type=>`data: ${JSON.stringify({type})}\n\n`).join('')).toString('base64')});
  await client.observe({kind:'dropped',count:3});
  assert.deepEqual(trace.filter(e=>e.type==='client_response_event').map(e=>e.eventType),types);
  assert.equal(trace[0].method,'POST');assert.equal(trace[0].path,meta.path);assert.ok(!JSON.stringify(trace).includes('secret=removed'));
  assert.equal(trace.at(-1).stage,'CAPTURE_GAP');assert.equal(client.diagnostics().responseEventsObserved,5);
});
test('instrumentation API requires token and acknowledges exact request ID',async t=>{
  const server=new GatewayServer({port:0});const address=await server.start();t.after(()=>server.stop());
  const url=`http://127.0.0.1:${address.port}/instrumentation/v1/outbound`,input={schemaVersion:1,...meta,url:'https://chatgpt.com'+meta.path,bodyJson:body};
  assert.equal((await fetch(url,{method:'POST',body:JSON.stringify(input)})).status,401);
  const res=await fetch(url,{method:'POST',headers:{'X-Codex-Gateway-Token':address.token},body:JSON.stringify(input)});
  assert.equal(res.status,200);const ack=await res.json();assert.equal(ack.requestId,'r1');assert.equal(ack.bodyJson,body);
});
test('client send/response observations update model diagnostics; prepared JSON is not delivery',async()=>{
  const {CodexGateway}=require('../gateway');const gateway=new CodexGateway();
  const command=gateway.createCommand('steer',{threadId:'thread-1',message:'hi'});
  const event={type:'client_request',stage:'CLIENT_JSON_PREPARED',kind:'MODEL_REQUEST',method:'POST',path:meta.path,threadId:'thread-1',requestId:'request-1',direction:'out',at:Date.now()};
  await gateway.onNetworkEvent(event);assert.equal(gateway.diagnostics().modelTrafficObserved,false);
  await gateway.onNetworkEvent({...event,stage:'CLIENT_TRANSPORT_SENT'});assert.equal(gateway.diagnostics().modelTrafficObserved,true);
  assert.ok(command.state.events.some(e=>e.stage==='UPSTREAM_BYTES_SENT'&&e.source==='codex-client-hook'));
  const before=command.state.events.length;await gateway.onNetworkEvent({...event,stage:'CLIENT_RESPONSE_HEADERS',threadId:'other-thread'});assert.equal(command.state.events.length,before);
});
