(() => {
  'use strict';
  const el = id => document.getElementById(id), dialog = el('chatOptionsDialog'), form = el('coForm');
  let threadId = '', sequence = 0, loading = false, saving = false, ready = false, loadId = '', saveId = '';
  let originalIdentity = null, originalNextSeries = null;
  function identityValue() {
    const code = el('coCode').value.trim().normalize('NFC'), number = el('coNumber').value.trim();
    return code ? { code, number: number.padStart(4, '0') } : null;
  }
  function identityPreview() {
    const value = identityValue();
    if (originalNextSeries && JSON.stringify(value) === JSON.stringify(originalIdentity)) {
      el('coNextPreview').textContent = 'Chat kế tiếp: [' + originalNextSeries.code + '-' + originalNextSeries.nextNumber + ']';
      return;
    }
    el('coNextPreview').textContent = value && /^\d+$/.test(value.number) && BigInt(value.number) > 0n
      ? 'Chat kế tiếp: [' + value.code + '-' + String(BigInt(value.number) + 1n).padStart(value.number.length, '0') + ']' : '';
  }
  function showIdentity(message) {
    originalIdentity = message.identity || null;
    originalNextSeries = message.nextSeries || null;
    el('coCode').value = originalIdentity?.code || ''; el('coNumber').value = originalIdentity?.number || '0001';
    el('coLabel').value = message.displayLabel || '';
    if (message.title) el('coSource').textContent = message.title;
    identityPreview();
  }
  const nextId = () => 'chat-options-' + Date.now() + '-' + (++sequence);
  function status(text = '', error = false) { el('coStatus').textContent = text; el('coStatus').classList.toggle('error', error); }
  function controls() {
    for (const name of ['coDelay', 'coInterval', 'coThreshold', 'coCompletion', 'coAutoAllow', 'coLabel', 'coCode', 'coNumber', 'coSave']) el(name).disabled = loading || saving || !ready;
    el('coNumber').disabled ||= !el('coCode').value.trim();
    for (const name of ['coClose', 'coCancel']) el(name).disabled = saving;
    form.setAttribute('aria-busy', String(loading || saving));
  }
  window.openChatOptions = id => {
    if (!id || saving) return;
    if (dialog.open) { el('coDelay').focus(); return; }
    threadId = id; ready = false; loading = true; form.reset(); originalIdentity = null; originalNextSeries = null; identityPreview(); loadId = nextId();
    const chat = (state.activeChats || []).concat(state.nonRunningChats || []).find(item => item.threadId === id);
    el('coSource').textContent = chat?.title || (state.selectedThreadId === id ? state.selected?.title : '') || id;
    status('Đang tải…'); controls(); dialog.showModal();
    vscode.postMessage({ command: 'loadChatOptions', threadId, requestId: loadId });
  };
  const close = () => { if (!saving) { loadId = ''; dialog.close(); } };
  el('coClose').onclick = el('coCancel').onclick = close;
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  for (const name of ['coCode', 'coNumber', 'coLabel']) el(name).oninput = () => { el(name).setCustomValidity(''); identityPreview(); controls(); };
  form.addEventListener('submit', event => {
    event.preventDefault(); if (el('coSave').disabled) return;
    const identity = identityValue(), label = el('coLabel').value.trim().normalize('NFC');
    el('coCode').setCustomValidity(!identity || /^[\p{L}\p{N}]{1,30}$/u.test(identity.code) ? '' : 'ID phải có 1–30 chữ hoặc số.');
    el('coNumber').setCustomValidity(!identity || /^\d+$/.test(identity.number) && BigInt(identity.number) > 0n ? '' : 'Số hiện tại phải lớn hơn 0.');
    el('coLabel').setCustomValidity([...label].length <= 120 ? '' : 'Nhãn tối đa 120 ký tự.');
    if (!form.reportValidity()) return;
    saving = true; saveId = nextId(); status('Đang lưu…'); controls();
    vscode.postMessage({ command: 'saveChatOptions', threadId, requestId: saveId, displayLabel: label,
      ...(JSON.stringify(identity) !== JSON.stringify(originalIdentity) ? { identity, expectedIdentity: originalIdentity } : {}), options: {
      handoffDelaySeconds: Number(el('coDelay').value), intervalMs: Number(el('coInterval').value), completionSound: el('coCompletion').checked,
      thresholdPercent: Number(el('coThreshold').value), autoAllow: el('coAutoAllow').checked } });
  });
  form.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
  });
  window.addEventListener('message', event => {
    const m = event.data;
    if (m.threadId !== threadId) return;
    if (m.type === 'chatOptionsLoaded' && m.requestId === loadId) {
      loading = false; ready = !m.error;
      if (m.error) status(m.error, true);
      else {
        showIdentity(m);
        el('coSource').textContent = m.title || el('coSource').textContent;
        el('coDelay').value = m.options.handoffDelaySeconds; el('coInterval').value = m.options.intervalMs;
        el('coThreshold').value = m.options.thresholdPercent;
        el('coAutoAllow').checked = m.options.autoAllow === true;
        el('coCompletion').checked = m.options.completionSound; status();
      }
      controls();
    } else if (m.type === 'chatOptionsSaved' && m.requestId === saveId) {
      saving = false;
      if (m.data) state.contextWatch = m.data;
      if (!m.error && m.title) {
        for (const chat of [...state.activeChats || [], ...state.nonRunningChats || [], state.selected].filter(Boolean)) if (chat.threadId === threadId) chat.title = m.title;
      }
      if (!m.error && Object.hasOwn(m, 'identity')) showIdentity(m);
      status(m.error ? 'Chưa lưu: ' + m.error : m.notice || 'Đã lưu.', Boolean(m.error)); controls(); requestRender();
    }
  });
})();
