"""Real Edge regression: account modal under continuous Tracker state updates."""
import json
import os
from copy import deepcopy
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[2]
scratch = Path(os.environ['CST_UI_SCRATCH'])
profile = scratch / 'accounts-edge'
profile.mkdir()
import sys
sys.path.insert(0,str(root/'test/fixtures'))
from webview import dashboard as build_dashboard
html=build_dashboard(root,include_shim=False)
shim = '<script nonce="ui-test">window.__messages=[];window.acquireVsCodeApi=()=>({getState:()=>({}),setState:()=>{},postMessage:m=>__messages.push(m)});</script>'
html = html.replace('<script nonce="ui-test">', shim+'<script nonce="ui-test">', 1)
theme = ':root{--vscode-font-family:Segoe UI,Arial;--vscode-foreground:#ddd;--vscode-panel-background:#202020;--vscode-editor-background:#202020;--vscode-sideBar-background:#252526;--vscode-editorWidget-background:#252526;--vscode-panel-border:#454545;--vscode-descriptionForeground:#aaa;--vscode-focusBorder:#3794ff;--vscode-input-background:#303030;--vscode-input-foreground:#eee;--vscode-input-border:#555;--vscode-textLink-foreground:#4daafc;--vscode-button-background:#0878c9;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#3a3d41;--vscode-button-secondaryForeground:#fff;--vscode-testing-iconPassed:#73c991}'
settings = {'autoSwitch':False, 'autoResume':False, 'resumeScope':'trigger', 'busyPolicy':'wait', 'choiceSeconds':30, 'autoModelFallback':False, 'allowedModels':[]}
accounts = [{'id':str(i), 'email':['work@example.test','personal@example.test','backup@example.test'][i % 3] if i < 3 else 'account-'+str(i)+'@example.test', 'planType':'plus' if i % 2 else 'business', 'status':'ready', 'launcherIds':['bat'+str(i)], 'settings':{'warmupEnabled':False,'autoSwitchAllowed':True}, 'quota':{'checkedAt':1800000000000,'groups':[{'id':'codex','windows':[{'durationMinutes':300,'usedPercent':i*3 % 100,'resetsAt':1800018000000}, {'durationMinutes':10080,'usedPercent':80-i % 80,'resetsAt':1800604800000}]}]}} for i in range(25)]
base = {'activeChats':[], 'nonRunningChats':[{'threadId':str(i),'title':'Chat '+str(i),'stateKind':'completed','lastActivity':1700000000000+i} for i in range(1000)], 'showNonRunning':True, 'selectedThreadId':'', 'selected':None, 'gateway':{}, 'queue':{}, 'steer':{}, 'authSession':{'accountLabel':'work@example.test'}, 'attention':{'plan':{'flags':['waitingOnPlanImplementation'],'title':'Plan','planTurnId':'turn'}}, 'attentionPresentation':{'plan':{'key':'key','hidden':False}}, 'accountManager':{'connected':True,'accounts':accounts,'launchers':[{'id':'bat'+str(i),'label':'Chrome '+str(i+1),'batPath':'D:/Chrome/Chrome'+str(i+1)+'.bat','accountLabel':'browser-'+str(i+1)+'@example.test'} for i in range(27)],'currentRef':'0','settings':settings}}
errors = []
with sync_playwright() as p:
    browser = p.chromium.launch_persistent_context(str(profile), channel='msedge', headless=True, downloads_path=str(scratch / 'downloads'))
    try:
        page = browser.new_page()
        page.set_viewport_size({'width':1100,'height':840})
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.set_content(html)
        page.add_style_tag(content=theme)
        def post(state):
            page.evaluate('(data)=>window.postMessage({type:"state",data},"*")', state)
            page.wait_for_timeout(30)
        def result(request, error='', state=None, launcher_id=None):
            page.evaluate('(m)=>window.postMessage(m,"*")', {'type':'accountActionResult','requestId':request['requestId'],'error':error,'launcherId':launcher_id,'data':state or base['accountManager']})
            page.wait_for_timeout(30)
        post(base)
        page.locator('[data-plan-ok]').click()
        assert page.evaluate('__messages.at(-1).command') == 'implementPlan'
        page.locator('[data-attention-dismiss]').click()
        base['attentionPresentation']['plan']['hidden'] = True
        post(base)
        assert page.locator('#main .account-manager').count() == 0
        assert page.locator('.auth-session-card [data-accounts-toggle]').count() == 1
        page.locator('.auth-session-card [data-accounts-toggle]').click()
        modal = page.locator('#accountManagerDialog')
        assert modal.is_visible() and modal.evaluate('(d)=>d.parentElement===document.body && d.matches(":modal")')
        assert page.locator('#amAccounts>.account-row').count() == 25
        assert page.locator('#amLaunchers>.account-row').count() == 2
        assert page.locator('#amLink').is_hidden()
        assert page.locator('#amAccounts .account-meter[role="meter"]').count() == 50
        assert page.locator('#amAccounts .account-plan[data-plan="plus"]').count()>0
        assert page.locator('#amAccounts .account-plan[data-plan="business"]').count()>0
        assert page.locator('[data-plan-ok]').count()==0
        assert 'nick' not in modal.inner_text().lower()
        help_messages = page.evaluate('__messages.length')
        page.locator('#amHelpButton').click()
        assert page.locator('#amHelpPanel').is_visible()
        assert 'workspace' in page.locator('#amHelpPanel').inner_text()
        page.locator('#amBody').evaluate('(n)=>n.scrollTop=100')
        post(base)
        assert page.locator('#amHelpPanel').is_visible()
        assert page.locator('#amBody').evaluate('(n)=>n.scrollTop') == 100
        assert page.evaluate('__messages.length') == help_messages, 'help must not link or open a browser'
        page.keyboard.press('Escape')
        assert modal.is_visible() and page.locator('#amHelpPanel').is_hidden()
        assert page.locator('#amHelpButton').evaluate('(n)=>document.activeElement===n')
        first = page.locator('#amAccounts>.account-row').first
        first.locator('[data-account-options]').click()
        first.locator('[data-account-setting="warmupEnabled"]').check()
        request = page.evaluate('__messages.at(-1)')
        assert request['settings']['warmupEnabled'] is True
        post(base)
        assert first.locator('[data-account-setting="warmupEnabled"]').is_checked()
        result(request, 'Không lưu được cấu hình')
        assert not first.locator('[data-account-setting="warmupEnabled"]').is_checked()
        assert page.locator('#amNotice').inner_text() == 'Không lưu được cấu hình'
        assert first.locator('[data-account-options]').get_attribute('aria-expanded') == 'true'
        first.locator('[data-account-options]').click()

        # Opening a BAT row selects exactly that launcher, retained across polls.
        page.locator('#amLaunchers button').last.click()
        assert page.locator('#amLauncher').input_value() == 'bat26'
        assert page.locator('[data-account-action="import"]').inner_text() == 'Chọn tệp BAT…'
        assert page.locator('.account-link-method').count() == 2
        page.locator('[data-account-action="import"]').click()
        request = page.evaluate('__messages.at(-1)')
        result(request, launcher_id='bat25')
        assert page.locator('#amLauncher').input_value() == 'bat25'
        post(base)
        assert page.locator('#amLauncher').input_value() == 'bat25'
        post(base)
        assert page.locator('#amLauncher').input_value() == 'bat25'
        page.locator('#amLinkClose').click()

        page.locator('#amPolicyTab').click()
        policy = page.locator('#amPolicyPanel')
        delay = page.locator('[data-account-config="choiceSeconds"]')
        models = page.locator('[data-account-config="allowedModels"]')
        delay.fill('75')
        page.locator('[data-account-config="busyPolicy"]').select_option('ask')
        models.fill('model-a, model-b')
        models.evaluate('(n)=>{window.originalField=n;n.setSelectionRange(3,8)}')
        before_scroll = page.locator('#amBody').evaluate('(n)=>n.scrollTop')
        for i in range(12):
            base['accountManager']['accounts'][0]['quota']['checkedAt'] += 1000
            post(base)
        assert policy.is_visible(), 'background update collapsed policies'
        assert models.input_value() == 'model-a, model-b' and delay.input_value() == '75'
        assert models.evaluate('(n)=>n===originalField && document.activeElement===n && n.selectionStart===3 && n.selectionEnd===8')
        assert page.locator('#amBody').evaluate('(n)=>n.scrollTop') == before_scroll
        assert page.locator('[data-account-config="busyPolicy"]').input_value() == 'ask'
        models.press('Tab')
        assert page.evaluate('document.getElementById("accountManagerDialog").contains(document.activeElement)')

        # Close after #main changed: return focus to the new trigger, retain draft.
        page.keyboard.press('Escape')
        assert modal.is_hidden()
        assert page.evaluate('document.activeElement.matches(".auth-session-card [data-accounts-toggle]")')
        page.keyboard.press('Enter')
        assert policy.is_visible() and delay.input_value() == '75'
        # No save on plain Enter in a field; native range validation still applies.
        count = page.evaluate('__messages.length')
        delay.fill('3601'); delay.press('Enter')
        assert page.evaluate('__messages.length') == count
        page.locator('#amSave').click()
        assert page.evaluate('__messages.length') == count
        delay.fill('75')
        page.locator('#amSave').click()
        request = page.evaluate('__messages.at(-1)')
        assert request['settings']['busyPolicy'] == 'ask' and request['settings']['choiceSeconds'] == 75
        assert page.locator('#amSave').is_disabled()
        page.locator('#amSave').evaluate('(n)=>n.click()')
        assert page.evaluate('__messages.at(-1).requestId') == request['requestId']
        post(base)
        assert delay.input_value() == '75', 'stale settings replaced an in-flight save'
        result(request, 'Lưu thất bại')
        assert delay.input_value() == '75' and not page.locator('#amSave').is_disabled()
        assert page.locator('#amNotice').inner_text() == 'Lưu thất bại'
        page.locator('#amSave').click()
        request = page.evaluate('__messages.at(-1)')
        models.fill('model-a, model-b, new-draft')
        base['accountManager']['settings'] = deepcopy(request['settings'])
        result(request)
        assert models.input_value().endswith('new-draft')
        assert page.locator('#amSaveStatus').inner_text() == 'Có thay đổi chưa lưu'
        page.locator('#amSave').click()
        request = page.evaluate('__messages.at(-1)')
        base['accountManager']['settings'] = deepcopy(request['settings'])
        result(request)
        assert page.locator('#amSaveStatus').inner_text() == 'Đã lưu chính sách'
        assert page.locator('#amSave').is_disabled()
        post(base)
        assert policy.is_visible()

        # Both tabs keep their scroll positions; rows stay mounted on quota polls.
        page.locator('#amAccountsTab').click()
        page.locator('#amBody').evaluate('(n)=>n.scrollTop=450')
        page.locator('#amAccounts>.account-row').first.evaluate('(n)=>window.originalAccount=n')
        post(base)
        assert page.locator('#amBody').evaluate('(n)=>n.scrollTop') == 450
        assert page.evaluate('originalAccount===document.querySelector("#amAccounts>.account-row")')
        page.locator('#amPolicyTab').click(); page.locator('#amAccountsTab').click()
        assert page.locator('#amBody').evaluate('(n)=>n.scrollTop') == 450
        base['accountManager']['switchJob'] = {'id':'switch','phase':'choosing','target':'1','deadline':1800000000000}
        post(base)
        page.locator('#amTarget').select_option('2')
        post(base)
        assert page.locator('#amTarget').input_value() == '2'
        page.locator('#amSwitch [data-account-action="choose"]').click()
        request = page.evaluate('__messages.at(-1)')
        assert request['accountRef'] == '2' and request['id'] == 'switch'
        result(request)
        page.locator('#amSwitch [data-account-action="cancel"]').click()
        request = page.evaluate('__messages.at(-1)')
        assert request['action'] == 'cancel'
        base['accountManager']['switchJob'] = {'id':'switch','phase':'cancelled'}
        result(request)
        assert modal.is_visible() and page.locator('#amSwitch').is_hidden()
        base['accountManager']['recovery'] = {'automationPaused':True,'source':'defaults'}
        post(base)
        assert not page.locator('#amNotice').evaluate('(n)=>n.classList.contains("error")')
        page.locator('#amPolicyTab').click()
        assert page.locator('#amSave').is_enabled()
        page.locator('#amSave').click()
        request = page.evaluate('__messages.at(-1)')
        assert request['action'] == 'configure'
        base['accountManager']['recovery']['automationPaused'] = False
        result(request)
        assert page.locator('#amNotice').is_hidden()
        page.locator('#amAccountsTab').click()

        # Empty account vault still shows existing BAT identities without
        # pretending that descriptive browser metadata is verified Codex auth.
        empty = deepcopy(base)
        empty['accountManager']['accounts'] = []
        post(empty)
        assert page.locator('#amEmpty').is_visible()
        assert page.locator('#amLaunchers>.account-row').count() == 27
        assert page.locator('#amLaunchers [data-account-action="switch"]').count() == 0
        empty['accountManager']['launchers'] = []
        post(empty); page.locator('#amAdd').click()
        assert page.locator('[data-account-action="link"]').is_disabled()
        assert page.locator('[data-account-action="login"]').is_disabled()
        assert page.locator('#amLauncher').is_disabled()
        page.locator('#amLinkClose').click()

        # Long labels, narrow/short viewports, theme changes and keyboard tabs.
        small = deepcopy(base)
        small['accountManager']['accounts'] = small['accountManager']['accounts'][:3]
        small['accountManager']['launchers'] = small['accountManager']['launchers'][:4]
        small['accountManager']['accounts'][0]['email'] = 'long-address-'*12+'@example.test'
        post(small)
        for width, height in [(1100,840),(520,700),(320,480),(900,360)]:
            page.set_viewport_size({'width':width,'height':height})
            for which in ['accounts','policy']:
                page.locator('[data-account-tab="'+which+'"]').click()
                page.wait_for_timeout(50)
                box = modal.bounding_box()
                assert box['x'] >= 0 and box['y'] >= 0 and box['x']+box['width'] <= width+1 and box['y']+box['height'] <= height+1, (width,height,box)
                assert page.locator('#amBody').evaluate('(n)=>n.scrollWidth<=n.clientWidth+1'), (width,height,which)
                assert page.locator('#amDone').evaluate('(n)=>{const r=n.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight}')
                assert page.locator('#amClose').evaluate('(n)=>{const r=n.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight}')
            page.locator('#amHelpButton').click()
            assert page.locator('#amHelpPanel').is_visible(), (width,height,'help did not open')
            assert page.locator('#amBody').evaluate('(n)=>n.scrollWidth<=n.clientWidth+1')
            assert page.locator('#amHelpButton').is_visible()
            page.keyboard.press('Escape')
            page.wait_for_timeout(60)
            assert modal.is_visible() and page.locator('#amHelpPanel').is_hidden(), (width,height,'escape must close only help')
        page.locator('#amAccountsTab').focus(); page.keyboard.press('ArrowRight')
        assert policy.is_visible() and page.locator('#amPolicyTab').evaluate('(n)=>document.activeElement===n')
        page.keyboard.press('Home')
        assert page.locator('#amAccountsPanel').is_visible()
        page.locator('#amDone').click()
        assert page.locator('.chat').count() == 1000
        page.locator('.chat').first.evaluate('(n)=>window.firstRow=n')
        base['usage'] = {'display':{'valueText':'---'}}
        post(base)
        assert page.evaluate('firstRow===document.querySelector(".chat")')

        preview = os.environ.get('CST_UI_PREVIEW')
        if preview:
            small['accountManager']['accounts'][0]['email'] = 'work@example.test'
            post(small)
            page.set_viewport_size({'width':1100,'height':840})
            page.locator('.auth-session-card [data-accounts-toggle]').click()
            page.locator('#amAccountsTab').click()
            page.locator('#amBody').evaluate('(n)=>n.scrollTop=0')
            page.screenshot(path=str(Path(preview)/'accounts.png'))
            page.locator('#amPolicyTab').click()
            page.locator('#amBody').evaluate('(n)=>n.scrollTop=0')
            page.screenshot(path=str(Path(preview)/'policy.png'))
            page.add_style_tag(content=':root{--vscode-foreground:#222;--vscode-editor-background:#fff;--vscode-descriptionForeground:#666;--vscode-input-background:#fff;--vscode-input-foreground:#222;--vscode-panel-border:#d4d4d4;--vscode-button-secondaryBackground:#e8e8e8;--vscode-button-secondaryForeground:#222}')
            page.set_viewport_size({'width':320,'height':480})
            page.screenshot(path=str(Path(preview)/'policy-small-light.png'))
        assert not errors, errors
        print(json.dumps({'passed':True,'chatRows':1000,'accountRows':25,'backgroundUpdates':12,'draftFocusSelectionScrollPreserved':True,'saveErrorAndDuplicateGuard':True,'linkedAndDiscoveredAccounts':True,'viewports':4,'pageErrors':errors}))
    finally:
        browser.close()
