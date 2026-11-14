'use strict';
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {findBundledCodex}=require('./codex_queue');

function createCoreAccess(vscode){
  let clientPromise;
  async function client(){
    if(!clientPromise)clientPromise=import(pathToFileURL(path.join(__dirname,'..','chatgpt-sdk/src/client.js')).href).then(({ChatGPTClient})=>new ChatGPTClient({consumer:'codex-session-tracker',nodePath:'node'})).catch(error=>{clientPromise=null;throw error;});
    return clientPromise;
  }
  return {
    async request(action,args={},options={}){return (await client()).request(action,args,options);},
    async ready(){return (await client()).negotiate(['account.list','quota.read','quota.observe','conversation.work']);},
    async cliPath(){const extension=vscode.extensions.getExtension('openai.chatgpt');const found=extension&&await findBundledCodex(extension.extensionPath);if(!found)throw new Error('Chưa tìm thấy Codex CLI đi kèm extension.');return found;}
  };
}
module.exports={createCoreAccess};
