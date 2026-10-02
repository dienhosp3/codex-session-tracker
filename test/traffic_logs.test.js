'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs/promises'),path=require('path'),os=require('os');
const {TrafficLogs}=require('../gateway/traffic_logs'),{TrafficPolicy}=require('../gateway/traffic_policy'),{SavedTraffic}=require('../gateway/saved_traffic');
const request=(id,method='POST',endpoint='/backend-api/codex/responses')=>({type:'client_request',stage:'CLIENT_JSON_PREPARED',at:Date.now(),requestId:id,method,path:endpoint,targetHost:'chatgpt.com',targetPort:443,protocol:'http',direction:'out'});
test('capture limit counts requests, keeps replies and excludes tunnel/TLS/PUT at ingestion',()=>{
  const policy=new TrafficPolicy({mode:'post-get',maxRequests:1});assert.equal(policy.allows(request('one')),true);
  assert.equal(policy.allows({...request('one'),type:'client_response_event',direction:'in',eventType:'response.completed'}),true);
  assert.equal(policy.allows(request('two','GET')),false);
  for(const type of ['connect_tunnel','tunnel_bytes','native_tls_record'])assert.equal(policy.allows({type,connectionId:'tunnel'}),false);
  assert.equal(policy.allows(request('put','PUT')),false);assert.equal(policy.snapshot().trafficRequestsCaptured,1);
  policy.configure({maxRequests:2});assert.equal(policy.allows(request('two','GET')),true);
});
test('POST/GET logs preserve complete bodies, separate responses and support folder browsing',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tracker-logs-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const logs=new TrafficLogs({directory}),body=Buffer.from('Tiếng Việt ✓ '.repeat(20000));
  await logs.append({...request('post'),contentCapture:{encoding:'utf8',content:'truncated',truncated:true}},{bytes:body});
  await logs.append({...request('post'),type:'client_response',stage:'CLIENT_RESPONSE_HEADERS',statusCode:200,headers:{'content-type':'text/event-stream'}});
  for(const bytes of [Buffer.from('data: {"type":"response.'),Buffer.from('completed"}\n\n')])await logs.append({...request('post'),type:'client_response',stage:'CLIENT_RESPONSE_CHUNK',direction:'in',size:bytes.length},{bytes});
  await logs.append({...request('post'),type:'client_response_event',stage:'RESPONSE_EVENT',eventType:'response.completed',direction:'in'},{bytes:Buffer.from('{"type":"response.completed"}')});
  await logs.append(request('get','GET','/backend-api/models'),{bytes:Buffer.alloc(0)});
  await logs.append(request('put','PUT','/backend-api/models'),{bytes:Buffer.from('excluded')});
  assert.equal(logs.requests.size,2);assert.ok(logs.requests.get('post').folder.includes(path.sep+'codex-responses'+path.sep));
  assert.ok(logs.requests.get('get').folder.includes(path.sep+'endpoints'+path.sep));
  assert.deepEqual(await fs.readFile(path.join(logs.requests.get('post').folder,'request.body')),body);
  const reader=new SavedTraffic();await reader.open(directory,10);assert.equal(reader.total,2);
  const post=reader.snapshot().traffic.find(e=>e.requestId==='post');assert.equal(post.statusCode,200);
  assert.equal((await reader.payload(post.traceId,'response')).contentCapture.content,'data: {"type":"response.completed"}\n\n');
  assert.equal(JSON.parse((await reader.payload(post.traceId,'events')).contentCapture.content).eventType,'response.completed');
  const first=await reader.payload(post.traceId,'request');assert.equal(first.contentCapture.complete,true);
  await reader.open(directory,1);assert.equal(reader.snapshot().loaded,1);assert.equal(reader.snapshot().total,2);
  await assert.rejects(reader.payload(reader.snapshot().traffic[0].traceId,'../../outside'),/Invalid/);
});

