"""Overlay scrolling, compact gutters and context-safe per-row actions."""
import json, os
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[2]
scratch=Path(os.environ['CST_UI_SCRATCH'])
import sys
sys.path.insert(0,str(root/'test/fixtures'))
from webview import dashboard as build_dashboard
html=build_dashboard(root,include_shim=False)
shim='<script nonce="ui-test">window.__messages=[];window.acquireVsCodeApi=()=>({getState:()=>({}),setState:()=>{},postMessage:m=>__messages.push(m)});</script>'
html=html.replace('<script nonce="ui-test">',shim+'<script nonce="ui-test">',1)
chat={'threadId':'selected','title':'Selected chat','stateKind':'running','state':'Running','timeline':[],'activeNodes':[]}
state={'activeChats':[chat,{'threadId':'other','title':'Another chat','stateKind':'running'}],'nonRunningChats':[],'selected':chat,'selectedThreadId':'selected','gateway':{},'queue':{},'steer':{},'contextWatch':{'entries':{},'busy':[]}}
errors=[]
with sync_playwright() as p:
    browser=p.chromium.launch_persistent_context(str(scratch/'scrollbars-edge'),channel='msedge',headless=True,downloads_path=str(scratch/'downloads'))
    try:
        page=browser.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
        page.set_viewport_size({'width':390,'height':800});page.set_content(html)
        page.add_style_tag(content='body{padding:0 20px}:root{--vscode-font-family:Arial;--vscode-foreground:#ddd;--vscode-editor-background:#25271f;--vscode-sideBar-background:#20221b;--vscode-panel-border:#555;--vscode-descriptionForeground:#aaa}')
        page.evaluate('(data)=>window.postMessage({type:"state",data},"*")',state)
        page.locator('#chatOptionsCurrent').wait_for()
        assert page.locator('body').evaluate('(e)=>getComputedStyle(e).paddingLeft==="0px"&&getComputedStyle(e).paddingRight==="0px"')
        assert page.locator('.sidebar').bounding_box()['x']==0
        assert page.locator('.main').evaluate('(e)=>parseFloat(getComputedStyle(e).paddingLeft)<=6')
        assert page.locator('#transferChat').count()==0
        page.locator('[data-chat-transfer="other"]').click()
        assert page.evaluate('__messages.at(-1).threadId')=='other'
        assert page.evaluate('__messages.at(-1).command')=='loadHandoffOptions'
        page.keyboard.press('Escape')
        page.evaluate('() => {const filler=document.createElement("div");filler.style.height="2000px";document.getElementById("main").appendChild(filler);}')
        rail=page.locator('.overlay-scrollbar[aria-controls="main"]')
        page.wait_for_function('() => {const r=document.querySelector(".overlay-scrollbar[aria-controls=main]");return r&&!r.hidden;}')
        width=page.locator('#main').evaluate('(e)=>e.clientWidth')
        assert page.locator('#main').evaluate('(e)=>e.offsetWidth-e.clientWidth')==0
        rail.focus();page.keyboard.press('End')
        page.wait_for_timeout(50)
        assert page.locator('#main').evaluate('(e)=>e.scrollTop>500')
        assert page.locator('#main').evaluate('(e)=>e.clientWidth')==width
        page.keyboard.press('Home');page.wait_for_timeout(50)
        thumb=rail.locator('.overlay-scrollbar-thumb').bounding_box()
        page.mouse.move(thumb['x']+3,thumb['y']+5);page.mouse.down()
        page.mouse.move(thumb['x']+3,thumb['y']+100,steps=5);page.mouse.up()
        assert page.locator('#main').evaluate('(e)=>e.scrollTop>100')
        assert page.locator('#main').evaluate('(e)=>e.clientWidth')==width
        page.locator('#search').focus();page.mouse.move(0,0);page.wait_for_timeout(1250)
        assert rail.evaluate('(e)=>floatValue=getComputedStyle(e).opacity')=='0'
        assert not errors,errors
        print(json.dumps({'passed':True,'bodyPadding':0,'reservedScrollbarWidth':0,'keyboardAndDrag':True,'otherChatHandoff':True,'pageErrors':errors}))
    finally:browser.close()
