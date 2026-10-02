'use strict';
const fs=require('fs/promises'),path=require('path'),cp=require('child_process'),crypto=require('crypto');
const {promisify}=require('util');
const execFile=promisify(cp.execFile);

// Only the Tracker's temporary loopback credential is stored here, never Codex auth.
async function secureDirectory(directory){
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  if(process.platform==='win32'){
    const {stdout}=await execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command','[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'],{windowsHide:true});
    const sid=stdout.trim();if(!/^S-1-[\d-]+$/.test(sid))throw new Error('Cannot determine runtime directory owner.');
    await execFile('icacls.exe',[directory,'/inheritance:r','/grant:r',`*${sid}:(OI)(CI)F`],{windowsHide:true});
  }else await fs.chmod(directory,0o700);
}
async function deploy({extensionRoot,storageDir,bundledExecutable}){
  if(process.platform!=='win32')throw new Error('Runtime hiện hỗ trợ Windows x64.');
  const metadata=JSON.parse(await fs.readFile(path.join(extensionRoot,'runtime','manifest.json'),'utf8'));
  const {stdout}=await execFile(bundledExecutable,['--version'],{windowsHide:true,timeout:10000});
  if(stdout.trim()!==`codex-cli ${metadata.cliVersion}`)throw new Error('CLI bundled đã đổi phiên bản. Cần build runtime tương ứng trước khi bật hook.');
  const directory=path.join(storageDir,'client-runtime',metadata.cliVersion);
  await secureDirectory(directory);
  const binary=await fs.readFile(path.join(extensionRoot,'runtime','bin','windows-x86_64','codex.exe'));
  if(crypto.createHash('sha256').update(binary).digest('hex')!==metadata.sha256)throw new Error('Runtime digest không khớp manifest.');
  const executable=path.join(directory,'codex.exe');
  let matches=false;try{matches=crypto.createHash('sha256').update(await fs.readFile(executable)).digest('hex')===metadata.sha256;}catch{}
  if(!matches){
    // Keep official sandbox/code-mode helpers beside the replacement executable.
    await fs.cp(path.dirname(bundledExecutable),directory,{recursive:true,filter:source=>path.basename(source)!=='codex.exe'});
    await fs.writeFile(executable,binary);
  }
  await fs.writeFile(path.join(directory,'tracker-runtime.json'),JSON.stringify({schemaVersion:1,managed:true,cliVersion:metadata.cliVersion}),{mode:0o600});
  const verified=await execFile(executable,['--version'],{windowsHide:true,timeout:10000});
  if(verified.stdout.trim()!==stdout.trim())throw new Error('Runtime --version verification failed.');
  return {executable,metadata};
}
async function publishBridge(executable,address){
  const file=path.join(path.dirname(executable),'tracker-bridge.json'),temporary=file+'.tmp';
  await fs.writeFile(temporary,JSON.stringify({schemaVersion:1,port:address.port,token:address.token}),{mode:0o600});
  await fs.rename(temporary,file);
}
async function removeBridge(executable){
  if(executable)await fs.rm(path.join(path.dirname(executable),'tracker-bridge.json'),{force:true});
}
module.exports={deploy,publishBridge,removeBridge};
