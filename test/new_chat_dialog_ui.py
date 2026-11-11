"""Real Edge modal interactions; run only under the ACL-verified UI runner."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
scratch = Path(os.environ['CST_UI_SCRATCH'])
assert scratch.is_dir() and 'AHUST-Work' in scratch.parts
profile = scratch / 'new-chat-edge'
profile.mkdir()
html = (root / 'dashboard.html').read_text(encoding='utf-8').replace('__NONCE__', 'ui-test')
html = html.replace('__NEW_CHAT_DIALOG_HTML__', (root / 'media/new_chat_dialog.html').read_text(encoding='utf-8'))
html = html.replace('/*__NEW_CHAT_DIALOG_JS__*/', (root / 'media/new_chat_dialog.js').read_text(encoding='utf-8'))
html = html.replace('/*__SOUND_SETTINGS_CSS__*/', (root / 'media/sound_settings.css').read_text(encoding='utf-8'))
html = html.replace('/*__SOUND_SETTINGS_JS__*/', (root / 'media/sound_settings.js').read_text(encoding='utf-8'))
html = html.replace('/*__CHAT_LIST_LAYOUT_JS__*/', (root / 'media/chat_list_layout.js').read_text(encoding='utf-8'))
html = html.replace('__HANDOFF_DIALOG_HTML__', (root / 'media/handoff_dialog.html').read_text(encoding='utf-8'))
html = html.replace('/*__HANDOFF_DIALOG_JS__*/', (root / 'media/handoff_dialog.js').read_text(encoding='utf-8'))
html = html.replace('__CHAT_OPTIONS_HTML__', (root / 'media/chat_options.html').read_text(encoding='utf-8'))
html = html.replace('/*__CHAT_OPTIONS_JS__*/', (root / 'media/chat_options.js').read_text(encoding='utf-8'))
html = html.replace('__PROXY_OPTIONS_HTML__', (root / 'media/proxy_options.html').read_text(encoding='utf-8'))
html = html.replace('/*__PROXY_OPTIONS_JS__*/', (root / 'media/proxy_options.js').read_text(encoding='utf-8'))
shim = '<script nonce="ui-test">window.__messages=[];window.acquireVsCodeApi=()=>({getState:()=>({}),setState:()=>{},postMessage:m=>window.__messages.push(m)});</script>'
html = html.replace('<script nonce="ui-test">', shim + '<script nonce="ui-test">', 1)
theme = ':root{--vscode-font-family:Arial;--vscode-foreground:#ddd;--vscode-panel-background:#292a23;--vscode-editor-background:#292a23;--vscode-descriptionForeground:#aaa;--vscode-panel-border:#55574b;--vscode-focusBorder:#bebba1;--vscode-input-background:#454738;--vscode-input-foreground:#eee;--vscode-sideBar-background:#33342b;--vscode-list-inactiveSelectionBackground:#454738;--vscode-button-background:#454738}'
choices = [
    {'preset': 'default', 'label': 'Mặc định', 'capacity': '272K', 'detail': 'Dùng 258,4K', 'available': True},
    {'preset': '400k', 'label': '400K', 'detail': 'Dùng 380K', 'available': True},
    {'preset': '600k', 'label': '600K', 'detail': 'Dùng 570K', 'available': True},
    {'preset': '900k', 'label': '900K', 'detail': 'Dùng 828,4K', 'note': 'Trần 872K', 'available': True},
]
errors = []
with sync_playwright() as p:
    browser = p.chromium.launch_persistent_context(str(profile), channel='msedge', headless=True, downloads_path=str(scratch / 'downloads'))
    try:
        for width, height in [(1000, 900), (520, 740), (320, 568)]:
            page = browser.new_page()
            page.set_viewport_size({'width': width, 'height': height})
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.set_content(html)
            page.add_style_tag(content=theme)
            state = {'activeChats': [], 'nonRunningChats': [], 'gateway': {}, 'newChat': {'contextPreset': '600k', 'autoContext': {'enabled': True, 'scope': 'tracker', 'thresholdPercent': 85}}, 'contextWatch': {'entries': {}}}
            def post(data):
                page.evaluate('(data)=>window.postMessage(data,"*")', data)
            def last():
                return page.evaluate('window.__messages.at(-1)')
            def options(request=None, **changes):
                data = {'type': 'newChatOptions', 'requestId': (request or last())['requestId'], 'cwd': 'D:\\Project',
                        'folders': [{'cwd': 'D:\\Project', 'name': 'Project'}], 'preset': '600k', 'model': 'gpt-6-astra', 'choices': choices,
                        'models': [{'id': 'gpt-6-astra', 'label': 'GPT-6-Astra'}, {'id': 'gpt-6.1-sol', 'label': 'GPT-6.1 Sol'}],
                        'autoContext': {'enabled': False, 'scope': 'all', 'thresholdPercent': 80}}
                data.update(changes)
                post(data)
                page.wait_for_function('() => !document.getElementById("ncForm").getAttribute("aria-busy").includes("true")')
            post({'type': 'state', 'data': state})
            assert page.locator('#newChat').evaluate('(e)=>getComputedStyle(e).backgroundColor') == 'rgb(8, 120, 201)'
            if os.environ.get('CST_UI_PREVIEW') and width == 520:
                page.locator('.sidebar').screenshot(path=str(scratch / 'new-chat-button.png'))
            page.locator('#newChat').click()
            assert page.locator('#newChatDialog').is_visible()
            assert page.locator('#ncSubmit').is_disabled()
            post({'type': 'newChatOptions', 'requestId': last()['requestId'], 'error': 'Codex chưa kết nối'})
            page.locator('#ncRetry').wait_for()
            assert page.locator('#ncAutoEnabled').is_checked(), 'saved rule is still shown when model loading fails'
            assert page.locator('#ncAutoThreshold').input_value() == '85'
            page.locator('#ncRetry').click()
            options()
            assert page.locator('#ncAutoScope option').count() == 3
            page.locator('#ncAutoEnabled').check()
            auto_request = last(); assert auto_request['command'] == 'saveNewChatAutoContext'
            assert page.locator('#ncSubmit').is_disabled()
            post({'type': 'newChatAutoContextSaved', 'requestId': auto_request['requestId'], 'autoContext': auto_request['settings']})
            page.locator('#ncAutoThreshold').fill('85')
            auto_request = last(); assert auto_request['settings']['thresholdPercent'] == 85
            post({'type': 'newChatAutoContextSaved', 'requestId': auto_request['requestId'], 'autoContext': auto_request['settings']})
            page.locator('#ncAutoScope').select_option('tracker')
            auto_request = last(); assert auto_request['settings']['scope'] == 'tracker'
            post({'type': 'newChatAutoContextSaved', 'requestId': auto_request['requestId'], 'autoContext': auto_request['settings']})
            page.locator('#ncBrowse').click()
            assert last()['command'] == 'browseNewChatWorkspace'
            post({'type': 'newChatOptions', 'requestId': last()['requestId'], 'cancelled': True})
            page.wait_for_function('() => !document.getElementById("ncBrowse").disabled')
            assert page.locator('#ncWorkspace').input_value() == 'D:\\Project'
            page.locator('#ncBrowse').click()
            options(cwd='D:\\Another project')
            assert page.locator('#ncPath').inner_text() == 'D:\\Another project'
            page.locator('#ncWorkspace').select_option('D:\\Project')
            options()
            assert page.locator('input[name="newChatContext"]:checked').input_value() == '600k'
            assert page.locator('#ncPresets').inner_text().count('K') >= 4
            prompt = page.locator('#ncPrompt')
            prompt.fill('Sửa giao diện cho đẹp.\nGiữ nguyên dữ liệu đang có.')
            prompt.press('Enter')
            assert len([m for m in page.evaluate('window.__messages') if m['command'] == 'submitNewChat']) == 0
            before = prompt.input_value()
            post({'type': 'state', 'data': state})
            page.wait_for_timeout(50)
            assert prompt.input_value() == before
            page.locator('#ncModelSelect').select_option('gpt-6.1-sol')
            model_request = last()
            assert model_request['model'] == 'gpt-6.1-sol'
            changed_choices = [dict(item) for item in choices]
            changed_choices[0].update({'capacity': '500K', 'detail': 'Dùng 475K'})
            options(model_request, model='gpt-6.1-sol', choices=changed_choices)
            assert '500K' in page.locator('#ncPresets').inner_text()
            assert prompt.input_value() == before
            page.locator('input[value="900k"]').check()
            save = last()
            assert save['command'] == 'saveNewChatPreset' and save['preset'] == '900k'
            post({'type': 'newChatPresetSaved', 'requestId': save['requestId'], 'preset': '900k'})
            page.wait_for_function('() => document.getElementById("ncPreference").textContent.startsWith("Đã nhớ")')
            selected = page.locator('.nc-choice:has(input:checked)')
            assert selected.evaluate('(e)=>getComputedStyle(e).backgroundColor') == 'rgb(6, 76, 120)'
            assert selected.evaluate('(e)=>getComputedStyle(e).borderTopColor') == 'rgb(57, 216, 255)'
            assert selected.locator('.nc-selected-mark').is_visible()
            assert selected.locator('small').count() == 1
            assert page.locator('.nc-choice:not(:has(input:checked)) .nc-selected-mark:visible').count() == 0
            # Native modal traps keyboard focus and fits a narrow panel.
            for _ in range(14):
                page.keyboard.press('Tab')
                assert page.evaluate('document.getElementById("newChatDialog").contains(document.activeElement)')
            assert page.locator('#newChatDialog').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
            box = page.locator('#newChatDialog').bounding_box()
            assert box['x'] >= 0 and box['y'] >= 0 and box['width'] <= width and box['height'] <= height
            # Optional preview is kept only in owned scratch until inspected.
            if os.environ.get('CST_UI_PREVIEW') and width == 520:
                page.set_viewport_size({'width': 520, 'height': 950})
                page.locator('#ncAutoEnabled').check()
                rule_request = last()
                if rule_request['command'] == 'saveNewChatAutoContext':
                    post({'type': 'newChatAutoContextSaved', 'requestId': rule_request['requestId'], 'autoContext': rule_request['settings']})
                page.locator('#ncAutoThreshold').fill('85')
                rule_request = last()
                post({'type': 'newChatAutoContextSaved', 'requestId': rule_request['requestId'], 'autoContext': rule_request['settings']})
                page.locator('.nc-body').evaluate('(e)=>e.scrollTop=0')
                page.screenshot(path=str(scratch / 'new-chat-dialog.png'))
            prompt.focus()
            prompt.press('Control+Enter')
            sent = last()
            assert sent['command'] == 'submitNewChat' and sent['preset'] == '900k'
            assert sent['model'] == 'gpt-6.1-sol'
            assert sent['message'] == before and sent['cwd'] == 'D:\\Project'
            page.keyboard.press('Control+Enter')
            assert len([m for m in page.evaluate('window.__messages') if m['command'] == 'submitNewChat']) == 1
            page.keyboard.press('Escape')
            assert page.locator('#newChatDialog').is_visible(), 'cannot dismiss an in-flight creation'
            post({'type': 'newChatResult', 'requestId': sent['requestId'], 'delivery': 'not_sent', 'error': 'Thư mục không còn tồn tại'})
            page.wait_for_function('() => !document.getElementById("ncPrompt").disabled')
            assert prompt.input_value() == before and page.locator('#ncStatus').is_visible()
            prompt.press('Control+Enter')
            retry = last()
            post({'type': 'newChatResult', 'requestId': retry['requestId'], 'threadId': 'fresh', 'delivery': 'created', 'error': 'Không mở được sidebar'})
            page.locator('#ncOpenCreated').wait_for()
            assert page.locator('#ncSubmit').is_disabled()
            page.locator('#ncOpenCreated').click()
            assert last() == {'command': 'openCreatedChat', 'requestId': retry['requestId']}
            page.locator('#ncStartOver').click()
            options()
            assert prompt.input_value() == ''
            prompt.fill('Tác vụ mới khác')
            page.locator('#ncSubmit').click()
            sent = last()
            post({'type': 'newChatResult', 'requestId': sent['requestId'], 'success': True, 'threadId': 'fresh-two'})
            page.wait_for_function('() => !document.getElementById("newChatDialog").open')
            page.locator('#newChatSettings').click()
            options(preset='900k')
            assert page.locator('#ncTitle').inner_text() == 'Cài đặt chat mới'
            assert not page.locator('#ncPromptField').is_visible()
            page.locator('#ncSubmit').click()
            page.locator('#newChat').click()
            stale = last()
            page.locator('#ncCancel').click()
            page.locator('#newChat').click()
            current = last()
            post({'type': 'newChatOptions', 'requestId': stale['requestId'], 'error': 'Stale response'})
            options(current)
            assert 'Stale response' not in page.locator('#ncStatus').inner_text()
            prompt.fill('Bản nháp giữ lại')
            page.keyboard.press('Escape')
            page.locator('#newChat').click()
            options()
            assert prompt.input_value() == 'Bản nháp giữ lại'
            page.close()
        assert errors == [], errors
        print(json.dumps({'passed': True, 'dialog': True, 'widths': [1000, 520, 320], 'unicode': True, 'multiline': True, 'focusTrap': True, 'pollingPreservesDraft': True, 'duplicateGuard': True, 'inlineErrors': True, 'recovery': True, 'pageErrors': errors}))
    finally:
        browser.close()
