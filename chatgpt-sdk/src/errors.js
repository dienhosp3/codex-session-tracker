export class CoreError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'CoreError'; this.code = code; this.details = details; }
}
export function invariant(condition, code, message, details) { if (!condition) throw new CoreError(code, message, details); }
export function errorResult(error) {
  return { code: error.code || 'CORE_FAILED', message: error.message || String(error), details: {...(error instanceof CoreError ? error.details : {}),...(error.diagnostic?{diagnosticId:error.diagnostic.id,logPath:error.diagnostic.logPath}:{})}, retryable: false };
}
export function validateChatUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new CoreError('INVALID_CHAT_URL', 'Invalid ChatGPT URL'); }
  invariant(url.protocol === 'https:' && url.hostname === 'chatgpt.com' && !url.port && !url.username && !url.password,
    'INVALID_CHAT_URL', 'Only https://chatgpt.com URLs are accepted');
  // Temporary chats now use local-chatgpt:<UUID>, often with the colon URL-encoded.
  const conversationKey='(?:[\\w-]+|local-chatgpt(?::|%3[aA])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})';
  const supported=new RegExp(`^/(?:c/${conversationKey}|g/g-[\\w-]+(?:/project|/c/${conversationKey})?)/?$`);
  invariant(url.pathname === '/' || supported.test(url.pathname), 'INVALID_CHAT_URL', 'Unsupported ChatGPT path');
  url.hash = '';
  return url.toString();
}
export function chatId(value) { const key=/\/c\/([^/]+)/.exec(new URL(validateChatUrl(value)).pathname)?.[1]; return key?decodeURIComponent(key):null; }
export function projectId(value) {
  const segment=/^\/g\/(g-[\w-]+)/.exec(new URL(validateChatUrl(value)).pathname)?.[1];
  if(!segment)return null;
  // ChatGPT adds a human-readable project slug when a root becomes a chat.
  // Only the immutable 32-hex project ID is identity; ordinary custom GPT IDs
  // and malformed project-like prefixes must retain their exact identity.
  return /^g-p-[0-9a-f]{32}(?:-|$)/i.test(segment)?segment.slice(0,36):segment;
}
