// The fence is presentation only. Consumers own the body format and schema.
// Never repair escapes, decode entities or reconstruct rendered formulas here.
const frame=value=>String(value).replace(/\r\n/g,'\n').replace(/\n$/,'');
export function validateCodeBlock(output,{languages,unlabeled=languages===undefined}={}){
  const issues=[],allowed=(languages||[]).map(value=>String(value).toLowerCase());
  if(output?.completed!==true)issues.push('OUTPUT_NOT_READY: require a completed response.');
  if(output?.capture?.source!=='copy')issues.push('CODE_BLOCK_SOURCE: require whole-response Copy source.');
  const match=/^(`{3,})([\w+-]*)(?:[ \t]+id="[A-Za-z0-9_-]{1,128}")?[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*$/.exec(String(output?.text||'').trim());
  if(!match||/^`{3,}/m.test(match[3]))issues.push('CODE_BLOCK_FENCE: require exactly one fenced block, no prose outside it.');
  const blocks=output?.codeBlocks;
  if(!Array.isArray(blocks)||blocks.length!==1)issues.push('CODE_BLOCK_UI: require exactly one observed static code block in this assistant.');
  const block=blocks?.length===1?blocks[0]:null,uiLanguage=String(block?.language||'').toLowerCase();
  // Current UI labels a requested ```tex viewer "LaTeX" and whole-response
  // Copy omits its language tag. This is UI evidence, not proof of a backend
  // token. Explicit ```latex source is still rejected for a tex-only contract.
  const language=unlabeled?'':uiLanguage==='latex'&&allowed.includes('tex')?'tex':uiLanguage;
  if(block){
    if(block.readOnly!==true||block.editControls?.length||output.editableResponse!==false)issues.push('CODE_BLOCK_EDITABLE: Canvas/editable controls are not allowed.');
    if(unlabeled?!['','text','plaintext','plain text','code'].includes(uiLanguage):!allowed.includes(language))issues.push('CODE_BLOCK_LANGUAGE: expected '+(unlabeled?'an unlabelled plain code block':allowed.join('/'))+', observed '+(language||'none')+'.');
    if(match&&frame(match[3])!==frame(block.text))issues.push('CODE_BLOCK_MISMATCH: Copy body differs from literal code text; no escape repair is allowed.');
  }
  if(match&&match[2]&&(unlabeled||!allowed.includes(match[2].toLowerCase())))issues.push('CODE_BLOCK_LANGUAGE: unexpected fence language '+match[2]+'.');
  return {valid:issues.length===0,issues,language,uiLanguage,languageEvidence:match?.[2]?'copy_fence_and_ui':'ui_label_only',body:match?.[3]};
}
