'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { PLAN_READY_TEXT } = require('./codex_plan_state');

const ASSET_DIRECTORY = path.join(__dirname, 'media', 'attention_voice');
const FULL_SENTENCE_LIMIT = 120;
const INITIAL_ATTENTION_SPEECH = Object.freeze({
  waitingOnApproval: { clip: 'approval_initial', text: 'Codex đang chờ duyệt thao tác' },
  waitingOnUserInput: { clip: 'input_initial', text: 'Codex đang chờ câu trả lời của bạn' },
  waitingOnPlanImplementation: { clip: 'plan_ready', text: PLAN_READY_TEXT }
});

function initialFlags(event) {
  const flags = new Set(event?.newFlags || event?.flags || (event?.waits || []).map(wait => wait.flag));
  if (flags.has('waitingOnPlanImplementation')) flags.delete('waitingOnUserInput');
  return Object.keys(INITIAL_ATTENTION_SPEECH).filter(flag => flags.has(flag));
}
function attentionInitialText(event) {
  return initialFlags(event).map(flag => INITIAL_ATTENTION_SPEECH[flag].text).join('. ');
}
function attentionInitialVoiceClips(event) {
  return initialFlags(event).map(flag => INITIAL_ATTENTION_SPEECH[flag].clip);
}

function attentionReminderText(event) {
  return (event?.waits || []).map(wait => {
    const minutes = Math.max(0, Math.floor(Number(wait.elapsedMinutes) || 0));
    if (wait.flag === 'waitingOnApproval') return `Đã ${minutes} phút chưa xác nhận.`;
    if (['waitingOnUserInput', 'waitingOnPlanImplementation'].includes(wait.flag)) return `Đã ${minutes} phút chưa có câu trả lời.`;
    return '';
  }).filter(Boolean).join(' ');
}

function numberClips(value) {
  const number = Math.floor(Number(value));
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('Thời gian chờ không hợp lệ.');
  if (!number) return ['number_0'];
  function group(n, padded) {
    const parts = [], hundred = Math.floor(n / 100), rest = n % 100;
    if (hundred || padded) parts.push('hundreds_' + hundred);
    if (rest && rest < 10 && (hundred || padded)) parts.push('link');
    if (rest < 20) { if (rest) parts.push('number_' + rest); }
    else {
      parts.push('tens_' + Math.floor(rest / 10));
      const unit = rest % 10;
      if (unit) parts.push(unit === 1 ? 'one_after_tens' : unit === 5 ? 'five_after_tens' : 'number_' + unit);
    }
    return parts;
  }
  const groups = []; let remaining = number;
  while (remaining) { groups.push(remaining % 1000); remaining = Math.floor(remaining / 1000); }
  const parts = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    if (!groups[i]) continue;
    parts.push(...group(groups[i], parts.length > 0));
    if (i % 3 === 1) parts.push('thousand');
    if (i % 3 === 2) parts.push('million');
    for (let billions = Math.floor(i / 3); billions > 0; billions--) parts.push('billion');
  }
  return parts;
}

function attentionVoiceClips(event) {
  const clips = [];
  for (const wait of event?.waits || []) {
    const kind = wait.flag === 'waitingOnApproval' ? 'approval' : ['waitingOnUserInput', 'waitingOnPlanImplementation'].includes(wait.flag) ? 'input' : '';
    if (!kind) continue;
    const minutes = Math.max(0, Math.floor(Number(wait.elapsedMinutes) || 0));
    // Common reminders use complete prerecorded sentences, as quota speech
    // does. Longer or delayed waits use bundled number phrases without a cap.
    if (minutes >= 5 && minutes <= FULL_SENTENCE_LIMIT && minutes % 5 === 0) clips.push(`${kind}_${minutes}`);
    else clips.push('elapsed', ...numberClips(minutes), kind + '_suffix');
  }
  return clips;
}

