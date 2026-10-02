'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
function ui(){
  const elements=new Map(),messages=[],listeners={};
  const element=id=>{if(!elements.has(id))elements.set(id,{value:'',textContent:'',innerHTML:'',dataset:{},classList:{toggle(){}},checked:false,disabled:false});return elements.get(id);};
  const context=vm.createContext({document:{getElementById:element,querySelectorAll:()=>[],activeElement:null},window:{addEventListener:(name,callback)=>listeners[name]=callback},acquireVsCodeApi:()=>({postMessage:value=>messages.push(value)}),Date,Set,Infinity});
  const source=fs.readFileSync(require('path').join(__dirname,'../traffic_monitor.html'),'utf8').match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(source,context);element('direction').value='all';element('layer').value='api';
  return {element,messages,context,update:data=>listeners.message({data:{type:'trafficState',data}})};
}
test('traffic UI filters method, backend, Responses group and time independently',()=>{
  const view=ui(),traffic=[{traceId:1,type:'client_request',method:'POST',path:'/backend-api/codex/responses',targetHost:'chatgpt.com',at:2000},{traceId:2,type:'client_request',method:'GET',path:'/models',targetHost:'other.test',at:3000},{traceId:3,type:'tunnel_bytes',at:4000}];
  view.update({traffic,gateway:{trafficMaxRequests:1000}});
  assert.equal(vm.runInContext('filtered().length',view.context),2);
  view.element('method').value='POST';assert.equal(vm.runInContext('filtered().length',view.context),1);
  view.element('method').value='';view.element('backend').value='other.test';assert.equal(vm.runInContext('filtered()[0].path',view.context),'/models');
  view.element('backend').value='';view.element('category').value='responses';assert.equal(vm.runInContext('filtered()[0].method',view.context),'POST');
  view.element('timeFrom').value=new Date(2500).toISOString();assert.equal(vm.runInContext('filtered().length',view.context),0);
});
test('traffic UI sends capture settings, directory and offline commands',()=>{
  const view=ui();view.update({traffic:[],gateway:{trafficCaptureMode:'post-get',trafficMaxRequests:500,trafficLogsEnabled:true,trafficLogsDirectory:'test-log-folder'}});
  view.element('captureMode').value='post-get';view.element('maxRequests').value=250;view.element('saveLogs').checked=true;view.element('maxRequests').onchange();
  assert.deepEqual(JSON.parse(JSON.stringify(view.messages.at(-1))),{command:'configureTraffic',settings:{mode:'post-get',maxRequests:250,enabled:true}});
  view.element('chooseLogs').onclick();assert.equal(view.messages.at(-1).command,'chooseTrafficLogDirectory');
  view.element('openLogs').onclick();assert.equal(view.messages.at(-1).command,'openSavedTraffic');
  view.element('newSession').onclick();assert.equal(view.messages.at(-1).command,'newTrafficSession');
});
