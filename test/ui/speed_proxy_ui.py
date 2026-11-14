"""Actual Edge: speed pickers, emphasis and proxy settings dialog."""
import json
import os
from copy import deepcopy
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[2]
scratch = Path(os.environ['CST_UI_SCRATCH'])
assert scratch.is_dir() and 'AHUST-Work' in scratch.parts
profile = scratch / 'speed-proxy-edge'
profile.mkdir()
import sys
sys.path.insert(0,str(root/'test/fixtures'))
from webview import dashboard as build_dashboard
html=build_dashboard(root,include_shim=False)
shim = '<script nonce="ui-test">window.__messages=[];window.acquireVsCodeApi=()=>({getState:()=>({}),setState:()=>{},postMessage:m=>window.__messages.push(m)});</script>'
html = html.replace('<script nonce="ui-test">', shim + '<script nonce="ui-test">', 1)
chat = {'threadId': 'source', 'title': 'Source', 'stateKind': 'running', 'runtime': {'model': 'gpt-6-astra', 'reasoning': 'ultra', 'serviceTier': 'ultrafast'}, 'timeline': [], 'activeNodes': []}
base = {'activeChats': [chat], 'nonRunningChats': [], 'selectedThreadId': 'source', 'selected': chat, 'contextWatch': {'entries': {}, 'readings': {}, 'busy': []},
        'newChat': {'serviceTier': 'priority'}, 'gateway': {}, 'queue': {}, 'steer': {}, 'localProxy': {'executablePath': 'C:/old.exe', 'watchdog': {'enabled': False, 'minutes': 5}}}
speeds = [{'value': value, 'label': label, 'available': True} for value, label in [('default', 'Standard'), ('priority', 'Fast'), ('ultrafast', 'Ultrafast')]]
options = {'cwd': 'D:/Project', 'folders': [{'name': 'Project', 'cwd': 'D:/Project'}], 'model': 'model', 'models': [{'id': 'model', 'label': 'Model'}, {'id': 'small', 'label': 'Small'}],
           'serviceTier': 'priority', 'speeds': speeds, 'preset': 'default', 'choices': [{'preset': 'default', 'label': 'Mặc định', 'detail': 'Dùng 258K', 'available': True}],
           'autoContext': {'enabled': False, 'scope': 'all', 'thresholdPercent': 80}, 'enabled': False, 'thresholdPercent': 80, 'handoffDelaySeconds': 0,
           'modes': {'normal': {'available': True}}, 'successorMode': 'normal', 'title': 'Source'}
