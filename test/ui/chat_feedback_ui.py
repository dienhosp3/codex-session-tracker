"""Exercise chat-options copy, transient delete failures and selected-header priority in Edge."""
import json
import os
from copy import deepcopy
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[2]
scratch = Path(os.environ['CST_UI_SCRATCH'])
assert scratch.is_dir() and 'AHUST-Work' in scratch.parts
profile = scratch / 'chat-feedback-edge'
profile.mkdir()
import sys
sys.path.insert(0,str(root/'test/fixtures'))
from webview import dashboard as build_dashboard
html=build_dashboard(root,include_shim=False)
shim = '<script nonce="ui-test">window.__messages=[];window.__ui={};window.acquireVsCodeApi=()=>({getState:()=>window.__ui,setState:s=>window.__ui=s,postMessage:m=>window.__messages.push(m)});</script>'
html = html.replace('<script nonce="ui-test">', shim + '<script nonce="ui-test">', 1)
theme = ':root{--vscode-font-family:Arial;--vscode-foreground:#ddd;--vscode-panel-background:#202020;--vscode-editor-background:#202020;--vscode-sideBar-background:#252526;--vscode-descriptionForeground:#aaa;--vscode-panel-border:#555;--vscode-input-background:#333;--vscode-input-foreground:#ddd;--vscode-focusBorder:#3794ff;--vscode-errorForeground:#ff6655}'
chat = {'threadId': 'selected', 'title': 'Tại sao codex session tracker không bắt được phần cần input?', 'state': 'Completed', 'stateKind': 'completed',
        'cwd': 'D:/VSCODE TEMP FOLDER', 'timeline': [], 'activeNodes': [],
        'runtime': {'model': 'gpt-6-astra', 'reasoning': 'ultra', 'serviceTier': 'ultrafast', 'contextWindowTokens': 828400, 'contextPercent': 10}}
base = {'activeChats': [], 'nonRunningChats': [{**chat, 'threadId': str(i)} for i in range(30)], 'showNonRunning': True,
        'selectedThreadId': 'selected', 'selected': chat, 'gateway': {}, 'queue': {}, 'steer': {},
        'contextWatch': {'entries': {}, 'readings': {}, 'busy': []}, 'usage': {'context': chat['runtime']},
        'authSession': {'accountLabel': 'tracker-test@example.invalid', 'canDeactivate': True}}
