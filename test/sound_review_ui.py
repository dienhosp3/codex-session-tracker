"""Validate the standalone review artifact using only ACL-verified scratch."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
scratch = Path(os.environ['CST_UI_SCRATCH'])
assert scratch.is_dir() and 'AHUST-Work' in scratch.parts
profile = scratch / 'sound-review-edge'
profile.mkdir()
errors = []
network = []
with sync_playwright() as p:
    browser = p.chromium.launch_persistent_context(str(profile), channel='msedge', headless=True,
                                                  accept_downloads=True, downloads_path=str(scratch / 'downloads'))
    try:
        page = browser.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('request', lambda request: network.append(request.url) if request.url.startswith(('https:', 'http:')) else None)
        page.goto((root / 'sound-review.html').as_uri())
        page.locator('#beepCards .card').first.wait_for()
        assert page.locator('[data-select]:checked').count() == 2
        assert page.locator('[data-select]:disabled').count() == 2
        assert page.locator('#existing .locked').count() == 4
        assert page.locator('#existing input').count() == 0
        assert page.evaluate('Object.keys(assets).length') == 6
        assert page.evaluate('Object.values(assets).every(value => value.startsWith("data:audio/"))')
        page.locator('#selectNone').click()
        assert page.locator('[data-select]:checked').count() == 0
        page.locator('#selectAll').click()
        assert page.locator('[data-select]:checked').count() == 2
        page.locator('[data-select="attention_input_initial"]').uncheck()
        edited = 'Có thao tác cần bạn duyệt.\nMở chat để kiểm tra. </script><script>window.bad=true</script>'
        page.locator('#text-attention_approval_initial').fill(edited)
        page.locator('#note-attention_approval_initial').fill('Giọng Việt rõ ràng, không nhạc nền.')
        page.locator('#globalNotes').fill('Giữ nguyên những sound tiếng Việt đã có.')
        page.wait_for_timeout(250)
        page.reload()
        assert page.locator('#text-attention_approval_initial').input_value() == edited
        assert page.locator('[data-select]:checked').count() == 1
        assert page.evaluate('window.bad === undefined')
        # Confirmed existing Vietnamese MP3 must remain excluded even on Select All.
        page.locator('#status-retry_limit_429').select_option('already_vi')
        page.locator('#status-model_capacity').select_option('needs_speech')
        page.locator('#selectAll').click()
        assert page.locator('[data-select]:checked').count() == 3
        assert page.locator('[data-select="retry_limit_429"]').is_disabled()
        page.locator('[data-select="attention_input_initial"]').uncheck()
        with page.expect_download() as downloaded:
            page.locator('#exportJson').click()
        json_file = scratch / 'selected.json'
        downloaded.value.save_as(json_file)
        data = json.loads(json_file.read_text(encoding='utf-8'))
        assert [item['id'] for item in data['actions']] == ['attention_approval_initial', 'model_capacity']
        assert data['actions'][0]['text'] == edited
        assert 'retry_limit_429' in data['keepExistingVietnamese']
        assert len(data['keepExistingVietnamese']) == 5
        assert data['pendingConfirmation'] == []
        # Import recovers edits and decisions after clearing the visible selection.
        page.locator('#selectNone').click()
        page.locator('#importFile').set_input_files(json_file)
        page.wait_for_function('document.querySelectorAll("[data-select]:checked").length === 2')
        assert page.locator('#text-attention_approval_initial').input_value() == edited
        # A saved HTML must carry its own snapshot and embedded audio to another file.
        with page.expect_download() as downloaded:
            page.locator('#saveHtml').click()
        html_file = scratch / 'edited.html'
        downloaded.value.save_as(html_file)
        restored = browser.new_page()
        restored.on('pageerror', lambda error: errors.append(str(error)))
        restored.goto(html_file.as_uri())
        assert restored.locator('[data-select]:checked').count() == 2
        assert restored.locator('#text-attention_approval_initial').input_value() == edited
        assert restored.locator('#status-retry_limit_429').input_value() == 'already_vi'
        assert restored.evaluate('window.bad === undefined')
        # Selected blank phrases block export; unselected rows can remain unfinished.
        restored.locator('#text-attention_approval_initial').fill(' ')
        restored.locator('#exportJson').click()
        assert 'chưa có lời đọc' in restored.locator('#saveStatus').inner_text()
        restored.locator('#text-attention_approval_initial').fill('Codex đang chờ bạn duyệt thao tác.')
        # Listen only by an explicit click. Decode in the browser without audible output.
        restored.evaluate('HTMLMediaElement.prototype.play = function(){ window.playedSource=this.src; return Promise.resolve(); }')
        restored.locator('[data-play="error_429"]').click()
        restored.wait_for_function('window.playedSource?.startsWith("data:audio/mpeg;base64,")')
        restored.locator('#stopAudio').click()
        assert 'Đã dừng' in restored.locator('#saveStatus').inner_text()
        for width in [1100, 700, 360]:
            restored.set_viewport_size({'width': width, 'height': 900})
            assert restored.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        if os.environ.get('CST_UI_PREVIEW'):
            restored.set_viewport_size({'width': 1100, 'height': 1000})
            restored.locator('#text-attention_approval_initial').fill('Codex đang chờ bạn duyệt thao tác. Hãy mở cuộc trò chuyện để kiểm tra và xác nhận.')
            restored.evaluate('window.scrollTo(0,0)')
            restored.screenshot(path=str(scratch / 'sound-review.png'))
        assert errors == [], errors
        assert network == [], network
        print(json.dumps({'passed': True, 'selectAllNoneIndividual': True, 'unicodeEdits': True, 'localPersistence': True,
                          'existingVietnameseExcluded': True, 'jsonRoundtrip': True, 'standaloneHtmlRoundtrip': True,
                          'embeddedAudio': 6, 'networkRequests': 0, 'widths': [1100, 700, 360], 'pageErrors': errors}))
    finally:
        browser.close()
