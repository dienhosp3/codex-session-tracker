window.TrackerContextChoice={
 customK(value){if(value==='600k')return 600;const match=/^custom:(\d+)$/.exec(String(value));return match?Number(match[1]):null;},
 key(value,choices){if(choices.some(choice=>choice.preset===value))return value;return this.customK(value)!==null?'custom':value;},
 fromInput(input){const k=Number(input.value);return Number.isSafeInteger(k)&&k>0&&Number.isSafeInteger(k*1000)?'custom:'+k:'custom';},
 sync(field,input,preset,choices,locked){
  const custom=this.key(preset,choices)==='custom',saved=this.customK(preset);
  field.hidden=!custom;input.disabled=locked||!custom;
  if(saved!==null&&document.activeElement!==input){input.value=String(saved);input.dataset.contextInitialized='true';}
  const defaultK=choices.find(choice=>choice.preset==='default')?.requestedK;
  if(!custom&&!input.dataset.contextInitialized){input.value=String(defaultK||400);if(defaultK)input.dataset.contextInitialized='true';}
  const valid=!custom||this.fromInput(input)!=='custom';
  input.setCustomValidity(valid?'':'Nhập số K nguyên dương.');
  return valid;
 }
};
