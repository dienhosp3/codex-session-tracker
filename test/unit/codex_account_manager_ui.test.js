'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const {createRequire} = require('node:module');
const {createAccountManager} = require('../../src/codex_account_manager');

function managerFixture(vscode={}) {
  const state = {settings:{},hosts:{},schedules:{}}, calls = [];
  const store = {read:async()=>structuredClone(state),transaction:async fn=>fn(state)};
  const core = {ready:async()=>{},request:async action=>{
    calls.push(action);
    if(action==='account.list')return {accounts:[]};
    if(action==='launcher.list')return {launchers:[]};
    return {};
  }};
  const manager = createAccountManager(vscode, {globalStorageUri:{fsPath:'fixture'}}, {store,core,codexHome:()=>'/fixture'});
  return {manager,state,core,calls};
}

test('invalid policy returns an error acknowledgement and leaves stored settings untouched', async()=>{
  const f=managerFixture();
  const result=await f.manager.action({action:'configure',settings:{choiceSeconds:3601}});
  assert.match(result.error,/3600/);
  assert.deepEqual(f.state.settings,{});
  assert.equal(f.manager.snapshot().busy,false);
});

test('a second action gets a busy error instead of a false successful save', async()=>{
  const f=managerFixture();
  let release,started;
  const ready=new Promise(resolve=>{started=resolve;});
  f.core.ready=()=>new Promise(resolve=>{release=resolve;started();});
  const first=f.manager.action({action:'refresh'});
  await ready;
  const result=await f.manager.action({action:'configure',settings:{choiceSeconds:75}});
  assert.match(result.error,/đang chạy/);
  release(); await first;
  assert.deepEqual(f.state.settings,{});
});

test('successful policy acknowledgement follows the persisted state', async()=>{
  const f=managerFixture();
  const result=await f.manager.action({action:'configure',settings:{choiceSeconds:75,busyPolicy:'ask'}});
  assert.equal(result?.error,undefined);
  assert.equal(f.state.settings.choiceSeconds,75);
  assert.equal(f.manager.snapshot().settings.busyPolicy,'ask');
});

test('BAT import returns the selected launcher without linking or switching accounts', async()=>{
  const f=managerFixture({window:{showOpenDialog:async()=>[{fsPath:'C:/fixtures/chrome.bat'}]}});
  const original=f.core.request;
  f.core.request=async action=>action==='launcher.importBat'?{id:'chosen-bat'}:original(action);
  const result=await f.manager.action({action:'import'});
  assert.equal(result.launcherId,'chosen-bat');
  assert.equal(f.calls.some(action=>['account.link','account.activate','account.loginStart'].includes(action)),false);
});

for(const outcome of ['success','error','throw','missing'])test('webview account action result is correlated and reports '+outcome,async()=>{
  const filename=path.join(__dirname,'../../extension.js'),localRequire=createRequire(filename),replies=[];
  let receive;
  const vscode={extensions:{all:[]},workspace:{getConfiguration:()=>({get:(_key,value)=>value})}};
  const view={visible:true,webview:{postMessage:m=>replies.push(m),onDidReceiveMessage:handler=>{receive=handler;}},onDidChangeVisibility(){}};
  const manager=outcome==='missing'?null:{action:async()=>{if(outcome==='throw')throw new Error('Operation failed');return outcome==='error'?{error:'Operation failed'}:{launcherId:'chosen-bat'};},snapshot:()=>({settings:{choiceSeconds:75}})};
  const context=vm.createContext({require:name=>name==='vscode'?vscode:localRequire(name),__dirname:path.dirname(filename),process,module:{exports:{}},console,setInterval,clearInterval,setTimeout,clearTimeout,view,manager});
  vm.runInContext(fs.readFileSync(filename,'utf8'),context,{filename});
  vm.runInContext("contextRef={subscriptions:[],globalState:{get:(_key,value)=>value},workspaceState:{update:async()=>{}}};dashboardHtml=()=>'';renderStatus=()=>{};postViewState=()=>{};refreshAll=async()=>{};accountManager=manager;new TrackerViewProvider().resolveWebviewView(view);",context);
  await receive({command:'accountAction',action:'configure',requestId:'save-1',settings:{choiceSeconds:75}});
  const result=replies.at(-1);
  assert.equal(result.type,'accountActionResult');assert.equal(result.requestId,'save-1');
  assert.equal(Boolean(result.error),outcome!=='success');
  if(outcome==='success'){assert.equal(result.data.settings.choiceSeconds,75);assert.equal(result.launcherId,'chosen-bat');}
});
