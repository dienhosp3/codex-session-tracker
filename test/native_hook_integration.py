"""Explicit Windows loopback test, no Codex owner or real upstream traffic."""
import json
import pathlib
import subprocess
import sys
import time

import frida

root = pathlib.Path(__file__).resolve().parent.parent
process = subprocess.Popen(["powershell.exe", "-NoProfile", "-NonInteractive", "-File", str(root / "test/native_tls_fixture.ps1")],
                           stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
session = None
events = []
errors = []
try:
    assert process.stdout.readline().strip() == "READY", "TLS fixture did not start"
    session = frida.attach(process.pid)
    script = session.create_script((root / "gateway/native_hook.js").read_text(encoding="utf-8"))

    def message(event, data):
        if event.get("type") == "send":
            events.append((event["payload"], bytes(data) if data is not None else b""))
        else:
            errors.append(event.get("description", "Hook failed"))

    script.on("message", message)
    script.load()
    script.exports_sync.configure({"capture": True, "rules": [{"host": "localhost", "find": list(b'"old"'), "replace": list(b'"new"')}]})
    process.stdin.write("start\n")
    process.stdin.flush()
    stdout, stderr = process.communicate(timeout=20)
    assert process.returncode == 0, "TLS fixture failed: " + stderr
    assert "MODIFIED" in stdout, "Upstream did not receive the changed plaintext"
    assert not errors, errors
    out = b"".join(data for event, data in events if event.get("direction") == "out")
    incoming = b"".join(data for event, data in events if event.get("direction") == "in")
    assert b'POST /fixture/responses HTTP/1.1' in out
    assert b'{"value":"new"}' in out
    assert b'{"reply":"yes"}' in incoming
    assert any(event.get("targetHost") == "localhost" for event, _ in events)
    assert any(event.get("type") == "mutation" and event.get("originalSha256") != event.get("bodySha256") for event, _ in events)
    print(json.dumps({"passed": True, "endpoint": "POST /fixture/responses", "outBytes": len(out), "inBytes": len(incoming), "upstreamReceivedModifiedBody": True}))
finally:
    if session:
        try:
            session.detach()
        except frida.InvalidOperationError:
            pass
    if process.poll() is None:
        process.kill()
