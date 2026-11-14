window.TrackerImageAttachments = (() => {
  const allowed = new Set(['image/png','image/jpeg','image/webp','image/gif']);
  function create({root,pasteTarget,changed}) {
    let images=[],locked=false,pending=0,generation=0,chain=Promise.resolve();
    root.innerHTML='<div class="attachment-tools"><button class="nc-button" type="button" data-attachment-add title="Đính kèm ảnh">＋ Ảnh</button><span class="account-help">Dán ảnh hoặc chọn tệp · tối đa 5 ảnh, 8 MiB/ảnh</span><input type="file" data-attachment-file accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden></div><div class="attachment-previews"></div><div class="attachment-error" role="status" hidden></div>';
    const input=root.querySelector('[data-attachment-file]'),add=root.querySelector('[data-attachment-add]'),previews=root.querySelector('.attachment-previews'),error=root.querySelector('.attachment-error');
    const report=message=>{error.textContent=message;error.hidden=!message;};
    function render() {
      previews.replaceChildren();
      images.forEach((image,index)=>{
        const thumb=document.createElement('span');thumb.className='attachment-thumb';thumb.tabIndex=0;
        const picture=document.createElement('img');picture.src=image.dataUrl;picture.alt=image.name;
        const remove=document.createElement('button');remove.type='button';remove.className='attachment-remove';remove.textContent='×';remove.title='Bỏ ảnh';remove.setAttribute('aria-label','Bỏ ảnh '+image.name);remove.disabled=locked;
        remove.onclick=()=>{if(locked)return;images.splice(index,1);report('');render();changed?.();};
        thumb.append(picture,remove);previews.append(thumb);
      });
      add.disabled=input.disabled=locked;
      changed?.();
    }
    async function append(files) {
      if(locked)return;
      const batch=Array.from(files||[]),epoch=generation;
      if(images.length+batch.length>5){report('Tối đa 5 ảnh.');return;}
      if(batch.some(file=>!allowed.has(file.type)||!file.size||file.size>8*1024*1024)){report('Chỉ nhận PNG, JPEG, WebP, GIF; tối đa 8 MiB mỗi ảnh.');return;}
      pending++;changed?.();
      chain=chain.then(async()=>{
        const loaded=[];
        for(const file of batch){
          const dataUrl=await new Promise((resolve,reject)=>{
            const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('Không đọc được ảnh.'));
            reader.readAsDataURL(file);
          });
          const picture=new Image();picture.src=dataUrl;
          try{await picture.decode();}catch{throw new Error('Tệp không phải ảnh hợp lệ.');}
          loaded.push({name:file.name||'Ảnh',mimeType:file.type,dataUrl});
        }
        if(epoch!==generation)return;
        if(images.length+loaded.length>5)throw new Error('Tối đa 5 ảnh.');
        images.push(...loaded);report('');render();
      }).catch(failure=>{if(epoch===generation)report(failure.message);}).finally(()=>{pending--;changed?.();});
      return chain;
    }
    add.onclick=()=>input.click();
    input.onchange=()=>{append(input.files);input.value='';};
    pasteTarget.addEventListener('paste',event=>{
      const files=Array.from(event.clipboardData?.files||[]).filter(file=>file.type.startsWith('image/'));
      if(files.length){event.preventDefault();append(files);}
    });
    pasteTarget.addEventListener('dragover',event=>{if(Array.from(event.dataTransfer?.types||[]).includes('Files'))event.preventDefault();});
    pasteTarget.addEventListener('drop',event=>{
      const files=Array.from(event.dataTransfer?.files||[]);
      if(files.length){event.preventDefault();append(files);}
    });
    return {
      get images(){return images.slice();},get busy(){return pending>0;},
      setImages(value=[]){generation++;images=value.slice();report('');render();},
      setLocked(value){locked=Boolean(value);add.disabled=input.disabled=locked;for(const button of previews.querySelectorAll('button'))button.disabled=locked;},
      clear(){this.setImages([]);}
    };
  }
  return {create};
})();
