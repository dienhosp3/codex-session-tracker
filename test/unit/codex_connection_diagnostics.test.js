'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {probeEndpoint,diagnoseConnection,readRelayFailure}=require('../../src/codex_connection_diagnostics');
test('real loopback HTTP 401 and 404 mean reachable, while refused TCP and DNS errors do not',async t=>{
  const server=http.createServer((req,res)=>{res.writeHead(req.url==='/v1/models'?401:404);res.end('private body is never retained');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const origin='http://127.0.0.1:'+server.address().port;
  for(const url of ['/v1/models','/health']){const r=await probeEndpoint(origin+url);assert.equal(r.reachable,true);assert.ok([401,404].includes(r.status));assert.equal(JSON.stringify(r).includes('private body'),false);}
  const dns=await probeEndpoint('https://example.invalid/',{lookup:async()=>{throw Object.assign(new Error('lookup'),{code:'ENOTFOUND'});}});
  assert.equal(dns.dns,false);assert.equal(dns.reachable,false);
  const refused=await probeEndpoint('http://127.0.0.1:1/');assert.equal(refused.reachable,false);
});
test('probe timeout destroys a stalled connection',async t=>{
  const sockets=new Set(),server=http.createServer(()=>{});server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));});
  const r=await probeEndpoint('http://127.0.0.1:'+server.address().port,{timeoutMs:30});assert.equal(r.error,'ETIMEDOUT');
});
test('diagnosis separates independent Internet, service route and local proxy failures',async()=>{
  const targets={service:'https://service.invalid/v1/models',local:'http://127.0.0.1:11500/v1/models'};
  for(const [which,category] of [['all','offline'],['dns','dns'],['service','upstream'],['local','proxy'],['none','stream']]){
    const r=await diagnoseConnection({targets,probe:async url=>{const failed=which==='all'||which==='dns'||(which==='service'&&url===targets.service)||(which==='local'&&url===targets.local);return {reachable:!failed,status:failed?0:401,dns:which!=='dns'};}});
    assert.equal(r.category,category);assert.equal(r.online,which==='none');
  }
});
test('relay attribution reads only metadata, requires repeated errors and rejects ambiguous matches',async t=>{
  const {DatabaseSync}=require('node:sqlite');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'relay-errors-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'relay.sqlite'),db=new DatabaseSync(file);
  try{db.exec('CREATE TABLE usage(ts INTEGER,duration_ms INTEGER,error TEXT,ended_in TEXT,session_key TEXT,secret_prompt TEXT)');
    const add=db.prepare('INSERT INTO usage VALUES (?,?,?,?,?,?)');
    add.run(10000,1000,'Your input exceeds the context window','none','one','MUST NOT READ');
    assert.equal(readRelayFailure(file,11000),null);
    add.run(20000,1000,'Your input exceeds the context window','none','one','MUST NOT READ');
    const result=readRelayFailure(file,21000);assert.equal(result.category,'context');assert.equal(result.confidence,'correlated');assert.equal(JSON.stringify(result).includes('MUST NOT READ'),false);
    add.run(20010,1000,'Your input exceeds the context window','none','two','MUST NOT READ');assert.equal(readRelayFailure(file,21000),null);
  }finally{db.close();}
});
