"""Actual Edge interaction with the handoff dialog and compact Tracker controls."""
import json
import os
from copy import deepcopy
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
scratch = Path(os.environ['CST_UI_SCRATCH'])
assert scratch.is_dir() and 'AHUST-Work' in scratch.parts
profile = scratch / 'handoff-edge'
profile.mkdir()
html = (root / 'dashboard.html').read_text(encoding='utf-8').replace('__NONCE__', 'ui-test')
for marker, filename in [('__NEW_CHAT_DIALOG_HTML__', 'media/new_chat_dialog.html'), ('/*__NEW_CHAT_DIALOG_JS__*/', 'media/new_chat_dialog.js'),
                         ('__HANDOFF_DIALOG_HTML__', 'media/handoff_dialog.html'), ('/*__HANDOFF_DIALOG_JS__*/', 'media/handoff_dialog.js'),
                         ('/*__SOUND_SETTINGS_CSS__*/', 'media/sound_settings.css'), ('/*__SOUND_SETTINGS_JS__*/', 'media/sound_settings.js'),
                         ('/*__CHAT_LIST_LAYOUT_JS__*/', 'media/chat_list_layout.js')]:
    html = html.replace(marker, (root / filename).read_text(encoding='utf-8'))
html = html.replace('__CHAT_OPTIONS_HTML__', (root / 'media/chat_options.html').read_text(encoding='utf-8'))
html = html.replace('/*__CHAT_OPTIONS_JS__*/', (root / 'media/chat_options.js').read_text(encoding='utf-8'))
html = html.replace('__PROXY_OPTIONS_HTML__', (root / 'media/proxy_options.html').read_text(encoding='utf-8'))
html = html.replace('/*__PROXY_OPTIONS_JS__*/', (root / 'media/proxy_options.js').read_text(encoding='utf-8'))
shim = '<script nonce="ui-test">window.__messages=[];window.acquireVsCodeApi=()=>({getState:()=>({}),setState:()=>{},postMessage:m=>window.__messages.push(m)});</script>'
html = html.replace('<script nonce="ui-test">', shim + '<script nonce="ui-test">', 1)
theme = ':root{--vscode-font-family:Arial;--vscode-foreground:#ddd;--vscode-panel-background:#202020;--vscode-editor-background:#202020;--vscode-descriptionForeground:#aaa;--vscode-panel-border:#444;--vscode-focusBorder:#0078d4;--vscode-input-background:#333;--vscode-input-foreground:#eee;--vscode-sideBar-background:#252526;--vscode-testing-iconPassed:#55bb66;--vscode-disabledForeground:#888}'
chat = {'threadId': 'old', 'title': '[TASK-0001] Nội dung', 'stateKind': 'completed', 'runtime': {'contextWindowTokens': 828400, 'contextPercent': 14.2, 'speedTokensPerSecond': 18.49}, 'timeline': [], 'activeNodes': []}
base = {'activeChats': [{'threadId': 'running', 'title': 'Running', 'stateKind': 'running'}], 'nonRunningChats': [chat], 'showNonRunning': True,
        'selectedThreadId': 'old', 'selected': chat, 'contextWatch': {'entries': {}, 'readings': {}, 'busy': [], 'thresholdPercent': 80},
        'gateway': {}, 'usage': {'context': chat['runtime']}, 'queue': {}, 'steer': {},
        'sounds': {'types': [{'id': 'chat_completed', 'label': 'Hoàn tất', 'group': 'Chat'}], 'settings': {'enabled': True, 'types': {'chat_completed': True}}}}
options = {'title': chat['title'], 'cwd': 'D:\\Project', 'model': 'source', 'models': [{'id': 'source', 'label': 'Source'}, {'id': 'other', 'label': 'Other'}],
           'modes': {mode: {'available': True} for mode in ['normal', 'goal', 'plan']}, 'successorMode': 'normal',
           'goalText': '',
           'preset': 'default', 'enabled': False, 'thresholdPercent': 80, 'handoffDelaySeconds': 10, 'series': {'code': 'TASK', 'nextNumber': '0002'},
           'choices': [{'preset': preset, 'label': label, 'detail': 'Dùng 570K', 'available': True} for preset, label in [('default', 'Mặc định · 272K'), ('400k', '400K'), ('600k', '600K'), ('900k', '900K')]]}
