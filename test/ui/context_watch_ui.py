"""Real Edge: compact per-chat options, live context and explicit source routing."""
import json
import os
from copy import deepcopy
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[2]
scratch = Path(os.environ['CST_UI_SCRATCH'])
assert scratch.is_dir() and 'AHUST-Work' in scratch.parts
profile = scratch / 'chat-options-edge'
profile.mkdir()
import sys
sys.path.insert(0,str(root/'test/fixtures'))
from webview import dashboard as build_dashboard
html=build_dashboard(root,include_shim=False)
shim = '<script nonce="ui-test">window.__messages=[];window.acquireVsCodeApi=()=>({getState:()=>({}),setState:()=>{},postMessage:m=>window.__messages.push(m)});</script>'
html = html.replace('<script nonce="ui-test">', shim + '<script nonce="ui-test">', 1)
base = {'activeChats': [{'threadId': 'old', 'title': 'Chat A'}, {'threadId': 'other', 'title': 'Chat B'}], 'nonRunningChats': [],
        'selectedThreadId': 'old', 'selected': {'threadId': 'old', 'title': 'Chat A', 'timeline': [], 'activeNodes': []},
        'contextWatch': {'entries': {}, 'readings': {}, 'busy': [], 'intervalMs': 300, 'handoffDelaySeconds': 10, 'thresholdPercent': 80},
        'gateway': {}, 'queue': {}, 'steer': {}, 'usage': {'context': {'contextWindowTokens': 272000, 'contextPercent': 14}}}
