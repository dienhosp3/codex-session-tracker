import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {CoreError,invariant} from './errors.js';
const digest=value=>createHash('sha256').update(value).digest('hex');

// Business validators and repair wording belong to the consumer. Transport,
// uncertain-send and capture errors propagate; only completed invalid replies
// are eligible for a fresh, counted corrective message.
export async function runValidatedTurn(client,{
  conversationRef,prompt,validate,buildRepairPrompt,maxRepairs=1,requestId=randomUUID(),
  attachmentRefs=[],repairAttachmentRefs=attachmentRefs,timeoutMs=240000,stableMs=3000,
  initialTurnRef,
}){
  invariant(typeof validate==='function'&&typeof buildRepairPrompt==='function','VALIDATOR_REQUIRED','Provide a validator and a repair prompt builder');
  invariant(Number.isInteger(maxRepairs)&&maxRepairs>=0&&maxRepairs<=5,'INVALID_REPAIR_LIMIT','Repair limit must be between 0 and 5');
  const folder=join(client.home,'client-captures',digest(client.consumer),digest(requestId));await mkdir(folder,{recursive:true});
  const attempts=[];let currentPrompt=prompt;
  for(let attempt=0;attempt<=maxRepairs;attempt++){
    const key=`${requestId}:attempt:${attempt}`;
    const sent=attempt===0&&initialTurnRef?{conversationRef,turnRef:initialTurnRef}:await client.request('turn.send',{conversationRef,prompt:currentPrompt,attachmentRefs:attempt?repairAttachmentRefs:attachmentRefs,timeoutMs},{requestId:key});
    conversationRef=sent.conversationRef;
    const output=attempt===0&&initialTurnRef?await client.request('output.readText',{turnRef:initialTurnRef}):await client.request('turn.wait',{turnRef:sent.turnRef,timeoutMs,stableMs},{requestId:key+':wait'});
    invariant(output.completed===true,'OUTPUT_NOT_READY','An incomplete response cannot be validated or repaired');
    const text=output.text||'',rawPath=join(folder,`${attempt}.txt`),sha256=digest(text);
    await writeFile(rawPath,text,'utf8');
    await client.request('output.persisted',{turnRef:sent.turnRef,sha256},{requestId:key+':receipt'});
    const validation=text.trim()?await validate(text,output):{valid:false,issues:['OUTPUT_EMPTY: the completed response contains no text.']};
    invariant(typeof validation?.valid==='boolean'&&Array.isArray(validation.issues),'VALIDATOR_RESULT_INVALID','Validator must return {valid,issues}');
    attempts.push({attempt,turnRef:sent.turnRef,conversationRef,rawPath,sha256,validation});
    await writeFile(join(folder,'validation.json'),JSON.stringify({requestId,attempts},null,2),'utf8');
    if(validation.valid)return {...output,turnRef:sent.turnRef,conversationRef,validation,attempts};
    if(attempt===maxRepairs)throw new CoreError('OUTPUT_VALIDATION_FAILED','Response failed validation after the allowed corrections',{conversationRef,attempts,reviewRequired:true});
    currentPrompt=await buildRepairPrompt({originalPrompt:prompt,previousText:text,issues:validation.issues,repairNumber:attempt+1,maxRepairs});
    invariant(typeof currentPrompt==='string'&&currentPrompt.trim(),'REPAIR_PROMPT_REQUIRED','Repair must provide an explicit corrective prompt');
  }
}
