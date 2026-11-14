'use strict';
const path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const {createStateStore}=require('./codex_state_store');
const {createCoreAccess}=require('./codex_accounts_core');
const {settings,windows}=require('./codex_account_policy');
const {createAccountScheduler}=require('./codex_account_scheduler');
const {createAccountSwitcher}=require('./codex_account_switcher');
const {setAccountBarrier}=require('./codex_account_barrier');

function recoveredAccountState(previous,{source}) {
  let policy; try { policy=settings(previous.settings); } catch { policy=settings(); }
  const recovery={source,at:Date.now(),automationPaused:true};
  return {...previous,schemaVersion:1,settings:{...policy,autoSwitch:false,autoResume:false,autoModelFallback:false},
    hosts:{},leader:null,coreConnected:false,recovery,
    switchJob:previous.switchJob ? {...previous.switchJob,phase:'failed',error:'Trạng thái vừa được phục hồi. Kiểm tra phiên trước khi chuyển hoặc tiếp tục.'} : null};
}

function createAccountManager(vscode,context,options){
  const core=options.core||createCoreAccess(vscode);
  const owner=context.workspaceState?.get('accountWindow.v1')||randomUUID();
  const ownerSaved=Promise.resolve(context.workspaceState?.update('accountWindow.v1',owner));
  const store=options.store||createStateStore(path.join(context.globalStorageUri.fsPath,'account-automation.v1.json'),{schemaVersion:1,settings:settings(),hosts:{},schedules:{},switchJob:null});
  let accounts=[],launchers=[],state={settings:settings(),schedules:{}},connected=false,notice='',busy=false,disposed=false,ticking=false,timer,lastHostAt=0,lastListAt=0,currentRef='',loginRef=null,signature='';
  const home=()=>options.codexHome();
  const homeKey=()=>createHash('sha256').update(path.resolve(home()).toLowerCase()).digest('hex');
  const snapshot=()=>({connected,notice,busy,accounts,launchers,currentRef,loginRef,settings:state.settings||settings(),schedules:state.schedules||{},switchJob:state.switchJob||null,recovery:state.recovery||null});
  function publish(){const next=JSON.stringify(snapshot());if(next!==signature){signature=next;options.changed?.();}}
  async function sync(){
    try { state=await store.read(); }
    catch(error) {
      if(error.code!=='STATE_FILE_INVALID'||!store.recover)throw error;
      state=(await store.recover(recoveredAccountState)).state;
    }
    state.settings=settings(state.settings);publish();
  }
  async function list(){const data=await core.request('account.list');accounts=data.accounts;launchers=(await core.request('launcher.list')).launchers;lastListAt=Date.now();publish();return accounts;}
  function observed(id,quota){accounts=accounts.map(a=>a.id===id?{...a,quota,status:'ready'}:a);publish();}
  async function readQuota(account){
    if(account.id===currentRef){const native=await options.readNativeQuota();const q=await core.request('quota.observe',{accountRef:account.id,nativeAccount:native.account,result:native.result});observed(account.id,q);return q;}
    const q=await core.request('quota.read',{accountRef:account.id});observed(account.id,q);return q;
  }
  const scheduler=createAccountScheduler({store,core,owner,readQuota,observed,changed:()=>sync().catch(()=>{})});
  const switcher=createAccountSwitcher({store,core,owner,codexHome:home,changed:()=>sync().catch(()=>{}),
    async refreshCandidates(){await list();for(const account of accounts){if((await store.read()).switchJob?.phase==='cancelled')break;if(account.id===currentRef||account.settings.autoSwitchAllowed===false)continue;try{await readQuota(account);}catch(error){accounts=accounts.map(a=>a.id===account.id?{...a,status:'check_failed',lastError:error.message}:a);}}await list();publish();return accounts;},
    async checkTarget(id){const account=accounts.find(a=>a.id===id);if(!account)return false;const q=await readQuota(account),all=windows(q).all;return !q.reached&&(all.length?all.every(w=>w.usedPercent<100&&(!w.resetsAt||w.resetsAt>Date.now())):q.credits?.unlimited===true||Number(q.credits?.balance)>0);},
    interrupt:options.interrupt,readStatus:options.readStatus,resume:options.resume,persist:options.persist,reload:()=>vscode.commands.executeCommand('workbench.action.reloadWindow')});
  async function connect(){await sync();await core.ready();connected=true;notice='';await list();await store.transaction(s=>{s.coreConnected=true;});await sync();}
  let heartbeatPending=null,hostTimer;
  function heartbeat(){if(disposed||!connected)return Promise.resolve();if(!heartbeatPending)heartbeatPending=performHeartbeat().finally(()=>{heartbeatPending=null;});return heartbeatPending;}
  async function performHeartbeat(){
    await sync();
    const job=state.switchJob;
    const barrier=job&&job.home===homeKey()&&(['activating','reloading'].includes(job.phase)||['choosing','waiting_idle','needs_stop_approval'].includes(job.phase)&&job.deadline!==null&&Date.now()>=job.deadline)?job.id:'';
    setAccountBarrier(Boolean(barrier));
    const native=await options.describeHost();
    if(native.account?.type==='chatgpt'){
      try{currentRef=(await core.request('account.current',{codexHome:home(),nativeAccount:native.account}))?.id||'';}catch(error){if(error.code!=='NATIVE_ACCOUNT_PENDING')currentRef='';}
    }else currentRef='';
    if(disposed)return;
    await store.transaction(s=>{s.hosts||={};s.hosts[owner]={id:owner,pid:process.pid,at:Date.now(),home:homeKey(),currentRef,barrier,ready:Boolean(native.ready&&currentRef),busy:native.busy||[],quotaFailures:native.quotaFailures||[],modelFailures:native.modelFailures||[]};
      const lease=s.leader;if(!lease||lease.until<Date.now()||lease.owner===owner)s.leader={owner,until:Date.now()+15000};});
    await core.request('automation.heartbeat',{owner});lastHostAt=Date.now();await sync();
  }
  async function tick(){
    if(disposed||ticking)return;ticking=true;
    try{
      if(!connected){await sync();if(!state.coreConnected)return;await connect();}
      if(Date.now()-lastHostAt>=4000)await heartbeat();else await sync();
      if(Date.now()-lastListAt>=15000)await list();
      if(state.recovery?.automationPaused)return;
      await switcher.tick();
      if(state.settings.autoModelFallback&&state.settings.allowedModels.length&&!state.switchJob?.phase?.match(/choosing|waiting|activating|reloading|resuming/)){
        for(const failure of state.hosts?.[owner]?.modelFailures||[]){
          const claimed=await store.transaction(s=>{s.modelAttempts||={};const previous=s.modelAttempts[failure.threadId];if(previous?.turnId===failure.turnId||previous?.phase==='unknown'||previous?.phase==='sending'||previous?.attempts>=3&&Date.now()-previous.originAt<600000)return false;s.modelAttempts[failure.threadId]={turnId:failure.turnId,phase:'sending',attempts:previous&&Date.now()-previous.originAt<600000?previous.attempts+1:1,originAt:previous?.originAt||Date.now()};return true;});
          if(!claimed)continue;
          try{await options.fallbackModel(failure.threadId,state.settings.allowedModels);await store.transaction(s=>{s.modelAttempts[failure.threadId].phase='done';});}
          catch(error){await store.transaction(s=>{s.modelAttempts[failure.threadId].phase=error.delivery==='not_sent'?'blocked':'unknown';});notice=error.message;}
        }
      }
      if(state.leader?.owner===owner){
        await scheduler.tick(accounts);
        const current=accounts.find(a=>a.id===currentRef),q=current?.quota;
        const exhausted=q&&Date.now()-q.checkedAt<60000&&(q.reached||windows(q).all.some(w=>w.usedPercent>=100));
        if(state.settings.autoSwitch&&exhausted&&!['checking','choosing','waiting_idle','needs_stop_approval','activating','reloading','resuming'].includes(state.switchJob?.phase)){
          const cycle=currentRef+':'+JSON.stringify(windows(q).all.map(w=>[w.durationMinutes,w.resetsAt]));
          if(state.lastAutoSwitchCycle!==cycle){await store.transaction(s=>{s.lastAutoSwitchCycle=cycle;});const trigger=state.hosts?.[owner]?.quotaFailures?.[0]?.threadId||'';await switcher.propose({automatic:true,threadId:trigger});}
        }
      }
    }catch(error){notice=String(error.message).slice(0,400);publish();}
    finally{ticking=false;}
  }
  async function action(message){
    if(message.action==='cancel'){await switcher.cancel(message.id);await sync();return;}
    if(message.action==='choose'){await switcher.choose(message.id,message.accountRef,{immediate:message.immediate===true});await sync();return;}
    if(busy)return {error:'Một thao tác account đang chạy. Hãy thử lại sau khi hoàn tất.'};busy=true;publish();
    let result;
    try{
      if(!connected)await connect();
      const action=message.action;
      if(action==='refresh')await list();
      if(action==='import'){
        const files=await vscode.window.showOpenDialog({canSelectMany:false,filters:{'Chrome BAT':['bat']},title:'Chọn tệp Chrome BAT chưa có trong danh sách'});
        if(files?.length){const launcher=await core.request('launcher.importBat',{batPath:files[0].fsPath});result={launcherId:launcher.id};await list();}
      }
      if(action==='link'){await core.request('account.link',{launcherId:message.launcherId,codexHome:home(),cliPath:await core.cliPath()});await list();}
      if(action==='login'){const result=await core.request('account.loginStart',{launcherId:message.launcherId,cliPath:await core.cliPath()});loginRef=result.loginRef;await core.request('account.loginOpen',{loginRef});}
      if(action==='loginStatus'){const result=await core.request('account.loginStatus',{loginRef});if(result.state==='linked'){loginRef=null;await list();}else notice='Đang chờ đăng nhập trong Chrome BAT đã chọn.';}
      if(action==='capacity'){
        const account=accounts.find(a=>a.id===message.accountRef);if(!account)throw new Error('Không tìm thấy tài khoản.');
        const ratio=await vscode.window.showInputBox({title:'Tỷ lệ quota tuần cho một phiên 5h đầy',value:String(account.settings.weeklyRatio||0.15),prompt:'0.15 nghĩa là 100% phiên 5h tương đương khoảng 15% tuần',validateInput:v=>Number(v)>0&&Number(v)<=1?undefined:'Nhập số lớn hơn 0 và không quá 1.'});
        if(ratio!==undefined){
          const weight=await vscode.window.showInputBox({title:'Sức chứa tương đối so với Plus',value:account.settings.capacityMultiplier==null?'':String(account.settings.capacityMultiplier),prompt:'Plus/Business tiêu chuẩn dùng 1; để trống nếu chưa xác định.',validateInput:v=>v===''||Number(v)>0&&Number(v)<=1000?undefined:'Nhập số từ lớn hơn 0 đến 1000.'});
          if(weight!==undefined){await core.request('account.configure',{accountRef:account.id,settings:{weeklyRatio:Number(ratio),capacityMultiplier:weight===''?null:Number(weight)}});await list();}
        }
      }
      if(action==='configureAccount'){
        await core.request('account.configure',{accountRef:message.accountRef,settings:message.settings});await list();
        const a=accounts.find(a=>a.id===message.accountRef);if(a?.settings.warmupEnabled&&!state.recovery?.automationPaused)scheduler.run(a,{manual:true});
      }
      if(action==='configure'){const next=settings(message.settings);await store.transaction(s=>{s.settings=next;if(s.recovery)s.recovery.automationPaused=false;});await sync();}
      if(action==='check'){const a=accounts.find(a=>a.id===message.accountRef);if(a){await readQuota(a);if(a.settings.warmupEnabled&&!state.recovery?.automationPaused)scheduler.run(a,{manual:true});}}
      if(action==='switch'){await heartbeat();await switcher.propose({accountRef:message.accountRef,threadId:message.threadId||''});}
      if(action==='choose')await switcher.choose(message.id,message.accountRef,{immediate:message.immediate===true});
      if(action==='cancel')await switcher.cancel(message.id);
      if(action==='stopApprove')await switcher.approveStop(message.id);
      if(action==='rollback'){
        await heartbeat();const current=await store.read(),job=current.switchJob;
        if(job?.id!==message.id)throw new Error('Lần chuyển account đã thay đổi.');
        const hosts=Object.values(current.hosts||{}).filter(h=>h.home===job.home);
        if(hosts.some(h=>Date.now()-h.at>15000||(h.busy||[]).length))throw new Error('Chờ các cửa sổ kết nối và các chat dừng trước khi phục hồi.');
        const restored=await core.request('account.rollback',{activationId:'switch:'+job.id,codexHome:home(),drained:true});
        await store.transaction(s=>{if(s.switchJob?.id===job.id)Object.assign(s.switchJob,{target:restored.accountRef,phase:'reloading',reloadRequested:{},confirmed:{},resume:[],error:''});});
      }
      if(action==='fallbackModel'){
        const allowed=state.settings.allowedModels;
        if(!allowed.length)throw new Error('Chọn danh sách model được phép trong cài đặt account.');
        await options.fallbackModel(message.threadId,allowed);
      }
      if(!['login','loginStatus'].includes(action))notice='';
      await sync();
      return result;
    }catch(error){notice=String(error.message).slice(0,500);return {error:notice};}
    finally{busy=false;publish();}
  }
  async function observeNative(native,result){
    if(!connected||disposed)return;
    const matches=accounts.filter(a=>a.email.toLowerCase()===native?.email?.toLowerCase());
    const account=matches.find(a=>a.id===currentRef)||(matches.length===1?matches[0]:null);
    if(account){try{const q=await core.request('quota.observe',{accountRef:account.id,nativeAccount:native,result});observed(account.id,q);await scheduler.observe(account,q);}catch(error){notice=error.message;publish();}}
  }
  async function start(){await ownerSaved;if(disposed)return;try{await sync();if(state.coreConnected)await connect();}catch(error){notice='Quản lý account: '+error.message;publish();}if(disposed)return;hostTimer=setInterval(()=>heartbeat().catch(error=>{notice=error.message;publish();}),4000);hostTimer.unref?.();timer=setInterval(()=>tick(),1000);timer.unref?.();}
  async function dispose(){disposed=true;clearInterval(timer);clearInterval(hostTimer);setAccountBarrier(false);scheduler.dispose();switcher.dispose();await heartbeatPending?.catch(()=>{});if(connected)await core.request('automation.release',{owner}).catch(()=>{});await store.transaction(s=>{delete s.hosts?.[owner];if(s.leader?.owner===owner)delete s.leader;});}
  return {start,dispose,snapshot,action,observeNative,tick};
}
module.exports={createAccountManager,recoveredAccountState};
