'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),net=require('net');
const {createLiveBackend,installOwnerBridge,continueInLocalBackend,disposeOwnerBridges}=require('../codex_live_backend');
const ipc=require('../codex_steer');
const {CodexGateway}=require('../gateway');
const input={conversationId:'target',clientUserMessageId:'stable-uuid',input:[{type:'text',text:'Tiếp tục công việc',text_elements:[]}]};
function fixture(options={}){
 const calls=[],providers=new Map();let loaded=options.loaded!==false,reads=0;
 const connection={initialized:true,proc:{pid:44,stdin:{destroyed:false}},registerProvider(name,p){providers.set(name,p);return{dispose:()=>providers.delete(name)}},sendRequest(name,id,method,params){
  calls.push({method,params});const p=providers.get(name);let result,error;
  if(method==='thread/read'){reads++;result={thread:{id:options.wrongRoot||options.wrongHistory&&params.includeTurns?'wrong':'target',status:{type:options.active||options.race&&reads>1?'active':loaded?'idle':'notLoaded'},...(params.includeTurns?{turns:[{id:'older-turn',status:'completed'},{id:'old-turn',status:options.inProgress?'inProgress':'completed'}]}:{})}};}
  else if(method==='thread/turns/list'){result={data:[{id:'old-turn',status:options.inProgress?'inProgress':'completed'}]};if(options.pagingError)error={message:options.pagingError};}
  else if(method==='thread/loaded/list')result={data:loaded?['target']:[],nextCursor:null};
  else if(method==='thread/resume'){loaded=true;result={thread:{id:options.wrongResume?'wrong':'target'}};if(options.resumeError)error={message:'resume failed'};}
  else if(method==='turn/start'){if(options.timeout)return;result={turn:{id:options.wrongAck?'old-turn':'new-turn',status:'inProgress'}};}
  queueMicrotask(()=>p.onResult({id,...(error?{error}:{result})}));
 }};
 return {connection,calls};
}
for(const loaded of [true,false])test('continue '+(loaded?'loaded':'unloaded')+' stopped chat starts exactly one new turn in the same thread',async()=>{
 const f=fixture({loaded}),b=createLiveBackend(f.connection);
 try{
  const r=await b.continueConversation(input);assert.equal(r.turnId,'new-turn');assert.equal(r.resumed,!loaded);
  assert.equal(f.calls.filter(c=>c.method==='turn/start').length,1);
  assert.deepEqual(f.calls.find(c=>c.method==='turn/start').params,{threadId:'target',input:input.input,clientUserMessageId:'stable-uuid'});
  const resumes=f.calls.filter(c=>c.method==='thread/resume');assert.equal(resumes.length,loaded?0:1);
  if(!loaded)assert.deepEqual(resumes[0].params,{threadId:'target',excludeTurns:true});
  assert.equal(f.calls.some(c=>['thread/start','turn/interrupt','turn/steer'].includes(c.method)),false);
 }finally{b.dispose();}
});
test('unsupported live turn paging reads full history and chooses the newest terminal turn',async()=>{
 const f=fixture({pagingError:'list_turns is not supported yet'}),b=createLiveBackend(f.connection);
 try{const r=await b.continueConversation(input);assert.equal(r.previousTurnId,'old-turn');assert.equal(r.turnId,'new-turn');}
 finally{b.dispose();}
 assert.equal(f.calls.filter(c=>c.method==='thread/read'&&c.params.includeTurns).length,2);
});
for(const options of [{pagingError:'read failed'},{pagingError:'list_turns is not supported yet',wrongHistory:true},{pagingError:'list_turns is not supported yet',inProgress:true}])test('history fallback does not hide '+JSON.stringify(options),async()=>{
 const f=fixture(options),b=createLiveBackend(f.connection);
 try{await assert.rejects(b.continueConversation(input));}finally{b.dispose();}
 assert.equal(f.calls.some(c=>c.method==='turn/start'),false);
 if(options.pagingError==='read failed')assert.equal(f.calls.some(c=>c.method==='thread/read'&&c.params.includeTurns),false);
});
for(const options of [{active:true},{inProgress:true},{loaded:false,race:true},{wrongRoot:true},{loaded:false,wrongResume:true},{loaded:false,resumeError:true}])test('continuation rejects '+JSON.stringify(options)+' before message submission',async()=>{
 const f=fixture(options),b=createLiveBackend(f.connection);
 try{await assert.rejects(b.continueConversation(input));}finally{b.dispose();}
 assert.equal(f.calls.some(c=>c.method==='turn/start'),false);
});
for(const option of ['timeout','wrongAck'])test('continue '+option+' keeps delivery unknown and does not retry',async()=>{
 const f=fixture({[option]:true}),b=createLiveBackend(f.connection,{timeoutMs:15});
 try{await assert.rejects(b.continueConversation(input),e=>e.delivery==='unknown');}finally{b.dispose();}
 assert.equal(f.calls.filter(c=>c.method==='turn/start').length,1);
});
test('local continuation advertises ownership and later direct steer can find this chat',async()=>{
 const f=fixture({loaded:false}),owned=new Set(),start=[()=>false,()=>{throw new Error('native')}];
 const handlers=new Map([['thread-owner-discovery',[()=>true,()=>({})]],['thread-follower-steer-turn',[()=>false,()=>{}]],['thread-follower-start-turn',start]]);
 const stream={ipcClient:{requestHandlers:handlers},ownsThread:(_,id)=>owned.has(id),setThreadOwnership({conversationId,ownsThread}){if(ownsThread)owned.add(conversationId)}};
 try{installOwnerBridge([f.connection],[stream]);const r=await continueInLocalBackend(input);assert.equal(r.turnId,'new-turn');assert.equal(owned.has('target'),true);assert.equal(handlers.get('thread-follower-steer-turn')[0]({...input,trackerDirectSteer:1},{}),true);}
 finally{disposeOwnerBridges();}
 assert.equal(handlers.get('thread-follower-start-turn'),start);
});
test('completed chat held by backend is discoverable without cached webview ownership; native requests stay native',async()=>{
 const f=fixture(),owned=new Set();let nativeCalls=0;
 const discovery=[()=>false,()=>({supportsUntrustedAppInput:true})],start=[()=>{nativeCalls++;return false},()=>{nativeCalls++;return 'native-result'}];
 const handlers=new Map([['thread-owner-discovery',discovery],['thread-follower-steer-turn',[()=>false,()=>{}]],['thread-follower-start-turn',start]]);
 const stream={ipcClient:{requestHandlers:handlers},ownsThread:(_,id)=>owned.has(id),setThreadOwnership({conversationId}){owned.add(conversationId)}};
 try{
  installOwnerBridge([f.connection],[stream]);
  const [canDiscover,describe]=handlers.get('thread-owner-discovery');
  assert.equal(await canDiscover({hostId:'local',conversationId:'target'},{}),false);
  assert.equal(await canDiscover({hostId:'local',conversationId:'target',trackerContinueDiscovery:1},{}),true);
  assert.equal(await canDiscover({hostId:'local',conversationId:'other',trackerContinueDiscovery:1},{}),false);
  assert.equal(await canDiscover({hostId:'remote',conversationId:'target',trackerContinueDiscovery:1},{}),false);
  assert.equal((await describe({})).supportsTrackerContinue,true);
  const [canStart,startTurn]=handlers.get('thread-follower-start-turn'),direct={...input,trackerContinue:1};
  assert.equal(await canStart(direct,{}),true);
  assert.equal(await canStart({...direct,conversationId:'other'},{}),false);
  assert.equal((await startTurn({params:direct})).turnId,'new-turn');
  assert.equal(owned.has('target'),true);assert.equal(f.calls.some(c=>c.method==='thread/resume'),false);
  assert.equal(await canStart(input,{}),false);assert.equal(await startTurn({params:input}),'native-result');assert.equal(nativeCalls,2);
 }finally{disposeOwnerBridges();}
 assert.equal(handlers.get('thread-owner-discovery'),discovery);assert.equal(handlers.get('thread-follower-start-turn'),start);
});

