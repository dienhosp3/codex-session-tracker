'use strict';
const {randomUUID}=require('node:crypto');
const {rankAccounts}=require('./codex_account_policy');

function createAccountSwitcher(options){
  const {store,core,owner}=options,now=options.now||Date.now;
  let working=false,disposed=false;
  const time=()=>typeof now==='function'?now():Date.now();
  async function update(fn){const result=await store.transaction(fn);options.changed?.();return result;}
  const alive=host=>{if(time()-host.at<15000)return true;try{process.kill(host.pid,0);return true;}catch{return false;}};
  const affected=(state,job)=>Object.values(state.hosts||{}).filter(h=>h.home===job.home&&alive(h));
  async function propose({accountRef=null,threadId='',automatic=false}={}){
    const state=await store.read();if(state.switchJob&&!['completed','cancelled','failed'].includes(state.switchJob.phase))return;
    if(automatic&&!state.settings.autoSwitch)return;
    const host=state.hosts?.[owner];if(!host?.currentRef)throw new Error('Chưa xác minh tài khoản Codex hiện tại.');
    const id=randomUUID();
    const reserved=await update(s=>{
      if(s.switchJob&&!['completed','cancelled','failed'].includes(s.switchJob.phase))return false;
      s.switchJob={id,phase:'checking',owner,home:host.home,from:host.currentRef,requestedTarget:accountRef,triggerThreadId:threadId,automatic,createdAt:time(),resume:[],reloadRequested:{},confirmed:{}};return true;
    });
    if(!reserved)return;
    try{
      const accounts=await options.refreshCandidates();
      const desiredModel=Object.values(state.hosts||{}).flatMap(h=>h.quotaFailures||[]).find(f=>f.threadId===threadId)?.model;
      const ranked=rankAccounts(accounts,time(),{exclude:[host.currentRef],model:desiredModel});
      const selected=accountRef?accounts.find(a=>a.id===accountRef):ranked[0];
      if(!selected||selected.id===host.currentRef){
        const resets=accounts.flatMap(a=>(a.quota?.groups||[]).flatMap(g=>g.windows.map(w=>w.resetsAt))).filter(t=>t>time());
        await update(s=>{if(s.switchJob?.id===id&&s.switchJob.phase==='checking')Object.assign(s.switchJob,{phase:resets.length?'waiting_quota':'failed',nextCheckAt:resets.length?Math.min(...resets)+60000:null,error:'Chưa có tài khoản đủ quota đã xác minh; chờ reset hoặc kiểm tra lại.'});});return;
      }
      const participants=affected(await store.read(),{home:host.home});
      const failed=participants.flatMap(h=>(h.quotaFailures||[]).map(f=>({...f,window: h.id})));
      const resume=state.settings.resumeScope==='all'?failed:failed.filter(f=>f.threadId===threadId);
      await update(s=>{if(s.switchJob?.id===id&&s.switchJob.phase==='checking')Object.assign(s.switchJob,{phase:'choosing',target:selected.id,desiredModel,candidates:ranked.map(a=>({id:a.id,email:a.email,score:a.score,remainingWeek:a.remainingWeek,resetAt:a.resetAt})),deadline:state.settings.choiceSeconds===null?null:time()+state.settings.choiceSeconds*1000,resume:resume.map(r=>({...r,state:'pending'}))});});
    }catch(error){await update(s=>{if(s.switchJob?.id===id&&s.switchJob.phase!=='cancelled')Object.assign(s.switchJob,{phase:'failed',error:error.message});});}
  }
  async function choose(id,accountRef,{immediate=false}={}){await update(s=>{const j=s.switchJob;if(j?.id!==id||!['choosing','waiting_idle','needs_stop_approval'].includes(j.phase))return;j.target=accountRef||j.target;j.phase='choosing';if(immediate)j.deadline=time();});}
  async function cancel(id){await update(s=>{if(s.switchJob?.id===id&&!['activating','reloading','resuming','completed'].includes(s.switchJob.phase))s.switchJob.phase='cancelled';});}
  async function approveStop(id){await update(s=>{if(s.switchJob?.id===id){s.switchJob.stopApproved=true;s.switchJob.phase='waiting_idle';}});}
  async function tick(){
    if(working||disposed)return;working=true;
    try{
      let state=await store.read(),job=state.switchJob;
      if(!job||['completed','failed','cancelled'].includes(job.phase))return;
      const me=state.hosts?.[owner];if(!me||me.home!==job.home)return;
      if(job.owner!==owner&&(!state.hosts?.[job.owner]||!alive(state.hosts[job.owner]))){
        if(job.phase==='checking'){
          await update(s=>{if(s.switchJob?.id===job.id)s.switchJob.phase='cancelled';});
          await propose({accountRef:job.requestedTarget,threadId:job.triggerThreadId,automatic:job.automatic});return;
        }
        await update(s=>{if(s.switchJob?.id===job.id&&s.switchJob.owner===job.owner)s.switchJob.owner=owner;});
        state=await store.read();job=state.switchJob;
      }
      if(job.phase==='checking')return;
      if(job.phase==='waiting_quota'){
        if(job.owner===owner&&job.nextCheckAt&&time()>=job.nextCheckAt){await update(s=>{if(s.switchJob?.id===job.id)s.switchJob.phase='cancelled';});await propose({accountRef:job.requestedTarget,threadId:job.triggerThreadId,automatic:job.automatic});}return;
      }
      if(['choosing','waiting_idle','needs_stop_approval'].includes(job.phase)){
        if(job.deadline===null||time()<job.deadline)return;
        const hosts=affected(state,job),fresh=hosts.every(h=>time()-h.at<15000&&h.ready&&h.barrier===job.id);
        const busy=hosts.flatMap(h=>h.busy||[]);
        if(!fresh)return;
        if(busy.length){
          const canStop=state.settings.busyPolicy==='interrupt'||job.stopApproved;
          if(canStop){for(const turn of me.busy||[])await options.interrupt(turn);}
          await update(s=>{if(s.switchJob?.id===job.id)s.switchJob.phase=canStop||state.settings.busyPolicy==='wait'?'waiting_idle':'needs_stop_approval';});return;
        }
        if(job.owner!==owner)return;
        if(hosts.some(h=>h.currentRef!==job.from))throw new Error('Tài khoản trong một cửa sổ đã thay đổi; dừng chuyển.');
        let target=await options.checkTarget(job.target);
        if(disposed)return;
        if(!target){
          const rejected=[...(job.rejectedTargets||[]),job.target];
          const ranked=rankAccounts(await options.refreshCandidates(),time(),{exclude:[job.from,...rejected],model:job.desiredModel});
          if(!ranked.length)throw new Error('Chưa còn tài khoản đủ quota; chờ reset hoặc kiểm tra lại.');
          await update(s=>{if(s.switchJob?.id===job.id&&s.switchJob.phase!=='cancelled'&&s.switchJob.target===job.target){s.switchJob.target=ranked[0].id;s.switchJob.rejectedTargets=rejected;s.switchJob.phase='choosing';s.switchJob.deadline=time();}});return;
        }
        const claimed=await update(s=>{const current=s.switchJob;if(current?.id!==job.id||!['choosing','waiting_idle','needs_stop_approval'].includes(current.phase)||current.target!==job.target)return false;current.phase='activating';return true;});
        if(!claimed)return;
        await core.request('account.activate',{accountRef:job.target,expectedCurrentRef:job.from,codexHome:options.codexHome(),drained:true},{requestId:'switch:'+job.id});
        await update(s=>{if(s.switchJob?.id===job.id)s.switchJob.phase='reloading';});
        return;
      }
      if(job.phase==='activating'){
        if(job.owner!==owner)return;
        const receipt=await core.request('account.activationInspect',{activationId:'switch:'+job.id,codexHome:options.codexHome()});
        if(receipt?.state==='written')await update(s=>{if(s.switchJob?.id===job.id)s.switchJob.phase='reloading';});
        return;
      }
      if(job.phase==='reloading'){
        if(me.currentRef===job.target&&me.ready){await update(s=>{if(s.switchJob?.id===job.id)s.switchJob.confirmed[owner]=true;});}
        else if(!job.reloadRequested?.[owner]){
          if((me.busy||[]).length)return;
          await options.persist();await update(s=>{if(s.switchJob?.id===job.id)s.switchJob.reloadRequested[owner]=time();});
          await options.reload();return;
        }
        state=await store.read();job=state.switchJob;
        if(affected(state,job).every(h=>h.currentRef===job.target&&h.ready))await update(s=>{if(s.switchJob?.id===job.id)s.switchJob.phase='resuming';});
      }
      state=await store.read();job=state.switchJob;
      if(job?.phase!=='resuming')return;
      await update(s=>{if(s.switchJob?.id===job.id)for(const item of s.switchJob.resume)if(item.state==='pending'&&(!s.hosts?.[item.window]||!alive(s.hosts[item.window])))item.state='skipped_closed';});
      if(!state.settings.autoResume||state.settings.resumeScope==='none'){await update(s=>{if(s.switchJob?.id===job.id)s.switchJob.phase='completed';});return;}
      for(const item of job.resume.filter(r=>r.window===owner&&r.state==='pending')){
        const live=await options.readStatus(item.threadId);
        if(live.active||live.waiting||live.goalPaused||live.turnId!==item.turnId||!['failed','interrupted'].includes(live.status)){
          await update(s=>{const r=s.switchJob?.resume.find(r=>r.threadId===item.threadId);if(r)r.state='skipped';});continue;
        }
        const claim=await update(s=>{const r=s.switchJob?.resume.find(r=>r.threadId===item.threadId&&r.window===owner);if(s.switchJob?.id!==job.id||r?.state!=='pending')return false;r.state='sending';return true;});
        if(!claim)continue;
        try{const result=await options.resume({...item,requestId:'resume:'+job.id+':'+item.threadId});await update(s=>{const r=s.switchJob?.resume.find(r=>r.threadId===item.threadId);if(r)Object.assign(r,{state:'done',newTurnId:result.turnId});});}
        catch(error){await update(s=>{const r=s.switchJob?.resume.find(r=>r.threadId===item.threadId);if(r)Object.assign(r,{state:error.delivery==='not_sent'?'blocked':'unknown',error:error.message});});}
      }
      await update(s=>{if(s.switchJob?.id===job.id&&s.switchJob.resume.every(r=>!['pending','sending'].includes(r.state)))s.switchJob.phase='completed';});
    }catch(error){await update(s=>{if(s.switchJob&&!['completed','cancelled'].includes(s.switchJob.phase)){s.switchJob.error=String(error.message).slice(0,400);if(s.switchJob.phase!=='activating')s.switchJob.phase='failed';}});}
    finally{working=false;}
  }
  return {propose,choose,cancel,approveStop,tick,dispose(){disposed=true;}};
}
module.exports={createAccountSwitcher};
