"""Exercise native question prop shapes and real DOM actions in headless Edge."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[2]
scratch = Path(os.environ['CST_UI_SCRATCH'])
assert scratch.is_dir() and 'AHUST-Work' in scratch.parts
profile = scratch / 'async-input-edge'
profile.mkdir()
observer = (root / 'media/codex_current_chat_observer.js').read_text(encoding='utf-8')
errors = []
with sync_playwright() as p:
    browser = p.chromium.launch_persistent_context(str(profile), channel='msedge', headless=True, downloads_path=str(scratch / 'downloads'))
    try:
        page = browser.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.set_content('''<div id="root"><div id="change"></div><section id="prompt">
<input id="answer"><button id="skip" data-request-input-dismiss>Hủy</button><button id="send">Gửi</button><button id="close">×</button>
</section></div><script>
window.messages=[];window.acquisitions=0;window.sent=0;window.failSend=false;
window.acquireVsCodeApi=()=>{acquisitions++;return {postMessage:m=>messages.push(m)}};
window.route={memoizedProps:{value:{location:{pathname:'/local/chat'},navigationType:'POP'}}};
const container=document.getElementById('root');container['__reactContainer$fixture']={stateNode:{current:{child:route}}};
window.bump=()=>document.getElementById('change').textContent=String(Math.random());
window.show=(call,count=1,host='local')=>{
  const ids=Array.from({length:count},(_,i)=>JSON.stringify(['request_user_input_async',call,i]));
  window.owner={memoizedProps:{questionKey:{hostId:host,threadId:'chat',entityKey:'conversation',itemId:ids[0]}},return:route};
  window.form={memoizedProps:{questions:ids.map(id=>({id,question:'PRIVATE_QUESTION',options:[],draft:''})),questionIndex:0,isSubmitting:false,onSkip(){},onSubmit(){}},return:owner};
  owner.child=form;route.child=owner;
  for(const id of ['skip','send','close','answer'])document.getElementById(id)['__reactFiber$fixture']={return:form};
  document.getElementById('prompt').hidden=false;document.getElementById('skip').disabled=false;bump();return ids;
};
window.hide=()=>{route.child=null;document.getElementById('prompt').hidden=true;bump()};
document.getElementById('skip').onclick=()=>{
  if(form.memoizedProps.questionIndex+1<form.memoizedProps.questions.length){form.memoizedProps.questionIndex++;owner.memoizedProps.questionKey.itemId=form.memoizedProps.questions[form.memoizedProps.questionIndex].id;bump()}else hide();
};
document.getElementById('send').onclick=()=>{sent++;if(!failSend)hide()};
document.getElementById('close').onclick=hide;
</script>''')
        page.add_script_tag(content=observer.replace("const token = document.currentScript?.dataset.trackerToken;", "const token = 'fixture';"))
        page.evaluate('window.nativeApi=window.acquireVsCodeApi()')
        page.wait_for_function('messages.length>0')
        resolved = lambda: page.evaluate('messages.flatMap(m=>m.resolvedInputIds||[])')

        ids = page.evaluate('show("partial",2)')
        page.locator('#skip').click()
        page.wait_for_function('(id)=>messages.some(m=>m.resolvedInputIds?.includes(id))', arg=ids[0])
        assert ids[1] not in resolved(), 'only the skipped question clears'
        page.locator('#skip').click()
        page.wait_for_function('(id)=>messages.some(m=>m.resolvedInputIds?.includes(id))', arg=ids[1])
        assert page.evaluate('sent') == 0, 'cancellation does not submit a response'

        ids = page.evaluate('show("rapid",2)')
        page.evaluate('document.getElementById("skip").click();document.getElementById("skip").click()')
        page.wait_for_function('(ids)=>ids.every(id=>messages.some(m=>m.resolvedInputIds?.includes(id)))', arg=ids)

        # A DOM node can retain the alternate (old) React fiber. The committed
        # tree supplies the actual currently selected question.
        ids = page.evaluate('show("alternate",2)')
        page.evaluate('''()=>{const stale={memoizedProps:{...form.memoizedProps},return:owner};document.getElementById('skip')['__reactFiber$fixture']={return:stale};form.memoizedProps.questionIndex=1;owner.memoizedProps.questionKey.itemId=form.memoizedProps.questions[1].id;bump()}''')
        page.locator('#skip').click()
        page.wait_for_function('(id)=>messages.some(m=>m.resolvedInputIds?.includes(id))', arg=ids[1])
        assert ids[0] not in resolved()

        ids = page.evaluate('show("answered")')
        page.locator('#answer').fill('PRIVATE_ANSWER')
        page.locator('#send').click()
        page.wait_for_function('(id)=>messages.some(m=>m.resolvedInputIds?.includes(id))', arg=ids[0])
        ids = page.evaluate('show("closed")')
        page.locator('#close').click()
        page.wait_for_function('(id)=>messages.some(m=>m.resolvedInputIds?.includes(id))', arg=ids[0])

        ids = page.evaluate('show("failed");failSend=true;form.memoizedProps.questions.map(q=>q.id)')
        page.locator('#send').click(); page.wait_for_timeout(180)
        assert ids[0] not in resolved(), 'failed send retains attention'
        page.evaluate('hide()'); page.wait_for_timeout(180)
        assert ids[0] not in resolved(), 'later passive unmount cannot turn failed submission into an answer'
        page.evaluate('route.memoizedProps.value.location.pathname="/local/other";hide()')
        page.wait_for_timeout(180)
        assert ids[0] not in resolved(), 'navigation during send is not an answer'
        page.evaluate('route.memoizedProps.value.location.pathname="/local/chat";failSend=false;bump()')

        ids = page.evaluate('show("passive-hide")')
        page.evaluate('hide()'); page.wait_for_timeout(180)
        assert ids[0] not in resolved(), 'unmount without an action is not cancellation'
        ids = page.evaluate('show("disabled");document.getElementById("skip").disabled=true;form.memoizedProps.questions.map(q=>q.id)')
        page.locator('#skip').dispatch_event('click'); page.wait_for_timeout(180)
        assert ids[0] not in resolved(), 'disabled cancel must not resolve'

        # Native committed atom state can confirm a reply/Skip already made
        # before focus returns, without requiring an observed click.
        for mode in ['answer', 'skip']:
            ids = page.evaluate('(mode)=>show("committed-"+mode)', mode)
            page.evaluate('''mode=>{owner.updateQueue={memoCache:{data:[[{question:{id:owner.memoizedProps.questionKey.itemId},isSubmitting:false,isSkipped:mode==='skip',lastSubmission:mode==='answer'?'PRIVATE_ANSWER':null}]]}};bump()}''', mode)
            page.wait_for_function('(id)=>messages.some(m=>m.resolvedInputIds?.includes(id))', arg=ids[0])
        ids = page.evaluate('show("remote",1,"remote-server")')
        page.locator('#skip').click(); page.wait_for_timeout(180)
        assert ids[0] not in resolved(), 'remote UI does not resolve local question IDs'
        assert page.evaluate('acquisitions') == 1
        assert not page.evaluate('JSON.stringify(messages).includes("PRIVATE_")')
        assert len(resolved()) == len(set(resolved())), 'resolution is emitted once per ID'
        assert errors == [], errors
        print(json.dumps({'passed': True, 'partialSkip': True, 'cancelWithoutReply': True, 'answerAndClose': True,
                          'failedSendRetainsWait': True, 'navigationRetainsWait': True, 'committedAnswers': True,
                          'noPrivateText': True, 'pageErrors': errors}))
    finally:
        browser.close()
