"""Sound switches and minimum visible running-chat layout in real Edge."""
import json
import os
from copy import deepcopy
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[2]
scratch = Path(os.environ['CST_UI_SCRATCH'])
assert scratch.is_dir() and 'AHUST-Work' in scratch.parts
profile = scratch / 'sounds-layout-edge'
profile.mkdir()
import sys
sys.path.insert(0,str(root/'test/fixtures'))
from webview import dashboard as build_dashboard
html=build_dashboard(root,include_shim=False)
shim = '<script nonce="ui-test">window.__messages=[];window.__ui={sidebarHeight:100};window.acquireVsCodeApi=()=>({getState:()=>window.__ui,setState:s=>window.__ui=s,postMessage:m=>window.__messages.push(m)});</script>'
html = html.replace('<script nonce="ui-test">', shim + '<script nonce="ui-test">', 1)
types = [{'id': key, 'label': label, 'group': group} for key, label, group in [
    ('chat_completed', 'Hoàn tất', 'Chat'), ('chat_failed', 'Dừng do lỗi', 'Chat'),
    ('approval_initial', 'Chờ duyệt', 'Chat'), ('input_initial', 'Chờ trả lời', 'Chat'),
    ('approval_reminder', 'Nhắc chờ duyệt', 'Nhắc chờ'), ('input_reminder', 'Nhắc chờ trả lời', 'Nhắc chờ'),
    ('retry_429', 'Lỗi 429', 'Lỗi riêng'), ('model_capacity', 'Model quá tải', 'Lỗi riêng'),
    ('quota_change', 'Quota thay đổi', 'Quota'), ('quota_large_change', 'Quota đổi mạnh', 'Quota')]]
settings = {'schemaVersion': 1, 'enabled': True, 'types': {item['id']: True for item in types}}
chat = lambda key: {'threadId': key, 'title': 'Tác vụ ' + key, 'stateKind': 'running', 'cwd': 'D:\\Project',
                    'runtime': {'contextWindowTokens': 828400, 'contextPercent': 57.8, 'model': 'gpt-6-astra', 'reasoning': 'high'}}
state = {'activeChats': [chat('one'), chat('two')], 'nonRunningChats': [], 'showNonRunning': False, 'gateway': {},
         'contextWatch': {'thresholdPercent': 85, 'entries': {'one': {'enabled': True, 'thresholdPercent': 85}}, 'readings': {}, 'busy': []},
         'sounds': {'settings': settings, 'types': types}, 'queue': {}, 'steer': {}, 'newChat': {'contextPreset': '600k'}}
