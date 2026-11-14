'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {appServerFixture}=require('../fixtures/app_server_fixture');
const {contextConfig}=require('../../src/codex_new_chat');
const {queueMessage,findBundledCodex}=require('../../src/codex_queue');
const {createImageQueue}=require('../../src/codex_image_queue');
const image={name:'fixture.png',mimeType:'image/png',dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNoaGgAAAMEAYFL09IQAAAAAElFTkSuQmCC'};
const permissions={start:{approvalPolicy:'never',sandbox:'danger-full-access'},turn:{approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'}}};
async function waitFor(predicate){for(let i=0;i<160;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('Native image request did not complete');}
function hasImage(value){if(Array.isArray(value))return value.some(hasImage);if(!value||typeof value!=='object')return false;return value.type==='input_image'&&typeof value.image_url==='string'&&value.image_url.startsWith('data:image/')||Object.values(value).some(hasImage);}
test('installed Codex forwards images in fresh, normal, Plan and Goal requests to loopback only',{timeout:55000},async()=>{
 const f=await appServerFixture();
 try{
  const config=contextConfig('default',{model:'gpt-6-astra',defaultTokens:272000,maxTokens:872000,effectivePercent:95});
  const fresh=await f.backend.createFreshChat({cwd:f.root,model:'gpt-6-astra',contextConfig:config,message:'Inspect image',images:[image]});
  await waitFor(()=>f.requests.length===1);assert.ok(hasImage(f.requests[0]));
  await waitFor(()=>f.events.some(e=>e.method==='turn/completed'&&e.params.threadId===fresh.id));
  for(const mode of ['normal','plan','goal']){
   const next=await f.backend.createSuccessor({cwd:f.root,model:'gpt-6-astra',permissionSettings:permissions,contextConfig:config});
   const before=f.requests.length;
   const result=await f.backend.startSuccessor({threadId:next.id,model:'gpt-6-astra',message:'Continue with this image',images:[image],permissionSettings:permissions,successorMode:mode,goalText:'Inspect the supplied image and finish.',clientUserMessageId:'image-'+mode});
   await waitFor(()=>f.requests.length>before);assert.ok(hasImage(f.requests.at(-1)),mode+' lost the image');
   await waitFor(()=>f.events.some(e=>e.method==='turn/completed'&&e.params.turn?.id===result.turnId));
   if(mode==='goal')await f.rpc('thread/goal/set',{threadId:next.id,status:'paused'});
  }
  console.log('Installed native image inputs verified across fresh/normal/Plan/Goal; external model requests: 0.');
 }finally{await f.close();}
});
test('durable Tracker image queue delivers through installed native owner after the original turn ends',{timeout:30000},async()=>{
 const f=await appServerFixture();
 let queue;
 try{
  const thread=(await f.rpc('thread/start',{cwd:f.root})).thread;
  const turn=(await f.rpc('turn/start',{threadId:thread.id,input:[{type:'text',text:'First turn'}]})).turn;
  await waitFor(()=>f.events.some(e=>e.method==='turn/completed'&&e.params.turn?.id===turn.id));
  queue=createImageQueue({file:path.join(f.root,'queue.json'),imageDirectory:path.join(f.root,'retained'),readStatus:id=>f.backend.readRecoveryState(id),
   send:job=>f.backend.continueConversation({conversationId:job.threadId,expectedPreviousTurnId:job.expectedPreviousTurnId,clientUserMessageId:job.clientUserMessageId,input:[{type:'text',text:job.message},...job.images.map(image=>({type:'image',url:image.dataUrl}))]})});
  await queue.ready;
  await queue.enqueue({requestId:'image-queue-fixture',threadId:thread.id,sourceTurnId:turn.id,message:'Queued image fixture',images:[image]});
  await queue.tick();assert.equal(queue.snapshot().jobs[0].phase,'sent');
  await waitFor(()=>f.requests.length>=2);assert.ok(hasImage(f.requests.at(-1)));
  await queue.tick();assert.equal(queue.snapshot().jobs.filter(job=>job.phase==='sent').length,1);
  assert.equal((await fs.readdir(path.join(f.root,'retained'))).filter(name=>name.endsWith('.png')).length,1);
  console.log('Durable image queue sent one image turn through installed native owner; external model calls: 0.');
 }finally{queue?.dispose();await f.close();}
});
