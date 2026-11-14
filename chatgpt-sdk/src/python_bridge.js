// Keep module loading inside the boundary: runtime replacement or missing files
// must produce a structured failure before a command can be dispatched.
let phase='bridge.input', command;
try {
  let text='';for await(const chunk of process.stdin)text+=chunk;
  const input=JSON.parse(text);command=input.command;
  phase='bridge.load';
  const {ChatGPTClient}=await import('./client.js');
  const client=new ChatGPTClient({consumer:command.consumer,home:input.home,
    runtimePath:input.runtimePath,runtimeHome:input.runtimeHome,
    requiredCapabilities:input.requiredCapabilities||[]});
  phase='bridge.request';
  const result=await client.request(command.action,command.args,{requestId:command.requestId,timeoutMs:input.timeoutMs});
  process.stdout.write(JSON.stringify({status:'completed',result})+'\n');
} catch(error) {
  const details={...(error.details||{}),...(error.diagnostic?{diagnosticId:error.diagnostic.id,logPath:error.diagnostic.logPath}:{}),...(phase==='bridge.load'?{phase,dispatched:false,cause:error.code,requestId:command?.requestId}:{})};
  process.stdout.write(JSON.stringify({status:'failed',error:{code:phase==='bridge.load'?'CORE_BRIDGE_LOAD_FAILED':error.code||'CORE_FAILED',message:error.message||String(error),details,retryable:false}})+'\n');
  process.exitCode=1;
}
