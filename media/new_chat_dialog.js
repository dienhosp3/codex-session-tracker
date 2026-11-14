(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const dialog = el('newChatDialog'), form = el('ncForm'), workspace = el('ncWorkspace'), prompt = el('ncPrompt');
  const modelSelect = el('ncModelSelect');
  const speedSelect = el('ncSpeed');
  let speedId = '', speedSaving = false, speedFailed = false, speedTouched = false, speeds = [];
  let sequence = 0, optionsId = '', saveId = '', submitId = '', selectedPreset = '', choices = [];
  let loading = false, sending = false, blocked = false, settingsOnly = false, touched = false, ready = false;
  let savingPreference = false, saveFailed = false;
  let autoRuleRequest = '', autoRuleSaving = false, autoRuleInvalid = false;
  const imageEditor = window.TrackerImageAttachments?.create({root:el('ncImages'),pasteTarget:form,changed:()=>updateControls()});
  const contexts=window.TrackerContextChoice;
  const id = () => 'new-chat-' + Date.now() + '-' + (++sequence);
  const send = message => vscode.postMessage(message);
  const status = (text = '', error = false) => {
    el('ncStatus').textContent = text;
    el('ncStatus').hidden = !text;
    el('ncStatus').classList.toggle('error', error);
  };
  function updateControls() {
    const locked = sending || blocked;
    const customValid=contexts.sync(el('ncCustomField'),el('ncCustomK'),selectedPreset,choices,locked||loading);
    imageEditor?.setLocked(locked || settingsOnly);
    workspace.disabled = locked || loading;
    modelSelect.disabled = locked || loading;
    speedSelect.disabled = locked || loading;
    speedSelect.classList.toggle('is-ultrafast', speedSelect.value === 'ultrafast');
    for (const option of speedSelect.options) option.disabled = option.value !== 'default' && !speeds.some(speed => speed.value === option.value && speed.available);
    const speedUnavailable = speedSelect.selectedOptions[0]?.disabled;
    el('ncBrowse').disabled = locked || loading;
    prompt.disabled = locked;
    for (const name of ['ncAutoEnabled','ncAutoScope','ncAutoThreshold']) el(name).disabled = locked || loading;
    for (const input of el('ncPresets').querySelectorAll('input')) {
      input.disabled = locked || loading || !choices.find(choice => choice.preset === input.value)?.available;
    }
    for (const name of ['ncClose', 'ncCancel']) el(name).disabled = sending;
    el('ncSubmit').disabled = sending || blocked || loading || !ready || !customValid || imageEditor?.busy || autoRuleSaving || autoRuleInvalid || speedSaving || speedFailed || speedUnavailable ||
      (settingsOnly && (savingPreference || saveFailed)) ||
      !modelSelect.value || (!settingsOnly && (!workspace.value || !prompt.value.trim() && !imageEditor?.images.length)) || !choices.find(choice => choice.preset === contexts.key(selectedPreset,choices))?.available;
    el('ncSubmit').textContent = sending ? 'Đang tạo chat…' : settingsOnly ? 'Xong' : 'Tạo chat';
    form.setAttribute('aria-busy', String(sending || loading));
  }
  function renderChoices() {
    el('ncPresets').replaceChildren();
    const data = choices.length ? choices : ['default', '400k', '550k', '700k', '900k','custom'].map(preset => ({ preset, label: preset === 'default' ? '—K' : preset==='custom'?'Tự đặt':preset.toUpperCase(), detail: 'Đang tải…' }));
    for (const choice of data) {
      const label = document.createElement('label'); label.className = 'nc-choice';
      const input = document.createElement('input'); input.type = 'radio'; input.name = 'newChatContext'; input.value = choice.preset;
      input.checked = choice.preset === contexts.key(selectedPreset,choices);
      input.addEventListener('change', () => {
        selectedPreset = choice.preset==='custom'?contexts.fromInput(el('ncCustomK')):choice.preset;
        if(selectedPreset==='custom'){updateControls();el('ncCustomK').focus();return;}
        touched = true; saveId = id();
        savingPreference = true; saveFailed = false;
        el('ncPreference').textContent = 'Đang lưu…';
        send({ command: 'saveNewChatPreset', requestId: saveId, preset: selectedPreset });
        updateControls();
      });
      const title = document.createElement('span'); title.className = 'nc-choice-title';
      title.textContent = choice.label + (choice.capacity ? ' · ' + choice.capacity : '');
      const detail = document.createElement('small'); detail.textContent = choice.detail;
      const mark = document.createElement('span'); mark.className = 'nc-selected-mark'; mark.textContent = '✓'; mark.setAttribute('aria-hidden', 'true');
      label.append(input, title, detail, mark);
      if (choice.note) label.title = choice.note;
      el('ncPresets').append(label);
    }
    updateControls();
  }
  function load(browse = false) {
    optionsId = id(); loading = true;
    status('Đang tải…'); el('ncRetry').hidden = true;
    updateControls();
    send({ command: browse ? 'browseNewChatWorkspace' : 'loadNewChatOptions', requestId: optionsId, cwd: workspace.value,
      ...(modelSelect.value ? { model: modelSelect.value } : {}) });
  }
  el('ncCustomK').oninput=()=>{
    selectedPreset=contexts.fromInput(el('ncCustomK'));touched=true;
    if(selectedPreset!=='custom'){
      saveId=id();savingPreference=true;saveFailed=false;
      send({command:'saveNewChatPreset',requestId:saveId,preset:selectedPreset});
    }
    updateControls();
  };
  function open(onlySettings = false) {
    if (dialog.open) { prompt.focus(); return; }
    settingsOnly = onlySettings; speedTouched = speedSaving;
    if (!speedSaving) speedSelect.value = state.newChat?.serviceTier || speedSelect.value || 'default';
    selectedPreset = savingPreference ? selectedPreset : state.newChat?.contextPreset || selectedPreset || 'default';
    touched = savingPreference;
    showAutoRule(state.newChat?.autoContext);
    el('ncTitle').textContent = settingsOnly ? 'Cài đặt chat mới' : 'Tạo chat mới';
    el('ncSubtitle').textContent = settingsOnly ? 'Nhớ cho lần sau.' : 'Model · Context · Yêu cầu';
    el('ncPromptField').hidden = settingsOnly;
    el('ncShortcut').hidden = settingsOnly;
    el('ncCancel').textContent = settingsOnly ? 'Đóng' : 'Hủy';
    dialog.showModal();
    if (!blocked) { renderChoices(); load(); }
    updateControls();
    if (!settingsOnly && !blocked) prompt.focus();
  }
  function close() {
    if (sending) return;
    dialog.close(); optionsId = '';
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (el('ncSubmit').disabled) return;
    if (settingsOnly) { close(); return; }
    sending = true; submitId = id(); status('Đang tạo chat…'); updateControls();
    send({ command: 'submitNewChat', requestId: submitId, cwd: workspace.value, model: modelSelect.value, preset: selectedPreset, message: prompt.value, ...(imageEditor?.images.length?{images:imageEditor.images}:{}), serviceTier: speedSelect.value });
  });
  form.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing && !settingsOnly) {
      event.preventDefault(); form.requestSubmit();
    }
  });
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  speedSelect.onchange = () => {
    speedTouched = true; speedId = id(); speedSaving = true; speedFailed = false;
    el('ncSpeedStatus').textContent = 'Đang lưu…'; updateControls();
    send({ command: 'saveNewChatSpeed', requestId: speedId, serviceTier: speedSelect.value });
  };
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll('button:not(:disabled),select:not(:disabled),textarea:not(:disabled),input:not(:disabled)')]
      .filter(element => element.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  for (const name of ['ncClose', 'ncCancel']) el(name).onclick = close;
  el('ncBrowse').onclick = () => load(true);
  el('ncRetry').onclick = () => load();
  el('ncOpenCreated').onclick = () => send({ command: 'openCreatedChat', requestId: submitId });
  el('ncStartOver').onclick = () => {
    blocked = false; submitId = ''; prompt.value = ''; imageEditor?.clear();
    el('ncStartOver').hidden = true; el('ncOpenCreated').hidden = true;
    load(); prompt.focus();
  };
  workspace.onchange = () => load();
  modelSelect.onchange = () => load();
  prompt.oninput = updateControls;
  function showAutoRule(rule) {
    if (!rule || autoRuleSaving) return;
    el('ncAutoEnabled').checked = rule.enabled === true;
    el('ncAutoScope').value = rule.scope || 'all';
    el('ncAutoThreshold').value = rule.thresholdPercent ?? 80;
    updateAutoHint();
  }
  function updateAutoHint() {
    const labels = { all: 'Codex, Tracker, chuyển tiếp.', tracker: 'Chỉ nút Chat mới của Tracker.', successor: 'Chỉ chat kế tiếp.' };
    el('ncAutoHint').textContent = labels[el('ncAutoScope').value] + ' Chat cũ giữ nguyên.';
  }
  function saveAutoRule() {
    const thresholdPercent = Number(el('ncAutoThreshold').value);
    autoRuleInvalid = !Number.isInteger(thresholdPercent) || thresholdPercent < 1 || thresholdPercent > 99;
    if (autoRuleInvalid) { el('ncAutoStatus').textContent = 'Ngưỡng: 1–99%.'; updateControls(); return; }
    autoRuleRequest = id(); autoRuleSaving = true; updateAutoHint(); el('ncAutoStatus').textContent = 'Đang lưu…'; updateControls();
    send({ command: 'saveNewChatAutoContext', requestId: autoRuleRequest, settings: {
      enabled: el('ncAutoEnabled').checked, scope: el('ncAutoScope').value, thresholdPercent
    } });
  }
  el('ncAutoEnabled').onchange = saveAutoRule;
  el('ncAutoScope').onchange = saveAutoRule;
  el('ncAutoThreshold').oninput = saveAutoRule;
  el('newChat').onclick = () => open();
  el('newChatSettings').onclick = () => open(true);
  window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'openNewChatDialog') { open(message.settingsOnly === true); return; }
    if (message.type === 'newChatOptions' && message.requestId === optionsId && dialog.open) {
      loading = false;
      if (message.cancelled) { status(); updateControls(); return; }
      if (message.error) {
        showAutoRule(message.autoContext || state.newChat?.autoContext);
        ready = false; status(message.error, true); el('ncRetry').hidden = false; updateControls(); return;
      }
      ready = true;
      const folders = [...(message.folders || [])];
      if (message.cwd && !folders.some(folder => folder.cwd === message.cwd)) folders.push({ name: baseName(message.cwd), cwd: message.cwd });
      workspace.replaceChildren();
      if (!folders.length) workspace.add(new Option('Chọn thư mục…', ''));
      for (const folder of folders) workspace.add(new Option(folder.name, folder.cwd));
      workspace.value = message.cwd || '';
      el('ncPath').textContent = message.cwd || 'Chọn thư mục.';
      modelSelect.replaceChildren();
      for (const model of message.models || []) modelSelect.add(new Option(model.label, model.id));
      modelSelect.value = message.model || '';
      speeds = message.speeds || [];
      if (!speedTouched && !speedSaving) speedSelect.value = message.serviceTier || state.newChat?.serviceTier || 'default';
      if (speedSelect.value !== 'default' && !speeds.some(speed => speed.value === speedSelect.value && speed.available)) el('ncSpeedStatus').textContent = 'Tốc độ đã chọn chưa khả dụng với model này.';
      else if (!speedSaving && !speedFailed) el('ncSpeedStatus').textContent = '';
      if (!touched) selectedPreset = message.preset || selectedPreset;
      choices = message.choices || [];
      showAutoRule(message.autoContext || state.newChat?.autoContext);
      status(); renderChoices();
    } else if (message.type === 'newChatSpeedSaved' && message.requestId === speedId) {
      speedSaving = false; speedFailed = Boolean(message.error);
      el('ncSpeedStatus').textContent = message.error ? 'Chưa lưu: ' + message.error : '';
      if (!message.error) state.newChat = { ...state.newChat, serviceTier: message.serviceTier };
      updateControls();
    } else if (message.type === 'newChatAutoContextSaved' && message.requestId === autoRuleRequest) {
      autoRuleSaving = false; autoRuleInvalid = Boolean(message.error);
      el('ncAutoStatus').textContent = message.error ? 'Chưa lưu: ' + message.error : 'Đã lưu.';
      if (!message.error) { state.newChat = { ...state.newChat, autoContext: message.autoContext }; showAutoRule(message.autoContext); }
      updateControls();
    } else if (message.type === 'newChatPresetSaved' && message.requestId === saveId) {
      savingPreference = false; saveFailed = Boolean(message.error);
      el('ncPreference').textContent = message.error ? 'Chưa lưu: ' + message.error : 'Đã nhớ.';
      if (!message.error) state.newChat = { ...state.newChat, contextPreset: message.preset };
      updateControls();
    } else if (message.type === 'newChatResult' && message.requestId === submitId) {
      sending = false;
      if (message.success) {
        prompt.value = ''; blocked = false; imageEditor?.clear(); status(); dialog.close();
        el('ncOpenCreated').hidden = true; el('ncStartOver').hidden = true;
      } else {
        blocked = Boolean(message.threadId) || message.delivery === 'unknown';
        status((message.threadId ? 'Chat đã tạo. ' : blocked ? 'Chưa xác nhận được kết quả. Kiểm tra danh sách chat trước khi tạo lại. ' : '') + message.error, true);
        el('ncOpenCreated').hidden = !message.threadId;
        el('ncStartOver').hidden = !blocked;
      }
      updateControls();
    }
  });
  send({ command: 'newChatDialogReady' });
})();