errors = []
with sync_playwright() as p:
    browser = p.chromium.launch_persistent_context(str(profile), channel='msedge', headless=True, downloads_path=str(scratch / 'downloads'))
    try:
        for width in [1000, 520, 320]:
            page = browser.new_page(); page.set_viewport_size({'width': width, 'height': 900})
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.set_content(html)
            page.add_style_tag(content=':root{--vscode-font-family:Arial;--vscode-foreground:#ddd;--vscode-editor-background:#202020;--vscode-panel-background:#202020;--vscode-panel-border:#555;--vscode-descriptionForeground:#aaa;--vscode-input-background:#333;--vscode-input-foreground:#ddd}')
            post = lambda m: page.evaluate('(m)=>window.postMessage(m,"*")', m)
            last = lambda: page.evaluate('window.__messages.at(-1)')
            state = deepcopy(base); post({'type': 'state', 'data': state})
            page.locator('#newChat').wait_for()
            assert page.locator('.chat .runtime-badge.ultra').inner_text() == 'ULTRA'
            assert page.locator('.chat .runtime-badge.ultrafast').inner_text() == '⚡ ULTRAFAST'
            assert page.locator('.chat .model-emphasis').count() == 1
            page.locator('#newChat').click(); req = last()
            post({'type': 'newChatOptions', 'requestId': req['requestId'], **options})
            page.wait_for_function('() => !document.getElementById("ncSpeed").disabled')
            assert page.locator('#ncSpeed').input_value() == 'priority'
            page.locator('#ncSpeed').select_option('ultrafast'); req = last()
            assert req['command'] == 'saveNewChatSpeed' and req['serviceTier'] == 'ultrafast'
            post({'type': 'newChatSpeedSaved', 'requestId': req['requestId'], 'serviceTier': 'ultrafast'})
            page.wait_for_function('() => document.getElementById("ncSpeed").classList.contains("is-ultrafast")')
            page.locator('#ncPrompt').fill('Tạo tác vụ thử')
            page.locator('#ncSubmit').click(); sent = last()
            assert sent['command'] == 'submitNewChat' and sent['serviceTier'] == 'ultrafast'
            post({'type': 'newChatResult', 'requestId': sent['requestId'], 'success': True, 'threadId': 'fresh'})
            page.wait_for_function('() => !document.getElementById("newChatDialog").open')
            page.locator('#newChat').click(); req = last()
            unavailable = deepcopy(options); unavailable['serviceTier'] = 'ultrafast'; unavailable['speeds'][2]['available'] = False
            post({'type': 'newChatOptions', 'requestId': req['requestId'], **unavailable})
            page.wait_for_function('() => !document.getElementById("ncSpeed").disabled')
            page.locator('#ncPrompt').fill('Unchanged')
            assert page.locator('#ncSpeed').input_value() == 'ultrafast' and page.locator('#ncSubmit').is_disabled()
            assert 'chưa khả dụng' in page.locator('#ncSpeedStatus').inner_text()
            page.locator('#ncCancel').click()
            page.locator('#contextTransferNow').click(); req = last()
            post({'type': 'handoffOptions', 'threadId': 'source', 'requestId': req['requestId'], **options})
            page.wait_for_function('() => !document.getElementById("hfSubmit").disabled')
            assert page.locator('#hfSpeed').input_value() == 'priority'
            page.locator('#hfSpeed').select_option('ultrafast')
            assert page.locator('#hfSpeed').evaluate('(e)=>e.classList.contains("is-ultrafast")')
            page.locator('#hfCancel').click()
            page.locator('#contextTransferNow').click(); req = last()
            post({'type': 'handoffOptions', 'threadId': 'source', 'requestId': req['requestId'], **options})
            page.wait_for_function('() => !document.getElementById("hfSubmit").disabled')
            assert page.locator('#hfSpeed').input_value() == 'ultrafast'
            page.locator('#hfSubmit').click(); sent = last()
            assert sent['settings']['serviceTier'] == 'ultrafast'
            post({'type': 'handoffResult', 'threadId': 'source', 'requestId': sent['requestId'], 'success': True, 'nextThreadId': 'next'})
            page.wait_for_function('() => !document.getElementById("handoffDialog").open')
            count = len([m for m in page.evaluate('window.__messages') if m['command'] == 'restartLocalProxy'])
            page.locator('#restartLocalProxy').click(button='right'); req = last()
            assert req['command'] == 'loadProxyOptions'
            assert page.locator('#proxyOptionsDialog').is_visible()
            post({'type': 'proxyOptionsLoaded', 'requestId': req['requestId'], 'settings': {'enabled': False, 'minutes': 5, 'executablePath': 'C:/old.exe'}})
            page.wait_for_function('() => !document.getElementById("poSave").disabled')
            page.locator('#poEnabled').check(); page.locator('#poMinutes').fill('8')
            page.locator('#poBrowse').click(); req = last(); assert req['command'] == 'browseProxyOptions'
            post({'type': 'proxyOptionsBrowsed', 'requestId': req['requestId'], 'executablePath': 'C:/Proxy tiếng Việt/proxy.exe'})
            page.wait_for_function('() => !document.getElementById("poSave").disabled')
            post({'type': 'state', 'data': state}); page.wait_for_timeout(40)
            assert page.locator('#poMinutes').input_value() == '8'
            before = len(page.evaluate('window.__messages'))
            page.locator('#poMinutes').fill('0'); page.locator('#poSave').click(); assert len(page.evaluate('window.__messages')) == before
            page.locator('#poMinutes').fill('8'); page.locator('#poSave').click(); sent = last()
            assert sent['settings'] == {'enabled': True, 'minutes': 8, 'executablePath': 'C:/Proxy tiếng Việt/proxy.exe'}
            assert page.locator('#poSave').is_disabled(); page.evaluate('document.getElementById("poSave").click()'); assert last() == sent
            post({'type': 'proxyOptionsSaved', 'requestId': sent['requestId'], 'settings': sent['settings']})
            page.wait_for_function('() => document.getElementById("poStatus").textContent==="Đã lưu."')
            assert page.locator('#proxyOptionsDialog').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
            page.locator('#poCancel').click()
            assert len([m for m in page.evaluate('window.__messages') if m['command'] == 'restartLocalProxy']) == count
            page.close()
        assert errors == [], errors
        print(json.dumps({'passed': True, 'widths': [1000, 520, 320], 'speedSelections': True, 'unavailableBlocked': True,
                          'ultraEmphasis': True, 'proxyModal': True, 'noUnrequestedRestart': True, 'pageErrors': errors}))
    finally:
        browser.close()
