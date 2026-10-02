'use strict';
const {StringDecoder}=require('string_decoder');

// Parse SSE on event boundaries, including UTF-8 and CRLF split across chunks.
// Preserve every event rather than the subset consumed by Codex's reducer.
class ResponseEvents{
  constructor(onEvent,options={}){this.onEvent=onEvent;this.maxBytes=options.maxBytes||16*1024*1024;this.streams=new Map();}
  websocket(meta,text){this.emit(meta,'',text);}
  emit(meta,eventName,data,id=''){
    let parsed;try{parsed=JSON.parse(data);}catch{}
    const type=eventName||parsed?.type||(data==='[DONE]'?'stream.done':'message');
    this.onEvent({...meta,eventType:type,responseId:parsed?.response?.id||parsed?.response_id||'',
      itemId:parsed?.item?.id||parsed?.item_id||'',sequenceNumber:parsed?.sequence_number,sseId:id,data});
  }
  chunk(meta,bytes){
    if(!this.streams.has(meta.requestId)){
      if(this.streams.size>=256)this.streams.delete(this.streams.keys().next().value);
      this.streams.set(meta.requestId,{decoder:new StringDecoder('utf8'),buffer:'',data:[],event:'',id:'',size:0});
    }
    const stream=this.streams.get(meta.requestId);stream.buffer+=stream.decoder.write(bytes);
    let match;
    while((match=/\r\n|\r|\n/.exec(stream.buffer))){
      if(match[0]==='\r'&&match.index===stream.buffer.length-1)break;
      const line=stream.buffer.slice(0,match.index);stream.buffer=stream.buffer.slice(match.index+match[0].length);
      if(!line){
        if(stream.data.length)this.emit(meta,stream.event,stream.data.join('\n'),stream.id);
        stream.data=[];stream.event='';stream.size=0;continue;
      }
      if(line.startsWith(':'))continue;
      const colon=line.indexOf(':');const field=colon<0?line:line.slice(0,colon);let value=colon<0?'':line.slice(colon+1);
      if(value.startsWith(' '))value=value.slice(1);
      if(field==='event')stream.event=value;
      if(field==='id'&&!value.includes('\0'))stream.id=value;
      if(field==='data'){stream.size+=Buffer.byteLength(value);if(stream.size>this.maxBytes)throw new Error('SSE event vượt giới hạn capture.');stream.data.push(value);}
    }
    if(Buffer.byteLength(stream.buffer)>this.maxBytes)throw new Error('SSE line vượt giới hạn capture.');
  }
  end(id){this.streams.delete(id);}
}
module.exports={ResponseEvents};
