"""Audit shared styles, compact toolbar, six contexts, family labels and cleanup."""
import json,os,sys
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(root/'test/fixtures'))
from webview import dashboard
scratch=Path(os.environ['CST_UI_SCRATCH'])
chat={'threadId':'a','title':'[Dự án_1-0001] One','stateKind':'running','state':'Running','timeline':[],'activeNodes':[]}
second={'threadId':'b','title':'[Dự án_1-0002] Two','stateKind':'completed'}
other={'threadId':'other','title':'[OTHER-0009] Other','stateKind':'completed'}
state={'activeChats':[chat,second,other],'nonRunningChats':[],'selected':chat,'selectedThreadId':'a','queue':{},'steer':{},
 'gateway':{'enabled':True,'running':True},'keepAwake':{'enabled':True,'busy':False},
 'sounds':{'types':[{'id':'chat_completed','label':'Done','group':'Chat'}],'settings':{'enabled':False,'types':{'chat_completed':False}}},
 'attention':{'a':{'title':chat['title'],'flags':['waitingOnPlanImplementation'],'planTurnId':'plan'}},'attentionPresentation':{'a':{'key':'key'}},
 'contextWatch':{'entries':{'a':{'displayLabel':'Shared'},'b':{'displayLabel':'Shared','previousThreadId':'a'},'other':{'displayLabel':'Shared'}},'busy':[]},
 'accountManager':{'connected':True,'accounts':[],'launchers':[],'settings':{}},
 'storage':{'policy':{'automatic':True,'days':7,'maxMiB':512},'groups':[{'id':'trace','label':'Trace','bytes':1024},{'id':'images','label':'Images','bytes':2048,'protected':True}],'plannedFiles':1,'plannedBytes':1024,'busy':False}}
