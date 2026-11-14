// Overlay scroll controls never consume layout width. Native wheel/touch/keys
// still scroll the original element; the thumb is only an optional control.
window.TrackerScrollbars = (() => {
  const selector = '.sidebar,.main,.chat-list,.nc-body';
  const entries = new Map();
  let frame = 0, serial = 0;
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
  const resize = new ResizeObserver(schedule);
  function reveal(entry) {
    clearTimeout(entry.timer);
    entry.rail.classList.add('active');
    entry.timer = setTimeout(() => { if (!entry.dragging) entry.rail.classList.remove('active'); }, 1000);
  }
  function create(target) {
    const rail = document.createElement('div'), thumb = document.createElement('div');
    rail.className = 'overlay-scrollbar'; thumb.className = 'overlay-scrollbar-thumb';
    rail.appendChild(thumb); rail.tabIndex = 0;
    if (!target.id) target.id = 'tracker-scroll-'+(++serial);
    rail.setAttribute('role','scrollbar'); rail.setAttribute('aria-controls',target.id);
    rail.setAttribute('aria-orientation','vertical'); rail.setAttribute('aria-label','Cuộn nội dung');
    const host = target.closest('dialog') || document.body;
    host.appendChild(rail);
    const entry = {target,rail,thumb,host,timer:0,dragging:false,track:0};
    const scroll = () => { reveal(entry); schedule(); };
    const move = () => reveal(entry);
    target.addEventListener('scroll',scroll,{passive:true});
    target.addEventListener('pointermove',move,{passive:true});
    entry.remove = () => {
      clearTimeout(entry.timer); resize.unobserve(target);
      target.removeEventListener('scroll',scroll); target.removeEventListener('pointermove',move);
      rail.remove();
    };
    rail.onpointerdown = event => {
      if (event.button !== 0) return;
      event.preventDefault(); rail.setPointerCapture(event.pointerId);
      entry.dragging = true; reveal(entry);
      const bounds = rail.getBoundingClientRect(), thumbBounds = thumb.getBoundingClientRect();
      const grab = event.target === thumb ? event.clientY-thumbBounds.top : thumbBounds.height/2;
      entry.drag = y => {
        const limit = target.scrollHeight-target.clientHeight;
        target.scrollTop = Math.max(0,Math.min(limit,(y-bounds.top-grab)/Math.max(1,entry.track)*limit));
      };
      if (event.target !== thumb) entry.drag(event.clientY);
    };
    rail.onpointermove = event => { if (entry.dragging) entry.drag(event.clientY); };
    rail.onpointerup = rail.onpointercancel = () => { entry.dragging=false; reveal(entry); };
    rail.onkeydown = event => {
      const amount = {ArrowDown:40,ArrowUp:-40,PageDown:target.clientHeight*.85,PageUp:-target.clientHeight*.85};
      if (Object.hasOwn(amount,event.key)) { event.preventDefault(); target.scrollTop+=amount[event.key]; }
      else if (event.key==='Home'||event.key==='End') { event.preventDefault(); target.scrollTop=event.key==='Home'?0:target.scrollHeight; }
      reveal(entry);
    };
    resize.observe(target);
    return entry;
  }
  function update() {
    frame=0;
    for (const [target,entry] of entries) if (!target.isConnected) { entry.remove(); entries.delete(target); }
    for (const target of document.querySelectorAll(selector)) {
      let entry=entries.get(target);
      if (!entry) { entry=create(target); entries.set(target,entry); }
      const rect=target.getBoundingClientRect(), limit=target.scrollHeight-target.clientHeight;
      const modal=target.closest('dialog');
      const top=Math.max(0,rect.top), bottom=Math.min(innerHeight,rect.bottom), height=bottom-top;
      entry.rail.hidden=limit<=1||height<=0||rect.width<=0||Boolean(modal&&!modal.open);
      if (entry.rail.hidden) continue;
      // Fixed descendants of an animating dialog are relative to its transform.
      const origin=modal&&getComputedStyle(modal).transform!=='none'?modal.getBoundingClientRect():{left:0,top:0};
      const thumbHeight=Math.min(height,Math.max(24,height*target.clientHeight/target.scrollHeight));
      entry.track=height-thumbHeight;
      const style='top:'+(top-origin.top)+'px;left:'+(rect.right-origin.left-8)+'px;height:'+height+'px';
      if(entry.rail.getAttribute('style')!==style)entry.rail.setAttribute('style',style);
      entry.thumb.style.height=thumbHeight+'px';
      entry.thumb.style.transform='translateY('+(entry.track*target.scrollTop/limit)+'px)';
      entry.rail.setAttribute('aria-valuemin','0');entry.rail.setAttribute('aria-valuemax',String(Math.round(limit)));
      entry.rail.setAttribute('aria-valuenow',String(Math.round(target.scrollTop)));
    }
  }
  const changes=new MutationObserver(records=>{
    if(records.some(record=>!record.target.closest?.('.overlay-scrollbar')))schedule();
  });
  changes.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['open','hidden','class','style']});
  window.addEventListener('resize',schedule);
  document.addEventListener('animationend',schedule,true);
  document.addEventListener('scroll',schedule,true);
  schedule();
  return {refresh:schedule};
})();