test('saved logs index response events and recover each original BODY and event payload',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tracker-log-events-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const logs=new TrafficLogs({directory}),base={...request('events','GET'),protocol:'websocket',kind:'MODEL_REQUEST'};
  await logs.append(base,{bytes:Buffer.from('{"stream":true}')});
  const frames=[Buffer.from('response first ✓'),Buffer.from([0xe2,0x9c]),Buffer.alloc(65537,65)];
  for(const [chunkIndex,bytes]of frames.entries())await logs.append({...base,type:'client_response',stage:'CLIENT_RESPONSE_CHUNK',direction:'in',size:bytes.length,chunkIndex,captureBoundary:'websocket-message'},{bytes});
  for(const eventType of ['response.created','response.output_text.delta','response.completed'])await logs.append({...base,type:'client_response_event',stage:'RESPONSE_EVENT',direction:'in',eventType},{bytes:Buffer.from(JSON.stringify({type:eventType,delta:'Tiếng Việt ✓'}))});
  const reader=new SavedTraffic();await reader.open(directory,1);const snapshot=reader.snapshot();
  assert.equal(snapshot.loaded,1);assert.equal(snapshot.total,1);assert.equal(snapshot.eventCount,7);
  const events=snapshot.traffic.filter(e=>e.type==='client_response_event');
  assert.deepEqual(events.map(e=>e.eventType),['response.created','response.output_text.delta','response.completed']);
  for(const event of events){
    assert.equal(event.direction,'in');assert.equal(event.method,'GET');assert.equal(event.kind,'MODEL_REQUEST');
    const payload=await reader.payload(event.traceId,'event');assert.equal(JSON.parse(payload.contentCapture.content).type,event.eventType);
  }
  // Re-select a preceding event after a later one: the cached byte offset remains correct.
  assert.equal(JSON.parse((await reader.payload(events[0].traceId,'event')).contentCapture.content).type,'response.created');
  for(const [index,event]of snapshot.traffic.filter(e=>e.stage==='CLIENT_RESPONSE_CHUNK').entries()){
    const payload=await reader.payload(event.traceId,'event');assert.deepEqual(Buffer.from(payload.contentCapture.content,payload.contentCapture.encoding),frames[index]);
  }
  const selected=snapshot.traffic.find(e=>e.savedEvent&&e.stage==='CLIENT_JSON_PREPARED');
  assert.equal((await reader.payload(selected.traceId,'event')).contentCapture.content,'{"stream":true}');
  assert.equal((await reader.payload(events[0].traceId,'response')).contentCapture.totalBytes,Buffer.concat(frames).length);
});
test('directory changes affect new requests; in-flight replies stay with their original request',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tracker-logs-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const logs=new TrafficLogs({directory:path.join(directory,'a')});await logs.append(request('a'),{bytes:Buffer.from('{}')});
  logs.configure({directory:path.join(directory,'b')});await logs.append(request('b'),{bytes:Buffer.from('{}')});
  await logs.append({...request('a'),type:'client_response',stage:'CLIENT_RESPONSE_CHUNK'},{bytes:Buffer.from('reply')});
  assert.ok(logs.requests.get('a').folder.startsWith(path.join(directory,'a')));assert.ok(logs.requests.get('b').folder.startsWith(path.join(directory,'b')));
  assert.equal(await fs.readFile(path.join(logs.requests.get('a').folder,'response.body'),'utf8'),'reply');
});
test('log failures surface an error and capture gaps are retained',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tracker-logs-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const blocker=path.join(directory,'file');await fs.writeFile(blocker,'x');const failed=new TrafficLogs({directory:blocker});await failed.append(request('a'));assert.ok(failed.snapshot().trafficLogsError);
  const logs=new TrafficLogs({directory});await logs.append({type:'client_hook_status',stage:'CAPTURE_GAP',at:Date.now(),size:3});
  const folder=path.join(directory,new Date(logs.sessionStartedAt).toISOString().slice(0,10),logs.session);
  assert.equal(JSON.parse(await fs.readFile(path.join(folder,'capture.gaps.jsonl'),'utf8')).size,3);
});
test('saved payload pagination preserves Unicode across byte boundaries',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tracker-logs-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const logs=new TrafficLogs({directory}),text='x'.repeat(512*1024-1)+'✓ remaining';await logs.append(request('unicode'),{bytes:Buffer.from(text)});
  const reader=new SavedTraffic();await reader.open(directory);const id=reader.snapshot().traffic[0].traceId;
  const first=await reader.payload(id),second=await reader.payload(id,'request',first.contentCapture.nextOffset);
  assert.equal(first.contentCapture.content+second.contentCapture.content,text);
  const whole=await reader.payload(id,'request',0,{whole:true});
  assert.equal(whole.contentCapture.content,text);assert.equal(whole.contentCapture.complete,true);
});
