"""Headless Edge checks error actions; never connects to or resumes real chats."""
import json
import os
from pathlib import Path
from copy import deepcopy
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[2]
scratch = Path(os.environ['CST_UI_SCRATCH'])
assert scratch.is_dir() and 'AHUST-Work' in scratch.parts
profile = scratch / 'failure-recovery-edge'
profile.mkdir()
import sys
sys.path.insert(0,str(root/'test/fixtures'))
from webview import dashboard as build_dashboard
html=build_dashboard(root,include_shim=False)
shim = '<script nonce="ui-test">window.__messages=[];window.acquireVsCodeApi=()=>({getState:()=>({}),setState:()=>{},postMessage:m=>window.__messages.push(m)});</script>'
html = html.replace('<script nonce="ui-test">', shim + '<script nonce="ui-test">', 1)
error = {'threadId': 'failed-thread', 'turnId': 'failed-turn', 'phase': 'ready', 'category': 'context', 'confidence': 'correlated',
         'label': 'Vượt giới hạn context', 'guidance': 'Compact hoặc chuyển chat.', 'message': '<script>not chat content</script>',
         'connection': {'checkedAt': 1700000000000, 'online': True}}
chat = {'threadId': 'failed-thread', 'title': 'Fixture', 'state': 'Error', 'stateKind': 'error', 'timeline': [], 'activeNodes': []}
base = {'activeChats': [], 'nonRunningChats': [chat], 'showNonRunning': True, 'selectedThreadId': 'failed-thread', 'selected': chat,
        'gateway': {}, 'queue': {}, 'steer': {}, 'failureRecovery': {'autoResume': False, 'entries': {'failed-thread': error}}}
errors = []
with sync_playwright() as p:
    browser = p.chromium.launch_persistent_context(str(profile), channel='msedge', headless=True, downloads_path=str(scratch / 'downloads'))
    try:
        page = browser.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.set_content(html)
        page.add_style_tag(content=':root{--vscode-font-family:Arial;--vscode-foreground:#ddd;--vscode-panel-background:#202020;--vscode-editor-background:#202020;--vscode-descriptionForeground:#aaa}')
        post = lambda state: page.evaluate('(data)=>window.postMessage({type:"state",data},"*")', state)
        for width in [320, 520, 1000]:
            page.set_viewport_size({'width': width, 'height': 900})
            post(base)
            page.locator('.failure-panel').wait_for()
            assert page.locator('.failure-panel script').count() == 0
            assert page.locator('[data-failure-action="retry"]').count() == 0
            assert 'nghi vấn từ relay' in page.locator('.failure-panel').inner_text()
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
            page.locator('[data-failure-action="compact"]').click()
            assert page.evaluate('window.__messages.at(-1)') == {'command': 'failureAction', 'threadId': 'failed-thread', 'turnId': 'failed-turn', 'action': 'compact'}
            assert page.locator('[data-failure-action="compact"]').is_disabled()
        post(base)
        page.locator('[data-failure-auto]').check()
        assert page.evaluate('window.__messages.at(-1).enabled') is True
        for phase in ['working', 'unknown', 'awaiting_result']:
            state = deepcopy(base)
            state['failureRecovery']['entries']['failed-thread'].update(category='stream', phase=phase)
            post(state)
            page.wait_for_timeout(80)
            assert page.locator('[data-failure-action="retry"]').is_disabled()
        state = deepcopy(base)
        state['failureRecovery']['entries']['failed-thread'].update(category='proxy', phase='ready')
        post(state)
        page.locator('[data-failure-action="restart"]').wait_for()
        page.locator('[data-failure-action="diagnose"]').click()
        assert page.evaluate('window.__messages.at(-1).action') == 'diagnose'
        state['failureRecovery']['entries']['failed-thread']['phase'] = 'resolved'
        post(state)
        page.locator('.failure-panel').wait_for(state='hidden')
        assert errors == [], errors
        print(json.dumps({'passed': True, 'viewportCases': 3, 'scopedActions': True, 'unknownAckLocked': True, 'pageErrors': errors}))
    finally:
        browser.close()
