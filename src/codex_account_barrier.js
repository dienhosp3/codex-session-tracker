'use strict';
// A short native dispatch barrier while all windows drain for an account change.
// Reading/navigation/interrupts remain available. It never touches transport config.
let blocked=false;
const wrappers=new Map();
function setAccountBarrier(value){blocked=value===true;}
function installAccountBarrier(connection){
  if(wrappers.has(connection)||typeof connection?.sendRequest!=='function')return;
  const original=connection.sendRequest;
  const wrapped=function(...args){
    const method=args[2],params=args[3];
    if(blocked&&(method==='turn/start'||method==='thread/start'||method==='thread/goal/set'&&params?.status==='active'))throw Object.assign(new Error('Đang chuyển account; chờ Codex nạp phiên mới rồi gửi.'),{code:'ACCOUNT_SWITCH_IN_PROGRESS',delivery:'not_sent'});
    return original.apply(this,args);
  };
  connection.sendRequest=wrapped;wrappers.set(connection,{original,wrapped});
}
function disposeAccountBarriers(){blocked=false;for(const [connection,{original,wrapped}]of wrappers)if(connection.sendRequest===wrapped)connection.sendRequest=original;wrappers.clear();}
module.exports={setAccountBarrier,installAccountBarrier,disposeAccountBarriers};
