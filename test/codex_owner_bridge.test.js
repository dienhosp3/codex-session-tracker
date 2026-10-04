'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureOwnerBridge } = require('../codex_owner_bridge');
const { disposeOwnerBridges } = require('../codex_live_backend');

test('finds renamed live constructors in the Extension module scope without starting a process', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cst-owner-scope-'));
  const file = path.join(root, 'out', 'extension.js');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, `
    const zt=()=>({});
    var ChangedBackend=class {
      constructor(){this.initialized=true;this.proc={pid:41,stdin:{destroyed:false}};this.providers=new Map();}
      logger=zt("CodexMcpConnection");
      registerProvider(name,value){this.providers.set(name,value);return{dispose:()=>this.providers.delete(name)}}
      sendRequest(){}
    };
    var ChangedStream=class {
      ownedThreads=new Set;
      constructor(){this.ipcClient={requestHandlers:new Map([
        ['thread-owner-discovery',[()=>true,()=>({supportsUntrustedAppInput:true})]],
        ['thread-follower-steer-turn',[()=>false,()=>{throw new Error('gray')}]]
      ])};}
      ownsThread(host,id){return host==='local'&&id==='target';}
    };
    module.exports={activate(){return [ChangedBackend,ChangedStream]},connection:new ChangedBackend(),stream:new ChangedStream()};
  `);
  const extension = require(file);
  try {
    const result = await ensureOwnerBridge(root);
    assert.deepEqual(result, [{ installed: true, ownerPid: 41, transport: 'codex-existing-app-server' }]);
    assert.equal(extension.connection.providers.size, 1);
    assert.equal(extension.stream.ipcClient.requestHandlers.get('thread-follower-steer-turn')[0]({ trackerDirectSteer: 1, conversationId: 'target' }, {}), true);
  } finally {
    disposeOwnerBridges();
    delete require.cache[file];
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(extension.connection.providers.size, 0);
});
