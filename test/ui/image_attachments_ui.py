"""Image picker/paste, hover-only removal, drafts, and queued-image controls."""
import base64,json,os
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[2]
scratch=Path(os.environ['CST_UI_SCRATCH'])
png=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNoaGgAAAMEAYFL09IQAAAAAElFTkSuQmCC')
import sys
sys.path.insert(0,str(root/'test/fixtures'))
from webview import dashboard as build_dashboard
html=build_dashboard(root,include_shim=False)
shim='<script nonce="ui-test">window.__messages=[];window.acquireVsCodeApi=()=>({getState:()=>({}),setState:()=>{},postMessage:m=>__messages.push(m)});</script>'
html=html.replace('<script nonce="ui-test">',shim+'<script nonce="ui-test">',1)
choices=[{'preset':'default','label':'Default','detail':'272K','available':True}]
chat={'threadId':'source','title':'Source','stateKind':'running','state':'Running','timeline':[],'activeNodes':[]}
state={'activeChats':[chat],'nonRunningChats':[],'selected':chat,'selectedThreadId':'source','gateway':{},'queue':{'checked':True,'available':True,'imagesAvailable':True},'steer':{'checked':True,'available':True},'contextWatch':{'entries':{},'busy':[]}}
errors=[]
with sync_playwright() as p:
 browser=p.chromium.launch_persistent_context(str(scratch/'images-edge'),channel='msedge',headless=True,downloads_path=str(scratch/'downloads'))
 try:
  page=browser.new_page();page.set_viewport_size({'width':520,'height':850});page.on('pageerror',lambda e:errors.append(str(e)))
  page.set_content(html);page.add_style_tag(content=':root{--vscode-font-family:Arial;--vscode-foreground:#ddd;--vscode-editor-background:#222;--vscode-panel-background:#222;--vscode-sideBar-background:#252526;--vscode-panel-border:#555;--vscode-descriptionForeground:#aaa}')
  def post(message):page.evaluate('(m)=>window.postMessage(m,"*")',message);page.wait_for_timeout(40)
  def last():return page.evaluate('__messages.at(-1)')
  def paste(selector):
   page.locator(selector).evaluate("""(el,b64)=>{const bytes=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));const data=new DataTransfer();data.items.add(new File([bytes],'paste.png',{type:'image/png'}));el.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));}""",base64.b64encode(png).decode())
  post({'type':'state','data':state});page.locator('#newChat').click()
  post({'type':'newChatOptions','requestId':last()['requestId'],'cwd':'D:/Project','folders':[{'cwd':'D:/Project','name':'Project'}],'preset':'default','model':'model','models':[{'id':'model','label':'Model'}],'choices':choices})
  page.locator('#ncImages [data-attachment-file]').set_input_files({'name':'pick.png','mimeType':'image/png','buffer':png})
  page.wait_for_function('() => document.querySelectorAll("#ncImages .attachment-thumb").length===1')
  assert page.locator('#ncSubmit').is_enabled(), 'image-only prompt must be valid'
  remove=page.locator('#ncImages .attachment-remove')
  page.mouse.move(0,0);assert remove.evaluate('(e)=>getComputedStyle(e).opacity')=='0'
  page.locator('#ncImages .attachment-thumb').hover()
  assert remove.evaluate('(e)=>getComputedStyle(e).opacity')=='1'
  parent=remove.locator('..').bounding_box();box=remove.bounding_box()
  assert box['x']>=parent['x'] and box['x']+box['width']<=parent['x']+parent['width']
  page.locator('#ncCancel').click();page.locator('#newChat').click()
  request=last();post({'type':'newChatOptions','requestId':request['requestId'],'cwd':'D:/Project','folders':[{'cwd':'D:/Project','name':'Project'}],'preset':'default','model':'model','models':[{'id':'model','label':'Model'}],'choices':choices})
  assert page.locator('#ncImages .attachment-thumb').count()==1
  paste('#ncPrompt');page.wait_for_function('() => document.querySelectorAll("#ncImages .attachment-thumb").length===2')
  post({'type':'state','data':state});assert page.locator('#ncImages .attachment-thumb').count()==2
  page.locator('#ncSubmit').click();request=last();assert len(request['images'])==2 and request['message']==''
  post({'type':'newChatResult','requestId':request['requestId'],'error':'fixture error','delivery':'not_sent'})
  assert page.locator('#ncImages .attachment-thumb').count()==2
  page.locator('#ncCancel').click()
  page.locator('#contextTransferNow').click();request=last()
  post({'type':'handoffOptions','requestId':request['requestId'],'threadId':'source','title':'Source','cwd':'D:/Project','model':'model','models':[{'id':'model','label':'Model'}],'modes':{'normal':{'available':True}},'successorMode':'normal','preset':'default','enabled':False,'thresholdPercent':80,'handoffDelaySeconds':0,'choices':choices})
  paste('#hfExtra');page.wait_for_function('() => document.querySelectorAll("#hfImages .attachment-thumb").length===1')
  page.locator('#hfCancel').click();page.locator('#contextTransferNow').click();request=last()
  post({'type':'handoffOptions','requestId':request['requestId'],'threadId':'source','title':'Source','cwd':'D:/Project','model':'model','models':[{'id':'model','label':'Model'}],'modes':{'normal':{'available':True}},'successorMode':'normal','preset':'default','enabled':False,'thresholdPercent':80,'handoffDelaySeconds':0,'choices':choices})
  assert page.locator('#hfImages .attachment-thumb').count()==1
  page.locator('#hfSubmit').click();request=last();assert len(request['settings']['images'])==1
  post({'type':'handoffResult','threadId':'source','requestId':request['requestId'],'error':'not sent','blocked':False})
  assert page.locator('#hfImages .attachment-thumb').count()==1
  page.locator('#hfCancel').click()
  paste('#composerInput');page.wait_for_function('() => document.querySelectorAll("[data-remove-image]").length===1')
  page.mouse.move(0,0);assert page.locator('[data-remove-image]').evaluate('(e)=>getComputedStyle(e).opacity')=='0'
  page.locator('.image-gallery .image-preview').hover();assert page.locator('[data-remove-image]').evaluate('(e)=>getComputedStyle(e).opacity')=='1'
  assert page.locator('#queueBtn').is_enabled()
  page.locator('#queueBtn').click();request=last();assert request['command']=='queueMessage' and len(request.get('images',[]))==1, {'command':request['command'],'images':len(request.get('images',[])),'errors':errors}
  state['queue']['imageJobs']=[{'id':'queued','phase':'waiting','threadId':'source'}]
  post({'type':'state','data':state});page.locator('[data-queue-image-cancel]').click();assert last()=={'command':'cancelQueuedImage','id':'queued'}
  assert not errors,errors
  print(json.dumps({'passed':True,'pickerAndPaste':True,'hoverOnlyRemove':True,'newAndHandoffDrafts':True,'imageOnlyNewChat':True,'queuedImages':True,'pageErrors':errors}))
 finally:browser.close()
