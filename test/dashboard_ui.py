from copy import deepcopy
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
import json
import subprocess

from playwright.sync_api import sync_playwright


import tempfile
root = Path(__file__).resolve().parents[1]
output = Path(tempfile.mkdtemp(prefix='tracker-proxy-ui-'))


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_GET(self):
        if self.path == '/favicon.ico':
            self.send_response(204)
            self.end_headers()
            return
        super().do_GET()


server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=str(root)))
Thread(target=server.serve_forever, daemon=True).start()
fixture = {
    'activeChats': [{'threadId': 'chat-a', 'title': 'Chat A'}, {'threadId': 'chat-b', 'title': 'Chat B'}],
    'nonRunningChats': [{'threadId': 'chat-c', 'title': 'Chat C'}],
    'selectedThreadId': 'chat-a',
    'codexCurrentThreadId': 'chat-b',
    'selected': None,
    'usage': {
        'intervalMinutes': 5,
        'checkedAt': 1800000000000,
        'alerts': {'summary': {'enabled': True, 'thresholds': [50, 70, 85, 95]}},
        'groups': [{'id': 'codex', 'name': '', 'windows': [
            {'key': 'primary', 'usedPercent': 45, 'durationMinutes': 300, 'resetsAt': 1800000300000},
            {'key': 'secondary', 'usedPercent': 7, 'durationMinutes': 10080, 'resetsAt': 1800000600000},
        ]}],
    },
    'authSession': {'accountLabel': 'owner@example.test', 'canDeactivate': True},
    'gateway': {
        'running': True,
        'enabled': True,
        'address': {'host': '127.0.0.1', 'port': 8765},
        'commands': [],
        'traffic': [],
        'settings': {'enabled': True, 'port': 8765, 'traceMaxMb': 64},
        'extensionRuntime': {'version': 'fixture'},
    },
}
result = {'passed': False, 'viewports': [], 'consoleErrors': []}
theme = '''
:root{--vscode-font-family:Arial,sans-serif;--vscode-editor-font-family:Consolas,monospace;
--vscode-foreground:#ccc;--vscode-editor-background:#202020;--vscode-panel-background:#202020;
--vscode-descriptionForeground:#aaa;--vscode-panel-border:#383838;--vscode-focusBorder:#0078d4;
--vscode-sideBar-background:#252526;--vscode-input-background:#303030;--vscode-input-foreground:#ccc;
--vscode-button-background:#0078d4;--vscode-button-foreground:white;--vscode-errorForeground:#f88}
'''
try:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel='msedge', headless=True)
        for width in [1000, 520, 320]:
            page = browser.new_page(viewport={'width': width, 'height': 900})
            page.on('pageerror', lambda error: result['consoleErrors'].append(str(error)))
            page.on('console', lambda message: result['consoleErrors'].append(message.text) if message.type == 'error' else None)
            page.add_init_script('''
                window.__trackerMessages = [];
                window.acquireVsCodeApi = () => ({
                    getState: () => ({}),
                    setState: value => value,
                    postMessage: value => window.__trackerMessages.push(value)
                });
            ''')
            page.goto(f'http://127.0.0.1:{server.server_port}/dashboard.html')
            page.add_style_tag(content=theme)

            def update(data):
                data = deepcopy(data)
                data['usage']['display'] = json.loads(subprocess.check_output([
                    'node', '-e', "process.stdout.write(JSON.stringify(require('./codex_usage').usageStatus(JSON.parse(process.argv[1]))))",
                    json.dumps(data['usage']),
                ], cwd=root, text=True, encoding='utf-8'))
                page.evaluate("data => window.postMessage({type:'state', data}, '*')", data)
                page.wait_for_timeout(50)

            update(fixture)
            yellow = page.locator('.chat-title.codex-current')
            assert yellow.inner_text() == 'Chat B'
            assert yellow.evaluate('(node) => getComputedStyle(node).color') == 'rgb(255, 215, 94)'
            assert page.locator('.chat.selected').get_attribute('data-id') == 'chat-a'
            page.evaluate("window.postMessage({type:'codexCurrentChat', threadId:'chat-a'}, '*')")
            page.wait_for_timeout(50)
            assert yellow.inner_text() == 'Chat A'
            page.evaluate("window.postMessage({type:'codexCurrentChat', threadId:'chat-c'}, '*')")
            page.locator('#nonRunningTab').click()
            assert yellow.inner_text() == 'Chat C'
            page.locator('#runningTab').click()
            page.evaluate("window.postMessage({type:'codexCurrentChat', threadId:''}, '*')")
            page.wait_for_timeout(50)
            assert yellow.count() == 0
            update(fixture)

            usage = page.locator('.usage-card')
            account = page.locator('.auth-session-card')
            assert account.count() == 1
            assert account.locator('.usage-card').count() == 1
            assert account.locator('.auth-session-row').count() == 1
            assert 'Phiên đăng nhập Codex' not in account.inner_text()
            assert account.locator('.usage-alert-dialog').count() == 1
            assert account.locator('.usage-alert-dialog .usage-alert-section').count() == 2
            assert usage.evaluate('(node) => !!(document.querySelector(".auth-session-row").compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)')
            account_height = account.bounding_box()['height']
            assert account_height <= 90, account_height
            usage_height = usage.bounding_box()['height']
            assert usage_height <= 20, usage_height
            assert usage.locator('progress,input').count() == 0
            assert usage.locator('.usage-value').inner_text() == '5h 55% - 7d 93%'
            assert usage.locator('.usage-value').evaluate('(node) => node.scrollHeight <= node.clientHeight + 1')
            assert usage.locator('.usage-percent-yellow').inner_text() == '55%'
            assert usage.locator('.usage-percent-green').inner_text() == '93%'
            assert usage.locator('.usage-percent-yellow').evaluate('(node) => getComputedStyle(node).color') != usage.locator('.usage-percent-green').evaluate('(node) => getComputedStyle(node).color')
            assert 'Đặt lại' in usage.locator('.usage-value').get_attribute('title')
            assert '5 phút' in page.locator('#usageSettings').get_attribute('title')
            assert usage.locator('#usageAlertsSettings').count() == 1
            assert '50%, 70%, 85%, 95%' in page.locator('#usageAlertsSettings').get_attribute('title')
            assert 'Cú pháp mốc %: 50,70,85,95' in page.locator('#usageAlertsSettings').get_attribute('title')
            assert 'tốc độ %/giờ: 10,20,30' in page.locator('#usageAlertsSettings').get_attribute('title')
            page.locator('#usageAlertsSettings').click()
            assert page.locator('#usageAlertDialog').is_visible()
            assert page.locator('#usageAlertPrimaryThresholds').get_attribute('placeholder') == '50,70,85,95'
            assert page.locator('#usageAlertPrimaryRates').get_attribute('placeholder') == '10,20,30'
            page.locator('#usageAlertCancel').click()
            page.locator('#usageSettings').click()
            assert page.evaluate("window.__trackerMessages.at(-1).command") == 'configureUsageInterval'
            interval_changed = deepcopy(fixture)
            interval_changed['usage']['intervalMinutes'] = 7
            update(interval_changed)
            assert '7 phút' in page.locator('#usageSettings').get_attribute('title')
            assert usage.bounding_box()['height'] == usage_height
            page.locator('#checkUsage').click()
            assert page.evaluate("window.__trackerMessages.at(-1).command") == 'checkUsage'
            busy = deepcopy(fixture)
            busy['usage']['busy'] = True
            update(busy)
            assert page.locator('#checkUsage').is_disabled()
            failed_usage = deepcopy(fixture)
            failed_usage['usage']['error'] = '<offline>'
            update(failed_usage)
            assert '<offline>' in usage.locator('.usage-value').get_attribute('title')
            assert '<offline>' not in usage.inner_text()
            assert usage.locator('.usage-value').inner_text() == '5h 55% - 7d 93%'
            assert usage.bounding_box()['height'] == usage_height
            update(fixture)
            card = page.locator('.gateway-disclosure')
            summary = page.locator('#gatewaySummary')
            assert not card.evaluate('(node) => node.open')
            assert not page.locator('#gwPort').is_visible()
            closed_height = card.bounding_box()['height']
            assert closed_height <= 45, closed_height
            assert summary.locator('.gateway-summary-label').evaluate('(node) => node.scrollHeight <= node.clientHeight + 1')
            assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
            restart = page.locator('#restartLocalProxy')
            assert restart.is_visible()
            assert restart.inner_text() == ''
            assert restart.locator('svg').count() == 1
            assert restart.get_attribute('aria-label') == 'Khởi động lại proxy'
            assert restart.evaluate('(node) => getComputedStyle(node).color') == 'rgb(255, 215, 94)'
            restart.click()
            assert page.evaluate("window.__trackerMessages.at(-1).command") == 'restartLocalProxy'
            assert not card.evaluate('(node) => node.open')
            restart.focus()
            restart.press('Enter')
            assert page.evaluate("window.__trackerMessages.at(-1).command") == 'restartLocalProxy'
            assert not card.evaluate('(node) => node.open')
            restart.press('Space')
            assert not card.evaluate('(node) => node.open')
            restart.click(button='right')
            assert page.evaluate("window.__trackerMessages.at(-1).command") == 'configureProxyWatchdog'
            assert not card.evaluate('(node) => node.open')
            assert '5 phút' in restart.get_attribute('title')
            proxy_busy = deepcopy(fixture)
            proxy_busy['localProxy'] = {'busy': True, 'executablePath': 'C:\\Proxy\\proxy.exe'}
            update(proxy_busy)
            assert restart.is_disabled()
            assert not card.evaluate('(node) => node.open')
            proxy_state = deepcopy(fixture)
            proxy_state['localProxy'] = {'executablePath': 'C:\\A & B <proxy>\\proxy.exe', 'notice': {'kind': 'error', 'text': '<fixture stop denied>'}}
            update(proxy_state)
            assert not restart.is_disabled()
            assert 'C:\\A & B <proxy>\\proxy.exe' in restart.get_attribute('title')
            summary.click()
            assert page.locator('.local-proxy-path').inner_text() == proxy_state['localProxy']['executablePath']
            assert '<fixture stop denied>' in page.locator('.gateway-content').inner_text()
            page.locator('#configureLocalProxy').click()
            assert page.evaluate("window.__trackerMessages.at(-1).command") == 'configureLocalProxy'
            restart.click()
            assert card.evaluate('(node) => node.open')
            summary.click()
            update(fixture)
            page.screenshot(path=str(output / f'gateway-{width}-collapsed.png'))

            summary.click()
            assert card.evaluate('(node) => node.open')
            assert page.locator('#gwPort').is_visible()
            page.locator('#gwPort').fill('9876')
            update(fixture)
            assert card.evaluate('(node) => node.open')
            assert page.locator('#gwPort').input_value() == '9876'
            assert page.locator('#gwPort').evaluate('(node) => node === document.activeElement')
            page.locator('#gwSave').click()
            saved = page.evaluate("window.__trackerMessages.filter(item => item.command === 'saveGatewaySettings').at(-1)")
            assert saved['settings']['port'] == 9876
            page.locator('#gwTraffic').click()
            assert page.evaluate("window.__trackerMessages.at(-1).command") == 'openTrafficMonitor'

            selected = deepcopy(fixture)
            selected['selectedThreadId'] = 'fixture-thread'
            selected['selected'] = {'title': 'Fixture conversation', 'stateKind': 'completed', 'state': 'Completed', 'timeline': []}
            update(selected)
            assert card.evaluate('(node) => node.open')
            composer = page.locator('#composerInput')
            composer.fill('Tiếp tục kiểm tra bản nháp')
            for _ in range(4):
                update(selected)
                assert composer.input_value() == 'Tiếp tục kiểm tra bản nháp'
            page.locator('#usageSettings').click()
            update(selected)
            assert composer.input_value() == 'Tiếp tục kiểm tra bản nháp'
            page.locator('#continueBtn').click()
            sent = page.evaluate('window.__trackerMessages.at(-1)')
            assert sent['command'] == 'continueMessage'
            assert sent['threadId'] == 'fixture-thread'
            assert sent['text'] == 'Tiếp tục kiểm tra bản nháp'
            assert sent['requestId']
            update(selected)
            assert composer.input_value() == sent['text']
            assert page.locator('#continueBtn').is_disabled()
            rejected = deepcopy(selected)
            rejected['continuation'] = {'notice': {'kind': 'error', 'text': 'fixture rejected', 'threadId': sent['threadId'], 'requestId': sent['requestId']}}
            update(rejected)
            assert composer.input_value() == sent['text']
            assert not page.locator('#continueBtn').is_disabled()
            page.locator('#continueBtn').click()
            retry = page.evaluate('window.__trackerMessages.at(-1)')
            acknowledged = deepcopy(selected)
            acknowledged['continuation'] = {'notice': {'kind': 'success', 'text': 'fixture accepted', 'threadId': retry['threadId'], 'requestId': retry['requestId']}}
            update(acknowledged)
            assert composer.input_value() == ''
            composer.fill('Bản nháp mới sau ACK')
            update(acknowledged)
            assert composer.input_value() == 'Bản nháp mới sau ACK'
            other = deepcopy(selected)
            other['selectedThreadId'] = 'other-thread'
            update(other)
            assert composer.input_value() == ''
            composer.fill('Bản nháp riêng chat khác')
            update(selected)
            assert composer.input_value() == 'Bản nháp mới sau ACK'
            update(other)
            assert composer.input_value() == 'Bản nháp riêng chat khác'
            update(selected)
            page.screenshot(path=str(output / f'gateway-{width}-expanded.png'))
            summary.focus()
            summary.press('Enter')
            assert not card.evaluate('(node) => node.open')
            update(selected)
            assert not card.evaluate('(node) => node.open')
            assert summary.evaluate('(node) => node === document.activeElement')
            summary.press('Space')
            assert card.evaluate('(node) => node.open')
            update(fixture)
            assert card.evaluate('(node) => node.open')
            summary.click()
            update(fixture)
            assert not card.evaluate('(node) => node.open')

            failed = deepcopy(fixture)
            failed['gateway'].update({'running': False, 'error': '<fixture error>'})
            update(failed)
            assert page.locator('.gateway-summary-status').inner_text() == 'Lỗi'
            assert not card.evaluate('(node) => node.open')
            summary.click()
            assert '<fixture error>' in page.locator('.gateway-content').inner_text()
            failed['gateway']['enabled'] = False
            update(failed)
            assert page.locator('.gateway-summary-status').inner_text() == 'Đã tắt'
            result['viewports'].append({
                'width': width,
                'collapsedHeight': closed_height,
                'defaultCollapsed': True,
                'mouseAndKeyboard': True,
                'settingsAndTrafficActions': True,
                'stateAndDraftAndFocusRetained': True,
                'selectedAndUnselectedRefresh': True,
                'nativeCurrentChatColorAndBothTabs': True,
                'selectedChatIndependentOfCurrentChat': True,
                'usageHeight': usage_height,
                'accountCardHeight': account_height,
                'usageOneLineInsideAccountCard': True,
                'loginHeadingRemoved': True,
                'proxyIconOnlyHighlighted': True,
                'proxyRestartMouseKeyboardAndNoToggle': True,
                'proxyBusyAndEscapedPathAndNotice': True,
                'proxyRightClickSettings': True,
                'stoppedComposerDraftSurvivesPollingAndBlur': True,
                'stoppedComposerSendsExactChatAndRequestId': True,
                'onlyMatchingAcknowledgementClearsDraft': True,
                'separateDraftPerChat': True,
                'usageSettingsAndManualCheck': True,
                'usageAlertButtonAndConfiguration': True,
                'usageExactCompactTextAndSeparatePercentageColors': True,
                'usageDetailsOnlyOnHover': True,
            })
            page.close()
        browser.close()
    assert not result['consoleErrors'], result['consoleErrors']
    result['passed'] = True
finally:
    server.shutdown()
    (output / 'browser.json').write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
print(json.dumps({**result, 'temporaryScreenshots': str(output)}, ensure_ascii=False))
if result['passed']:
    destination = root / 'artifacts/verification/local-proxy-0.12.12'
    destination.mkdir(parents=True, exist_ok=True)
    (destination / 'browser.json').write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
