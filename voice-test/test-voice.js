'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { composeUsageVoiceWav, usageVoiceAssetSequence } = require('../codex_usage_voice');

const root = __dirname;
const segments = path.join(root, 'segments');
const output = path.join(root, 'output');
const requested = process.argv.indexOf('-p');
const values = requested >= 0 && /^\d+$/.test(process.argv[requested + 1] || '')
  ? [Number(process.argv[requested + 1])]
  : [0, 1, 9, 10, 11, 15, 20, 21, 42, 50, 84, 99, 100];
const large = process.argv.includes('--large');

fs.mkdirSync(output, { recursive: true });
async function main() {
  for (const value of values) {
    if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error(`Invalid percentage: ${value}`);
    const parts = usageVoiceAssetSequence(value, large);
    const file = path.join(output, `${large ? 'large-' : ''}${value}.wav`);
    await composeUsageVoiceWav(parts, segments, file);
    process.stdout.write(`${file}\n  ${parts.join(' + ')}\n`);
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
