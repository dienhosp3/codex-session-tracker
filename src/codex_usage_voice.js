'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { playAttentionWav, ATTENTION_VOICE_SCRIPT: USAGE_VOICE_WAV_SCRIPT } = require('./codex_attention_voice');
const { identityKey, validPercent, resetTime, sameCycle, MAX_SAMPLE_GAP_MS } = require('./codex_usage_cycle');

const DEFAULT_USAGE_VOICE_SETTINGS = Object.freeze({
  enabled: false,
  speakOnChange: true,
  speakOnLargeChange: true,
  largeChangePercent: 10
});

const USAGE_VOICE_ASSET_DIRECTORY = path.join(__dirname, '..', 'media', 'usage_voice');
const USAGE_VOICE_ASSETS = Object.freeze(Object.fromEntries([
  ['large_prefix', 'large_prefix.wav'],
  ...Array.from({ length: 101 }, (_, value) => [`percent_${value}`, `percent_${value}.wav`])
]));

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
    const parts = key.split('|');
    const stableKey = parts.slice(0, 3).join('|');
    if (valid[stableKey]?.checkedAt >= checkedAt) continue;
    valid[stableKey] = { remainingPercent, checkedAt,
      resetsAt: resetTime(sample.resetsAt) || resetTime(Number(parts[3])),
      changedAt: Number(sample.changedAt) || checkedAt };
  }
  const activeKey = source.activeKey || Object.keys(valid).sort((a, b) => valid[b].checkedAt - valid[a].checkedAt)[0] || '';
  return { schemaVersion: 2, samples: valid, activeKey };
}

function usageVoiceSample(snapshot, checkedAt = Date.now()) {
  const groups = Array.isArray(snapshot?.groups) ? snapshot.groups : [];
  const group = groups.find(item => item?.id === 'codex') || groups[0];
  const window = group?.windows?.find(item => item?.key === 'primary');
  const timestamp = Number(checkedAt);
  const remainingPercent = integerPercent(100 - Number(window?.usedPercent));
  if (snapshot?.error || !group || !window || !validPercent(window.usedPercent) || remainingPercent === null || !Number.isFinite(timestamp) || timestamp <= 0) return null;
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
  return identityKey({ accountKey: sample.accountKey, id: sample.groupId }, { key: sample.windowKey });
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


function usageVoiceAssetSequence(value, largeChange = false) {
  const number = integerPercent(value);
  if (number === null) return [];
  // Each percentage is a complete Vietnamese sentence.  Speaking isolated
  // digit clips made the TTS engine reinterpret words such as "ba" and
  // "bảy" as letter names, and concatenating them produced unnatural pauses.
  return largeChange ? ['large_prefix', `percent_${number}`] : [`percent_${number}`];
}
function readWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Usage voice asset is not a RIFF WAV file.');
  let offset = 12, format = null, data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4), size = buffer.readUInt32LE(offset + 4), start = offset + 8;
    if (id === 'fmt ' && size >= 16) format = { audioFormat: buffer.readUInt16LE(start), channels: buffer.readUInt16LE(start + 2), sampleRate: buffer.readUInt32LE(start + 4), bitsPerSample: buffer.readUInt16LE(start + 14) };
    if (id === 'data') data = buffer.subarray(start, Math.min(buffer.length, start + size));
    offset = start + size + (size % 2);
  }
  if (!format || !data || format.audioFormat !== 1 || !format.channels || !format.sampleRate || format.bitsPerSample !== 16) throw new Error('Usage voice assets must be PCM 16-bit WAV files.');
  return { ...format, data };
}
async function composeUsageVoiceWav(parts, assetsDirectory = USAGE_VOICE_ASSET_DIRECTORY, outputFile = '') {
  const names = Array.isArray(parts) ? parts : [];
  if (!names.length || names.some(name => !USAGE_VOICE_ASSETS[name])) throw new Error('Missing Vietnamese usage voice segment.');
  const clips = await Promise.all(names.map(name => fs.promises.readFile(path.join(assetsDirectory, USAGE_VOICE_ASSETS[name])).then(readWav)));
  const first = clips[0], data = Buffer.concat(clips.map(clip => clip.data));
  if (clips.some(clip => clip.channels !== first.channels || clip.sampleRate !== first.sampleRate || clip.bitsPerSample !== first.bitsPerSample)) throw new Error('Usage voice segments use different WAV formats.');
  const wav = Buffer.alloc(44);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + data.length, 4); wav.write('WAVE', 8); wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(first.channels, 22); wav.writeUInt32LE(first.sampleRate, 24); wav.writeUInt32LE(first.sampleRate * first.channels * 2, 28); wav.writeUInt16LE(first.channels * 2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(data.length, 40);
  const result = Buffer.concat([wav, data]);
  if (outputFile) { await fs.promises.writeFile(outputFile, result); return outputFile; }
  return result;
}