errors = []
with sync_playwright() as p:
    browser = p.chromium.launch_persistent_context(str(profile), channel='msedge', headless=True, downloads_path=str(scratch / 'downloads'))
    try:
        page = browser.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.set_viewport_size({'width': 520, 'height': 720})
        page.set_content(html); page.add_style_tag(content=theme)
        post = lambda data: page.evaluate('(data)=>window.postMessage(data,"*")', data)
        last = lambda: page.evaluate('window.__messages.at(-1)')
        post({'type': 'state', 'data': base})
        page.locator('[data-chat-options="0"]').click()
        assert last()['command'] == 'loadChatOptions'
        # Copy is independent of loading/saving settings, and targets the row, not selected chat.
        page.locator('#coCopyDeeplink').click(); request = last()
        assert request['command'] == 'copyChatDeeplink' and request['threadId'] == '0'
        assert page.locator('#coCopyDeeplink').is_disabled()
        post({'type': 'chatDeeplinkCopied', 'threadId': '0', 'requestId': 'stale', 'error': ''})
        page.wait_for_timeout(40); assert page.locator('#coCopyDeeplink').is_disabled()
        post({'type': 'chatDeeplinkCopied', 'threadId': '0', 'requestId': request['requestId'], 'error': ''})
        page.wait_for_function('() => document.getElementById("coCopyStatus").textContent === "Đã copy deeplink."')
        page.locator('#coCopyDeeplink').click(); request = last()
        post({'type': 'chatDeeplinkCopied', 'threadId': '0', 'requestId': request['requestId'], 'error': 'Clipboard busy'})
        page.wait_for_function('() => document.getElementById("coCopyStatus").textContent.includes("Clipboard busy")')
        page.locator('#coCancel').click()
        assert not any(m['command'] in ['selectChat', 'saveChatOptions'] for m in page.evaluate('window.__messages'))

        for width, height in [(520, 720), (320, 480), (520, 360), (320, 240), (1000, 720)]:
            page.set_viewport_size({'width': width, 'height': height})
            post({'type': 'state', 'data': base}); page.wait_for_timeout(120)
            if width <= 700:
                page.locator('#sidebarResizer').dblclick(); page.wait_for_timeout(80)
            head = page.locator('.head').bounding_box()
            detail = page.locator('#main').bounding_box()
            assert head['y'] >= detail['y'] - 1 and head['y'] + head['height'] <= height, (width, height, head, detail)
            assert page.locator('.sidebar').evaluate('(s)=>s.scrollHeight>s.clientHeight')
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
            if height >= 480:
                card = page.locator('.auth-session-card').bounding_box()
                assert card['y'] + card['height'] <= height + 1
            if width <= 700:
                handle = page.locator('#sidebarResizer')
                handle.focus(); handle.press('End'); page.wait_for_timeout(50)
                assert page.locator('.head').evaluate('(e)=>e.getBoundingClientRect().bottom<=innerHeight'), 'manual expansion still respects the selected header'

        # Plenty of height: every row fits without hiding the selected header.
        page.set_viewport_size({'width': 520, 'height': 1000})
        short = deepcopy(base); short['nonRunningChats'] = short['nonRunningChats'][:2]
        post({'type': 'state', 'data': short}); page.wait_for_timeout(100)
        page.locator('#sidebarResizer').dblclick(); page.wait_for_timeout(80)
        assert page.locator('.chat').last.evaluate('(e)=>e.getBoundingClientRect().bottom<=e.closest(".sidebar").getBoundingClientRect().bottom+1')
        assert page.locator('.auth-session-card').evaluate('(e)=>e.getBoundingClientRect().bottom<=innerHeight')

        # The failure is visible even after scrolling to the bottom of a long list.
        page.set_viewport_size({'width': 520, 'height': 720})
        post({'type': 'state', 'data': base}); page.wait_for_timeout(80)
        page.locator('.sidebar').evaluate('(s)=>s.scrollTop=s.scrollHeight')
        page.locator('[data-delete="29"]').click(); assert last() == {'command': 'deleteChat', 'threadId': '29'}
        failed = deepcopy(base)
        failed['deleteChat'] = {'busy': False, 'notice': {'kind': 'error', 'threadId': '29', 'at': 1234, 'text': 'Không xoá được cuộc trò chuyện: Chat đang chạy. <script>literal</script>'}}
        post({'type': 'state', 'data': failed})
        toast = page.locator('#chatListToast'); toast.wait_for(state='visible')
        box = toast.bounding_box(); sidebar = page.locator('.sidebar').bounding_box()
        assert sidebar['x'] <= box['x'] and box['x'] + box['width'] <= sidebar['x'] + sidebar['width']
        assert sidebar['y'] <= box['y'] and box['y'] + box['height'] <= sidebar['y'] + sidebar['height']
        assert toast.locator('script').count() == 0 and '<script>literal</script>' in toast.inner_text()
        assert page.locator('.chat').count() == 30
        if os.environ.get('CST_UI_PREVIEW'):
            page.screenshot(path=str(scratch / 'chat-feedback.png'))
        # Periodic state refreshes must not restart the timeout or resurrect a dismissed error.
        for _ in range(7):
            page.wait_for_timeout(1000); post({'type': 'state', 'data': failed})
        assert not toast.is_visible()
        post({'type': 'state', 'data': failed}); page.wait_for_timeout(80); assert not toast.is_visible()
        failed['deleteChat']['notice']['at'] += 1
        post({'type': 'state', 'data': failed}); toast.wait_for(state='visible')
        toast.locator('button').click(); assert not toast.is_visible()
        assert errors == [], errors
        print(json.dumps({'passed': True, 'deeplinkCorrectRowAndAck': True, 'deleteFailureExpiresWithoutReplay': True,
                          'selectedHeaderPriority': True, 'viewportCases': 6, 'pageErrors': errors}))
    finally:
        browser.close()
