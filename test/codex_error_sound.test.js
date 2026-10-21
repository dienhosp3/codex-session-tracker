'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { validateErrorSound, playErrorSound, createErrorSoundController } = require('../codex_error_sound');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-mp3-test-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const file = path.join(directory, 'âm 429 $(literal) & sound.mp3');
  await fs.writeFile(file, 'ID3-fixture');
  return { directory, file };
}

test('MP3 playback uses one synchronous play in a hidden process with a literal path', async t => {
  const f = await fixture(t);
  const calls = [];
  await playErrorSound({ file: f.file, platform: 'win32', execFile: (exe, args, settings, callback) => {
    calls.push({ exe, args, settings });
    callback(null);
  } });
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.exe, 'powershell.exe');
  assert.equal(call.settings.env.CODEX_TRACKER_ERROR_MP3, f.file);
  assert.equal(call.settings.windowsHide, true);
  assert.equal(call.settings.timeout, 0);
  const script = call.args.at(-1);
  assert.equal(script.includes(f.file), false);
  assert.equal((script.match(/Send\('play codexRetryError wait'\)/g) || []).length, 1);
  assert.doesNotMatch(script, /SystemSounds|Console\]::Beep|retryErrorBeep/);
  assert.match(script, /finally[\s\S]*close codexRetryError/);
});

test('missing, relative, empty and unsupported audio paths fail before spawning', async t => {
  const f = await fixture(t);
  let spawned = false;
  const options = { platform: 'win32', execFile: () => { spawned = true; } };
  await assert.rejects(playErrorSound(options), /Chưa chọn/);
  await assert.rejects(playErrorSound({ ...options, file: 'relative.mp3' }), /không hợp lệ/);
  await assert.rejects(validateErrorSound(path.join(f.directory, 'sound.wav')), /MP3/);
  await assert.rejects(validateErrorSound(path.join(f.directory, 'missing.mp3')), { code: 'ENOENT' });
  const empty = path.join(f.directory, 'empty.mp3');
  await fs.writeFile(empty, '');
  await assert.rejects(validateErrorSound(empty), /trống/);
  await assert.rejects(playErrorSound({ file: f.file, platform: 'linux' }), /Windows/);
  assert.equal(spawned, false);
});

test('native playback failure is surfaced without substituting a beep', async t => {
  const f = await fixture(t);
  let calls = 0;
  await assert.rejects(playErrorSound({ file: f.file, platform: 'win32', execFile: (_exe, _args, _settings, callback) => {
    calls += 1;
    callback(new Error('fixture unsupported MP3 stream'));
  } }), /unsupported MP3/);
  assert.equal(calls, 1);
});

test('sound selection is validated and saved before replacing the current path', async t => {
  const f = await fixture(t);
  const saved = [];
  const sound = createErrorSoundController({ file: 'previous.mp3', save: async file => saved.push(file) });
  await sound.setFile(f.file);
  assert.deepEqual(saved, [f.file]);
  assert.equal(sound.snapshot().file, f.file);
  const failed = createErrorSoundController({ file: f.file, save: async () => { throw new Error('fixture storage locked'); } });
  const another = path.join(f.directory, 'replacement.mp3');
  await fs.copyFile(f.file, another);
  await assert.rejects(failed.setFile(another), /storage locked/);
  assert.equal(failed.snapshot().file, f.file);
});

test('preview and error playback share a serial queue that recovers from failure', async t => {
  const f = await fixture(t);
  let active = 0;
  let maximum = 0;
  let attempted = 0;
  const sound = createErrorSoundController({ file: f.file, play: async options => {
    assert.equal(options.file, f.file);
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setImmediate(resolve));
    active -= 1;
    attempted += 1;
    if (attempted === 1) throw new Error('fixture first playback failed');
  } });
  const first = sound.play();
  const second = sound.play();
  await assert.rejects(first, /first playback failed/);
  await second;
  assert.equal(attempted, 2);
  assert.equal(maximum, 1);
});
