import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex');
export function coreHome() { return process.env.AHUST_CHATGPT_HOME || (process.platform === 'win32' ? join(process.env.LOCALAPPDATA || join(homedir(),'AppData','Local'),'AHUST','ChatGPTCore') : join(homedir(),'.local','share','AHUST','ChatGPTCore')); }
export function endpoint(home) { return process.platform === 'win32' ? `\\\\.\\pipe\\ahust-chatgpt-${hash(home.toLowerCase()).slice(0,20)}` : join(home,'runtime.sock'); }
