// The dialog lives outside #main. Background renders must never replace its
// controls: native select popups, IME input, focus and scroll belong to the user.
window.TrackerAccountsUI = (() => {
  'use strict';
  const el = id => document.getElementById(id);
  const dialog = el('accountManagerDialog');
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const phases = {checking:'Đang kiểm tra tài khoản dự phòng',waiting_quota:'Chờ quota phục hồi',choosing:'Chuẩn bị chuyển tài khoản',waiting_idle:'Chờ các chat dừng',needs_stop_approval:'Cần xác nhận dừng chat',activating:'Đang đổi phiên Codex',reloading:'Đang nạp tài khoản mới',resuming:'Đang tiếp tục công việc',completed:'Đã chuyển tài khoản',cancelled:'Đã hủy chuyển',failed:'Chưa chuyển được'};
  const statuses = {ready:'Sẵn sàng',check_failed:'Chưa kiểm tra được',linked:'Đã liên kết',expired:'Phiên hết hạn'};
  const defaults = {autoSwitch:false,busyPolicy:'wait',choiceSeconds:30,autoResume:false,resumeScope:'trigger',autoModelFallback:false,allowedModels:[]};
  const rows = new Map(), launcherRows = new Map(), dirty = new Set(), pending = new Map();
  const icons = {
    refresh:'<path d="M20 11a8 8 0 1 0-2 6M20 4v7h-7"/>',
    switch:'<path d="M4 12h16m-6-6 6 6-6 6"/>',
    options:'<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/>',
    browser:'<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 8h18M7 5.5h.01M10 5.5h.01"/>'
  };
  const icon = name => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">'+icons[name]+'</svg>';
  let current = {}, post = () => {}, tab = 'accounts', sequence = 0, lastJobId = '', savedMessage = '', actionError = '', opener = null, helpScroll = 0, importedLauncher = '';
  const scroll = {accounts:0,policy:0};
  const data = () => current.accountManager || {};
  const fields = () => dialog ? [...dialog.querySelectorAll('[data-account-config]')] : [];
  const date = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString('vi-VN') : '---';
  const text = (node, value) => { const next = String(value ?? ''); if (node && node.textContent !== next) node.textContent = next; };
  const activeJob = job => job && !['completed','cancelled'].includes(job.phase);
  const raw = field => field.type === 'checkbox' ? field.checked : field.value;
  const configValue = (settings, key) => key === 'allowedModels' ? (settings[key] || []).join(', ') : settings[key] ?? '';
  const busy = () => data().busy === true || pending.size > 0;
  const saving = () => [...pending.values()].some(item => item.action === 'configure');

  function trigger(state) {
    return '<button class="iconbtn account-icon" type="button" data-accounts-toggle aria-label="Quản lý account" aria-haspopup="dialog" aria-controls="accountManagerDialog" title="Quản lý account · '+(state.accountManager?.accounts?.length||0)+' tài khoản"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="9" cy="7" r="3"/><path d="M3 20v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v3"/></svg></button>';
  }

  // Only a running switch needs a notice in the dashboard. Management itself
  // is opened explicitly, and never adds an expandable settings card to it.
  function render(state) {
    const job = state.accountManager?.switchJob;
    if (!activeJob(job)) return '';
    return '<section class="account-switch account-switch-inline"><strong>'+esc(phases[job.phase]||job.phase)+'</strong><span data-account-countdown="'+esc(job.deadline??'')+'"></span><div class="account-actions"><button type="button" data-accounts-toggle aria-haspopup="dialog">Mở quản lý account</button>'+(['checking','waiting_quota','choosing','waiting_idle','needs_stop_approval'].includes(job.phase)?'<button type="button" data-account-cancel>Hủy chuyển</button>':'')+'</div></section>';
  }

  function syncOptions(select, items, fallback, reset = false) {
    const selected = reset ? fallback : select.value;
    const existing = new Map([...select.options].map(option => [option.value, option]));
    items.forEach((item, index) => {
      let option = existing.get(item.id);
      if (!option) { option = document.createElement('option'); option.value = item.id; }
      text(option, item.label);
      if (select.options[index] !== option) select.insertBefore(option, select.options[index] || null);
      existing.delete(item.id);
    });
    for (const option of existing.values()) option.remove();
    const value = items.some(item => item.id === selected) ? selected : items.some(item => item.id === fallback) ? fallback : items[0]?.id || '';
    if (select.value !== value) select.value = value;
  }

  function quotaMarkup(account) {
    const group = account.quota?.groups?.find(group => group.id === 'codex') || account.quota?.groups?.[0];
    return group?.windows?.map(window => {
      const label = window.durationMinutes === 300 ? '5h' : window.durationMinutes === 10080 ? 'Tuần' : window.durationMinutes ? window.durationMinutes+'m' : window.key;
      const value = Number.isFinite(window.usedPercent) ? Math.max(0,Math.min(100,Math.round((100-window.usedPercent)*10)/10)) : null;
      const remaining = value === null ? '---' : value+'%';
      return '<div title="'+esc(label+' còn lại · Reset '+date(window.resetsAt))+'"><div class="account-quota-label"><span>'+esc(label)+'</span><b>'+remaining+'</b></div><div class="account-meter" '+(value===null?'':'role="meter" aria-label="'+esc(label)+' còn lại" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+value+'"')+' data-level="'+(value<=5?'empty':value<=25?'low':'normal')+'"><span style="width:'+(value??0)+'%"></span></div></div>';
    }).join('') || '<span class="account-help">Quota —</span>';
  }

  function createRow(account) {
    const row = document.createElement('article');
    row.className = 'account-row'; row.dataset.accountId = account.id;
    row.innerHTML = '<div class="account-summary"><span class="account-avatar" aria-hidden="true"></span><div class="account-main"><span class="account-email"></span><div class="account-meta"><span class="account-badge account-plan"></span><span class="account-badge account-current" hidden>Đang dùng</span></div><span class="account-linked-meta"></span></div><div class="account-quota"></div><div class="account-row-tools"><button class="account-tool" type="button" data-account-action="check" title="Kiểm tra quota" aria-label="Kiểm tra quota">'+icon('refresh')+'</button><button class="account-tool primary" type="button" data-account-action="switch" title="Chuyển sang tài khoản này" aria-label="Chuyển sang tài khoản này">'+icon('switch')+'</button><button class="account-tool" type="button" data-account-options title="Tùy chọn tài khoản" aria-label="Tùy chọn tài khoản" aria-expanded="false">'+icon('options')+'</button></div></div><div class="account-row-options" hidden><p class="account-help account-updated"></p><label class="account-check"><input type="checkbox" data-account-setting="warmupEnabled"><span>Tự kích hoạt 5h sau reset</span></label><label class="account-check"><input type="checkbox" data-account-setting="autoSwitchAllowed"><span>Cho phép tự chọn tài khoản này</span></label><div class="account-actions"><button class="nc-button" type="button" data-account-action="capacity">Quy đổi quota</button></div><p class="account-help account-schedule" hidden></p></div>';
    row.querySelector('[data-account-options]').onclick = event => {
      const button = event.currentTarget, options = row.querySelector('.account-row-options');
      options.hidden = !options.hidden; button.setAttribute('aria-expanded', String(!options.hidden));
    };
    return row;
  }

  function syncAccounts() {
    const a = data(), accounts = a.accounts || [], list = el('amAccounts'), wanted = new Set();
    accounts.forEach((account, index) => {
      wanted.add(account.id);
      let row = rows.get(account.id);
      if (!row) { row = createRow(account); rows.set(account.id, row); }
      if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
      row.dataset.current = String(account.id === a.currentRef);
      text(row.querySelector('.account-email'), account.email || 'Tài khoản chưa xác định');
      row.querySelector('.account-email').title = account.email || '';
      text(row.querySelector('.account-avatar'), (account.email || '?').slice(0,2).toUpperCase());
      const plan = row.querySelector('.account-plan'), rawPlan = String(account.planType || '').toLowerCase();
      const planNames = {free:'Free',plus:'Plus',pro:'Pro',business:'Business',team:'Business',standard_business:'Business',enterprise:'Enterprise',edu:'Edu'};
      text(plan, planNames[rawPlan] || account.planType || 'Chưa rõ gói');
      plan.dataset.plan = rawPlan in planNames ? (rawPlan === 'team' || rawPlan === 'standard_business' ? 'business' : rawPlan) : 'unknown';
      plan.title = 'Gói tài khoản được Codex xác minh: '+plan.textContent;
      const linked = (a.launchers || []).filter(launcher => account.launcherIds?.includes(launcher.id)).map(launcher => launcher.label || String(launcher.batPath || '').split(/[\\/]/).at(-1));
      text(row.querySelector('.account-linked-meta'), linked.join(' · '));
      row.querySelector('.account-current').hidden = account.id !== a.currentRef;
      const quota = row.querySelector('.account-quota'), markup = quotaMarkup(account);
      if (quota.dataset.markup !== markup) { quota.innerHTML = markup; quota.dataset.markup = markup; }
      text(row.querySelector('.account-updated'), 'Cập nhật '+date(account.quota?.checkedAt)+' · '+(statuses[account.status] || account.status || 'Chưa xác định'));
      for (const field of row.querySelectorAll('[data-account-setting]')) {
        const inflight = [...pending.values()].some(item => item.accountRef === account.id && item.action === 'configureAccount');
        if (!inflight) field.checked = Boolean(account.settings?.[field.dataset.accountSetting]);
        field.disabled = busy();
      }
      const schedule = a.schedules?.[account.id], note = row.querySelector('.account-schedule');
      note.hidden = !schedule;
      if (schedule) text(note, 'Work: '+(schedule.phase || schedule.decision || 'chờ')+' · Kiểm tra tiếp '+date(schedule.nextCheckAt)+(schedule.error?' · '+schedule.error:''));
    });
    for (const [id, row] of rows) if (!wanted.has(id)) { row.remove(); rows.delete(id); }
    el('amEmpty').hidden = accounts.length > 0;
    text(el('amCount'), '('+accounts.length+')');
    syncLaunchers();
  }

  function syncLaunchers() {
    const a = data(), linked = new Set((a.accounts || []).flatMap(account => account.launcherIds || []));
    const launchers = (a.launchers || []).filter(launcher => !linked.has(launcher.id)), wanted = new Set(), list = el('amLaunchers');
    launchers.forEach((launcher, index) => {
      wanted.add(launcher.id);
      let row = launcherRows.get(launcher.id);
      if (!row) {
        row = document.createElement('article'); row.className = 'account-row account-launcher-row';
        row.innerHTML = '<div class="account-summary"><span class="account-avatar" aria-hidden="true">'+icon('browser')+'</span><div class="account-main"><span class="account-email"></span><span class="account-linked-meta"></span><div class="account-meta"><span class="account-badge">Chưa liên kết</span></div></div><button class="nc-button" type="button">Liên kết</button></div>';
        row.querySelector('button').onclick = () => { showLink(true); el('amLauncher').value = launcher.id; updateControls(); el('amLauncher').focus(); };
        launcherRows.set(launcher.id, row);
      }
      if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
      const name = launcher.accountLabel || launcher.label || 'Chưa xác minh tài khoản';
      text(row.querySelector('.account-email'), name); row.querySelector('.account-email').title = name;
      text(row.querySelector('.account-linked-meta'), String(launcher.batPath || launcher.label || '').split(/[\\/]/).at(-1));
    });
    for (const [id, row] of launcherRows) if (!wanted.has(id)) { row.remove(); launcherRows.delete(id); }
    el('amDiscovered').hidden = launchers.length === 0;
  }

  function showLink(show) {
    el('amLink').dataset.expanded = String(show); el('amAdd').setAttribute('aria-expanded', String(show));
    if (show) el('amLink').scrollIntoView({block:'nearest'});
    else el('amAdd').focus({preventScroll:true});
  }

  function showHelp(show) {
    if (show) helpScroll = el('amBody').scrollTop;
    el('amHelpPanel').hidden = !show; el('amHelpButton').setAttribute('aria-expanded', String(show));
    if (show) { el('amBody').scrollTop = 0; el('amHelpTitle').focus({preventScroll:true}); }
    else { el('amBody').scrollTop = helpScroll; el('amHelpButton').focus({preventScroll:true}); }
  }

  function syncSwitch() {
    const a = data(), job = a.switchJob, panel = el('amSwitch');
    panel.hidden = !activeJob(job);
    if (!activeJob(job)) { lastJobId = ''; return; }
    text(el('amSwitchTitle'), phases[job.phase] || job.phase);
    el('amSwitchCountdown').dataset.accountCountdown = job.deadline ?? '';
    text(el('amSwitchError'), job.error); el('amSwitchError').hidden = !job.error;
    const choosing = ['choosing','waiting_idle','needs_stop_approval'].includes(job.phase);
    el('amTargetField').hidden = !choosing;
    syncOptions(el('amTarget'), (a.accounts || []).filter(account => account.id !== a.currentRef).map(account => ({id:account.id,label:(account.email || account.id)+' · '+(account.planType || 'Chưa rõ gói')})), job.target, lastJobId !== job.id);
    lastJobId = job.id;
    for (const button of panel.querySelectorAll('[data-account-action]')) {
      const action = button.dataset.accountAction;
      button.hidden = action === 'choose' ? !choosing : action === 'cancel' ? !['checking','waiting_quota','choosing','waiting_idle','needs_stop_approval'].includes(job.phase) : action === 'stopApprove' ? job.phase !== 'needs_stop_approval' : !['activating','reloading','failed'].includes(job.phase);
    }
  }

  function updateControls() {
    if (!dialog) return;
    const a = data(), savingNow = saving();
    for (const button of dialog.querySelectorAll('[data-account-action]')) {
      const action = button.dataset.accountAction, accountRef = button.closest('[data-account-id]')?.dataset.accountId;
      button.disabled = ['choose','cancel'].includes(action) ? [...pending.values()].some(item => item.action === action) : busy();
      if (action === 'configure') button.disabled ||= !dirty.size && !a.recovery?.automationPaused || savingNow;
      if (['link','login'].includes(action)) button.disabled ||= !el('amLauncher').value;
      if (action === 'switch') button.disabled ||= accountRef === a.currentRef;
      if (action === 'choose') button.disabled ||= !el('amTarget').value;
    }
    el('amLauncher').disabled = busy() || !(a.launchers || []).length;
    text(el('amSave'), savingNow ? 'Đang lưu…' : 'Lưu chính sách');
    text(el('amSaveStatus'), savingNow ? 'Đang lưu chính sách…' : dirty.size ? 'Có thay đổi chưa lưu' : savedMessage);
    const recoveryNotice = a.recovery?.automationPaused ? 'Đã phục hồi file trạng thái bị hỏng. Tự động hóa tạm dừng; kiểm tra và Lưu chính sách để tiếp tục.' : '';
    const notice = actionError || a.notice || (busy() ? 'Đang xử lý account…' : recoveryNotice);
    text(el('amNotice'), notice); el('amNotice').hidden = !notice;
    el('amNotice').classList.toggle('error', Boolean(actionError || a.notice));
  }

  function sync(state) {
    current = state || current;
    if (!dialog || !dialog.open) return;
    const a = data(), settings = {...defaults,...a.settings};
    for (const field of fields()) {
      const key = field.dataset.accountConfig;
      if (dirty.has(key) || document.activeElement === field) continue;
      if (field.type === 'checkbox') field.checked = Boolean(settings[key]);
      else { const value = String(configValue(settings, key)); if (field.value !== value) field.value = value; }
    }
    text(el('amSubtitle'), a.connected ? 'Tài khoản, quota và chuyển phiên' : 'Kết nối để tải tài khoản và Chrome BAT');
    syncOptions(el('amLauncher'), (a.launchers || []).map(launcher => ({id:launcher.id,label:launcher.label || String(launcher.batPath || '').split(/[\\/]/).at(-1) || launcher.id})), '');
    if (!el('amLauncher').options.length) syncOptions(el('amLauncher'), [{id:'',label:'Chưa có Chrome BAT'}], '');
    if (importedLauncher && [...el('amLauncher').options].some(option => option.value === importedLauncher)) { el('amLauncher').value = importedLauncher; importedLauncher = ''; }
    text(el('amLauncherHelp'), (a.launchers || []).length ? 'Chọn BAT đã có; chỉ chọn tệp mới khi chưa có trong danh sách.' : 'Chưa có BAT. Bấm Chọn tệp BAT… để chọn tệp trên máy.');
    el('amLoginStatus').hidden = !a.loginRef;
    syncAccounts(); syncSwitch(); updateControls(); countdown();
  }

  function selectTab(next, focus = false) {
    if (!dialog) return;
    scroll[tab] = el('amBody').scrollTop; tab = next;
    for (const button of dialog.querySelectorAll('[data-account-tab]')) {
      const active = button.dataset.accountTab === tab;
      button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
      el(button.getAttribute('aria-controls')).hidden = !active;
      if (active && focus) button.focus({preventScroll:true});
    }
    el('amSave').hidden = tab !== 'policy';
    el('amBody').scrollTop = scroll[tab];
  }

  function open(source) {
    if (!dialog) return;
    if (dialog.open) return;
    opener = source || document.activeElement;
    dialog.showModal(); sync();
    dialog.querySelector('[data-account-tab="'+tab+'"]').focus({preventScroll:true});
    el('amBody').scrollTop = scroll[tab];
    if (!data().connected && !busy()) send('refresh');
  }

  function close() {
    scroll[tab] = el('amBody').scrollTop;
    dialog.close();
    const target = opener?.isConnected ? opener : document.querySelector('[data-accounts-toggle]');
    target?.focus({preventScroll:true});
  }

  function send(action, extra = {}) {
    if (['choose','cancel'].includes(action)) {
      if ([...pending.values()].some(item => item.action === action)) return;
    } else if (busy()) return;
    const requestId = 'account-ui-'+Date.now()+'-'+(++sequence);
    const item = {action, ...extra};
    if (action === 'configure') item.raw = Object.fromEntries(fields().map(field => [field.dataset.accountConfig, raw(field)]));
    pending.set(requestId, item); actionError = ''; savedMessage = '';
    updateControls();
    for (const row of rows.values()) for (const field of row.querySelectorAll('[data-account-setting]')) field.disabled = busy();
    post({command:'accountAction',action,requestId,...extra});
  }

  function save() {
    if (tab !== 'policy' || !dirty.size && !data().recovery?.automationPaused || busy() || !el('amForm').reportValidity()) return;
    const settings = {...defaults,...data().settings};
    for (const field of fields()) {
      const key = field.dataset.accountConfig;
      settings[key] = field.type === 'checkbox' ? field.checked : key === 'choiceSeconds' ? field.value === '' ? null : Number(field.value) : key === 'allowedModels' ? field.value.split(',').map(value => value.trim()).filter(Boolean) : field.value;
    }
    send('configure', {settings});
  }

  function countdown() {
    for (const node of document.querySelectorAll('[data-account-countdown]')) {
      const deadline = node.dataset.accountCountdown;
      text(node, deadline && Number.isFinite(Number(deadline)) ? Math.max(0,Math.ceil((Number(deadline)-Date.now())/1000))+'s' : '');
    }
  }

  function bind(root, sender, state) {
    post = sender; sync(state);
    for (const button of root.querySelectorAll('[data-accounts-toggle]')) button.onclick = () => open(button);
    for (const button of root.querySelectorAll('[data-account-cancel]')) button.onclick = () => { button.disabled = true; send('cancel', {id:data().switchJob?.id}); };
    countdown();
  }

  if (dialog) {
    el('amClose').onclick = el('amDone').onclick = close;
    el('amAdd').onclick = () => showLink(el('amLink').dataset.expanded !== 'true');
    el('amLinkClose').onclick = () => showLink(false);
    el('amHelpButton').onclick = () => showHelp(el('amHelpPanel').hidden);
    el('amHelpClose').onclick = () => showHelp(false);
    dialog.addEventListener('cancel', event => { event.preventDefault(); if (!el('amHelpPanel').hidden) showHelp(false); else close(); });
    // Backdrop clicks deliberately keep the dialog and its draft open.
    el('amForm').onsubmit = event => { event.preventDefault(); save(); };
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !el('amHelpPanel').hidden) {
        event.preventDefault(); event.stopPropagation(); showHelp(false); return;
      }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); save(); }
      else if (event.key === 'Enter' && event.target.matches('input') && !event.isComposing) event.preventDefault();
    });
    for (const button of dialog.querySelectorAll('[data-account-tab]')) {
      button.onclick = () => selectTab(button.dataset.accountTab);
      button.onkeydown = event => {
        if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
        event.preventDefault(); selectTab(event.key === 'Home' ? 'accounts' : event.key === 'End' ? 'policy' : button.dataset.accountTab === 'accounts' ? 'policy' : 'accounts', true);
      };
    }
    for (const field of fields()) field.addEventListener('input', () => {
      dirty.add(field.dataset.accountConfig); savedMessage = ''; updateControls();
    });
    el('amLauncher').onchange = el('amTarget').onchange = updateControls;
    dialog.addEventListener('change', event => {
      const field = event.target.closest('[data-account-setting]');
      if (field) send('configureAccount', {accountRef:field.closest('[data-account-id]').dataset.accountId,settings:{[field.dataset.accountSetting]:field.checked}});
    });
    dialog.addEventListener('click', event => {
      const button = event.target.closest('[data-account-action]');
      if (!button || button.disabled || button.dataset.accountAction === 'configure') return;
      const action = button.dataset.accountAction;
      send(action, {accountRef:action === 'choose' ? el('amTarget').value : button.closest('[data-account-id]')?.dataset.accountId,launcherId:el('amLauncher').value,id:data().switchJob?.id,immediate:action === 'choose',threadId:current.selectedThreadId});
    });
    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type !== 'accountActionResult' || !pending.has(message.requestId)) return;
      const item = pending.get(message.requestId); pending.delete(message.requestId);
      if (message.data) current = {...current,accountManager:message.data};
      actionError = message.error || '';
      if (!actionError && item.action === 'import' && message.launcherId) importedLauncher = message.launcherId;
      if (!actionError && item.action === 'configure') {
        for (const field of fields()) if (raw(field) === item.raw[field.dataset.accountConfig]) dirty.delete(field.dataset.accountConfig);
        savedMessage = 'Đã lưu chính sách';
      }
      sync();
      if (!actionError && (item.action === 'link' || item.action === 'loginStatus' && !data().loginRef)) {
        savedMessage = 'Đã liên kết tài khoản';
        if (dialog.open) { showLink(false); el('amBody').scrollTop = 0; updateControls(); }
      }
    });
  }
  setInterval(countdown, 1000);
  return {render, trigger, bind, sync, open};
})();
