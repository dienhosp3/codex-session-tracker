'use strict';

const childProcess = require('node:child_process');

const DEFAULT_USAGE_VOICE_SETTINGS = Object.freeze({
  enabled: false,
  speakOnChange: true,
  speakOnLargeChange: true,
  largeChangePercent: 10
});

const USAGE_VOICE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$text = $env:CODEX_TRACKER_USAGE_VOICE_TEXT
$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $candidate = $voice.GetInstalledVoices() |
        Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'vi*' } |
        Select-Object -First 1
    if ($candidate) { $voice.SelectVoice($candidate.VoiceInfo.Name) }
    $voice.Speak($text)
} finally {
    $voice.Dispose()
}
`;

function integerPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function normalizeUsageVoiceSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  const threshold = integerPercent(source.largeChangePercent);
  return {
    schemaVersion: 1,
    enabled: source.enabled === true,
    speakOnChange: source.speakOnChange !== false,
    speakOnLargeChange: source.speakOnLargeChange !== false,
    largeChangePercent: threshold && threshold >= 1 ? threshold : DEFAULT_USAGE_VOICE_SETTINGS.largeChangePercent
  };
}

function normalizeUsageVoiceState(value) {
  const source = value && typeof value === 'object' ? value : {};
  const samples = source.samples && typeof source.samples === 'object' ? source.samples : {};
  const valid = {};
  for (const [key, sample] of Object.entries(samples)) {
    if (!sample || typeof sample !== 'object') continue;
    const checkedAt = Number(sample.checkedAt);
    const remainingPercent = integerPercent(sample.remainingPercent);
    if (!Number.isFinite(checkedAt) || checkedAt <= 0 || remainingPercent === null) continue;
    valid[String(key)] = { remainingPercent, checkedAt };
  }
  return { schemaVersion: 1, samples: valid };
}

function usageVoiceSample(snapshot, checkedAt = Date.now()) {
  const groups = Array.isArray(snapshot?.groups) ? snapshot.groups : [];
  const group = groups.find(item => item?.id === 'codex') || groups[0];
  const window = group?.windows?.find(item => item?.key === 'primary');
  const timestamp = Number(checkedAt);
  const remainingPercent = integerPercent(100 - Number(window?.usedPercent));
  if (!group || !window || remainingPercent === null || !Number.isFinite(timestamp) || timestamp <= 0) return null;
  const accountKey = String(group.accountKey || 'account:unknown').trim() || 'account:unknown';
  const groupId = String(group.id || 'codex').trim() || 'codex';
  const resetsAt = Number.isFinite(Number(window.resetsAt)) && Number(window.resetsAt) > 0 ? Number(window.resetsAt) : null;
  return {
    accountKey,
    groupId,
    windowKey: 'primary',
    resetsAt,
    remainingPercent,
    usedPercent: integerPercent(window.usedPercent),
    checkedAt: timestamp
  };
}

function sampleKey(sample) {
  return [sample.accountKey, sample.groupId, sample.windowKey, sample.resetsAt || 'session'].join('|');
}

function vietnameseNumber(value) {
  const number = integerPercent(value);
  if (number === null) return '';
  const ones = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];
  if (number < 10) return ones[number];
  if (number === 100) return 'một trăm';
  const tens = Math.floor(number / 10);
  const unit = number % 10;
  if (tens === 1) return unit === 0 ? 'mười' : 'mười ' + (unit === 5 ? 'lăm' : ones[unit]);
  if (unit === 0) return ones[tens] + ' mươi';
  const unitWord = unit === 1 ? 'mốt' : unit === 5 ? 'lăm' : unit === 4 ? 'tư' : ones[unit];
  return ones[tens] + ' mươi ' + unitWord;
}

function usageVoiceText(event) {
  const prefix = event.largeChange ? 'Quota thay đổi mạnh, ' : '';
  return prefix + 'quota năm giờ còn ' + vietnameseNumber(event.remainingPercent) + ' phần trăm.';
}

function evaluateUsageVoice(snapshot, stateValue, settingsValue, checkedAt = Date.now()) {
  const settings = normalizeUsageVoiceSettings(settingsValue);
  const state = normalizeUsageVoiceState(stateValue);
  const sample = usageVoiceSample(snapshot, checkedAt);
  if (!sample) return { events: [], state, settings };
  const key = sampleKey(sample);
  const previous = state.samples[key];
  state.samples[key] = { remainingPercent: sample.remainingPercent, checkedAt: sample.checkedAt };
  const keys = Object.keys(state.samples);
  if (keys.length > 32) {
    keys.sort((a, b) => state.samples[a].checkedAt - state.samples[b].checkedAt);
    for (const oldKey of keys.slice(0, keys.length - 32)) delete state.samples[oldKey];
  }
  if (!previous || !settings.enabled) return { events: [], state, settings };
  const deltaPercent = sample.remainingPercent - previous.remainingPercent;
  const changePercent = Math.abs(deltaPercent);
  if (!changePercent) return { events: [], state, settings };
  const largeChange = changePercent >= settings.largeChangePercent;
  const shouldSpeak = (settings.speakOnChange && changePercent > 0) || (settings.speakOnLargeChange && largeChange);
  if (!shouldSpeak) return { events: [], state, settings };
  const event = {
    source: 'usage',
    eventType: 'usage_voice',
    accountKey: sample.accountKey,
    groupId: sample.groupId,
    windowKey: sample.windowKey,
    remainingPercent: sample.remainingPercent,
    usedPercent: sample.usedPercent,
    deltaPercent,
    changePercent,
    largeChange,
    checkedAt: sample.checkedAt
  };
  return { events: [{ ...event, text: usageVoiceText(event) }], state, settings };
}

function speakUsageVoice(options = {}) {
  if ((options.platform || process.platform) !== 'win32') return Promise.reject(new Error('Đọc quota bằng tiếng Việt hiện chỉ hỗ trợ Windows.'));
  const text = String(options.text || '').trim();
  if (!text || text.length > 240 || /[\0\r\n]/.test(text)) return Promise.reject(new Error('Nội dung đọc quota không hợp lệ.'));
  const execFile = options.execFile || childProcess.execFile;
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', USAGE_VOICE_SCRIPT], {
      windowsHide: true,
      timeout: 0,
      maxBuffer: 64 * 1024,
      encoding: 'utf8',
      env: { ...process.env, CODEX_TRACKER_USAGE_VOICE_TEXT: text }
    }, error => error ? reject(error) : resolve());
  });
}

function createUsageVoiceController(options = {}) {
  let queue = Promise.resolve();
  return {
    speak(text) {
      const operation = queue.then(() => (options.speak || speakUsageVoice)({
        text,
        platform: options.platform,
        execFile: options.execFile
      }));
      queue = operation.catch(() => {});
      return operation;
    }
  };
}

module.exports = {
  DEFAULT_USAGE_VOICE_SETTINGS,
  USAGE_VOICE_SCRIPT,
  integerPercent,
  normalizeUsageVoiceSettings,
  normalizeUsageVoiceState,
  usageVoiceSample,
  vietnameseNumber,
  usageVoiceText,
  evaluateUsageVoice,
  speakUsageVoice,
  createUsageVoiceController
};
