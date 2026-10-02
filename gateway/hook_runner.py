"""Private stdio bridge to Frida; raw TLS plaintext never goes to a log file."""
import base64
import json
import pathlib
import os
import sys
import threading


def run():
    import frida
    from h2_headers import HeaderDecoder
    pid = int(sys.argv[1])
    lock = threading.Lock()
    decoder = HeaderDecoder()

    def emit(event):
        with lock:
            print(json.dumps(event, separators=(",", ":")), flush=True)

    session = frida.attach(pid)
    session.on("detached", lambda reason, crash: emit({"type": "detached", "reason": reason}))
    # Validate PID identity in-process before installing any TLS interceptor.
    probe = session.create_script("rpc.exports = { identity() { return Process.mainModule.path; } };")
    probe.load()
    try:
        if os.path.normcase(os.path.abspath(probe.exports_sync.identity())) != os.path.normcase(os.path.abspath(sys.argv[2])):
            session.detach()
            raise RuntimeError("Process identity changed")
    finally:
        probe.unload()
    script = session.create_script(pathlib.Path(__file__).with_name("native_hook.js").read_text(encoding="utf-8"))

    def message(event, data):
        if event.get("type") == "send":
            value = event["payload"]
            if data is not None:
                # Headers must arrive before DATA from the same TLS record.
                for header in decoder.feed(value, data):
                    emit(header)
                value["bytes"] = base64.b64encode(data).decode("ascii")
            if value.get("type") == "context_closed":
                decoder.close(value["connectionId"])
            emit(value)
        else:
            # No exception dumps containing process memory or private paths.
            emit({"type": "error", "reason": "Native hook callback failed"})

    script.on("message", message)
    try:
        script.load()
        for line in sys.stdin:
            command = json.loads(line)
            if command.get("action") == "stop":
                break
            if command.get("action") == "configure":
                script.exports_sync.configure(command["options"])
                emit({"type": "configured"})
    finally:
        session.detach()


if __name__ == "__main__":
    try:
        run()
    except ImportError:
        print(json.dumps({"type": "error", "reason": "Install the pinned Frida dependency in the selected Python environment"}), flush=True)
        sys.exit(1)
    except Exception:
        print(json.dumps({"type": "error", "reason": "Cannot attach native TLS hook to the selected process"}), flush=True)
        sys.exit(1)
