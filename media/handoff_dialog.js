(() => {
  'use strict';
  const el = id => document.getElementById(id), dialog = el('handoffDialog'), form = el('hfForm');
  const drafts = new Map();
  let threadId = '', sequence = 0, optionsId = '', submitId = '', choices = [], preset = 'default';
  let loading = false, sending = false, ready = false, blocked = false, initialized = false, nextThreadId = '';
  let modes = {}, speeds = [];
  const imageEditor = window.TrackerImageAttachments?.create({root:el('hfImages'),pasteTarget:form,changed:()=>controls()});
  const contexts=window.TrackerContextChoice;
  const requestId = () => 'handoff-' + Date.now() + '-' + (++sequence);
  function status(text = '', error = false) { el('hfStatus').textContent = text; el('hfStatus').classList.toggle('error', error); }
  function draft() {
    return { model: el('hfModel').value, preset, extraMessage: el('hfExtra').value, code: el('hfCode').value,
      successorMode: el('hfMode').value, goalText: el('hfGoal').value,
      serviceTier: el('hfSpeed').value, images:imageEditor?.images||[],
      nextNumber: el('hfNumber').value, enabled: el('hfEnabled').checked,
      thresholdPercent: el('hfThreshold').value, handoffDelaySeconds: el('hfDelay').value };
  }
  function controls() {
    const locked = sending || blocked;
    const customValid=contexts.sync(el('hfCustomField'),el('hfCustomK'),preset,choices,locked||loading);
    imageEditor?.setLocked(locked || loading);
    el('hfSpeed').classList.toggle('is-ultrafast', el('hfSpeed').value === 'ultrafast');
    for (const option of el('hfSpeed').options) option.disabled = option.value !== 'default' && !speeds.some(speed => speed.value === option.value && speed.available);
    for (const input of form.querySelectorAll('input,select,textarea')) if(input.id!=='hfCustomK')input.disabled = locked || loading;
    const mode = el('hfMode').value, isGoal = mode === 'goal';
    el('hfGoalField').hidden = !isGoal; el('hfGoal').required = isGoal; el('hfGoal').disabled = locked || loading || !isGoal;
    for (const option of el('hfMode').options) option.disabled = option.value !== 'normal' && !modes[option.value]?.available;
    const unavailable = mode !== 'normal' && !modes[mode]?.available;
    const speedUnavailable = el('hfSpeed').selectedOptions[0]?.disabled;
    el('hfSpeedStatus').hidden = !speedUnavailable;
    el('hfSpeedStatus').textContent = speedUnavailable ? 'Tốc độ đã chọn chưa khả dụng với model này.' : '';
    el('hfModeStatus').hidden = !unavailable;
    el('hfModeStatus').textContent = unavailable ? modes[mode]?.reason || 'Chế độ này chưa khả dụng.' : '';
    for (const input of el('hfPresets').querySelectorAll('input')) input.disabled ||= !choices.find(c => c.preset === input.value)?.available;
    el('hfSubmit').disabled = locked || loading || !ready || !customValid || imageEditor?.busy || unavailable || speedUnavailable || !choices.find(c => c.preset === contexts.key(preset,choices))?.available;
    el('hfSubmit').textContent = sending ? 'Đang chuyển…' : 'Chuyển chat';
    el('hfClose').disabled = el('hfCancel').disabled = sending;
    form.setAttribute('aria-busy', String(sending || loading));
  }
  function renderChoices() {
    el('hfPresets').replaceChildren();
    for (const choice of choices) {
      const label = document.createElement('label'); label.className = 'nc-choice';
      const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'handoffContext'; radio.value = choice.preset; radio.checked = contexts.key(preset,choices) === choice.preset;
      radio.onchange = () => { preset = choice.preset==='custom'?contexts.fromInput(el('hfCustomK')):choice.preset; controls();if(choice.preset==='custom')el('hfCustomK').focus(); };
      const title = document.createElement('span'); title.className = 'nc-choice-title'; title.textContent = choice.label;
      const detail = document.createElement('small'); detail.textContent = choice.detail;
      const mark = document.createElement('span'); mark.className = 'nc-selected-mark'; mark.textContent = '✓'; mark.setAttribute('aria-hidden', 'true');
      label.append(radio, title, detail, mark); el('hfPresets').append(label);
    }
    controls();
  }
  function load() {
    optionsId = requestId(); loading = true; el('hfReload').hidden = true; status('Đang tải…'); controls();
    vscode.postMessage({ command: 'loadHandoffOptions', threadId, requestId: optionsId, ...(el('hfModel').value ? { model: el('hfModel').value } : {}) });
  }
  function close() {
    if (sending) return;
    if (initialized && !blocked) { drafts.set(threadId, draft()); if(drafts.size>8)drafts.delete(drafts.keys().next().value); }
    optionsId = ''; dialog.close();
  }
  window.openHandoffDialog = id => {
    if (!id || sending) return;
    if (dialog.open) { el('hfExtra').focus(); return; }
    threadId = id; initialized = false; ready = false; blocked = false; nextThreadId = ''; choices = [];
    const saved = drafts.get(id);
    form.reset(); el('hfModel').replaceChildren(); el('hfPresets').replaceChildren();
    imageEditor?.setImages(saved?.images||[]);
    if (saved?.model) el('hfModel').add(new Option(saved.model, saved.model));
    el('hfSource').textContent = (state.activeChats || []).concat(state.nonRunningChats || []).find(c => c.threadId === id)?.title || (state.selectedThreadId === id ? state.selected?.title : '') || id;
    el('hfOpenNext').hidden = true;
    dialog.showModal(); load();
  };
  el('hfModel').onchange = load;
  el('hfSpeed').onchange = controls;
  el('hfCustomK').oninput=()=>{preset=contexts.fromInput(el('hfCustomK'));controls();};
  el('hfMode').onchange = controls;
  el('hfGoal').oninput = () => el('hfGoal').setCustomValidity('');
  el('hfReload').onclick = load;
  el('hfClose').onclick = el('hfCancel').onclick = close;
  el('hfOpenNext').onclick = () => vscode.postMessage({ command: 'openContextSuccessor', threadId });
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
    if (event.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll('button:not(:disabled),select:not(:disabled),textarea:not(:disabled),input:not(:disabled)')].filter(e => e.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  for (const name of ['hfCode', 'hfNumber']) el(name).oninput = () => el(name).setCustomValidity('');
  form.addEventListener('submit', event => {
    event.preventDefault(); if (el('hfSubmit').disabled) return;
    const value = draft(), code = value.code.trim().normalize('NFC');
    el('hfCode').setCustomValidity(!code || /^[\p{L}\p{N}_ ]{1,30}$/u.test(code) ? '' : 'ID gồm 1–30 chữ, số, dấu cách hoặc _.');
    el('hfNumber').setCustomValidity(/^\d+$/.test(value.nextNumber) && BigInt(value.nextNumber) > 0n ? '' : 'Số kế tiếp phải lớn hơn 0.');
    el('hfGoal').setCustomValidity(value.successorMode === 'goal' && (!value.goalText.trim() || [...value.goalText.trim().normalize('NFC')].length > 4000 || /\[(Kết quả cần hoàn thành|Tiêu chí kiểm chứng được)\]/iu.test(value.goalText)) ? 'Nhập mục tiêu, tối đa 4000 ký tự.' : '');
    if (!form.reportValidity()) return;
    drafts.set(threadId, value); submitId = requestId(); sending = true;
    contextHandoffPending[threadId] = submitId; status('Đang chuyển chat…'); controls();
    vscode.postMessage({ command: 'submitHandoff', threadId, requestId: submitId, model: value.model, settings: {
      preset, extraMessage: value.extraMessage, enabled: value.enabled, thresholdPercent: Number(value.thresholdPercent),
      successorMode: value.successorMode, ...(value.successorMode === 'goal' ? { goalText: value.goalText } : {}),
      serviceTier: value.serviceTier, ...(value.images.length?{images:value.images}:{}),
      handoffDelaySeconds: Number(value.handoffDelaySeconds), series: code ? { code, nextNumber: value.nextNumber } : null } });
    requestRender();
  });
  window.addEventListener('message', event => {
    const m = event.data;
    if (m.type === 'chatOptionsSaved' && !m.error && m.identityUpdated && drafts.has(m.threadId)) {
      const saved = drafts.get(m.threadId), series = m.data?.entries?.[m.threadId]?.series;
      saved.code = series?.code || ''; saved.nextNumber = series?.nextNumber || '0001';
    }
    if (m.type === 'openHandoffDialog') window.openHandoffDialog(m.threadId);
    if (m.type === 'handoffOptions' && m.threadId === threadId && m.requestId === optionsId) {
      loading = false;
      if (m.error) { ready = false; status(m.error, true); el('hfReload').hidden = false; controls(); return; }
      el('hfSource').textContent = m.title || threadId; el('hfSource').title = m.cwd || '';
      el('hfModel').replaceChildren(); for (const model of m.models || []) el('hfModel').add(new Option(model.label, model.id));
      el('hfModel').value = m.model;
      modes = m.modes || {};
      speeds = m.speeds || [];
      if (!initialized) {
        const value = drafts.get(threadId) || { ...m, code: m.series?.code || '', nextNumber: m.series?.nextNumber || '0001', extraMessage: '' };
        preset = value.preset;
        el('hfSpeed').value = value.serviceTier || m.serviceTier || 'default';
        el('hfMode').value = value.successorMode || 'normal'; el('hfGoal').value = value.goalText || m.goalText || '';
        el('hfExtra').value = value.extraMessage; el('hfCode').value = value.code; el('hfNumber').value = value.nextNumber;
        el('hfEnabled').checked = value.enabled; el('hfThreshold').value = value.thresholdPercent; el('hfDelay').value = value.handoffDelaySeconds;
        initialized = true;
      }
      choices = m.choices || []; ready = true; renderChoices(); status();
    } else if (m.type === 'handoffResult' && m.threadId === threadId && m.requestId === submitId) {
      sending = false; delete contextHandoffPending[threadId]; blocked = Boolean(m.blocked || m.success); nextThreadId = m.nextThreadId || '';
      el('hfOpenNext').hidden = !nextThreadId;
      if (m.success) { drafts.delete(threadId); imageEditor?.clear(); dialog.close(); }
      else status(m.error || 'Chưa xác nhận chuyển chat.', true);
      controls(); requestRender();
    }
  });
})();
