'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
function ui(){
  const elements=new Map(),messages=[],listeners={};
  const element=id=>{
    if(!elements.has(id)){
      let html='';
      const node={value:'',textContent:'',dataset:{},classList:{toggle(){}},checked:false,disabled:false,scrollTop:0,scrollLeft:0,writes:0};
      Object.defineProperty(node,'innerHTML',{get:()=>html,set:value=>{
        html=value;node.writes++;
        if(id==='detail'){node.scrollTop=0;node.scrollLeft=0;for(const child of ['plaintext','copyPlaintext','copyStatus','more'])elements.delete(child);}
      }});
      elements.set(id,node);
    }
    return elements.get(id);
  };
  const context=vm.createContext({document:{getElementById:element,querySelectorAll:()=>[],activeElement:null},window:{addEventListener:(name,callback)=>listeners[name]=callback},acquireVsCodeApi:()=>({postMessage:value=>messages.push(value)}),Date,Set,Infinity});
  const source=fs.readFileSync(require('path').join(__dirname,'../traffic_monitor.html'),'utf8').match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(source,context);element('direction').value='all';element('layer').value='api';
  return {element,messages,context,receive:data=>listeners.message({data}),update:data=>listeners.message({data:{type:'trafficState',data}})};
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

test('offline event names participate in search and selecting a match loads that event',()=>{
  const view=ui();view.update({gateway:{},savedTraffic:{directory:'fixture-log',loaded:1,total:1,eventCount:3},traffic:[
    {traceId:1,type:'saved_request',stage:'SAVED_REQUEST',method:'GET',path:'/backend-api/codex/responses',targetHost:'chatgpt.com'},
    ...['response.created','response.output_text.delta','response.completed'].map((eventType,index)=>({traceId:index+2,type:'client_response_event',stage:'RESPONSE_EVENT',savedEvent:true,direction:'in',eventType,method:'GET',path:'/backend-api/codex/responses',targetHost:'chatgpt.com',kind:'MODEL_REQUEST'}))
  ]});
  for(const term of ['response.created','delta','response.completed']){view.element('search').value=term;assert.equal(vm.runInContext('filtered().length',view.context),1);}
  view.element('direction').value='in';assert.equal(vm.runInContext('filtered().length',view.context),1);
  vm.runInContext('selectTraffic(3)',view.context);assert.equal(view.messages.at(-1).part,'event');assert.equal(view.messages.at(-1).traceId,3);
  assert.match(view.element('detail').innerHTML,/Event này/);assert.match(view.element('status').textContent,/1\/1 requests · 3 events/);
});

function reader(){
  const view=ui(),traffic=[{traceId:1,type:'client_response',stage:'CLIENT_RESPONSE_CHUNK',direction:'in',hasContent:true,at:2000},{traceId:2,type:'client_response',stage:'CLIENT_RESPONSE_HEADERS',direction:'in',at:3000}];
  const state={traffic,gateway:{}};view.update(state);vm.runInContext('selectTraffic(1)',view.context);
  const token=view.messages.at(-1).viewToken;
  view.receive({type:'trafficPayload',viewToken:token,payload:{traceId:1,part:'request',contentCapture:{content:'line 1\nTiếng Việt <tag> & "JSON"',offset:0,nextOffset:30,complete:false}}});
  return {view,state,token};
}

test('plaintext polling retains DOM, scroll, selection and copy status even after event eviction',()=>{
  const {view,state,token}=reader(),text=view.element('plaintext'),detail=view.element('detail');
  text.scrollTop=240;text.scrollLeft=18;text.selection='selected text';detail.scrollTop=90;
  view.element('copyPlaintext').onclick();const copy=view.messages.at(-1);
  assert.equal(copy.command,'copyTrafficPlaintext');assert.equal(copy.text,'line 1\nTiếng Việt <tag> & "JSON"');
  view.receive({type:'trafficCopyResult',viewToken:token,copySequence:copy.copySequence});
  const writes=detail.writes;
  view.update(state);view.update({...state,traffic:[]});
  assert.equal(detail.writes,writes);assert.equal(view.element('plaintext'),text);
  assert.equal(text.scrollTop,240);assert.equal(text.scrollLeft,18);assert.equal(text.selection,'selected text');assert.equal(detail.scrollTop,90);
  assert.equal(view.element('copyStatus').textContent,'Đã copy.');
  assert.match(detail.innerHTML,/Copy plaintext/);assert.match(detail.innerHTML,/&lt;tag&gt;/);
});

test('a large original BODY is displayed and copied without pagination',()=>{
  const {view,token,state}=reader(),content='Tiếng Việt <raw>\n'.repeat(80000);
  view.receive({type:'trafficPayload',viewToken:token,payload:{traceId:1,contentCapture:{content,complete:true}}});
  const text=view.element('plaintext');text.scrollTop=230;view.element('detail').scrollTop=70;
  view.update(state);assert.equal(view.element('plaintext'),text);assert.equal(text.scrollTop,230);assert.equal(view.element('detail').scrollTop,70);
  view.element('copyPlaintext').onclick();assert.equal(view.messages.at(-1).text,content);
  assert.doesNotMatch(view.element('detail').innerHTML,/id="more"|Tải thêm|Copy phần đã tải/);
});

test('switching event resets scroll and rejects stale payload and clipboard results',()=>{
  const {view,token}=reader();view.element('copyPlaintext').onclick();const copy=view.messages.at(-1);
  view.element('detail').scrollTop=70;view.element('plaintext').scrollTop=230;
  vm.runInContext('selectTraffic(2)',view.context);const currentToken=view.messages.at(-1).viewToken;
  assert.equal(view.element('detail').scrollTop,0);
  view.receive({type:'trafficPayload',viewToken:token,payload:{traceId:1,contentCapture:{content:'stale'}}});
  view.receive({type:'trafficPayload',viewToken:currentToken,payload:{traceId:2,headers:{'content-type':'text/event-stream'}}});
  assert.match(view.element('detail').innerHTML,/Copy headers/);assert.doesNotMatch(view.element('detail').innerHTML,/stale/);
  view.element('copyPlaintext').onclick();const currentCopy=view.messages.at(-1);
  view.receive({type:'trafficCopyResult',viewToken:token,copySequence:copy.copySequence});
  assert.equal(view.element('copyStatus').textContent,'Đang copy…');
  view.receive({type:'trafficCopyResult',viewToken:currentToken,copySequence:currentCopy.copySequence,error:'clipboard unavailable'});
  assert.equal(view.element('copyStatus').textContent,'Copy thất bại: clipboard unavailable');
  assert.equal(JSON.parse(currentCopy.text)['content-type'],'text/event-stream');
});

test('phase labels distinguish HTTP data, end milestones and semantic response completion',()=>{
  const view=ui();
  for(const [stage,name] of [['CLIENT_RESPONSE_HEADERS','HEADER'],['PLAINTEXT_HTTP_HEADERS','HEADER'],['UPSTREAM_REQUEST_OPENED','HEADER'],['CLIENT_RESPONSE_CHUNK','BODY'],['CLIENT_JSON_PREPARED','BODY'],['PLAINTEXT_HTTP_REQUEST_BODY','BODY'],['CLIENT_RESPONSE_FINISHED','FINISHED'],['UPSTREAM_BODY_FINISHED','FINISHED']]){
    assert.equal(vm.runInContext('eventPhase({stage:'+JSON.stringify(stage)+'}).name',view.context),name);
  }
  assert.equal(vm.runInContext('eventPhase({stage:"RESPONSE_EVENT",eventType:"response.completed"})',view.context),null);
  assert.match(vm.runInContext('eventPhase({stage:"CLIENT_RESPONSE_FINISHED"}).note',view.context),/Không tự chứng minh/);
  assert.match(vm.runInContext('eventPhase({stage:"CLIENT_RESPONSE_CHUNK",captureBoundary:"http-client-body-frame"}).note',view.context),/Tracker không chia lại/);
});

test('traffic panel copies exact raw text through VS Code clipboard and reports failures',async()=>{
  const source=fs.readFileSync(require('path').join(__dirname,'../extension.js'),'utf8');
  const start=source.indexOf('async function openTrafficMonitor()'),end=source.indexOf('\nasync function ',start+1);
  assert.ok(start>=0&&end>start);
  let receiver,failure=false;const copied=[],replies=[];
  const context=vm.createContext({
    trafficPanel:null,contextRef:{subscriptions:[]},trafficMonitorHtml:()=>'',postTrafficState:()=>{},friendlyError:e=>e.message,
    vscode:{ViewColumn:{Two:2},env:{clipboard:{writeText:async text=>{if(failure)throw new Error('clipboard unavailable');copied.push(text);}}},
      window:{createWebviewPanel:()=>({webview:{postMessage:m=>replies.push(m),onDidReceiveMessage:fn=>{receiver=fn;}},onDidDispose:()=>{}})}}
  });
  vm.runInContext(source.slice(start,end),context);await vm.runInContext('openTrafficMonitor()',context);
  const text='Tiếng Việt\n{"html":"<tag> &"}\n';
  await receiver({command:'copyTrafficPlaintext',text,viewToken:4,copySequence:2});
  assert.deepEqual(copied,[text]);assert.deepEqual(JSON.parse(JSON.stringify(replies.at(-1))),{type:'trafficCopyResult',viewToken:4,copySequence:2});
  failure=true;await receiver({command:'copyTrafficPlaintext',text,viewToken:5,copySequence:3});
  assert.equal(replies.at(-1).error,'clipboard unavailable');assert.equal(replies.at(-1).viewToken,5);assert.equal(copied.length,1);
});
test('traffic UI sends capture settings, directory and offline commands',()=>{
  const view=ui();view.update({traffic:[],gateway:{trafficCaptureMode:'post-get',trafficMaxRequests:500,trafficLogsEnabled:true,trafficLogsDirectory:'test-log-folder'}});
  view.element('captureMode').value='post-get';view.element('maxRequests').value=250;view.element('saveLogs').checked=true;view.element('maxRequests').onchange();
  assert.deepEqual(JSON.parse(JSON.stringify(view.messages.at(-1))),{command:'configureTraffic',settings:{mode:'post-get',maxRequests:250,enabled:true}});
  view.element('chooseLogs').onclick();assert.equal(view.messages.at(-1).command,'chooseTrafficLogDirectory');
  view.element('openLogs').onclick();assert.equal(view.messages.at(-1).command,'openSavedTraffic');
  view.element('newSession').onclick();assert.equal(view.messages.at(-1).command,'newTrafficSession');
});
