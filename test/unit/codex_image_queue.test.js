'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createImageQueue}=require('../../src/codex_image_queue');
const image={name:'fixture.png',mimeType:'image/png',dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNoaGgAAAMEAYFL09IQAAAAAElFTkSuQmCC'};
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'image-queue-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const sent=[],live={turnId:'source',status:'inProgress',active:true};
 const options={file:path.join(root,'queue.json'),imageDirectory:path.join(root,'images'),readStatus:async()=>({...live}),send:async job=>{sent.push(job);live.turnId='next-'+sent.length;live.status='inProgress';live.active=true;return {turnId:live.turnId};}};
 const queue=createImageQueue(options);await queue.ready;t.after(()=>queue.dispose());
 return {root,queue,options,sent,live,enqueue:(id)=>queue.enqueue({requestId:id,threadId:'thread',sourceTurnId:live.turnId,message:id,images:[image]})};
}
test('image queue survives reload, waits for completion, and dispatches FIFO once across windows',async t=>{
 const f=await fixture(t);
 const first=await f.enqueue('first');await f.enqueue('first');await f.enqueue('second');
 await f.queue.tick();assert.equal(f.sent.length,0);
 const other=createImageQueue(f.options);await other.ready;t.after(()=>other.dispose());
 f.live.active=false;f.live.status='completed';
 await Promise.all([f.queue.tick(),other.tick()]);
 assert.equal(f.sent.length,1);assert.equal(f.sent[0].id,'first');assert.equal(f.sent[0].clientUserMessageId,first.clientUserMessageId);
 assert.equal(f.sent[0].images[0].dataUrl,image.dataUrl);
 f.live.active=false;f.live.status='completed';await other.tick();
 assert.equal(f.sent.length,2);assert.equal(f.sent[1].id,'second');assert.equal(f.sent[1].expectedPreviousTurnId,'next-1');
 await other.tick();assert.equal(f.sent.length,2);
 assert.equal((await fs.readdir(f.options.imageDirectory)).length,1);
});
test('paused Goals, waiting requests, cancellation and changed turns never auto-send',async t=>{
 const f=await fixture(t);await f.enqueue('cancel');
 f.live.active=false;f.live.status='completed';f.live.goalPaused=true;await f.queue.tick();assert.equal(f.sent.length,0);
 f.live.goalPaused=false;f.live.waiting=true;await f.queue.tick();assert.equal(f.sent.length,0);
 f.live.waiting=false;f.live.turnId='different';await f.queue.tick();assert.equal(f.sent.length,0);
 await f.queue.cancel('cancel');f.live.turnId='source';await f.queue.tick();assert.equal(f.sent.length,0);
});
test('uncertain delivery is retained and never replayed after reload',async t=>{
 const f=await fixture(t);f.options.send=async()=>{f.sent.push('attempt');throw Object.assign(new Error('ACK lost'),{delivery:'unknown'});};
 await f.enqueue('uncertain');f.live.active=false;f.live.status='completed';await f.queue.tick();
 assert.equal(f.queue.snapshot().jobs[0].phase,'unknown');
 const other=createImageQueue(f.options);await other.ready;t.after(()=>other.dispose());await other.tick();
 assert.equal(f.sent.length,1);
});
