'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
const html=fs.readFileSync(require('path').join(__dirname,'../dashboard.html'),'utf8');
function ui(kind){
 const elements=new Map(),messages=[];
 const context=vm.createContext({document:{getElementById:id=>elements.get(id)||null,querySelectorAll:()=>[]},vscode:{postMessage:m=>messages.push(m)},esc:s=>String(s||''),imageMarkup:()=>'',steerInfo:()=>null,queueInfo:()=>null,addDraftImages:()=>{},renderMain:()=>{}});
 vm.runInContext(`let state={selected:{stateKind:${JSON.stringify(kind)}},selectedThreadId:'target',steer:{available:true},queue:{available:true},continuation:{}};let draft='',draftImages=[],composerNotice='';`,context);
 for(const [start,end] of [['bindComposer','addDraftImages'],['renderComposer','renderMain']]){
  vm.runInContext(html.slice(html.indexOf('function '+start+'('),html.indexOf('function '+end+'(')),context);
 }
 const rendered=vm.runInContext('renderComposer()',context);
 for(const match of rendered.matchAll(/id="([^"]+)"/g)){const element={value:'',disabled:false,focus(){},setSelectionRange(){},click(){this.onclick?.()}};elements.set(match[1],element);}
 vm.runInContext('bindComposer(false,0,0)',context);
 return{context,elements,messages,rendered,setDraft(text){elements.get('composerInput').value=text;elements.get('composerInput').oninput();}};
}
test('completed chat renders continuation composer and sends Unicode to the selected chat',()=>{
 const view=ui('completed');assert.match(view.rendered,/Tiếp tục chat/);assert.equal(view.elements.has('steerBtn'),false);assert.equal(view.elements.has('queueBtn'),false);
 assert.equal(view.elements.get('continueBtn').disabled,true);view.setDraft('Làm tiếp nhé');view.elements.get('continueBtn').click();
 const sent=view.messages[0];assert.equal(sent.command,'continueMessage');assert.equal(sent.threadId,'target');assert.equal(sent.text,'Làm tiếp nhé');
});
test('Ctrl+Enter continues completed chat and global send busy disables the action',()=>{
 const view=ui('completed');view.setDraft('Next');view.elements.get('composerInput').onkeydown({key:'Enter',ctrlKey:true,preventDefault(){}});assert.equal(view.messages.length,1);
 vm.runInContext('state.continuation.busy=true',view.context);view.elements.get('composerInput').oninput();assert.equal(view.elements.get('continueBtn').disabled,true);view.elements.get('continueBtn').click();assert.equal(view.messages.length,1);
});
test('completed chat supports image-only continuation',()=>{
 const view=ui('completed');vm.runInContext("draftImages=[{dataUrl:'data:image/png;base64,test'}]",view.context);view.elements.get('composerInput').oninput();view.elements.get('continueBtn').click();assert.equal(view.messages[0].images.length,1);assert.equal(view.messages[0].text,'');
});
test('running chat retains steer and queue actions and unknown state cannot continue',()=>{
 const running=ui('running');assert.equal(running.elements.has('continueBtn'),false);assert.equal(running.elements.has('steerBtn'),true);assert.equal(running.elements.has('queueBtn'),true);
 running.setDraft('Steer');running.elements.get('composerInput').onkeydown({key:'Enter',ctrlKey:true,preventDefault(){}});assert.equal(running.messages[0].command,'steerMessage');
 const unknown=ui('unknown');unknown.setDraft('Continue');assert.equal(unknown.elements.get('continueBtn').disabled,true);
});
