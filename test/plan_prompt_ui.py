"""Observe the actual implementPlan prop shape without reading plan text or clicking it."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
scratch = Path(os.environ['CST_UI_SCRATCH'])
assert scratch.is_dir() and 'AHUST-Work' in scratch.parts
profile = scratch / 'plan-prompt-edge'
profile.mkdir()
observer = (root / 'media/codex_current_chat_observer.js').read_text(encoding='utf-8')
errors = []
with sync_playwright() as p:
    browser = p.chromium.launch_persistent_context(str(profile), channel='msedge', headless=True, downloads_path=str(scratch / 'downloads'))
    try:
        page = browser.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.set_content('''<div id="root"><section id="prompt"><h3>Implement this plan?</h3><button id="yes">Yes, implement this plan</button><button id="skip">Skip</button></section><div id="change"></div></div>
<script>window.messages=[];window.acquisitions=0;window.answers=0;
window.acquireVsCodeApi=()=>{window.acquisitions++;return {postMessage:m=>messages.push(m)}};
window.route={memoizedProps:{value:{location:{pathname:'/local/a'},navigationType:'POP'}}};
window.plan={memoizedProps:{conversationId:'a',hostId:'local',pendingRequest:{type:'implementPlan',turnId:'plan-a',planContent:'PRIVATE_PLAN_CONTENT'}}};
route.child=plan;document.getElementById('root')['__reactContainer$fixture']={stateNode:{current:{child:route}}};
document.getElementById('yes').onclick=()=>answers++;
</script>''')
        page.add_script_tag(content=observer.replace("const token = document.currentScript?.dataset.trackerToken;", "const token = 'fixture';"))
        page.evaluate('window.nativeApi=window.acquireVsCodeApi()')
        page.wait_for_function('messages.some(m=>m.planTurnId==="plan-a")')
        assert page.evaluate('acquisitions') == 1
        assert page.evaluate('answers') == 0
        assert page.evaluate('JSON.stringify(messages).includes("PRIVATE_PLAN_CONTENT")') is False
        assert page.evaluate('messages.at(-1).route') == '/local/a'
        count = page.evaluate('messages.length')
        page.evaluate('document.getElementById("change").textContent="ordinary mutation"')
        page.wait_for_timeout(180)
        assert page.evaluate('messages.length') == count, 'no repeated report for unchanged prompt'
        # Navigation leaves the original decision unresolved.
        page.evaluate('route.memoizedProps.value.location.pathname="/local/b";document.getElementById("change").textContent="navigate"')
        page.wait_for_function('messages.at(-1).route==="/local/b"')
        assert page.evaluate('messages.at(-1).resolvedPlanTurnId') == ''
        assert page.evaluate('messages.at(-1).planTurnId') == ''
        page.evaluate('route.memoizedProps.value.location.pathname="/local/a";document.getElementById("change").textContent="return"')
        page.wait_for_function('messages.at(-1).planTurnId==="plan-a"')
        # Skip/dismiss removes the pending component on the same route.
        page.evaluate('plan.memoizedProps.pendingRequest=null;document.getElementById("prompt").remove()')
        page.wait_for_function('messages.at(-1).resolvedPlanTurnId==="plan-a"')
        # Text quoted in a chat must not become an implementation decision.
        page.evaluate('document.getElementById("change").textContent="Implement this plan? Yes, implement this plan"')
        page.wait_for_timeout(180)
        assert page.evaluate('messages.at(-1).planTurnId') == ''
        page.evaluate('plan.memoizedProps.pendingRequest={type:"userInput",turnId:"question"};document.getElementById("change").textContent="not a plan"')
        page.wait_for_timeout(180)
        assert page.evaluate('messages.at(-1).planTurnId') == ''
        # The detector is locale-independent and checks typed props, not English text.
        page.evaluate('plan.memoizedProps.pendingRequest={type:"implementPlan",turnId:"plan-b"};document.getElementById("change").textContent="Triển khai kế hoạch?"')
        page.wait_for_function('messages.at(-1).planTurnId==="plan-b"')
        assert page.evaluate('answers') == 0
        assert errors == [], errors
        print(json.dumps({'passed': True, 'typedPlanDetection': True, 'sameRouteUpdates': True, 'dismissal': True,
                          'navigationPreservesWait': True, 'noPlanTextSent': True, 'noAutomaticAnswer': True, 'pageErrors': errors}))
    finally:
        browser.close()
