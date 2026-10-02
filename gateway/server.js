'use strict';

const http = require('http');
const https = require('https');
const { randomUUID, createHash } = require('crypto');
const { URL } = require('url');
const { classifyRequest } = require('./classifier');
const { redactHeaders, sanitizePath, sha256, safeError } = require('./redaction');
const { proxyWebSocket } = require('./websocket_proxy');

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isLoopback(req) {
  const addr = String(req.socket && req.socket.remoteAddress || '');
  return LOOPBACK.has(addr);
}

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, { 'content-type':'application/json; charset=utf-8', 'content-length': body.length });
  res.end(body);
}

async function readJson(req, maxBytes = 10 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw Object.assign(new Error('Request body too large.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!total) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

class GatewayServer {
  constructor(options = {}) {
    this.host = '127.0.0.1';
    const requestedPort = options.port === 0 ? 0 : Number(options.port || 8765);
    this.port = requestedPort === 0 ? 0 : Math.max(1, Math.min(65535, requestedPort));
    this.token = String(options.token || randomUUID());
    this.version = String(options.version || 'dev');
    this.startedAt = 0;
    this.server = null;
    this.handlers = options.handlers || {};
    this.trace = options.trace || null;
    this.diagnostics = typeof options.diagnostics === 'function' ? options.diagnostics : () => ({});
    this.onNetworkEvent = typeof options.onNetworkEvent === 'function' ? options.onNetworkEvent : null;
    this.modelProxyEnabled = Boolean(options.modelProxyEnabled);
    this.upstreamBaseUrl = String(options.upstreamBaseUrl || '').trim();
  }

  async start() {
    if (this.server) return this.address();
    this.server = http.createServer((req,res)=>this.handle(req,res));
    this.server.on('upgrade', (req, socket, head) => {
      if (!isLoopback(req)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      if (this.modelProxyEnabled && this.upstreamBaseUrl) {
        proxyWebSocket(req, socket, head, {
          upstreamBaseUrl: this.upstreamBaseUrl,
          record: event => this.record(event)
        });
        return;
      }
      this.record({ type:'ws_upgrade_rejected', at:Date.now(), path:sanitizePath(req.url), kind:classifyRequest({method:req.method,path:req.url,upgrade:true}), reason:'model proxy disabled' });
      socket.end('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n');
    });
    await new Promise((resolve,reject)=>{
      const onError=err=>{ this.server=null; reject(err); };
      this.server.once('error',onError);
      this.server.listen(this.port,this.host,()=>{ this.server.off('error',onError); resolve(); });
    });
    this.startedAt=Date.now();
    return this.address();
  }

  async stop() {
    const server=this.server;
    this.server=null;
    if(!server) return;
    await new Promise(resolve=>server.close(()=>resolve()));
  }

  address() {
    const a=this.server&&this.server.address();
    return { host:this.host, port:a&&typeof a==='object'?a.port:this.port, token:this.token };
  }

  async record(event) {
    if(this.trace) await this.trace.append(event).catch(()=>{});
    if(this.onNetworkEvent && event && (event.type === 'http_upstream' || event.type === 'ws_connection')) await this.onNetworkEvent(event).catch(()=>{});
  }

  authorized(req) {
    return String(req.headers['x-codex-gateway-token'] || '') === this.token;
  }

  async handle(req,res) {
    if(!isLoopback(req)) return json(res,403,{error:'loopback only'});
    try {
      const pathOnly=sanitizePath(req.url);
      if(req.method==='GET'&&pathOnly==='/health') {
        return json(res,200,{
          running:true,version:this.version,uptimeMs:Date.now()-this.startedAt,
          listen:{host:this.address().host,port:this.address().port},modelProxyConfigured:this.modelProxyEnabled,
          modelProxyEnabled:Boolean(this.modelProxyEnabled&&this.upstreamBaseUrl),
          websocketProxy:Boolean(this.modelProxyEnabled&&this.upstreamBaseUrl),...this.diagnostics()
        });
      }
      if(req.method==='GET'&&pathOnly==='/diagnostics') {
        if(!this.authorized(req)) return json(res,401,{error:'unauthorized'});
        return json(res,200,this.diagnostics());
      }
      if(pathOnly.startsWith('/control/')) {
        if(!this.authorized(req)) return json(res,401,{error:'unauthorized'});
        if(req.method!=='POST') return json(res,405,{error:'POST required'});
        const action=pathOnly.slice('/control/'.length);
        const handler=this.handlers[action];
        if(typeof handler!=='function') return json(res,404,{error:'unsupported control action'});
        const body=await readJson(req);
        return json(res,200,await handler(body));
      }
      if(this.modelProxyEnabled&&this.upstreamBaseUrl) return this.proxyHttp(req,res);
      return json(res,404,{error:'not found'});
    } catch(error) {
      await this.record({type:'gateway_error',at:Date.now(),error:safeError(error)});
      return json(res,Number(error.statusCode)||500,{error:safeError(error)||'gateway error'});
    }
  }

  async proxyHttp(req,res) {
    const started=Date.now();
    const requestId=randomUUID();
    const base=new URL(this.upstreamBaseUrl);
    const incoming=new URL(String(req.url||'/'),'http://gateway.invalid');
    const prefix=base.pathname==='/'?'':base.pathname.replace(/\/$/,'');
    const incomingPath=incoming.pathname||'/';
    const targetPath=prefix&&!(incomingPath===prefix||incomingPath.startsWith(prefix+'/'))
      ? prefix+(incomingPath.startsWith('/')?incomingPath:'/'+incomingPath)
      : incomingPath;
    const target=new URL(targetPath+incoming.search,base.origin);
    const kind=classifyRequest({method:req.method,path:req.url,upgrade:false});
    const connectionId=String(req.socket.remotePort||'');
    const eventBase={type:'http_upstream',requestId,connectionId,kind,method:req.method,path:sanitizePath(req.url),requestStartAt:started};
    await this.record({...eventBase,stage:'UPSTREAM_REQUEST_OPENED',at:started,headers:redactHeaders(req.headers)});

    const headers={...req.headers,host:target.host};
    delete headers.connection;
    delete headers['proxy-connection'];
    const transport=target.protocol==='http:'?http:https;
    const hash=createHash('sha256');
    let requestBytes=0;
    let responseBytes=0;
    let firstRequestByte=true;
    let firstResponseByte=true;
    let settled=false;

    const finishResponse=(resolve,error)=>{
      if(settled)return;
      settled=true;
      if(error)resolve({error});
      else resolve({});
    };

    const result=await new Promise(resolve=>{
      const upstream=transport.request(target,{method:req.method,headers},upstreamRes=>{
        const headersAt=Date.now();
        this.record({...eventBase,stage:'UPSTREAM_RESPONSE_HEADERS',at:headersAt,statusCode:upstreamRes.statusCode||0,headers:redactHeaders(upstreamRes.headers)}).catch(()=>{});
        res.writeHead(upstreamRes.statusCode||502,upstreamRes.headers);
        upstreamRes.on('data',chunk=>{
          responseBytes+=chunk.length;
          if(firstResponseByte){
            firstResponseByte=false;
            this.record({...eventBase,stage:'UPSTREAM_FIRST_EVENT',at:Date.now(),statusCode:upstreamRes.statusCode||0}).catch(()=>{});
          }
          if(!res.write(chunk))upstreamRes.pause();
        });
        res.on('drain',()=>upstreamRes.resume());
        upstreamRes.on('end',()=>{
          res.end();
          this.record({...eventBase,stage:'UPSTREAM_FINISHED',at:Date.now(),responseBytes,totalMs:Date.now()-started,statusCode:upstreamRes.statusCode||0}).catch(()=>{});
          finishResponse(resolve);
        });
        upstreamRes.on('error',error=>finishResponse(resolve,error));
      });
      upstream.on('error',error=>finishResponse(resolve,error));

      (async()=>{
        try{
          for await(const chunk of req){
            requestBytes+=chunk.length;
            if(requestBytes>64*1024*1024)throw Object.assign(new Error('Proxy request body exceeds 64 MiB.'),{statusCode:413});
            hash.update(chunk);
            if(firstRequestByte){
              firstRequestByte=false;
              await this.record({...eventBase,stage:'UPSTREAM_BYTES_SENT',at:Date.now(),requestBytes:chunk.length});
            }
            if(!upstream.write(chunk))await new Promise(wait=>upstream.once('drain',wait));
          }
          const bodySha256=requestBytes?hash.digest('hex'):'';
          await this.record({...eventBase,stage:'UPSTREAM_BODY_FINISHED',at:Date.now(),requestBytes,bodySha256});
          upstream.end();
        }catch(error){
          try{upstream.destroy(error);}catch{}
          finishResponse(resolve,error);
        }
      })();
    });

    if(result.error){
      await this.record({...eventBase,stage:'UPSTREAM_ERROR',at:Date.now(),error:safeError(result.error),requestBytes,responseBytes});
      if(!res.headersSent)json(res,Number(result.error.statusCode)||502,{error:'upstream failure'});
      else res.destroy();
    }
  }
}

module.exports={GatewayServer,isLoopback,readJson};
