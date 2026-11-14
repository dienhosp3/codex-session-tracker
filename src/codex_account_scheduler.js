'use strict';
const {randomUUID,randomInt}=require('node:crypto');
const {warmupDecision,windows}=require('./codex_account_policy');

function createAccountScheduler(options){
  const {store,core,owner}=options,now=options.now||Date.now;
  const pending=new Map();let disposed=false;
  async function update(id,change){const result=await store.transaction(s=>{s.schedules||={};const current=s.schedules[id]||{};const next=change(current);if(next)s.schedules[id]=next;return s.schedules[id];});options.changed?.();return result;}
  const readQuota=account=>options.readQuota?options.readQuota(account):core.request('quota.read',{accountRef:account.id});
  async function reconcile(account,job){
    if(job.turnRef){
      const result=await core.request('turn.wait',{turnRef:job.turnRef,timeoutMs:120000,readOnly:true,allowModelRetry:false,allowResponseReader:false,stopRemoteOnAbort:false},{requestId:job.requestId+':wait'});
      if(!result.completed)throw new Error('ChatGPT Work chưa xác nhận phản hồi hoàn tất.');
      return update(account.id,s=>({...s,phase:'completed',completedAt:now(),nextCheckAt:now()+15000,recheckIndex:0,error:''}));
    }
    const receipt=await core.request('request.inspect',{requestId:job.requestId});
    if(receipt.turnRef){const next=await update(account.id,s=>({...s,turnRef:receipt.turnRef,phase:'waiting'}));return reconcile(account,next);}
    return update(account.id,s=>({...s,phase:receipt.state==='not_sent'?'blocked':'unknown',error:'Chưa xác nhận được lượt trước; không gửi lại.',nextCheckAt:null}));
  }
  async function run(account,{manual=false}={}){
    if(disposed||pending.has(account.id))return pending.get(account.id);
    const operation=(async()=>{
      let state=await store.read(),job=state.schedules?.[account.id]||{};
      if(['sending','waiting','unknown'].includes(job.phase)&&job.requestId)return reconcile(account,job);
      if(['preparing','blocked'].includes(job.phase)&&!manual)return;
      const quota=await readQuota(account);options.observed?.(account.id,quota);
      if(disposed)return;
      const decision=warmupDecision(account,quota,job,now()),short=windows(quota).short;
      if(decision.action!=='send'){
        return update(account.id,s=>{
          const confirmedReset=short?.resetsAt>now()?short.resetsAt:s.resetAt;
          let nextCheckAt=decision.nextAt||(decision.action==='reconcile'&&confirmedReset>now()?confirmedReset+60000:null),recheckIndex=s.recheckIndex||0;
          if(decision.action==='reconcile'&&s.phase==='completed'&&recheckIndex<2){recheckIndex++;nextCheckAt=s.completedAt+[15000,60000,180000][recheckIndex];}
          return {...s,observedResetAt:short?.resetsAt||s.observedResetAt,resetAt:confirmedReset,nextCheckAt,recheckIndex,decision:decision.reason||decision.action,error:''};
        });
      }
      const requestId='quota-work-'+randomUUID();
      const claimed=await store.transaction(s=>{
        s.schedules||={};const previous=s.schedules[account.id]||{};
        if(previous.requestId!==job.requestId||['preparing','sending','waiting','unknown'].includes(previous.phase))return false;
        s.schedules[account.id]={...previous,requestId,phase:'preparing',resetAt:decision.resetAt,observedResetAt:short?.resetsAt||null,prompt:randomInt(1,10)+'+'+randomInt(1,10)+'=?',startedAt:now(),nextCheckAt:null,owner};return true;
      });
      if(!claimed)return;
      job=(await store.read()).schedules[account.id];options.changed?.();
      const conversation=await core.request('conversation.create',{launcherId:account.launcherId,surface:'work',mode:'regular',expectedAccountRef:account.id,requireUnboundTab:true},{requestId:requestId+':create'});
      await update(account.id,s=>({...s,conversationRef:conversation.id}));
      await core.request('controls.lightest',{conversationRef:conversation.id},{requestId:requestId+':controls'});
      if(disposed)throw new Error('Tracker đã đóng trước khi gửi.');
      await update(account.id,s=>({...s,phase:'sending'}));
      const accepted=await core.request('turn.send',{conversationRef:conversation.id,prompt:job.prompt,automationLease:owner},{requestId});
      const next=await update(account.id,s=>({...s,phase:'waiting',turnRef:accepted.turnRef}));
      await reconcile(account,next);
    })().catch(async error=>{
      await update(account.id,s=>({...s,phase:['sending','waiting','unknown'].includes(s.phase)?'unknown':'blocked',error:String(error.message).slice(0,400),nextCheckAt:null}));
    }).finally(()=>{pending.delete(account.id);options.changed?.();});
    pending.set(account.id,operation);return operation;
  }
  async function tick(accounts){
    if(disposed)return;
    const state=await store.read();
    for(const account of accounts){
      if(!account.settings?.warmupEnabled||pending.has(account.id))continue;
      const job=state.schedules?.[account.id];
      if(!job||job.nextCheckAt&&now()>=job.nextCheckAt||job.phase==='waiting')run(account);
    }
  }
  async function observe(account,quota){
    if(!account.settings?.warmupEnabled)return;
    const short=windows(quota).short;if(!short?.resetsAt||short.resetsAt<=now())return;
    await update(account.id,s=>short.usedPercent===0&&!s.requestId?undefined:['preparing','sending','waiting','unknown'].includes(s.phase)?s:{...s,observedResetAt:short.resetsAt,resetAt:short.resetsAt,nextCheckAt:short.resetsAt+60000,decision:'cycle_observed'});
  }
  return {run,tick,observe,get busy(){return pending.size>0;},dispose(){disposed=true;}};
}
module.exports={createAccountScheduler};