function evaluateUsageVoice(snapshot, stateValue, settingsValue, checkedAt = Date.now()) {
  const settings = normalizeUsageVoiceSettings(settingsValue);
  const state = normalizeUsageVoiceState(stateValue);
  const sample = usageVoiceSample(snapshot, checkedAt);
  if (!sample) return { events: [], state, settings };
  const key = sampleKey(sample);
  const previous = state.samples[key];
  if (previous && sample.checkedAt <= previous.checkedAt) return { events: [], state, settings };
  const continuous = previous && sameCycle(previous, sample.resetsAt, sample.checkedAt, sample.usedPercent) && state.activeKey === key && sample.checkedAt - previous.checkedAt <= MAX_SAMPLE_GAP_MS;
  const unchanged = continuous && previous.remainingPercent === sample.remainingPercent;
  state.samples[key] = { remainingPercent: sample.remainingPercent, checkedAt: sample.checkedAt,
    resetsAt: continuous ? previous.resetsAt || sample.resetsAt : sample.resetsAt,
    changedAt: unchanged ? previous.changedAt : sample.checkedAt };
  state.activeKey = key;
  const keys = Object.keys(state.samples);
  if (keys.length > 32) {
    keys.sort((a, b) => state.samples[a].checkedAt - state.samples[b].checkedAt);
    for (const oldKey of keys.slice(0, keys.length - 32)) delete state.samples[oldKey];
  }
  if (!continuous || !settings.enabled) return { events: [], state, settings };
  const deltaPercent = sample.remainingPercent - previous.remainingPercent;
  const changePercent = Math.abs(deltaPercent);
  if (!changePercent) return { events: [], state, settings };
  const largeChange = deltaPercent < 0 && changePercent >= settings.largeChangePercent;
  const shouldSpeak = (settings.speakOnChange && changePercent > 0) || (settings.speakOnLargeChange && largeChange);
  if (!shouldSpeak) return { events: [], state, settings };
  const event = {
    key,
    changedAt: state.samples[key].changedAt,
    id: `quota:${key}:${state.samples[key].resetsAt || 'session'}:${sample.checkedAt}:${sample.remainingPercent}`,
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

async function speakUsageVoice(options = {}) {
  if ((options.platform || process.platform) !== 'win32') throw new Error('Pre-recorded Vietnamese usage audio requires Windows playback.');
  const event = options.event && typeof options.event === 'object' ? options.event : options;
  const parts = usageVoiceAssetSequence(event.remainingPercent, event.largeChange === true);
  if (!parts.length) throw new Error('Usage percentage must be an integer from 0 through 100.');
  const wav = await composeUsageVoiceWav(parts, options.assetsDirectory || USAGE_VOICE_ASSET_DIRECTORY);
  return playAttentionWav(wav, options);
}

function createUsageVoiceController(options = {}) {
  let queue = Promise.resolve();
  let disposed = false;
  return {
    dispose() { disposed = true; },
    speak(event) {
      const operation = queue.then(async () => {
        if (disposed || (event?.isCurrent && !await event.isCurrent())) return;
        return (options.speak || speakUsageVoice)({ event: event && typeof event === 'object' ? event : { text: String(event || '') }, platform: options.platform, execFile: options.execFile, assetsDirectory: options.assetsDirectory });
      });
      queue = operation.catch(() => {});
      return operation;
    }
  };
}

module.exports = {
  DEFAULT_USAGE_VOICE_SETTINGS,
  USAGE_VOICE_WAV_SCRIPT,
  integerPercent,
  normalizeUsageVoiceSettings,
  normalizeUsageVoiceState,
  usageVoiceSample,
  vietnameseNumber,
  usageVoiceText,
  usageVoiceAssetSequence,
  composeUsageVoiceWav,
  evaluateUsageVoice,
  speakUsageVoice,
  createUsageVoiceController
};
