"""Real Edge: header rows, icon controls, offline Deactive and composer alignment."""
import json
import os
from copy import deepcopy
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
scratch = Path(os.environ['CST_UI_SCRATCH'])
assert scratch.is_dir() and 'AHUST-Work' in scratch.parts
profile = scratch / 'layout-controls-edge'
profile.mkdir()
html = (root / 'dashboard.html').read_text(encoding='utf-8').replace('__NONCE__', 'ui-test')
for marker, file in [('__NEW_CHAT_DIALOG_HTML__', 'media/new_chat_dialog.html'), ('/*__NEW_CHAT_DIALOG_JS__*/', 'media/new_chat_dialog.js'),
                     ('__HANDOFF_DIALOG_HTML__', 'media/handoff_dialog.html'), ('/*__HANDOFF_DIALOG_JS__*/', 'media/handoff_dialog.js'),
                     ('__CHAT_OPTIONS_HTML__', 'media/chat_options.html'), ('/*__CHAT_OPTIONS_JS__*/', 'media/chat_options.js'),
                     ('__PROXY_OPTIONS_HTML__', 'media/proxy_options.html'), ('/*__PROXY_OPTIONS_JS__*/', 'media/proxy_options.js'),
                     ('/*__SOUND_SETTINGS_CSS__*/', 'media/sound_settings.css'), ('/*__SOUND_SETTINGS_JS__*/', 'media/sound_settings.js'),
                     ('/*__CHAT_LIST_LAYOUT_JS__*/', 'media/chat_list_layout.js')]:
    html = html.replace(marker, (root / file).read_text(encoding='utf-8'))
shim = '<script nonce="ui-test">window.__messages=[];window.__ui={};window.acquireVsCodeApi=()=>({getState:()=>window.__ui,setState:s=>window.__ui=s,postMessage:m=>window.__messages.push(m)});</script>'
html = html.replace('<script nonce="ui-test">', shim + '<script nonce="ui-test">', 1)
chat = {'threadId': 'source', 'title': 'CODEX Tracker: Thêm chức năng chuyển chat và tuỳ chọn', 'state': 'Completed', 'stateKind': 'completed',
        'cwd': 'D:/VSCODE TEMP FOLDER', 'runtime': {'model': 'gpt-6-astra', 'reasoning': 'ultra', 'serviceTier': 'ultrafast', 'contextWindowTokens': 828400, 'contextPercent': 14},
        'timeline': [], 'activeNodes': []}
base = {'activeChats': [], 'nonRunningChats': [chat], 'showNonRunning': True, 'selectedThreadId': 'source', 'selected': chat,
        'contextWatch': {'entries': {}, 'readings': {}, 'busy': []}, 'gateway': {}, 'queue': {}, 'steer': {},
        'authSession': {'accountLabel': 'Không tải được Codex', 'canDeactivate': False, 'busy': False}, 'usage': {'context': chat['runtime']}}
