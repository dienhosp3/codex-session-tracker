const soundPending = new Map(), soundPreviewBusy = new Map();
let soundSequence = 0, soundFeedback = '', soundFeedbackError = false;
function soundViewSettings() {
  const settings = { enabled: state.sounds?.settings?.enabled !== false, types: { ...state.sounds?.settings?.types } };
  for (const patch of soundPending.values()) {
    if (patch.enabled !== undefined) settings.enabled = patch.enabled;
    Object.assign(settings.types, patch.types);
  }
  return settings;
}
function updateSoundCount(settings) {
  const counter = document.querySelector('.sound-panel-count'), types = state.sounds?.types || [];
  if (counter) counter.textContent = (settings.enabled ? types.filter(type => settings.types[type.id]).length : 0) + '/' + types.length + ' bật';
}
function renderSoundSettings() {
  const types = state.sounds?.types || [], settings = soundViewSettings();
  if (!types.length) return '';
  const groups = [...new Set(types.map(type => type.group))];
  const count = settings.enabled ? types.filter(type => settings.types[type.id]).length : 0;
  return '<div id="soundSettingsPanel" class="sound-panel"><header class="sound-header"><b id="soundTitle">Cài đặt âm thanh</b><span class="sound-panel-count">'+count+'/'+types.length+' bật</span><button id="soundClose" class="iconbtn" type="button" aria-label="Đóng cài đặt âm thanh">×</button></header><div class="sound-panel-body">'+
    '<div class="sound-toolbar"><label><input id="soundMaster" type="checkbox" '+(settings.enabled?'checked':'')+'> Bật âm báo</label><button id="soundAllOn" type="button">Bật hết</button><button id="soundAllOff" type="button">Tắt hết</button></div>'+
    '<div class="sound-groups">'+groups.map(group=>'<div><div class="sound-group-title">'+esc(group)+'</div>'+types.filter(type=>type.group===group).map(type=>'<div class="sound-row"><label><input type="checkbox" data-sound-toggle="'+esc(type.id)+'" '+(settings.types[type.id]?'checked':'')+'> '+esc(type.label)+'</label><button class="sound-preview" type="button" data-sound-preview="'+esc(type.id)+'" title="Nghe thử: '+esc(type.label)+'" aria-label="Nghe thử: '+esc(type.label)+'" '+(soundPreviewBusy.has(type.id)?'disabled':'')+'>▶</button></div>').join('')+'</div>').join('')+'</div>'+
    '<div id="soundFeedback" class="sound-feedback '+(soundFeedbackError?'error':'')+'" role="status">'+esc(soundFeedback||state.sounds?.notice||'')+'</div></div></div>';
}
function sendSoundPatch(patch) {
  const requestId = 'sound-' + Date.now() + '-' + (++soundSequence);
  soundPending.set(requestId, patch); soundFeedback = 'Đang lưu…'; soundFeedbackError = false;
  vscode.postMessage({ command: 'saveSoundSettings', requestId, patch });
  // Reflect rapid edits immediately, including before the first save ACK.
  const settings = soundViewSettings(), master = document.getElementById('soundMaster');
  if (master) master.checked = settings.enabled;
  updateSoundCount(settings);
  for (const input of document.querySelectorAll('[data-sound-toggle]')) input.checked = settings.types[input.dataset.soundToggle] === true;
  const notice = document.getElementById('soundFeedback'); if (notice) notice.textContent = soundFeedback;
}
function bindSoundSettings() {
  const dialog = document.getElementById('soundSettingsDialog'), button = document.getElementById('soundSettingsButton');
  if (!dialog || !button) return;
  button.disabled = !state.sounds?.types?.length;
  button.onclick = () => { dialog.innerHTML = renderSoundSettings(); bindSoundSettings(); dialog.showModal(); };
  if (!dialog.open && !dialog.innerHTML) dialog.innerHTML = renderSoundSettings();
  const panel = document.getElementById('soundSettingsPanel'); if (!panel) return;
  document.getElementById('soundClose').onclick = () => dialog.close();
  const settings = soundViewSettings();
  document.getElementById('soundMaster').checked = settings.enabled;
  for (const input of panel.querySelectorAll('[data-sound-toggle]')) input.checked = settings.types[input.dataset.soundToggle] === true;
  updateSoundCount(settings);
  document.getElementById('soundMaster').onchange = event => sendSoundPatch({ enabled: event.target.checked });
  for (const input of panel.querySelectorAll('[data-sound-toggle]')) input.onchange = () => sendSoundPatch({ types: { [input.dataset.soundToggle]: input.checked } });
  for (const [id, enabled] of [['soundAllOn', true], ['soundAllOff', false]]) document.getElementById(id).onclick = () => sendSoundPatch({ enabled,
    types: Object.fromEntries((state.sounds?.types || []).map(type => [type.id, enabled])) });
  for (const button of panel.querySelectorAll('[data-sound-preview]')) button.onclick = () => {
    const soundType = button.dataset.soundPreview, requestId = 'sound-preview-' + Date.now() + '-' + (++soundSequence);
    soundPreviewBusy.set(soundType, requestId); button.disabled = true;
    vscode.postMessage({ command: 'previewSound', soundType, requestId });
  };
}
window.addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'soundSettingsSaved' && soundPending.has(message.requestId)) {
    soundPending.delete(message.requestId);
    if (message.settings) state.sounds = { ...state.sounds, settings: message.settings };
    soundFeedback = message.error ? 'Chưa lưu: ' + message.error : 'Đã lưu.';
    soundFeedbackError = Boolean(message.error);
    const settings = soundViewSettings(), panel = document.getElementById('soundSettingsPanel');
    updateSoundCount(settings);
    if (panel) {
      document.getElementById('soundMaster').checked = settings.enabled;
      for (const input of panel.querySelectorAll('[data-sound-toggle]')) input.checked = settings.types[input.dataset.soundToggle] === true;
      const notice = document.getElementById('soundFeedback'); notice.textContent = soundFeedback; notice.classList.toggle('error', soundFeedbackError);
    }
    requestRender();
  } else if (message.type === 'soundPreviewDone') {
    for (const [type, id] of soundPreviewBusy) if (id === message.requestId) soundPreviewBusy.delete(type);
    for (const button of document.querySelectorAll('[data-sound-preview]')) button.disabled = soundPreviewBusy.has(button.dataset.soundPreview);
    if (message.error) { soundFeedback = message.error; soundFeedbackError = true; requestRender(); }
  }
});