choices=[{'preset':preset,'label':label,'detail':'','requestedK':k,'available':True} for preset,label,k in [('default','272K',272),('400k','400K',400),('550k','550K',550),('700k','700K',700),('900k','900K',900),('custom','Tự đặt',None)]]
errors=[]
with sync_playwright() as p:
 browser=p.chromium.launch_persistent_context(str(scratch/'controls-edge'),channel='msedge',headless=True,downloads_path=str(scratch/'downloads'))
 try:
  page=browser.new_page();page.on('pageerror',lambda e:errors.append(str(e)));page.set_viewport_size({'width':520,'height':900})
  page.set_content(dashboard(root))
  page.add_style_tag(content=':root{--vscode-font-family:Arial;--vscode-foreground:#ddd;--vscode-editor-background:#222;--vscode-panel-background:#222;--vscode-sideBar-background:#252526;--vscode-panel-border:#555;--vscode-descriptionForeground:#aaa;--vscode-button-secondaryBackground:#3a3d41;--vscode-button-secondaryForeground:#ddd;--vscode-button-background:#0878c9;--vscode-button-foreground:#fff;--vscode-input-background:#333;--vscode-input-foreground:#ddd;--vscode-focusBorder:#3794ff}')
  def post(message):page.evaluate('(m)=>window.postMessage(m,"*")',message);page.wait_for_timeout(40)
  def last():return page.evaluate('__messages.at(-1)')
  def audit():
   bad=page.locator('button:visible').evaluate_all("""nodes=>nodes.filter(n=>{const s=getComputedStyle(n);return ['rgb(239, 239, 239)','rgb(240, 240, 240)'].includes(s.backgroundColor)||s.fontFamily==='Arial'&&s.color==='rgb(0, 0, 0)'}).map(n=>n.id||n.getAttribute('aria-label')||n.textContent)""")
   assert not bad,bad
  post({'type':'state','data':state})
  assert page.locator('.sidebar .bar').count()==0
  assert page.locator('#newChat').inner_text()=='+'
  assert page.locator('#newChat').evaluate('(n)=>parseFloat(getComputedStyle(n).fontSize)')>=28
  positions=[page.locator(x).bounding_box() for x in ['#newChat','#search','#refresh','#newChatSettings']]
  assert all(abs(box['y']-positions[0]['y'])<2 for box in positions)
  assert all(positions[i]['x']<positions[i+1]['x'] for i in range(3))
  page.locator('#search').fill('0002');assert page.locator('.chat').count()==1
  clear=page.locator('#clearSearch');assert clear.is_visible()
  field=page.locator('#search').bounding_box();button=clear.bounding_box()
  assert button['x']+button['width']<=field['x']+field['width']
  clear.click();assert page.locator('.chat').count()==3 and clear.is_hidden()
  assert page.locator('[data-id="a"] .chat-title').inner_text()=='[0001] Shared'
  assert page.locator('[data-id="b"] .chat-title').inner_text()=='[0002] Shared'
  assert page.locator('[data-id="other"] .chat-title').inner_text()=='[0009] Shared'
  assert page.locator('[data-attention-dismiss]').inner_text()==''
  assert page.locator('[data-attention-dismiss] svg').count()==1
  assert '?' not in page.locator('[data-plan-ok]').get_attribute('title')
  assert page.locator('.gateway-summary').inner_text()=='Giao tiếp'
  assert page.locator('.gateway-online-led.online').count()==1
  frames=page.evaluate("""() => [...document.styleSheets].flatMap(sheet=>[...sheet.cssRules]).filter(r=>r.name==='keep-awake-pulse').map(r=>r.cssText).join('')""")
  assert '0.1' in frames and 'opacity: 1' in frames
  assert page.locator('#soundSettingsButton').evaluate('(n)=>n.classList.contains("is-muted")')
  audit()
  page.locator('#newChat').click();request=last()
  post({'type':'newChatOptions','requestId':request['requestId'],'cwd':'D:/Project','folders':[{'cwd':'D:/Project','name':'Project'}],'preset':'600k','model':'model','models':[{'id':'model','label':'Model'}],'choices':choices})
  assert page.locator('#ncPresets input').count()==6
  assert page.locator('#ncPresets input[value="custom"]').is_checked()
  assert page.locator('#ncCustomK').input_value()=='600'
  page.locator('#ncCustomK').fill('650');request=last();assert request['preset']=='custom:650'
  post({'type':'newChatPresetSaved','requestId':request['requestId'],'preset':'custom:650'})
  page.locator('#ncPrompt').fill('Custom context')
  assert page.locator('#ncSubmit').is_enabled();audit()
  page.locator('#ncCustomK').fill('0');assert page.locator('#ncSubmit').is_disabled()
  page.locator('#ncCustomK').fill('650');request=last();post({'type':'newChatPresetSaved','requestId':request['requestId'],'preset':'custom:650'})
  page.locator('#ncSubmit').click();request=last();assert request['preset']=='custom:650'
  post({'type':'newChatResult','requestId':request['requestId'],'success':True})
  page.locator('#gatewaySummary').click();page.locator('[data-open-storage]').click();request=last()
  post({'type':'storageResult','requestId':request['requestId'],'action':'inspect','data':state['storage'],'error':''})
  assert page.locator('#storageAuto').is_checked()
  assert page.locator('#storageDays').input_value()=='7' and page.locator('#storageLimit').input_value()=='512'
  page.locator('#storageDays').fill('9');post({'type':'state','data':state});assert page.locator('#storageDays').input_value()=='9'
  assert page.locator('#storageClean').is_disabled(), 'unsaved policy must not clean with stale settings'
  page.locator('#storageSave').click();save=last()
  assert save['action']=='configure' and save['policy']['days']==9
  assert page.locator('#storageDays').is_disabled() and page.locator('#storageSave').is_disabled()
  post({'type':'storageResult','requestId':'stale','action':'configure','data':state['storage']})
  assert page.locator('#storageSave').is_disabled(), 'stale ACK unlocked pending save'
  post({'type':'storageResult','requestId':save['requestId'],'action':'configure','error':'Could not save','data':state['storage']})
  assert page.locator('#storageDays').input_value()=='9' and page.locator('#storageClean').is_disabled()
  assert 'Could not save' in page.locator('#storageStatus').inner_text()
  page.locator('#storageSave').click();save=last()
  state['storage']['policy']['days']=9
  post({'type':'storageResult','requestId':save['requestId'],'action':'configure','data':state['storage']})
  assert page.locator('#storageClean').is_enabled()
  page.locator('#storageMemory').click();request=last();assert request['action']=='memory'
  post({'type':'storageResult','requestId':request['requestId'],'action':'memory','data':state['storage']})
  assert 'cache' in page.locator('#storageStatus').inner_text()
  audit();page.locator('#storageClose').click()
  for control,close in [('#soundSettingsButton','#soundClose'),('.auth-session-card [data-accounts-toggle]','#amClose'),('#chatOptionsCurrent','#coCancel'),('#contextTransferNow','#hfCancel')]:
   page.locator(control).click();page.wait_for_timeout(30);audit();page.locator(close).click()
  for width in [320,520,1000]:
   page.set_viewport_size({'width':width,'height':800});page.wait_for_timeout(50)
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
   if width<=520:
    buttons={name:page.locator('#'+name).bounding_box() for name in ['steerBtn','queueBtn','stopBtn','pauseGoalBtn']}
    assert abs(buttons['steerBtn']['y']-buttons['queueBtn']['y'])<1
    assert abs(buttons['stopBtn']['y']-buttons['pauseGoalBtn']['y'])<1
    assert buttons['stopBtn']['y']>buttons['steerBtn']['y']
    assert page.locator('#pauseGoalBtn').evaluate('(n)=>n.scrollWidth<=n.clientWidth')
  page.emulate_media(reduced_motion='reduce')
  assert page.locator('.gateway-online-led.online').evaluate('(n)=>getComputedStyle(n).animationName')=='none'
  themes={
   'dark':{'foreground':'#ddd','editor-background':'#222','panel-background':'#222','sideBar-background':'#252526','editorWidget-background':'#252526','panel-border':'#555','descriptionForeground':'#aaa','button-secondaryBackground':'#3a3d41','button-secondaryForeground':'#ddd','input-background':'#333','input-foreground':'#ddd'},
   'light':{'foreground':'#222','editor-background':'#fff','panel-background':'#fff','sideBar-background':'#f3f3f3','editorWidget-background':'#fff','panel-border':'#ccc','descriptionForeground':'#555','button-secondaryBackground':'#e5e5e5','button-secondaryForeground':'#222','input-background':'#fff','input-foreground':'#222'},
   'contrast':{'foreground':'#fff','editor-background':'#000','panel-background':'#000','sideBar-background':'#000','editorWidget-background':'#000','panel-border':'#fff','descriptionForeground':'#fff','button-secondaryBackground':'#000','button-secondaryForeground':'#fff','input-background':'#000','input-foreground':'#fff'}
  }
  for name,tokens in themes.items():
   page.evaluate('(tokens)=>Object.entries(tokens).forEach(([key,value])=>document.documentElement.style.setProperty("--vscode-"+key,value))',tokens)
   for width in [320,520,1000]:
    page.set_viewport_size({'width':width,'height':800});page.wait_for_timeout(30)
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
    for selector in ['#steerBtn','#queueBtn','#stopBtn','#pauseGoalBtn']:
     assert page.locator(selector).evaluate('(n)=>n.scrollWidth<=n.clientWidth'), (name,width,selector)
   if name=='dark' and os.environ.get('CST_UI_PREVIEW'):
    page.set_viewport_size({'width':320,'height':800});page.locator('#pauseGoalBtn').scroll_into_view_if_needed()
    page.screenshot(path=str(scratch/'compact-composer.png'))
   page.set_viewport_size({'width':320,'height':480})
   page.locator('[data-open-storage]').click();request=last()
   post({'type':'storageResult','requestId':request['requestId'],'action':'inspect','data':state['storage']})
   for selector in ['#storageClose','#storageSave']:
    box=page.locator(selector).bounding_box();assert box['x']>=0 and box['y']>=0 and box['x']+box['width']<=320 and box['y']+box['height']<=480,(name,selector,box)
   if name=='light' and os.environ.get('CST_UI_PREVIEW'):
    page.screenshot(path=str(scratch/'storage-light.png'))
   page.locator('#storageClose').click()
  assert not errors,errors
  print(json.dumps({'passed':True,'toolbarAndClear':True,'familyOrdinals':True,'sixContexts':True,'custom650K':True,'styleAudit':True,'cleanupPolicy':True,'policyAckAndRecovery':True,'twoColumnComposer':True,'themes':list(themes),'mutedAndPulse':True,'pageErrors':errors}))
 finally:browser.close()
