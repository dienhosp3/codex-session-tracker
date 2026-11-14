window.TrackerStorageUI=(()=>{
 const el=id=>document.getElementById(id),dialog=el('storageDialog');
 if(!dialog)return {sync(){}};
 let current={},dirty=false,pending='',pendingAction='',sequence=0,opener;
 const format=bytes=>Number.isFinite(bytes)?bytes>=1024*1024?(bytes/1024/1024).toFixed(1)+' MiB':Math.ceil(bytes/1024)+' KiB':'Được giữ';
 const escape=value=>String(value??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
 function sync(value){
  current=value||current;
  if(!dialog.open)return;
  if(!dirty){el('storageAuto').checked=current.policy?.automatic!==false;el('storageDays').value=current.policy?.days??7;el('storageLimit').value=current.policy?.maxMiB??512;}
  el('storageGroups').innerHTML=(current.groups||[]).map(group=>'<div class="storage-group"><span>'+escape(group.label)+(group.protected?'<small>Không tự xoá</small>':'')+'</span><b>'+escape(format(group.bytes))+'</b></div>').join('');
  el('storagePreview').textContent=current.busy?'Đang kiểm tra dung lượng…':dirty?'Lưu chính sách để cập nhật danh sách dọn.':'Dự kiến dọn: '+(current.plannedFiles||0)+' file · '+format(current.plannedBytes||0)+(current.overBudgetBytes?' · '+format(current.overBudgetBytes)+' đang được giữ vì chưa dọn an toàn được.':'');
  const report=current.lastCleanup;
  el('storageStatus').textContent=current.error||report?.errors?.map(error=>error.path+': '+error.reason).join('\n')||(report?'Lần dọn gần nhất: '+report.files+' file · '+format(report.bytes):'');
  el('storageStatus').classList.toggle('error',Boolean(current.error||report?.errors?.length));
  for(const name of ['storageRefresh','storageClean','storageMemory','storageSave'])el(name).disabled=Boolean(pending||current.busy);
  el('storageClean').disabled ||= !current.plannedFiles||dirty;
  for(const id of ['storageAuto','storageDays','storageLimit'])el(id).disabled=!current.groups?.length||pendingAction==='configure';
 }
 function send(action,extra={}){
  if(pending)return;
  pending='storage-'+Date.now()+'-'+(++sequence);pendingAction=action;sync();
  vscode.postMessage({command:'storageAction',action,requestId:pending,...extra});
 }
 function close(){dialog.close();(opener?.isConnected?opener:document.querySelector('[data-open-storage]'))?.focus({preventScroll:true});}
 document.addEventListener('click',event=>{const button=event.target.closest('[data-open-storage]');if(button){opener=button;dialog.showModal();sync();send('inspect');}});
 el('storageClose').onclick=el('storageDone').onclick=close;
 dialog.oncancel=event=>{event.preventDefault();close();};
 for(const id of ['storageAuto','storageDays','storageLimit'])el(id).oninput=()=>{dirty=true;sync();};
 el('storageRefresh').onclick=()=>send('inspect');el('storageClean').onclick=()=>send('clean');el('storageMemory').onclick=()=>send('memory');
 el('storageForm').onsubmit=event=>{event.preventDefault();if(el('storageForm').reportValidity())send('configure',{policy:{automatic:el('storageAuto').checked,days:Number(el('storageDays').value),maxMiB:Number(el('storageLimit').value)}});};
 window.addEventListener('message',event=>{
  const message=event.data;
  if(message.type==='state')sync(message.data?.storage);
  if(message.type==='storageResult'&&message.requestId===pending){
   pending='';pendingAction='';if(!message.error&&message.action==='configure')dirty=false;
   sync(message.data||current);
   if(message.error){el('storageStatus').textContent=message.error;el('storageStatus').classList.add('error');}
   else if(message.action==='memory')el('storageStatus').textContent='Đã làm mới cache hiển thị; lịch sử và cấu hình được giữ nguyên.';
  }
 });
 return {sync};
})();
