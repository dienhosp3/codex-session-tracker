'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { normalizeDisplayLabel, normalizeIdentity, identityFromTitle, identityPlan, prepareIdentityEdit,familyMembers,prepareFamilyIdentityEdit,displayChatTitle } = require('../../src/codex_chat_identity');
const { createContextWatch } = require('../../src/codex_context_watch');
const { continuationPlan, CHAT_ID_NOTE } = require('../../src/codex_context_handoff');
const options = { handoffDelaySeconds: 0, intervalMs: 100, completionSound: true, thresholdPercent: 85 };

test('current identity changes preserve the native suffix and calculate the next padded number', () => {
  assert.deepEqual(identityFromTitle('[Dự án_2-0004] Tên'),{code:'Dự án_2',number:'0004'});
  assert.equal(normalizeIdentity({code:'Dự án_2',number:'4'}).code,'Dự án_2');
  assert.deepEqual(identityPlan('[OLD-0007] Tên gốc', { code: 'dựÁn2', number: '25' }), {
    title: '[dựÁn2-0025] Tên gốc', series: { code: 'dựÁn2', nextNumber: '0026' }
  });
  assert.equal(identityPlan('Chưa có ID', { code: 'x', number: '9999' }).series.nextNumber, '10000');
  assert.equal(identityPlan('[ABC-0001] Tên gốc', null).title, 'Tên gốc');
  assert.deepEqual(identityFromTitle('[ABC-00001] Tên'), { code: 'ABC', number: '00001' });
  assert.equal(normalizeIdentity({ code: 'á'.normalize('NFD').repeat(30), number: '1' }).code, 'á'.repeat(30));
  for (const value of [{ code: 'a'.repeat(31), number: '1' }, { code: 'bad-id', number: '1' }, { code: 'OK', number: '0' }]) assert.throws(() => normalizeIdentity(value));
});

test('family edits follow handoff relationships, preserve ordinals and ignore unrelated chats with the same label',async t=>{
 const entries={a:{title:'[OLD-0001] One',displayLabel:'Shared'},b:{title:'[OLD-0002] Two',previousThreadId:'a',displayLabel:'Shared',series:{code:'OLD',nextNumber:'0100'}},c:{title:'[OLD-0003] Three',previousThreadId:'b',displayLabel:'Shared'},other:{title:'[OTHER-0009] Other',displayLabel:'Shared'}};
 const titles=Object.fromEntries(Object.entries(entries).map(([id,e])=>[id,e.title])),renames=[];
 const backend={readChatTitle:async id=>titles[id],renameThread:async(id,title)=>{renames.push(id);titles[id]=title;}};
 const watch=createContextWatch({state:{entries},save:async()=>{}});t.after(()=>watch.dispose());
 await watch.setChatOptions('b',options,entries.b,{members:familyMembers(entries,'b'),prepare:()=>prepareFamilyIdentityEdit({backend,threadId:'b',identity:{code:'New Code_1',number:'0002'},hasIdentity:true,hasLabel:true,displayLabel:'Work',entries,expectedIdentity:{code:'OLD',number:'0002'}})});
 assert.equal(titles.a,'[New Code_1-0001] One');assert.equal(titles.b,'[New Code_1-0002] Two');assert.equal(titles.c,'[New Code_1-0003] Three');
 assert.equal(titles.other,'[OTHER-0009] Other');assert.equal(renames.includes('other'),false);
 const next=watch.snapshot().entries;
 assert.equal(next.b.series.nextNumber,'0100');assert.equal(next.other.displayLabel,'Shared');
 assert.equal(displayChatTitle({threadId:'c',title:titles.c},next),'[0003] Work');
});

test('a failed family rename restores confirmed names and leaves all metadata unchanged',async t=>{
 const entries={a:{title:'[OLD-0001] One'},b:{title:'[OLD-0002] Two',previousThreadId:'a'}},titles={a:entries.a.title,b:entries.b.title};
 const backend={readChatTitle:async id=>titles[id],renameThread:async(id,title)=>{if(id==='b'&&title.startsWith('[NEW'))throw new Error('rename failed');titles[id]=title;}};
 const watch=createContextWatch({state:{entries},save:async()=>{}});t.after(()=>watch.dispose());
 await assert.rejects(watch.setChatOptions('a',options,entries.a,{members:['a','b'],prepare:()=>prepareFamilyIdentityEdit({backend,threadId:'a',identity:{code:'NEW',number:'0001'},hasIdentity:true,entries})}),/rename failed/);
 assert.equal(titles.a,entries.a.title);assert.equal(titles.b,entries.b.title);
 assert.equal(watch.snapshot().entries.a.title,entries.a.title);assert.equal(watch.snapshot().busy.length,0);
});

test('family labels work offline and deleted ancestors do not merge same-label families',async()=>{
 const entries={a:{title:'[OLD-0001] One',deleted:true,familyId:'a'},b:{title:'[OLD-0002] Two',previousThreadId:'a',familyId:'a'},other:{title:'[X-0001] Other',displayLabel:'Shared'}};
 assert.deepEqual(familyMembers(entries,'b'),['b']);
 const result=await prepareFamilyIdentityEdit({threadId:'b',entries,hasIdentity:false,hasLabel:true,displayLabel:'Shared'});
 assert.equal(result.patches.b.displayLabel,'Shared');assert.equal(result.patches.other,undefined);
});

