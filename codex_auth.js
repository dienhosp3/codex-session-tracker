'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Match Swapper's deactivation payload without reading or backing up credentials.
// Replace atomically so a failed write leaves the existing login intact.
async function deactivateSession({ codexHome, fsImpl = fs.promises } = {}) {
  if (typeof codexHome !== 'string' || !path.isAbsolute(codexHome)) {
    throw new Error('Codex Home must be an absolute directory.');
  }
  const authPath = path.join(codexHome, 'auth.json');
  const temporaryPath = path.join(codexHome, `.auth-deactivate-${crypto.randomUUID()}.tmp`);
  await fsImpl.mkdir(codexHome, { recursive: true });
  try {
    await fsImpl.writeFile(temporaryPath, JSON.stringify({ OPENAI_API_KEY: null, tokens: null }, null, 2) + '\n', {
      encoding: 'utf8', mode: 0o600, flag: 'wx'
    });
    await fsImpl.rename(temporaryPath, authPath);
  } finally {
    await fsImpl.unlink(temporaryPath).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function currentAccount(readAccount) {
  const result = await readAccount();
  if (!result || typeof result !== 'object' || !Object.hasOwn(result, 'account')) {
    throw new Error('Không đọc được tài khoản Codex.');
  }
  const account = result.account;
  if (account === null) return { label: 'Chưa đăng nhập', signedIn: false };
  if (account?.type === 'chatgpt') {
    const email = typeof account.email === 'string' ? account.email.trim() : '';
    return { label: email || 'Tài khoản Codex', signedIn: true };
  }
  if (account?.type === 'apiKey') return { label: 'API key', signedIn: true };
  if (account?.type === 'amazonBedrock') return { label: 'Amazon Bedrock', signedIn: true };
  throw new Error('Không đọc được tài khoản Codex.');
}

module.exports = { deactivateSession, currentAccount };