errors = []
with sync_playwright() as p:
    browser = p.chromium.launch_persistent_context(str(profile), channel='msedge', headless=True, downloads_path=str(scratch / 'downloads'))
    try:
        for width in [1000, 520, 440, 320]:
            page = browser.new_page(); page.set_viewport_size({'width': width, 'height': 1000})
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.set_content(html)
            page.add_style_tag(content=':root{--vscode-font-family:Arial;--vscode-foreground:#ddd;--vscode-panel-background:#202020;--vscode-editor-background:#202020;--vscode-descriptionForeground:#aaa;--vscode-panel-border:#555;--vscode-input-background:#333;--vscode-input-foreground:#ddd;--vscode-textLink-foreground:#42caff;--vscode-testing-iconFailed:#ff6655}')
            post = lambda data: page.evaluate('(data)=>window.postMessage({type:"state",data},"*")', data)
            state = deepcopy(base); post(state)
            page.locator('.head .state').wait_for()
            assert page.locator('.head .state').inner_text() == 'Completed'
            header = page.locator('.head').bounding_box(); badge = page.locator('.head .state').bounding_box()
            title = page.locator('.head .title').bounding_box(); subtitle = page.locator('.head .sub').bounding_box(); runtime = page.locator('.head .runtime-meta').bounding_box()
            assert abs(badge['y'] - title['y']) < 2 and badge['height'] < 28
            assert abs(header['x'] + header['width'] - 10 - badge['x'] - badge['width']) < 2
            assert subtitle['y'] >= badge['y'] + badge['height'] and runtime['y'] >= subtitle['y'] + subtitle['height']
            assert abs(subtitle['width'] - runtime['width']) < 2
            assert abs(runtime['x'] + runtime['width'] - badge['x'] - badge['width']) < 2, 'metadata spans the space beneath Completed'
            assert 'Model' not in page.locator('.head .runtime-meta').inner_text()
            assert 'gpt-6-astra' in page.locator('.head .runtime-meta').inner_text()
            assert page.locator('.head .runtime-badge.ultra').count() == 1 and page.locator('.head .runtime-badge.ultrafast').count() == 1
            assert page.locator('.usage-head>.card-title').count() == 0
            assert 'USAGE' not in page.locator('.usage-head').inner_text().upper()
            assert page.locator('#usageChartButton').inner_text() == '' and page.locator('#usageChartButton svg').count() == 1
            assert page.locator('#usageChartButton').get_attribute('aria-label') == 'Bật/tắt đồ thị quota theo thời điểm'
            page.locator('#usageChartButton').click()
            assert page.locator('#usageChartInline').is_visible()
            assert page.locator('#usageChartButton').get_attribute('aria-pressed') == 'true'
            page.locator('#usageChartButton').click()
            assert page.locator('#usageChartInline').count() == 0
            for running in [False, True]:
                state['selected']['stateKind'] = 'running' if running else 'completed'
                state['selected']['state'] = 'Running' if running else 'Completed'
                if running:
                    state['steer'] = {'checked': True, 'available': False, 'reason': 'Codex chưa kết nối'}
                    state['queue'] = {'checked': True, 'available': False, 'reason': 'Chưa có CLI'}
                post(state); page.wait_for_timeout(40)
                button = page.locator('#reprobe').bounding_box(); row = page.locator('.composer-meta').bounding_box()
                assert button['width'] <= 30 and button['height'] <= 28
                assert abs(button['x'] + button['width'] - row['x'] - row['width']) < 2, 'reprobe stays on the right'
                page.locator('#reprobe').click()
                assert page.evaluate('window.__messages.at(-1).command') == 'reprobeCodex'
                assert page.locator('.composer-card').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
            assert page.locator('#deactivateSession').is_enabled()
            page.locator('#deactivateSession').click()
            count = page.evaluate('window.__messages.filter(m=>m.command==="deactivateSession").length')
            page.evaluate('document.getElementById("deactivateSession").click()')
            assert page.evaluate('window.__messages.filter(m=>m.command==="deactivateSession").length') == count
            state['authSession']['busy'] = True; post(state)
            page.wait_for_function('() => document.getElementById("deactivateSession").disabled')
            state['authSession']['busy'] = False; state['authSession']['reloadRequired'] = True; post(state)
            page.wait_for_function('() => !document.getElementById("deactivateSession").disabled')
            state['selected'] = None; state['selectedThreadId'] = ''; post(state)
            page.wait_for_function('() => !document.querySelector(".head")')
            assert page.locator('#deactivateSession').is_enabled(), 'no selected/loaded Codex chat is required'
            page.close()
        assert errors == [], errors
        print(json.dumps({'passed': True, 'widths': [1000, 520, 440, 320], 'statusCornerOnly': True, 'metadataFullWidth': True,
                          'noModelOrUsageLabels': True, 'chartIconWorks': True, 'reprobeRightAligned': True, 'offlineDeactive': True, 'pageErrors': errors}))
    finally:
        browser.close()