test('changing a family member ordinal cannot collide with another member',async()=>{
 const entries={a:{title:'[OLD-0001] One'},b:{title:'[OLD-0002] Two',previousThreadId:'a'}};
 let writes=0;const backend={readChatTitle:async id=>entries[id].title,renameThread:async()=>{writes++;}};
 await assert.rejects(prepareFamilyIdentityEdit({backend,threadId:'a',identity:{code:'NEW',number:'0002'},hasIdentity:true,entries}),/STT này đã có/);
 assert.equal(writes,0);
});

test('labels are plain local strings, can be cleared and never become a series ID', () => {
  assert.equal(normalizeDisplayLabel('  Dự án <script>  '), 'Dự án <script>');
  assert.equal(normalizeDisplayLabel(''), '');
  assert.throws(() => normalizeDisplayLabel('a'.repeat(121)));
  assert.throws(() => normalizeDisplayLabel('two\nlines'));
  const plan = continuationPlan('uuid', '[REAL-0007] Native title');
  assert.equal(plan.nextTitle, '[REAL-0008] Tiếp tục');
  assert.equal(plan.message.split(CHAT_ID_NOTE).length, 2);
  assert.equal(CHAT_ID_NOTE, 'Mã ID và nhãn chỉ để nhận diện chat, không đưa vào repo.');
});

test('native rename is verified, rejects stale identity, and never resumes or starts anything', async () => {
  let title = '[OLD-0001] Native'; const calls = [];
  const backend = { readChatTitle: async () => title, renameThread: async (id, value) => { calls.push([id, value]); title = value; } };
  const prepared = await prepareIdentityEdit(backend, 'source', { code: 'NEW', number: '4' }, title, { code: 'OLD', number: '0001' });
  assert.equal(prepared.patch.title, '[NEW-0004] Native'); assert.equal(calls.length, 1);
  await prepared.rollback(); assert.equal(title, '[OLD-0001] Native');
  await assert.rejects(prepareIdentityEdit(backend, 'source', { code: 'NEW', number: '5' }, title, null), /ID chat đã thay đổi/);
  assert.equal(calls.length, 2);
});

test('alias and identity settings persist without enabling Auto resume; label follows the successor only as metadata', async t => {
  let saved, title = '[OLD-0001] Native', sent;
  const backend = { readChatTitle: async () => title, renameThread: async (_, value) => { title = value; } };
  const config = { save: async state => { saved = state; }, readManual: async () => ({ turnId: 'turn' }),
    handoff: async entry => { sent = continuationPlan(entry.threadId, title, [], undefined, entry.series); return { ...sent, phase: 'completed', nextThreadId: 'next' }; } };
  const watch = createContextWatch(config); t.after(() => watch.dispose());
  await watch.setChatOptions('source', options, { title }, { prepare: async () => {
    const result = await prepareIdentityEdit(backend, 'source', { code: 'REAL', number: '25' }, title);
    result.patch.displayLabel = '[FAKE-9999] Nhãn riêng'; return result;
  } });
  assert.equal(watch.tracks('source'), false); assert.equal(title, '[REAL-0025] Native');
  watch.dispose(); const restored = createContextWatch({ ...config, state: saved }); t.after(() => restored.dispose());
  await restored.transferNow('source');
  assert.equal(sent.nextTitle, '[REAL-0026] Tiếp tục');
  assert.equal(sent.message.includes('FAKE'), false);
  assert.equal(restored.snapshot().entries.next.displayLabel, '[FAKE-9999] Nhãn riêng');
  assert.equal(restored.snapshot().entries.next.series.nextNumber, '0027');
});

test('failed local save or later permission change rolls back native name and label', async t => {
  for (const afterSaveFails of [false, true]) {
    let title = '[OLD-0001] Native', saved;
    const backend = { readChatTitle: async () => title, renameThread: async (_, value) => { title = value; } };
    const watch = createContextWatch({ save: async state => { if (!afterSaveFails) throw new Error('storage'); saved = state; } }); t.after(() => watch.dispose());
    await assert.rejects(watch.setChatOptions('source', options, { title }, { prepare: async () => {
      const edit = await prepareIdentityEdit(backend, 'source', { code: 'NEW', number: '2' }, title);
      edit.patch.displayLabel = 'Not saved'; return edit;
    }, afterSave: async () => { throw new Error('permissions'); } }), afterSaveFails ? /permissions/ : /storage/);
    assert.equal(title, '[OLD-0001] Native'); assert.equal(watch.snapshot().entries.source, undefined);
    if (afterSaveFails) assert.equal(saved.entries.source, undefined);
  }
});

test('identity edit holds the same lock as auto/manual handoff until its metadata has been saved', async t => {
  let release, transfers = 0;
  const watch = createContextWatch({ state: { entries: { source: { enabled: true } } }, save: async () => {},
    read: async () => ({ running: true, turnId: 'turn', percent: 99 }), handoff: async () => { transfers++; return {}; } }); t.after(() => watch.dispose());
  const pending = watch.setChatOptions('source', options, {}, { prepare: () => new Promise(resolve => { release = resolve; }) });
  for (let i = 0; i < 20 && !release; i++) await new Promise(resolve => setImmediate(resolve));
  await watch.poll(); await assert.rejects(watch.transferNow('source'), /đang lưu/); assert.equal(transfers, 0);
  release({ patch: { displayLabel: 'Saved' } }); await pending;
});
