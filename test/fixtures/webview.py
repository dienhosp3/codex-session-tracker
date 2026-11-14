"""Assemble the repository webview assets for isolated browser interaction tests."""
import re
def dashboard(root, nonce='ui-test', include_shim=True):
    html=(root/'media/dashboard.html').read_text(encoding='utf-8')
    def asset(match):
        name,kind=match.groups()
        return (root/'media'/(name.lower()+'.'+kind.lower())).read_text(encoding='utf-8')
    html=re.sub(r'/\*__([A-Z_]+)_(JS|CSS)__\*/',asset,html)
    html=re.sub(r'<!--__([A-Z_]+)_(HTML)__-->',asset,html)
    html=re.sub(r'__([A-Z_]+)_(HTML)__',asset,html).replace('__NONCE__',nonce)
    if not include_shim:return html
    shim='<script nonce="'+nonce+'">window.__messages=[];window.acquireVsCodeApi=()=>({getState:()=>({}),setState:()=>{},postMessage:m=>__messages.push(m)});</script>'
    return html.replace('<script nonce="'+nonce+'">',shim+'<script nonce="'+nonce+'">',1)
