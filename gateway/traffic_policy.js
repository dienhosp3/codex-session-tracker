'use strict';
const networkTypes=new Set(['client_request','client_response','client_response_event','client_hook_status','http_upstream','native_plaintext','native_tls_record','native_hook_status','ws_frame','ws_connection','connect_tunnel','tunnel_bytes','ws_upgrade_rejected']);
class TrafficPolicy{
  constructor(options={}){this.requests=new Map();this.count=0;this.skipped=0;this.configure(options);}
  configure(options={}){
    if(options.mode!==undefined&&!['all','post-get'].includes(options.mode))throw new Error('Invalid traffic capture mode.');
    this.mode=options.mode||this.mode||'post-get';
    if(options.maxRequests!==undefined&&(!Number.isInteger(options.maxRequests)||options.maxRequests<1||options.maxRequests>10000))throw new Error('Giới hạn request phải từ 1 đến 10000.');
    this.maxRequests=options.maxRequests??this.maxRequests??1000;
  }
  allows(event){
    if(!networkTypes.has(event.type))return true;
    if(event.stage==='CAPTURE_GAP')return true;
    const key=event.requestId||event.connectionId;
    const previous=key&&this.requests.get(key);
    const method=event.method||previous?.method;
    if(this.mode==='post-get'&&(!['POST','GET'].includes(method)||!event.path&&!previous?.path)){this.skipped++;return false;}
    // Transport-only observations do not consume the HTTP request limit.
    if(!key||!method||!event.path&&!previous?.path)return this.mode==='all';
    if(previous)return previous.accepted;
    const accepted=this.count<this.maxRequests;
    if(accepted)this.requests.set(key,{accepted,method,path:event.path});
    if(accepted)this.count++;else this.skipped++;
    return accepted;
  }
  snapshot(){return {trafficCaptureMode:this.mode,trafficMaxRequests:this.maxRequests,trafficRequestsCaptured:this.count,trafficCaptureLimitReached:this.count>=this.maxRequests,trafficEventsSkipped:this.skipped};}
}
module.exports={TrafficPolicy};