defaults = {'handoffDelaySeconds': 10, 'intervalMs': 300, 'completionSound': True, 'thresholdPercent': 80, 'autoAllow': False}
errors = []
with sync_playwright() as p:
    browser = p.chromium.launch_persistent_context(str(profile), channel='msedge', headless=True, downloads_path=str(scratch / 'downloads'))
    try:
        for width in [1000, 520, 320]:
            page = browser.new_page(); page.set_viewport_size({'width': width, 'height': 900})
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.set_content(html)
            page.add_style_tag(content=':root{--vscode-font-family:Arial;--vscode-foreground:#ddd;--vscode-panel-background:#202020;--vscode-editor-background:#202020;--vscode-panel-border:#555;--vscode-input-background:#333;--vscode-input-foreground:#ddd;--vscode-descriptionForeground:#aaa}')
            post = lambda m: page.evaluate('(m)=>window.postMessage(m,"*")', m)
            last = lambda: page.evaluate('window.__messages.at(-1)')
            state = deepcopy(base); post({'type': 'state', 'data': state})
            page.locator('#chatOptionsCurrent').wait_for()
            assert page.locator('[data-chat-options]').count() == 2
            assert 'Theo dõi context ·' not in page.locator('#main').inner_text()
            assert page.locator('#contextWatchConfig,#contextWatchDelay,#contextWatchEnabled,#contextWatchThreshold,#contextSeriesCode,#successorContext').count() == 0
            page.locator('[data-context-watch="old"]').click()
            assert last() == {'command': 'setContextWatch', 'threadId': 'old', 'enabled': True}
            watch = deepcopy(state['contextWatch'])
            watch['entries']['old'] = {'enabled': True, 'thresholdPercent': 80}
            watch['readings']['old'] = {'percent': 79.25, 'windowTokens': 828400}
            post({'type': 'contextWatch', 'data': watch})
            page.wait_for_function('() => document.querySelector("[data-account-context]").textContent==="Context 79% of 828K"')
            assert page.locator('[data-context-inline="old"]').inner_text() == '79.3% / 80% of 828,4K'
            page.locator('[data-chat-options="other"]').click(); request = last()
            assert request['command'] == 'loadChatOptions' and request['threadId'] == 'other'
            assert not any(m['command'] == 'selectChat' for m in page.evaluate('window.__messages'))
            post({'type': 'chatOptionsLoaded', 'requestId': request['requestId'], 'threadId': 'other', 'title': 'Chat B', 'options': defaults})
            page.wait_for_function('() => !document.getElementById("coSave").disabled')
            assert page.locator('#coTitle').inner_text() == 'Tuỳ chọn chat'
            assert page.locator('#coSource').inner_text() == 'Chat B'
            assert page.locator('#coForm input').count() == 8
            assert page.locator('#coForm input[type="checkbox"]').count() == 2
            assert 'Âm báo hoàn tất' in page.locator('#coForm').inner_text()
            assert page.locator('#coForm select,#coForm textarea').count() == 0
            assert not any(label in page.locator('#coForm').inner_text() for label in ['Model', 'Auto resume', 'Lỗi 429', 'Chờ trả lời'])
            page.locator('#coDelay').fill('3'); page.locator('#coInterval').fill('100'); page.locator('#coCompletion').uncheck(); page.locator('#coThreshold').fill('89'); page.locator('#coAutoAllow').check()
            post({'type': 'state', 'data': state}); page.wait_for_timeout(40)
            assert page.locator('#coDelay').input_value() == '3'
            assert page.locator('#chatOptionsDialog').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
            before = len(page.evaluate('window.__messages'))
            page.locator('#coInterval').fill('99'); page.locator('#coSave').click()
            assert len(page.evaluate('window.__messages')) == before
            page.locator('#coInterval').fill('100'); page.locator('#coInterval').press('Control+Enter'); sent = last()
            assert sent['command'] == 'saveChatOptions' and sent['threadId'] == 'other'
            assert sent['options'] == {'handoffDelaySeconds': 3, 'intervalMs': 100, 'completionSound': False, 'thresholdPercent': 89, 'autoAllow': True}
            assert page.locator('#coSave').is_disabled() and page.locator('#coCancel').is_disabled()
            page.evaluate('document.getElementById("coSave").click()'); assert last() == sent
            post({'type': 'chatOptionsSaved', 'threadId': 'other', 'requestId': 'stale', 'error': 'stale'})
            page.wait_for_timeout(30); assert page.locator('#coSave').is_disabled()
            post({'type': 'chatOptionsSaved', 'threadId': 'other', 'requestId': sent['requestId'], 'error': 'Lỗi lưu thử nghiệm'})
            page.wait_for_function('() => !document.getElementById("coSave").disabled')
            assert page.locator('#coInterval').input_value() == '100' and not page.locator('#coCompletion').is_checked()
            page.locator('#coSave').click(); sent = last()
            watch['entries']['other'] = {'enabled': False, 'chatOptions': sent['options']}
            post({'type': 'chatOptionsSaved', 'threadId': 'other', 'requestId': sent['requestId'], 'options': sent['options'], 'data': watch})
            page.wait_for_function('() => document.getElementById("coStatus").textContent==="Đã lưu."')
            page.locator('#coCancel').click()
            page.locator('#chatOptionsCurrent').click(); request = last(); assert request['threadId'] == 'old'
            post({'type': 'chatOptionsLoaded', 'threadId': 'old', 'requestId': request['requestId'], 'title': 'Chat A', 'options': defaults})
            page.wait_for_function('() => !document.getElementById("coSave").disabled')
            assert page.locator('#coDelay').input_value() == '10' and page.locator('#coCompletion').is_checked()
            assert not page.locator('#coAutoAllow').is_checked()
            page.locator('#coCancel').click()
            page.locator('[data-chat-options="other"]').click(); request = last()
            post({'type': 'chatOptionsLoaded', 'threadId': 'other', 'requestId': request['requestId'], 'title': 'Chat B', 'options': sent['options']})
            page.wait_for_function('() => !document.getElementById("coSave").disabled')
            assert page.locator('#coDelay').input_value() == '3' and not page.locator('#coCompletion').is_checked()
            assert page.locator('#coAutoAllow').is_checked()
            page.locator('#coDelay').fill('9'); page.locator('#coCancel').click()
            assert last()['command'] == 'loadChatOptions', 'closing without save is inert'
            page.locator('#contextTransferNow').click(); assert last()['command'] == 'loadHandoffOptions'
            page.locator('#hfCancel').click()
            watch['entries']['old']['handoff'] = {'phase': 'failed', 'nextThreadId': 'next', 'error': 'Chưa nhận ACK'}
            post({'type': 'contextWatch', 'data': watch})
            page.locator('#contextWatchOpenNext').click(); assert last() == {'command': 'openContextSuccessor', 'threadId': 'old'}
            assert page.locator('#contextTransferNow').is_disabled()
            watch['entries']['old'].pop('handoff')
            watch['entries']['old']['speedNotice'] = 'Ultrafast chưa khả dụng; chat kế tiếp dùng Fast.'
            watch['entries']['old']['deferred'] = {'error': 'Goal đã dừng; chờ tiếp tục.'}
            watch['readings'].pop('old', None)
            post({'type': 'contextWatch', 'data': watch})
            page.wait_for_function('() => document.getElementById("contextWatchReadError").textContent.includes("Goal đã dừng")')
            assert 'Ultrafast chưa khả dụng; chat kế tiếp dùng Fast.' in page.locator('.chat-actions').inner_text()
            assert not page.locator('#contextTransferNow').is_disabled()
            # Editing current ID/label is independent from opening a successor.
            native = '[OLD-0001] Native title'
            state['activeChats'][0]['title'] = native; state['selected']['title'] = native
            watch['entries']['old'] = {'enabled': False, 'thresholdPercent': 85}
            state['contextWatch'] = watch; post({'type': 'state', 'data': state})
            page.locator('#chatOptionsCurrent').click(); request = last()
            post({'type': 'chatOptionsLoaded', 'threadId': 'old', 'requestId': request['requestId'], 'title': native,
                  'identity': {'code': 'OLD', 'number': '0001'}, 'displayLabel': '', 'options': defaults})
            page.wait_for_function('() => !document.getElementById("coSave").disabled')
            assert page.locator('#coCode').input_value() == 'OLD' and page.locator('#coNumber').input_value() == '0001'
            before = len(page.evaluate('window.__messages'))
            page.locator('#coCode').fill('a' * 31); page.locator('#coSave').click()
            assert len(page.evaluate('window.__messages')) == before
            code = 'dựÁn' * 7 + '01'
            label = 'Công việc <b>riêng</b>'
            page.locator('#coCode').fill(code); page.locator('#coNumber').fill('42'); page.locator('#coLabel').fill(label)
            assert page.locator('#coNextPreview').inner_text() == f'Chat kế tiếp: [{code}-0043]'
            page.locator('#coSave').click(); sent_identity = last()
            assert sent_identity['command'] == 'saveChatOptions' and sent_identity['threadId'] == 'old'
            assert sent_identity['identity'] == {'code': code, 'number': '0042'}
            assert sent_identity['expectedIdentity'] == {'code': 'OLD', 'number': '0001'}
            assert sent_identity['displayLabel'] == label
            renamed = f'[{code}-0042] Native title'
            watch['entries']['old'].update({'title': renamed, 'displayLabel': label, 'series': {'code': code, 'nextNumber': '0043'}})
            post({'type': 'chatOptionsSaved', 'threadId': 'old', 'requestId': sent_identity['requestId'], 'title': renamed,
                  'identity': sent_identity['identity'], 'identityUpdated': True, 'displayLabel': label, 'data': watch})
            page.wait_for_function('() => !document.getElementById("coSave").disabled')
            page.locator('#coCancel').click()
            assert page.locator('[data-id="old"] .chat-title').inner_text() == '[0042] '+label
            assert page.locator('.head .title').inner_text() == '[0042] '+label
            assert page.locator('.head .title').get_attribute('title') == renamed
            assert page.locator('[data-id="old"] .chat-title b').count() == 0
            page.locator('#search').fill(code); assert page.locator('.chat').count() == 1
            page.locator('#search').fill('Công việc'); assert page.locator('.chat').count() == 1
            page.locator('#search').fill('')
            page.locator('#chatOptionsCurrent').click(); request = last()
            post({'type': 'chatOptionsLoaded', 'threadId': 'old', 'requestId': request['requestId'], 'title': renamed,
                  'identity': sent_identity['identity'], 'displayLabel': label, 'options': defaults})
            page.wait_for_function('() => !document.getElementById("coSave").disabled')
            page.locator('#coLabel').fill(''); page.locator('#coSave').click(); cleared = last()
            assert 'identity' not in cleared and cleared['displayLabel'] == ''
            watch['entries']['old']['displayLabel'] = ''
            post({'type': 'chatOptionsSaved', 'threadId': 'old', 'requestId': cleared['requestId'], 'title': renamed,
                  'identity': sent_identity['identity'], 'displayLabel': '', 'data': watch})
            page.wait_for_function('() => !document.getElementById("coSave").disabled')
            page.locator('#coCancel').click()
            assert page.locator('.head .title').inner_text() == renamed
            page.close()
        assert errors == [], errors
        print(json.dumps({'passed': True, 'widths': [1000, 520, 320], 'currentThreshold': True, 'explicitTarget': True,
                          'perChatIsolation': True, 'retryAndStaleAck': True, 'completionOnly': True, 'liveContext': True,
                          'currentIdentity30': True, 'displayLabelAndOriginalName': True, 'labelEscapedAndClearable': True, 'pageErrors': errors}))
    finally:
        browser.close()
