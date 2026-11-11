(() => {
  'use strict';
  const el = id => document.getElementById(id), dialog = el('proxyOptionsDialog'), form = el('poForm');
  let sequence = 0, loadId = '', saveId = '', browseId = '', path = '', busy = false, ready = false;
  const id = () => 'proxy-options-' + Date.now() + '-' + (++sequence);
  const status = (text = '', error = false) => { el('poStatus').textContent = text; el('poStatus').classList.toggle('error', error); };
  function controls() {
    for (const name of ['poEnabled', 'poMinutes', 'poBrowse', 'poSave']) el(name).disabled = busy || !ready;
    el('poClose').disabled = el('poCancel').disabled = busy && Boolean(saveId);
    el('poPath').textContent = path || 'Chưa chọn EXE';
    form.setAttribute('aria-busy', String(busy));
  }
  window.openProxyOptions = () => {
    if (dialog.open) return;
    busy = true; ready = false; saveId = ''; browseId = ''; loadId = id(); form.reset(); path = '';
    status('Đang tải…'); controls(); dialog.showModal();
    vscode.postMessage({ command: 'loadProxyOptions', requestId: loadId });
  };
  const close = () => { if (busy && saveId) return; loadId = browseId = ''; dialog.close(); };
  el('poClose').onclick = el('poCancel').onclick = close;
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  el('poBrowse').onclick = () => {
    browseId = id(); busy = true; controls();
    vscode.postMessage({ command: 'browseProxyOptions', requestId: browseId });
  };
  form.onsubmit = event => {
    event.preventDefault(); if (el('poSave').disabled || !form.reportValidity()) return;
    saveId = id(); busy = true; status('Đang lưu…'); controls();
    vscode.postMessage({ command: 'saveProxyOptions', requestId: saveId, settings: {
      enabled: el('poEnabled').checked, minutes: Number(el('poMinutes').value), executablePath: path } });
  };
  window.addEventListener('message', event => {
    const m = event.data;
    if (m.type === 'openProxyOptions') window.openProxyOptions();
    if (m.type === 'proxyOptionsLoaded' && m.requestId === loadId) {
      busy = false; ready = !m.error;
      if (m.error) status(m.error, true);
      else { path = m.settings.executablePath; el('poEnabled').checked = m.settings.enabled; el('poMinutes').value = m.settings.minutes; status(); }
      controls();
    } else if (m.type === 'proxyOptionsBrowsed' && m.requestId === browseId) {
      busy = false; if (m.executablePath) path = m.executablePath;
      if (m.error) status(m.error, true); controls();
    } else if (m.type === 'proxyOptionsSaved' && m.requestId === saveId) {
      busy = false; saveId = ''; status(m.error ? 'Chưa lưu: ' + m.error : 'Đã lưu.', Boolean(m.error)); controls();
    }
  });
})();
