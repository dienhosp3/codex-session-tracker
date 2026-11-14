"""Opt-in: installed account modules + actual app storage/Core + headless Edge."""
import json
import os
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(os.environ['CST_INSTALLED_EXTENSION'])
storage = Path(os.environ['CST_LIVE_STORAGE'])
scratch = Path(os.environ['CST_UI_SCRATCH'])
assert root.is_dir() and storage.is_dir() and 'AHUST-Work' in scratch.parts
node = r"""
const path=require('node:path');
const {createAccountManager}=require('./src/codex_account_manager');
const {createCoreAccess}=require('./src/codex_accounts_core');
(async()=>{
 const manager=createAccountManager({}, {globalStorageUri:{fsPath:process.env.CST_LIVE_STORAGE}},
   {core:createCoreAccess({}),codexHome:()=>path.join(process.env.USERPROFILE,'.codex')});
 const result=await manager.action({action:'refresh'});
 if(result?.error)throw new Error(result.error);
 process.stdout.write(JSON.stringify({version:require('./package.json').version,data:manager.snapshot()}));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
"""
def live():
    result = subprocess.run(['node','-e',node], cwd=root, capture_output=True, text=True, encoding='utf-8', timeout=25, creationflags=subprocess.CREATE_NO_WINDOW)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)

# Render every installed asset through the same template assembler as UI suites.
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'fixtures'))
from webview import dashboard
html = dashboard(root, nonce='live-ui')

data=live()
state={'activeChats':[],'nonRunningChats':[],'selectedThreadId':'','selected':None,'gateway':{},'queue':{},'steer':{},'authSession':{'accountLabel':'Codex'},'accountManager':data['data']}
errors=[]
with sync_playwright() as p:
    browser=p.chromium.launch_persistent_context(str(scratch/'edge-live'),channel='msedge',headless=True,downloads_path=str(scratch/'downloads'))
    try:
        page=browser.new_page()
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.set_viewport_size({'width':390,'height':900})
        page.set_content(html)
        page.add_style_tag(content=':root{--vscode-font-family:Segoe UI,Arial;--vscode-foreground:#ccc;--vscode-editor-background:#25271f;--vscode-panel-background:#25271f;--vscode-sideBar-background:#20221b;--vscode-panel-border:#47493c;--vscode-descriptionForeground:#aaa;--vscode-input-background:#303228;--vscode-input-foreground:#ddd;--vscode-button-secondaryBackground:#414337;--vscode-button-secondaryForeground:#ddd;--vscode-focusBorder:#cac9a5}')
        def post():
            page.evaluate('(data)=>window.postMessage({type:"state",data},"*")',state)
            page.wait_for_timeout(50)
        post()
        assert page.locator('.auth-session-actions .account-icon').count()==2
        assert page.locator('.auth-session-actions').inner_text()==''
        page.locator('.auth-session-card').screenshot(path=str(scratch/'live-icons.png'))
        page.locator('.auth-session-card [data-accounts-toggle]').click()
        for _ in range(3):
            page.locator('#amRefresh').click()
            request=page.evaluate('__messages.at(-1)')
            assert request['action']=='refresh'
            data=live();state['accountManager']=data['data'];post()
            page.evaluate('(m)=>window.postMessage(m,"*")',{'type':'accountActionResult','requestId':request['requestId'],'error':'','data':data['data']})
            page.wait_for_timeout(50)
            assert page.locator('#amRefresh').is_enabled()
            assert not page.locator('#amNotice').evaluate('(n)=>n.classList.contains("error")')
        assert 'Unexpected token' not in page.locator('#accountManagerDialog').inner_text()
        assert page.locator('#amLaunchers>.account-row').count()==len(data['data']['launchers'])
        page.locator('#amHelpButton').click();post()
        assert page.locator('#amHelpPanel').is_visible()
        page.screenshot(path=str(scratch/'live-help.png'))
        page.keyboard.press('Escape');page.wait_for_timeout(60)
        assert page.locator('#accountManagerDialog').is_visible()
        page.locator('#amLaunchers button').first.click()
        assert page.locator('.account-link-method').count()==2
        assert page.locator('#amLink').is_visible()
        page.screenshot(path=str(scratch/'live-linking.png'))
        assert not errors,errors
        print(json.dumps({'installedVersion':data['version'],'actualCoreAndAppStorage':True,'refreshThroughUI':3,'launchers':len(data['data']['launchers']),'accounts':len(data['data']['accounts']),'jsonError':False,'iconButtons':2,'helpAndLinking':True,'pageErrors':errors}))
    finally:
        browser.close()
