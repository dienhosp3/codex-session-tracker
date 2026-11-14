'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {appServerFixture}=require('../fixtures/app_server_fixture');
const {prepareFamilyIdentityEdit,identityFromTitle}=require('../../src/codex_chat_identity');
test('installed native owner renames only the linked family, including spaces/underscore, without a model turn',{timeout:30000},async()=>{
 const f=await appServerFixture();
 try{
  const entries={},sessions=[];
  for(let i=0;i<3;i++){
   const thread=(await f.rpc('thread/start',{cwd:f.root})).thread;
   const title=i===2?'[OTHER-0009] Separate':'[OLD-000'+(i+1)+'] Work';
   await f.backend.renameThread(thread.id,title);
   entries[thread.id]={title,displayLabel:'Shared',...(i===1?{previousThreadId:sessions[0].threadId}:{})};
   sessions.push({threadId:thread.id,title});
  }
  const before=f.requests.length;
  const edit=await prepareFamilyIdentityEdit({backend:f.backend,threadId:sessions[0].threadId,identity:{code:'New Code_1',number:'0001'},hasIdentity:true,entries,sessions});
  assert.equal(identityFromTitle(await f.backend.readChatTitle(sessions[0].threadId)).code,'New Code_1');
  assert.equal(identityFromTitle(await f.backend.readChatTitle(sessions[1].threadId)).code,'New Code_1');
  assert.equal(identityFromTitle(await f.backend.readChatTitle(sessions[1].threadId)).number,'0002');
  assert.equal(identityFromTitle(await f.backend.readChatTitle(sessions[2].threadId)).code,'OTHER');
  assert.equal(f.requests.length,before);
  await edit.rollback();
  assert.equal(await f.backend.readChatTitle(sessions[0].threadId),sessions[0].title);
  console.log('Native family rename and rollback verified; model turns during metadata edit: 0.');
 }finally{await f.close();}
});