theme = ':root{--vscode-font-family:Arial;--vscode-foreground:#ddd;--vscode-panel-background:#202020;--vscode-editor-background:#202020;--vscode-descriptionForeground:#aaa;--vscode-panel-border:#444;--vscode-focusBorder:#0078d4;--vscode-input-background:#333;--vscode-input-foreground:#eee;--vscode-sideBar-background:#252526}'
errors = []
with sync_playwright() as p:
    browser = p.chromium.launch_persistent_context(str(profile), channel='msedge', headless=True, downloads_path=str(scratch / 'downloads'))
    try:
        page = browser.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.set_viewport_size({'width': 1000, 'height': 800})
        page.set_content(html); page.add_style_tag(content=theme)
        post = lambda data: page.evaluate('(data)=>window.postMessage(data,"*")', data)
        last = lambda: page.evaluate('window.__messages.at(-1)')
        post({'type': 'state', 'data': state})
        page.locator('#soundSettingsButton').click()
        page.locator('#soundSettingsPanel').wait_for()
        page.evaluate('sidebarWidth=190;document.documentElement.style.setProperty("--sidebar-width","190px")')
        assert page.locator('.context-row').first.evaluate('(e)=>e.scrollWidth<=e.clientWidth+1'), 'context must fit minimum sidebar width'
        page.evaluate('sidebarWidth=300;document.documentElement.style.setProperty("--sidebar-width","300px")')
        assert page.locator('[data-sound-toggle]').count() == 10
        toggle = page.locator('[data-sound-toggle="chat_completed"]')
        toggle.uncheck(); request = last(); assert request['patch'] == {'types': {'chat_completed': False}}
        post({'type': 'state', 'data': state}); page.wait_for_timeout(70); assert not toggle.is_checked()
        toggle.check(); newer = last()
        old_settings = deepcopy(settings); old_settings['types']['chat_completed'] = False
        post({'type': 'soundSettingsSaved', 'requestId': request['requestId'], 'settings': old_settings})
        page.wait_for_timeout(30); assert toggle.is_checked(), 'late ACK must not undo the newer toggle'
        post({'type': 'soundSettingsSaved', 'requestId': newer['requestId'], 'settings': settings})
        page.locator('#soundAllOff').click(); request = last()
        muted = {'schemaVersion': 1, **request['patch']}
        post({'type': 'soundSettingsSaved', 'requestId': request['requestId'], 'settings': muted})
        assert page.locator('[data-sound-toggle]:checked').count() == 0
        assert not page.locator('#soundMaster').is_checked()
        assert page.locator('#soundSettingsButton').evaluate('(e)=>e.classList.contains("is-muted")')
        assert 'Đã tắt' in page.locator('#soundSettingsButton').get_attribute('aria-label')
        page.locator('[data-sound-preview="chat_failed"]').click(); request = last()
        assert request['command'] == 'previewSound' and request['soundType'] == 'chat_failed'
        assert page.locator('[data-sound-preview="chat_failed"]').is_disabled()
        post({'type': 'soundPreviewDone', 'requestId': request['requestId'], 'error': ''})
        page.wait_for_function('() => !document.querySelector("[data-sound-preview=chat_failed]").disabled')
        page.locator('#soundAllOn').click(); request = last()
        post({'type': 'soundSettingsSaved', 'requestId': request['requestId'], 'settings': settings})
        page.wait_for_function('() => document.querySelectorAll("[data-sound-toggle]:checked").length === 10')
        assert not page.locator('#soundSettingsButton').evaluate('(e)=>e.classList.contains("is-muted")')
        page.locator('#soundClose').click()
        # The compact ring replaces the old checkbox and capacity row.
        ring = page.locator('[data-context-watch="one"]')
        assert ring.evaluate('(e)=>e.tagName') == 'BUTTON'
        assert ring.get_attribute('aria-pressed') == 'true'
        assert ring.evaluate('(e)=>getComputedStyle(e).backgroundColor') == 'rgb(8, 120, 201)'
        assert abs(float(ring.locator('.progress').get_attribute('stroke-dashoffset')) - 42.2) < .001
        assert page.locator('[data-context-inline="one"]').inner_text() == '57.8% / 85% of 828,4K'
        assert page.locator('.chat [data-context-window]').count() == 0
        message_count = len(page.evaluate('window.__messages'))
        page.locator('[data-context-inline="one"]').click()
        row = page.locator('.chat[data-id="one"] .context-row')
        size = row.bounding_box()
        actions = row.locator('.chat-row-actions').bounding_box()
        row.click(position={'x': actions['x'] - size['x'] - 3, 'y': size['height'] / 2})
        assert len(page.evaluate('window.__messages')) == message_count, 'context text and row space must be inert'
        assert ring.get_attribute('aria-pressed') == 'true'
        ring.click(); assert last() == {'command': 'setContextWatch', 'threadId': 'one', 'enabled': False}
        ring.focus(); ring.press('Enter')
        assert last() == {'command': 'setContextWatch', 'threadId': 'one', 'enabled': True}
        assert len(page.evaluate('window.__messages')) == message_count + 2
        assert not any(m['command'] == 'selectChat' for m in page.evaluate('window.__messages'))
        def first_fits():
            page.wait_for_timeout(100)
            return page.locator('.chat').first.evaluate('(e)=>{const a=e.getBoundingClientRect(),s=e.closest(".sidebar").getBoundingClientRect();return a.top>=s.top-1&&a.bottom<=s.bottom+1}')
        for width, height in [(520, 850), (1000, 700), (320, 360), (1000, 240), (520, 700)]:
            page.set_viewport_size({'width': width, 'height': height})
            assert first_fits(), (width, height)
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
            if height >= 700:
                assert page.locator('.chat').last.evaluate('(e)=>e.getBoundingClientRect().bottom<=e.closest(".sidebar").getBoundingClientRect().bottom+1')
        taller = deepcopy(state); taller['activeChats'] = [chat(key) for key in ['one', 'two', 'three', 'four']]
        post({'type': 'state', 'data': taller}); page.wait_for_timeout(100)
        assert page.locator('#main').bounding_box()['height'] >= 160, 'auto-fit reserves room for detail'
        assert page.evaluate('sidebarHeight<=chatListHeightLimits().max'), 'overflow rows scroll within the list budget'
        # A double click resets a manually reduced list to all displayed chats.
        for width in [520, 320]:
            page.set_viewport_size({'width': width, 'height': 900})
            page.locator('#search').fill('')
            post({'type': 'state', 'data': taller}); page.wait_for_timeout(80)
            handle = page.locator('#sidebarResizer')
            assert handle.get_attribute('aria-label') == 'Resize chat list height'
            box = handle.bounding_box()
            page.mouse.move(box['x'] + box['width'] / 2, box['y'] + 4)
            page.mouse.down(); page.mouse.move(box['x'] + box['width'] / 2, box['y'] - 180); page.mouse.up()
            page.wait_for_timeout(60)
            reduced = page.locator('.sidebar').bounding_box()['height']
            handle.dblclick()
            page.wait_for_function('() => {const s=document.querySelector(".sidebar"),c=document.querySelector(".chat:last-child");return c.getBoundingClientRect().bottom<=s.getBoundingClientRect().bottom+1}')
            assert page.locator('.sidebar').bounding_box()['height'] > reduced + 30
            assert abs(page.evaluate('window.__ui.sidebarHeight') - page.locator('.sidebar').bounding_box()['height']) < 2
            # Fit exactly the filtered results, not hidden chats from the other tab.
            page.locator('#search').fill('one'); handle.dblclick(); page.wait_for_timeout(80)
            assert page.locator('.chat').count() == 1
            assert page.locator('.sidebar').evaluate('(s)=>Math.abs(s.getBoundingClientRect().bottom-document.querySelector(".chat").getBoundingClientRect().bottom)<18')
            page.locator('#search').fill('')
            long_list = deepcopy(state); long_list['activeChats'] = [chat(str(i)) for i in range(35)]
            post({'type': 'state', 'data': long_list}); page.wait_for_timeout(80)
            handle.dblclick(); page.wait_for_timeout(80)
            assert page.locator('#main').bounding_box()['height'] >= 160
            assert page.locator('.sidebar').bounding_box()['height'] < 891
            assert page.locator('.sidebar').evaluate('(s)=>s.scrollHeight>s.clientHeight')
            page.locator('.sidebar').evaluate('(s)=>s.scrollTop=s.scrollHeight')
            assert page.locator('.chat').last.evaluate('(e)=>e.getBoundingClientRect().bottom<=e.closest(".sidebar").getBoundingClientRect().bottom+1')
        page.locator('#search').fill('')
        post({'type': 'state', 'data': state})
        page.locator('#nonRunningTab').click()
        hidden_state = deepcopy(state); hidden_state['showNonRunning'] = True
        post({'type': 'state', 'data': hidden_state})
        page.locator('#search').fill('no match')
        post({'type': 'trackerShown'})
        assert first_fits()
        assert page.locator('#runningTab').get_attribute('aria-selected') == 'true'
        assert page.locator('#search').input_value() == ''
        if os.environ.get('CST_UI_PREVIEW'):
            page.set_viewport_size({'width': 1100, 'height': 850})
            post({'type': 'state', 'data': state}); page.wait_for_timeout(120)
            page.screenshot(path=str(scratch / 'sound-settings-layout.png'))
        assert errors == [], errors
        print(json.dumps({'passed': True, 'soundToggles': 10, 'lateAckSafe': True, 'preview': True,
                          'contextRing': True, 'oneLineContext': True, 'responsiveFirstChatVisible': True, 'revealRunningList': True, 'pageErrors': errors}))
    finally:
        browser.close()
