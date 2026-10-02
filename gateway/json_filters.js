'use strict';
const {sha256}=require('./redaction');

function parts(pointer){
  if(typeof pointer!=='string'||!pointer.startsWith('/')||pointer.length>2048)throw new Error('JSON pointer phải bắt đầu bằng /.');
  const keys=pointer.slice(1).split('/').map(v=>v.replace(/~1/g,'/').replace(/~0/g,'~'));
  if(keys.some(k=>['__proto__','prototype','constructor'].includes(k)))throw new Error('JSON pointer không hợp lệ.');
  return keys;
}
function at(value,pointer){
  for(const key of parts(pointer)){
    if(value===null||typeof value!=='object'||!Object.hasOwn(value,key))return undefined;
    value=value[key];
  }
  return value;
}
function patch(body,operation){
  const keys=parts(operation.path),key=keys.pop();let parent=body;
  for(const part of keys){
    if(parent===null||typeof parent!=='object'||!Object.hasOwn(parent,part))throw new Error('Không tìm thấy parent của JSON pointer.');
    parent=parent[part];
  }
  if(parent===null||typeof parent!=='object')throw new Error('JSON pointer không trỏ tới object/array.');
  if(Array.isArray(parent)){
    const index=key==='-'?parent.length:/^(0|[1-9]\d*)$/.test(key)?Number(key):-1;
    if(index<0||index>parent.length||(operation.op!=='add'&&index===parent.length))throw new Error('Array index không hợp lệ.');
    if(operation.op==='add')parent.splice(index,0,operation.value);
    else if(operation.op==='remove')parent.splice(index,1);
    else parent[index]=operation.value;
  }else{
    if(operation.op!=='add'&&!Object.hasOwn(parent,key))throw new Error('Không tìm thấy JSON pointer cần sửa.');
    if(operation.op==='remove')delete parent[key];else parent[key]=operation.value;
  }
}

class JsonFilters{
  constructor(){this.rules=[];}
  configure(rules){
    if(!Array.isArray(rules)||rules.length>50)throw new Error('Bộ lọc phải là array, tối đa 50 rule.');
    const copy=JSON.parse(JSON.stringify(rules));
    for(const rule of copy){
      if(typeof rule.host!=='string'||!rule.host||typeof rule.method!=='string'||!/^[A-Z]+$/.test(rule.method)||typeof rule.path!=='string'||!rule.path.startsWith('/')||rule.path.includes('?')||rule.path.includes('#'))throw new Error('Rule cần host, method viết hoa và endpoint path cụ thể.');
      if(rule.conditions!==undefined&&!Array.isArray(rule.conditions))throw new Error('conditions phải là array.');
      if(!Array.isArray(rule.operations)||!rule.operations.length||rule.operations.length>50)throw new Error('Rule cần 1..50 operations.');
      for(const op of rule.operations){
        if(!['add','replace','remove'].includes(op.op))throw new Error('Chỉ hỗ trợ add/replace/remove.');
        parts(op.path);
        if(op.path==='/model'||op.path.startsWith('/model/'))throw new Error('Bộ lọc không được đổi model hiện tại.');
        if(op.op!=='remove'&&!Object.hasOwn(op,'value'))throw new Error('Operation thiếu value.');
      }
      for(const condition of rule.conditions||[]){parts(condition.path);if(!Object.hasOwn(condition,'equals'))throw new Error('Condition thiếu equals.');}
    }
    this.rules=copy;
  }
  apply(meta,bodyJson){
    const originalSha256=sha256(Buffer.from(bodyJson));
    const candidates=this.rules.filter(rule=>rule.enabled!==false&&rule.host===meta.host&&rule.method===meta.method&&rule.path===meta.path&&(!rule.protocol||rule.protocol===meta.protocol));
    if(!candidates.length||!bodyJson)return {bodyJson,originalSha256,bodySha256:originalSha256,modified:false,appliedRules:[]};
    let body;try{body=JSON.parse(bodyJson,(_key,value)=>{if(typeof value==='number'&&Number.isInteger(value)&&!Number.isSafeInteger(value))throw new Error();return value;});}catch{throw new Error('Request JSON không hợp lệ hoặc chứa integer vượt độ chính xác; chưa gửi upstream.');}
    const model=body?.model,appliedRules=[];
    for(const rule of candidates){
      if(!(rule.conditions||[]).every(condition=>JSON.stringify(at(body,condition.path))===JSON.stringify(condition.equals)))continue;
      for(const op of rule.operations)patch(body,op);
      appliedRules.push(String(rule.id||this.rules.indexOf(rule)));
    }
    if(body?.model!==model)throw new Error('Bộ lọc đã đổi model; request bị chặn trước khi gửi.');
    const result=appliedRules.length?JSON.stringify(body):bodyJson;
    return {bodyJson:result,originalSha256,bodySha256:sha256(Buffer.from(result)),modified:result!==bodyJson,appliedRules};
  }
}
module.exports={JsonFilters};
