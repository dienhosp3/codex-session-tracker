'use strict';

const DEFAULTS = Object.freeze({autoSwitch:false,autoResume:false,resumeScope:'trigger',busyPolicy:'wait',choiceSeconds:30,autoModelFallback:false,allowedModels:[]});
function settings(value={}) {
  const out={...DEFAULTS,...value};
  for(const key of ['autoSwitch','autoResume','autoModelFallback'])if(typeof out[key]!=='boolean')throw new Error('Cài đặt phải là bật/tắt.');
  if(!['none','trigger','all'].includes(out.resumeScope)||!['wait','ask','interrupt'].includes(out.busyPolicy))throw new Error('Chính sách không hợp lệ.');
  if(out.choiceSeconds!==null&&(!Number.isInteger(out.choiceSeconds)||out.choiceSeconds<0||out.choiceSeconds>3600))throw new Error('Thời gian chờ từ 0 đến 3600 giây; để trống để chờ vô hạn.');
  if(!Array.isArray(out.allowedModels)||out.allowedModels.some(m=>typeof m!=='string'||m.length>120))throw new Error('Danh sách model không hợp lệ.');
  return out;
}
function windows(quota) {
  const group=quota?.groups?.find(g=>g.id==='codex')||quota?.groups?.[0];
  return {short:group?.windows.find(w=>w.durationMinutes===300),week:group?.windows.find(w=>w.durationMinutes===10080),all:group?.windows||[]};
}
function warmupDecision(account,quota,previous={},now=Date.now()) {
  if(!account.settings?.warmupEnabled)return {action:'disabled'};
  if(!quota||quota.checkedAt>now+60000||now-quota.checkedAt>300000)return {action:'check',reason:'stale'};
  const {short,week}=windows(quota);
  if(!short)return {action:'unsupported',reason:'no_5h_window'};
  if(week?.usedPercent>=100)return {action:'wait',nextAt:week.resetsAt?week.resetsAt+60000:null,reason:'weekly_exhausted'};
  if(short.usedPercent>0)return {action:'wait',nextAt:short.resetsAt?short.resetsAt+60000:null,resetAt:short.resetsAt,reason:'cycle_active'};
  if(previous.requestId){
    const expired=previous.resetAt&&now>=previous.resetAt+60000&&quota.checkedAt>=previous.resetAt+60000;
    const resetObserved=expired&&(!short.resetsAt||short.resetsAt<=now||short.resetsAt>previous.resetAt+60000);
    if(!resetObserved)return {action:'reconcile',reason:'already_submitted'};
  }
  if(previous.observedResetAt&&now<previous.observedResetAt+60000)return {action:'wait',nextAt:previous.observedResetAt+60000,reason:'known_cycle'};
  return {action:'send',resetAt:short.resetsAt>now?short.resetsAt:null};
}
function rankAccounts(accounts,now=Date.now(),{exclude=[],maxAgeMs=60000,model}={}) {
  const candidates=[];
  for(const account of accounts){
    if(exclude.includes(account.id)||account.settings?.autoSwitchAllowed===false||account.status!=='ready')continue;
    const q=account.quota;if(!q||now-q.checkedAt>maxAgeMs||q.checkedAt>now+60000)continue;
    const w=windows(q);if(q.reached||w.all.some(x=>x.usedPercent>=100||x.resetsAt&&x.resetsAt<=now))continue;
    if(model&&!account.availableModels?.includes(model))continue;
    const comparable=/^(plus|team|business|standard_business)$/i.test(account.planType);
    const multiplier=account.settings?.capacityMultiplier||(comparable?1:null);
    if(!multiplier||!w.all.length)continue;
    const remaining=w.short?100-w.short.usedPercent:Math.min(...w.all.map(x=>100-x.usedPercent));
    const usable=Math.min(remaining,w.week?(100-w.week.usedPercent)/(account.settings?.weeklyRatio||0.15):Infinity)*multiplier;
    if(usable<=0)continue;
    candidates.push({...account,score:usable,remainingWeek:w.week?100-w.week.usedPercent:null,resetAt:w.short?.resetsAt||null});
  }
  const best=Math.max(0,...candidates.map(c=>c.score));
  const soon=c=>c.score>=best-5&&c.resetAt>now&&c.resetAt-now<=1800000;
  return candidates.sort((a,b)=>Number(soon(b))-Number(soon(a))||(soon(a)&&soon(b)?a.resetAt-b.resetAt:0)||b.score-a.score||(b.remainingWeek??0)-(a.remainingWeek??0)||a.id.localeCompare(b.id));
}
module.exports={DEFAULTS,settings,windows,warmupDecision,rankAccounts};