errors = []
with sync_playwright() as p:
    browser = p.chromium.launch_persistent_context(str(profile), channel='msedge', headless=True, downloads_path=str(scratch / 'downloads'))
    try:
        for width in [1000, 520, 320]:
            page = browser.new_page()
            page.set_viewport_size({'width': width, 'height': 900})
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.set_content(html); page.add_style_tag(content=theme)
            post = lambda m: page.evaluate('(m)=>window.postMessage(m,"*")', m)
            last = lambda: page.evaluate('window.__messages.at(-1)')
            state = deepcopy(base)
            post({'type': 'state', 'data': state})
            page.locator('#contextTransferNow').wait_for()
            assert page.locator('[data-account-context]').inner_text() == 'Context 14% of 828K'
            assert 'tok/s' not in page.locator('body').inner_text()
            for text in ['Chuyển chủ động bất cứ lúc nào', 'Nhập ID và số.', '1–10 chữ/số', 'Tự động.', 'Dừng thủ công: im lặng. Tự lưu.', 'Tự dừng và tiếp tục ở chat mới']:
                assert text not in page.locator('body').inner_text(), text
            assert page.locator('#chatOptionsCurrent').inner_text() == '⚙ Tuỳ chọn chat'
            assert page.locator('#contextWatchEnabled').count() == 0
            row = page.locator('.chat-tabs-row')
            assert row.locator('#soundSettingsButton').count() == 1
            assert abs(page.locator('#soundSettingsButton').bounding_box()['y'] - page.locator('#runningTab').bounding_box()['y']) < 2
            assert row.evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
            assert page.locator('.chat-stopped .dot').evaluate('(e)=>getComputedStyle(e).backgroundColor') == 'rgb(136, 136, 136)'
            assert page.locator('.titleline [data-chat-options],.titleline [data-delete]').count() == 0
            assert page.locator('.context-row .chat-row-actions button').count() == 2
            assert page.locator('.chat-row-actions').evaluate('(e)=>Math.abs(e.getBoundingClientRect().right-e.parentElement.getBoundingClientRect().right)<2')
            assert page.locator('.context-row').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
            state['attention'] = {'old': {'title': chat['title'], 'flags': ['waitingOnPlanImplementation']}}
            post({'type': 'state', 'data': state})
            page.locator('.chat .attention-badge.plan').wait_for()
            assert page.locator('.chat .attention-badge.plan').inner_text() == 'Đã lập xong kế hoạch. Có triển khai luôn không?'
            state['attention'] = {}; post({'type': 'state', 'data': state})
            # Regaining focus after the delete dialog must keep the stopped tab.
            page.locator('[data-delete="old"]').click(); assert last()['command'] == 'deleteChat'
            page.evaluate('window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange"))')
            assert page.locator('#nonRunningTab').get_attribute('aria-selected') == 'true'
            page.locator('#soundSettingsButton').click(); assert page.locator('#soundSettingsDialog').is_visible()
            page.locator('#soundClose').click(); assert not page.locator('#soundSettingsDialog').is_visible()
            page.locator('#contextTransferNow').click(); request = last()
            assert request['command'] == 'loadHandoffOptions' and request['threadId'] == 'old'
            post({'type': 'handoffOptions', 'requestId': request['requestId'], 'threadId': 'old', **options})
            page.wait_for_function('() => !document.getElementById("hfSubmit").disabled')
            assert page.locator('#hfModel').input_value() == 'source'
            assert page.locator('#hfMode').input_value() == 'normal'
            assert 'hoặc Codex bắt đầu tự compact' in page.locator('.hf-auto').get_attribute('title')
            assert not page.locator('#hfGoalField').is_visible()
            page.locator('#hfMode').select_option('goal')
            assert page.locator('#hfGoal').input_value() == options['goalText']
            before_goal = len(page.evaluate('window.__messages'))
            page.locator('#hfSubmit').click()
            assert len(page.evaluate('window.__messages')) == before_goal
            goal = 'Hoàn thành bản sửa Tracker.'
            page.locator('#hfGoal').fill(goal)
            page.locator('#hfMode').select_option('plan'); assert not page.locator('#hfGoalField').is_visible()
            page.locator('#hfMode').select_option('goal'); assert page.locator('#hfGoal').input_value() == goal
            assert page.locator('#hfThreshold').bounding_box()['width'] <= 56
            assert page.locator('#hfEnabled').locator('..').inner_text() == 'Auto resume'
            extra = 'Lập plan trước.\nGiữ tiếng Việt và dòng mới.'
            code = 'dựÁn' * 7 + '01'
            page.locator('#hfExtra').fill(extra)
            page.locator('#hfCode').fill(code)
            page.locator('#hfNumber').fill('42')
            page.locator('#hfEnabled').check()
            page.locator('#hfThreshold').fill('87')
            page.locator('#hfDelay').fill('0')
            page.locator('#hfPresets input[value="600k"]').check()
            assert not any(m['command'] in ['submitHandoff', 'setContextWatch', 'saveNewChatPreset'] for m in page.evaluate('window.__messages'))
            page.locator('#hfModel').select_option('other'); request = last()
            assert request['model'] == 'other' and request['command'] == 'loadHandoffOptions'
            changed = deepcopy(options); changed['model'] = 'other'; changed['choices'][0]['label'] = 'Mặc định · 128K'
            post({'type': 'handoffOptions', 'threadId': 'old', 'requestId': 'stale', 'error': 'stale'})
            post({'type': 'handoffOptions', 'threadId': 'old', 'requestId': request['requestId'], **changed})
            page.wait_for_function('() => !document.getElementById("hfSubmit").disabled')
            assert page.locator('#hfExtra').input_value() == extra and page.locator('#hfThreshold').input_value() == '87'
            assert page.locator('#hfPresets input:checked').input_value() == '600k'
            page.locator('#hfCancel').click()
            assert not any(m['command'] == 'submitHandoff' for m in page.evaluate('window.__messages'))
            page.locator('#contextTransferNow').click(); request = last()
            post({'type': 'handoffOptions', 'threadId': 'old', 'requestId': request['requestId'], **changed})
            page.wait_for_function('() => !document.getElementById("hfSubmit").disabled')
            assert page.locator('#hfExtra').input_value() == extra and page.locator('#hfCode').input_value() == code
            page.locator('#hfCancel').click()
            post({'type': 'chatOptionsSaved', 'threadId': 'old', 'requestId': 'identity-saved', 'identityUpdated': True,
                  'data': {'entries': {'old': {'series': {'code': code, 'nextNumber': '0043'}}}}})
            page.locator('#contextTransferNow').click(); request = last()
            post({'type': 'handoffOptions', 'requestId': request['requestId'], 'threadId': 'old', **changed})
            page.wait_for_function('() => !document.getElementById("hfSubmit").disabled')
            assert page.locator('#hfCode').input_value() == code and page.locator('#hfNumber').input_value() == '0043'
            # Polling and changing the selected chat do not retarget this form.
            state['selectedThreadId'] = 'running'; state['selected'] = state['activeChats'][0]
            post({'type': 'state', 'data': state}); page.wait_for_timeout(40)
            assert page.locator('#hfExtra').input_value() == extra
            before = len(page.evaluate('window.__messages'))
            page.locator('#hfThreshold').fill('100'); page.locator('#hfSubmit').click()
            assert len(page.evaluate('window.__messages')) == before
            page.locator('#hfThreshold').fill('99'); page.locator('#hfCode').fill(code + 'X'); page.locator('#hfSubmit').click()
            assert len(page.evaluate('window.__messages')) == before
            page.locator('#hfCode').fill(code)
            assert page.locator('#handoffDialog').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
            page.locator('#hfExtra').press('Control+Enter'); sent = last()
            assert sent['command'] == 'submitHandoff' and sent['threadId'] == 'old' and sent['model'] == 'other'
            assert sent['settings'] == {'preset': '600k', 'extraMessage': extra, 'enabled': True, 'thresholdPercent': 99, 'handoffDelaySeconds': 0, 'series': {'code': code, 'nextNumber': '0043'}, 'successorMode': 'goal', 'goalText': goal, 'serviceTier': 'default'}
            assert page.locator('#hfSubmit').is_disabled() and page.locator('#hfCancel').is_disabled()
            page.evaluate('document.getElementById("hfSubmit").click()'); assert last() == sent
            post({'type': 'handoffResult', 'threadId': 'old', 'requestId': 'stale', 'success': True})
            page.wait_for_timeout(30); assert page.locator('#hfSubmit').is_disabled()
            post({'type': 'handoffResult', 'threadId': 'old', 'requestId': sent['requestId'], 'error': 'Model không còn có sẵn.', 'blocked': False})
            page.wait_for_function('() => !document.getElementById("hfSubmit").disabled')
            assert page.locator('#hfExtra').input_value() == extra
            page.locator('#hfSubmit').click(); sent = last()
            post({'type': 'handoffResult', 'threadId': 'old', 'requestId': sent['requestId'], 'error': 'Chưa xác nhận gửi.', 'blocked': True, 'nextThreadId': 'next'})
            page.locator('#hfOpenNext').wait_for(); assert page.locator('#hfSubmit').is_disabled()
            page.locator('#hfOpenNext').click(); assert last() == {'command': 'openContextSuccessor', 'threadId': 'old'}
            page.locator('#hfCancel').click()
            page.close()
        assert errors == [], errors
        print(json.dumps({'passed': True, 'widths': [1000, 520, 320], 'modelSelection': True, 'draftAndCancel': True, 'series30': True,
                          'threshold99': True, 'explicitTarget': True, 'duplicateAndRecovery': True, 'compactControls': True,
                          'stoppedIconGray': True, 'focusPreservesTab': True, 'pageErrors': errors}))
    finally:
        browser.close()
