'use strict';

const { normalizeSeries, parseSeries } = require('./codex_context_handoff');

function normalizeDisplayLabel(value) {
  if (typeof value !== 'string') throw new Error('Nhãn hiển thị không hợp lệ.');
  const label = value.trim().normalize('NFC');
  if ([...label].length > 120 || /[\u0000-\u001f\u007f]/u.test(label)) throw new Error('Nhãn tối đa 120 ký tự, trên một dòng.');
  return label;
}
function normalizeIdentity(value) {
  if (value == null) return null;
  const series = normalizeSeries({ code: value.code, nextNumber: value.number });
  return { code: series.code, number: series.nextNumber };
}
function identityFromTitle(title) {
  const series = parseSeries(title);
  return series ? { code: series.code, number: String(series.number).padStart(series.width, '0') } : null;
}
function identityPlan(title, value) {
  const identity = normalizeIdentity(value), original = String(title || '').normalize('NFC');
  const suffix = parseSeries(original) ? original.replace(/^\[[\p{L}\p{N}_ ]{1,30}-\d{4,}\](?:\s+|$)/u, '') : original;
  const name = suffix.trim() || 'Hội thoại';
  return { title: identity ? `[${identity.code}-${identity.number}] ${name}` : name,
    series: identity ? { code: identity.code, nextNumber: String(BigInt(identity.number) + 1n).padStart(identity.number.length, '0') } : null };
}

// Only metadata changes: never resume/interrupt/start a turn. Native names stay
// authoritative; the Tracker label is a separate local property.
async function prepareIdentityEdit(backend, threadId, value, fallbackTitle, expectedIdentity) {
  const before = await backend.readChatTitle(threadId, fallbackTitle);
  if (expectedIdentity !== undefined && JSON.stringify(identityFromTitle(before)) !== JSON.stringify(normalizeIdentity(expectedIdentity))) {
    throw new Error('ID chat đã thay đổi; mở lại Tuỳ chọn chat để chỉnh.');
  }
  const plan = identityPlan(before, value);
  if (plan.title === before) return { patch: { title: before, series: plan.series } };
  let failure;
  try { await backend.renameThread(threadId, plan.title); } catch (error) { failure = error; }
  const confirmed = await backend.readChatTitle(threadId, fallbackTitle);
  if (confirmed !== plan.title) throw failure || new Error('Chưa xác nhận được ID mới của chat.');
  return { patch: { title: confirmed, series: plan.series }, async rollback() {
    if (await backend.readChatTitle(threadId, fallbackTitle) !== plan.title) throw new Error('Tên gốc đã đổi ở nơi khác; không ghi đè.');
    await backend.renameThread(threadId, before);
    if (await backend.readChatTitle(threadId, fallbackTitle) !== before) throw new Error('Chưa khôi phục được tên gốc.');
  } };
}

function familyKey(entries,threadId){
 const seen=new Set();let current=threadId;
 while(entries[current]?.previousThreadId&&!seen.has(current)){
  if(entries[current].familyId)return entries[current].familyId;
  seen.add(current);current=entries[current].previousThreadId;
 }
 return entries[current]?.familyId||current;
}
function familyMembers(entries,threadId){
 const found=new Set([threadId]),key=familyKey(entries,threadId);let changed=true;
 while(changed){
  changed=false;
  for(const [id,entry] of Object.entries(entries)){
   const linked=[id,entry.previousThreadId,entry.handoff?.nextThreadId].filter(Boolean);
   if(entry.familyId===key||linked.some(value=>found.has(value)))for(const value of linked)if(!found.has(value)){found.add(value);changed=true;}
  }
 }
 return [...found].filter(id=>id===threadId||entries[id]&&!entries[id].deleted);
}
function displayChatTitle(session,entries={}){
 const entry=entries[session?.threadId]||{},label=entry.displayLabel;
 if(!label)return session?.title||entry.title||'Codex chat';
 const identity=identityFromTitle(entry.title)||identityFromTitle(session?.title)||identityFromTitle(entry.handoff?.sourceTitle);
 const number=entry.ordinal||identity?.number;
 return number?'['+number+'] '+label:label;
}
async function prepareFamilyIdentityEdit({backend,threadId,identity,hasIdentity,displayLabel,hasLabel,entries,sessions=[],expectedIdentity}){
 const members=familyMembers(entries,threadId),familyId=familyKey(entries,threadId),patches={},prepared=[];
 const fallback=id=>sessions.find(session=>session?.threadId===id)?.title||entries[id]?.title||entries[id]?.handoff?.sourceTitle||'';
 const before={},missing=new Set();
 if(hasIdentity){
  for(const id of members){
   try{before[id]=await backend.readChatTitle(id,fallback(id));}
   catch(error){if(id!==threadId&&/not found|does not exist|no saved thread/i.test(error.message))missing.add(id);else throw error;}
  }
  if(expectedIdentity!==undefined&&JSON.stringify(identityFromTitle(before[threadId]))!==JSON.stringify(normalizeIdentity(expectedIdentity)))throw new Error('ID dãy đã thay đổi; mở lại Tuỳ chọn chat.');
  const currentIdentity=identityFromTitle(before[threadId]);
  if(identity&&identity.number!==currentIdentity?.number&&members.some(id=>id!==threadId&&!missing.has(id)&&identityFromTitle(before[id])&&BigInt(identityFromTitle(before[id]).number)===BigInt(identity.number)))throw new Error('STT này đã có trong dãy. Chọn số khác cho chat hiện tại.');
 }
 const changes=[];
 for(const id of members){
  if(missing.has(id)){patches[id]={familyId,deleted:true,enabled:false};continue;}
  const old=identityFromTitle(hasIdentity?before[id]:fallback(id));
  const patch={familyId,...(hasLabel?{displayLabel}:{}),...(old?{ordinal:old.number}:{})};
  if(hasIdentity){
   const target=identity ? {code:identity.code,number:id===threadId?identity.number:old?.number||entries[id]?.ordinal} : null;
   if(target&&!target.number){patches[id]=patch;continue;}
   const plan=identityPlan(before[id],target);
   if(plan.series&&old&&target.number===old.number&&entries[id]?.series?.nextNumber)plan.series.nextNumber=entries[id].series.nextNumber;
   Object.assign(patch,{title:plan.title,series:plan.series,...(target?{ordinal:target.number}:{})});
   changes.push({id,target,before:before[id],expected:old});
  }
  patches[id]=patch;
 }
 async function rollback(){
  const failures=[];
  for(const item of prepared.slice().reverse())try{await item.rollback?.();}catch(error){failures.push(error.message);}
  if(failures.length)throw new Error(failures.join(' '));
 }
 try{
  for(const change of changes)prepared.push(await prepareIdentityEdit(backend,change.id,change.target,change.before,change.expected));
 }catch(error){
  try{await rollback();}catch(failure){error.message+=' Không khôi phục hết tên gốc: '+failure.message;}
  throw error;
 }
 return {patch:patches[threadId]||{},patches,members,rollback};
}
module.exports = { normalizeDisplayLabel, normalizeIdentity, identityFromTitle, identityPlan, prepareIdentityEdit,familyKey,familyMembers,displayChatTitle,prepareFamilyIdentityEdit };