async function server(onRequest,run){
 const requests=[],s=net.createServer(socket=>{let buffer=Buffer.alloc(0);socket.on('data',b=>{buffer=ipc.parseIpcFrames(Buffer.concat([buffer,b]),r=>{requests.push(r);onRequest(r,socket)})})});
 await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));const connectImpl=(_,cb)=>net.connect({host:'127.0.0.1',port:s.address().port},cb);
 try{await run(connectImpl,requests);}finally{await new Promise(resolve=>s.close(resolve));}
}
function response(request,socket,extra={}){socket.write(ipc.frameIpcMessage({type:'response',requestId:request.requestId,resultType:'success',method:request.method,result:request.method==='initialize'?{clientId:'client'}:{supportsTrackerContinue:true},...(request.method==='thread-owner-discovery'?{handledByClientId:'owner'}:{}),...extra}));}
test('continue routes to the existing owner using the versioned start method and stable UUID',async()=>{
 let fallbacks=0;
 await server((r,s)=>response(r,s,r.method==='thread-follower-start-turn'?{result:{turnId:'new-turn',transport:'codex-existing-app-server'}}:{}),async(connectImpl,requests)=>{
  const r=await ipc.continueConversation({threadId:'target',message:'Tiếp tục',clientUserMessageId:'uuid',connectImpl,localContinue:()=>{fallbacks++}});
  assert.equal(r.turnId,'new-turn');assert.equal(fallbacks,0);
  const sent=requests[2];assert.equal(sent.method,'thread-follower-start-turn');assert.equal(sent.version,2);assert.equal(sent.params.trackerContinue,1);assert.equal(sent.params.clientUserMessageId,'uuid');assert.equal(sent.targetClientId,'owner');
 });
});
test('no owner uses local existing backend once for an unopened completed chat',async()=>{
 let calls=0;
 await server((r,s)=>response(r,s,r.method==='thread-owner-discovery'?{resultType:'error',error:'no-client-found'}:{}),async(connectImpl,requests)=>{
  const r=await ipc.continueConversation({threadId:'target',message:'Tiếp tục',connectImpl,localContinue:async p=>{calls++;assert.equal(p.conversationId,'target');return{turnId:'local-turn'}}});
  assert.equal(r.turnId,'local-turn');assert.equal(calls,1);assert.equal(requests.length,2);
 });
});
test('an existing unsupported owner never falls back to a competing host',async()=>{
 await server((r,s)=>response(r,s,r.method==='thread-owner-discovery'?{result:{}}:{}),async(connectImpl,requests)=>{
  let calls=0;await assert.rejects(ipc.continueConversation({threadId:'target',message:'Continue',connectImpl,localContinue:()=>{calls++}}),e=>e.delivery==='not_sent');assert.equal(calls,0);assert.equal(requests.length,2);
 });
});
test('start disconnect after routing is unknown without falling back or resending',async()=>{
 await server((r,s)=>r.method==='thread-follower-start-turn'?s.destroy():response(r,s),async(connectImpl,requests)=>{
  let calls=0;await assert.rejects(ipc.continueConversation({threadId:'target',message:'Continue',connectImpl,localContinue:()=>{calls++}}),e=>e.delivery==='unknown');assert.equal(calls,0);assert.equal(requests.filter(r=>r.method==='thread-follower-start-turn').length,1);
 });
});
test('gateway tracks continuation separately from steer, preserving the target, UUID and new-turn ACK',async()=>{
 let received;
 const gateway=new CodexGateway({port:0,handlers:{continue:async p=>{
  received=p;await p.onProgress({stage:'OWNER_ROUTED',source:'test-owner'});
  await p.onProgress({stage:'CORE_ACCEPTED',source:'test-core',turnId:'new-turn'});
  return{turnId:'new-turn'};
 }}});
 const r=await gateway.continueConversation({threadId:'target',message:'Next',clientUserMessageId:'fixed-uuid'});
 assert.equal(received.threadId,'target');assert.equal(received.message,'Next');assert.equal(received.clientUserMessageId,'fixed-uuid');
 assert.equal(r.delivery.action,'continue');assert.equal(r.delivery.stage,'CORE_ACCEPTED');assert.equal(r.turnId,'new-turn');
});
test('gateway preserves unknown continuation delivery and never retries the start handler',async()=>{
 let calls=0;
 const gateway=new CodexGateway({port:0,handlers:{continue:async()=>{calls++;const e=new Error('lost ACK');e.delivery='unknown';throw e}}});
 await assert.rejects(gateway.continueConversation({threadId:'target',message:'Next'}),e=>Boolean(e.delivery==='unknown'&&e.gatewayCommandId&&e.clientUserMessageId));
 assert.equal(calls,1);assert.equal([...gateway.commands.values()][0].state.snapshot().terminal,'DELIVERY_UNKNOWN');
});
test('disposed backend refuses continuation before registering or sending any request',async()=>{
 const f=fixture(),b=createLiveBackend(f.connection);b.dispose();b.dispose();
 assert.equal(b.available(),false);await assert.rejects(b.continueConversation(input),e=>e.delivery==='not_sent');assert.equal(f.calls.length,0);
});
test('a reloaded bridge module adopts the existing provider for local continuation and disposes it',async()=>{
 const f=fixture({loaded:false}),handlers=new Map([['thread-owner-discovery',[()=>false,()=>({})]],['thread-follower-steer-turn',[()=>false,()=>{}]],['thread-follower-start-turn',[()=>false,()=>{}]]]);
 const stream={ipcClient:{requestHandlers:handlers},ownsThread:()=>false};let reloaded;
 try{
  installOwnerBridge([f.connection],[stream]);
  const filename=require.resolve('../codex_live_backend'),cached=require.cache[filename];
  try{delete require.cache[filename];reloaded=require('../codex_live_backend');}finally{require.cache[filename]=cached;}
  reloaded.installOwnerBridge([f.connection],[stream]);
  assert.equal((await reloaded.continueInLocalBackend(input)).turnId,'new-turn');
  reloaded.disposeOwnerBridges();assert.equal(reloaded.installedBridgeInfo().length,0);
  await assert.rejects(continueInLocalBackend(input),e=>e.delivery==='not_sent');
 }finally{reloaded?.disposeOwnerBridges();disposeOwnerBridges();}
});