function readPcmWav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Âm thanh lời nhắc không phải WAV.');
  let format, data;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const id = buffer.toString('ascii', offset, offset + 4), size = buffer.readUInt32LE(offset + 4), start = offset + 8;
    if (start + size > buffer.length) throw new Error('File âm thanh lời nhắc bị thiếu dữ liệu.');
    if (id === 'fmt ' && size >= 16) format = buffer.subarray(start, start + 16);
    if (id === 'data') data = buffer.subarray(start, start + size);
    offset = start + size + (size % 2);
  }
  if (!format || !data?.length || format.readUInt16LE(0) !== 1 || format.readUInt16LE(14) !== 16) throw new Error('Lời nhắc yêu cầu âm thanh PCM 16-bit.');
  return { format, data };
}

async function composeAttentionVoice(event, directory = ASSET_DIRECTORY) {
  return composeClips(attentionVoiceClips(event), directory);
}

async function composeAttentionInitialVoice(event, directory = ASSET_DIRECTORY) {
  return composeClips(attentionInitialVoiceClips(event), directory);
}

async function composeClips(names, directory) {
  if (!names.length) throw new Error('Không có trạng thái chờ để đọc lời nhắc.');
  const clips = await Promise.all(names.map(name => fs.readFile(path.join(directory, name + '.wav')).then(readPcmWav)));
  const format = clips[0].format;
  if (clips.some(clip => !clip.format.equals(format))) throw new Error('Định dạng âm thanh lời nhắc không đồng nhất.');
  const data = Buffer.concat(clips.map(clip => clip.data)), header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); format.copy(header, 20); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// Play bundled PCM in memory through stdin. No runtime synthesis, download,
// registry changes or scratch files are involved.
const ATTENTION_VOICE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$memory = New-Object IO.MemoryStream
$player = $null
try {
    [Console]::OpenStandardInput().CopyTo($memory)
    $memory.Position = 0
    $player = New-Object System.Media.SoundPlayer($memory)
    $player.Load()
    $player.PlaySync()
    @{ audioBytes=$memory.Length; source='bundled-wav' } | ConvertTo-Json -Compress
} finally {
    if ($player) { $player.Dispose() }
    $memory.Dispose()
}
`;

async function speakAttentionReminder(event, options = {}) {
  if ((options.platform || process.platform) !== 'win32') throw new Error('Phát lời nhắc yêu cầu Windows.');
  const wav = await composeAttentionVoice(event, options.assetsDirectory || ASSET_DIRECTORY);
  return playAttentionWav(wav, options);
}

async function speakAttentionInitial(event, options = {}) {
  if ((options.platform || process.platform) !== 'win32') throw new Error('Phát âm báo yêu cầu Windows.');
  const wav = await composeAttentionInitialVoice(event, options.assetsDirectory || ASSET_DIRECTORY);
  return playAttentionWav(wav, options);
}

async function speakCompletion(type, options = {}) {
  if ((options.platform || process.platform) !== 'win32') throw new Error('Phát âm báo yêu cầu Windows.');
  if (!['chat_completed', 'chat_failed'].includes(type)) throw new Error('Loại thông báo không hợp lệ.');
  const wav = await composeClips([type], options.assetsDirectory || ASSET_DIRECTORY);
  return playAttentionWav(wav, options);
}

function playAttentionWav(wav, options) {
  return new Promise((resolve, reject) => {
    const child = (options.execFile || execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ATTENTION_VOICE_SCRIPT], {
      windowsHide: true, timeout: 60000, maxBuffer: 16384, encoding: 'utf8'
    }, (error, stdout) => {
      if (error) return reject(error);
      try { resolve(stdout?.trim() ? JSON.parse(stdout) : null); } catch (failure) { reject(failure); }
    });
    child.stdin.on('error', reject);
    child.stdin.end(wav);
  });
}

module.exports = { attentionReminderText, attentionVoiceClips, numberClips, composeAttentionVoice, speakAttentionReminder, ATTENTION_VOICE_SCRIPT,
  attentionInitialText, attentionInitialVoiceClips, composeAttentionInitialVoice, speakAttentionInitial, speakCompletion };
