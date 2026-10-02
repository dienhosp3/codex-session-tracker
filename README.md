# Codex Session Tracker 0.12.3

## Saved event search (0.12.3)

Opening a log folder indexes request summaries and the original timeline records,
including `response.created`, delta events, completion, BODY, headers and errors.
Search and IN/OUT filters work on those event rows. Selecting an event opens its
own payload; the request/response/events tabs still open the corresponding files.
Timeline metadata is streamed when indexing. Event payloads are loaded on demand
with cached file offsets; opening a folder does not load all response bodies.

## Original client BODY boundaries (0.12.2)

- Each HTTP BODY record preserves one frame from the Codex HTTP client. Each
  WebSocket BODY record preserves one complete client message. Tracker no longer
  divides HTTP frames into 64 KiB pieces. These boundaries are not TCP packets or TLS records.
- Client captures retain every byte of the observed frame, including binary and
  UTF-8 fragments. SSE events are derived records alongside the original BODY.
- Removed the content capture size setting and plaintext pagination controls.
  Selected BODY records and saved files load in full. Historical divided/truncated
  captures retain their original limitations; their boundaries cannot be restored.
- Bridge messages that exceed its transport limit or cannot be queued produce
  explicit capture gaps rather than being divided or silently shortened.
- Runtime instrumentation version 2 must be deployed for this behavior. If the
  JSON hook is already enabled, disable it and enable it again after installing.

## Plaintext reader (0.12.1)

- Copy plaintext or headers using the VS Code clipboard.
- Live updates preserve the plaintext element and its scroll position; selecting
  another event or saved-file tab resets it.
- Colored HEADER/BODY/FINISHED labels explain metadata, content chunks and stream
  end milestones. FINISHED alone does not mean model success; `response.completed`
  is a separate semantic event. Proxy/native end records may include an assembled body.

VS Code tracker for Codex sessions with lifecycle-aware activity, queue/steer controls, a loopback transport Gateway, reversible proxy routing, and a dedicated traffic monitor.

This build targets **Codex in VS Code on Windows 10**.

## Client JSON hook, raw events and traffic files

Open **Codex Tracker: Open Traffic Monitor**, then **Bật hook JSON + Reload**.
This release bundles a Windows x64 Codex runtime built from upstream
`rust-v0.159.2` (`ff6aec96948b70d94983af2641a6b67c94faeff5`). It replaces
`chatgpt.cliExecutable` reversibly and retains the installed extension's sandbox
and code-mode helpers. Enabling checks the installed bundled CLI version and
the runtime SHA-256. **Gỡ hook JSON + Reload** restores the previous setting.
The original bundled executable is not overwritten.

The hook runs before JSON compression/signing and WebSocket framing/TLS.
Requests with no matching rules retain their exact JSON bytes. Responses are
observed in the shared HTTP body and WebSocket client before Codex reduces them.
SSE parsing preserves all event types, including `response.in_progress` and
unknown future events. The UI displays actual method, host, endpoint, response
ID, item ID, sequence number, and before/after body hashes. WebSocket JSON frames
are associated with their actual **GET** upgrade endpoint.

**Bộ lọc JSON outbound** accepts an array of exact host/method/path rules.
Operations use JSON Pointer (`add`, `replace`, `remove`), with optional
`conditions` and `protocol`. An empty array leaves requests unchanged.
For example, adapting the pointer to the observed payload:

```json
[
  {
    "id": "steer-text",
    "host": "chatgpt.com",
    "method": "POST",
    "path": "/backend-api/codex/responses",
    "conditions": [{"path": "/type", "equals": "response.create"}],
    "operations": [{"op": "replace", "path": "/input/0/content/0/text", "value": "New message"}]
  }
]
```

Filters can change JSON length. Model changes and unsafe JSON pointers are
rejected. A filter error or missing Gateway acknowledgement blocks that request
before upstream send. The temporary loopback bridge credential lives in a
directory with access restricted to the current Windows user and is removed on
deactivation; Codex authentication headers/files are not read by the bridge.
Request and response bodies are captured as requested.

### Capture limits and saved folders

Default capture mode is **Chỉ bắt POST / GET**. Other methods and transport-only
CONNECT/tunnel/TLS records are excluded when recording, independently of display
filters. **Tối đa request/phiên** accepts 1–10000 (default 1000). It counts logical
requests; accepted requests keep receiving their full response/events after the
limit is reached. Use **Phiên mới** to start a new capture session. This limit
does not block Codex network requests. Live display retains the latest 2500
events; saved files remain available after those rows leave the display.

POST/GET saving defaults to the Windows Documents folder's **Codex Logs**.
**Chọn nơi lưu** selects another directory. Existing requests finish in their
original folders; new requests use the new directory. Folder timestamps are UTC:

```text
Documents/Codex Logs/
  2026-10-02/<session timestamp>/backends/
    chatgpt.com/
      codex-responses/<request timestamp>-POST-<request key>/
        request.json
        request.body
        request.original.body         (only when modified)
        response.json
        response.body
        response.events.jsonl
        timeline.jsonl
      endpoints/<other endpoint>-<key>/<request folder>/
```

`/backend-api/codex/responses` has its own `codex-responses` directory. Backend
hosts are separate. Client-hook body files retain complete observed chunks;
the plaintext viewer loads the selected capture in full. Optional proxy/native
captures retain their encoding and any historical truncation metadata in `captures.jsonl`.
Capture gaps and disk errors are explicit; gaps have their own JSONL records.
Streaming outbound bodies that do not expose buffered bytes are marked
unavailable. The loopback bridge accepts at most 64 MiB per message; observation
queues are bounded. These limits report gaps rather than dividing BODY records.

**Mở log** opens a saved folder inside Traffic Monitor. Filter separately by
backend, endpoint, Responses group, method, session, and time. Saved requests
have request/response/events/timeline tabs with paged payload loading. **Live**
returns to active capture. Opening a folder never replays requests.

### Build and verification

`scripts/build-runtime.ps1` requires Git, Rust/MSVC, Node and OpenSSL for the
loopback TLS fixture. It pins the source revision, runs the client integration
fixture, copies the binary/licenses, records `runtime/manifest.json`, and runs
the checkpoint helper with fresh VS Code discovery. Incremental compilation is
disabled. It removes its Cargo target cache by default after retaining artifacts;
`-KeepBuildCache` opts into keeping that cache.

The shipped runtime uses the `dev-small` profile. Its runtime/version/hash and
source/toolchain provenance are separate from the installed Extension and its
official `bundledCli` provenance. Identical CLI version strings do not make the
two binaries identical.

Verification uses an ephemeral HTTPS/WSS loopback backend with a fixture-only
trusted leaf, without installing certificates or sending real model requests.
It checks longer JSON edits before zstd and WebSocket framing, unchanged model,
server-confirmed body hashes, all five requested events in order, rejected sends,
and complete POST/GET log files. See `artifacts/verification/client-runtime.json`.

```powershell
node --test test/*.test.js
powershell -NoProfile -File scripts/build-runtime.ps1
bash build-vsix.sh
```

## Optional Schannel instrumentation

Traffic Monitor now includes **Cài hook**, **↻ Codex PID**, and **Bật plaintext**.
Install the helper once, select the existing Extension app-server PID, then attach.
Python must be available on PATH. Dependencies are pinned in
`gateway/hook-requirements.txt` and installed in an isolated environment under
VS Code global storage. They are not installed into system Python.

This mode uses Frida to intercept Windows Schannel `EncryptMessage` before TLS
encryption and `DecryptMessage` after decryption, inside the existing process.
It does not change the backend URL, certificate trust, model, or thread owner.
Stopping capture detaches the interceptor; restarting Codex requires attaching
to its new PID. Hooks run without waiting synchronously for the dashboard.

Parsed events show **method + endpoint path**, not just the destination host:

```text
POST /backend-api/codex/responses
GET /v1/models
```

HTTP/1 headers and bodies are reconstructed across TLS records. HTTP/2 HPACK
headers are decoded with a separate decoder for each direction; DATA is linked
to the endpoint by stream ID. WebSocket frames retain their upgrade endpoint.
Authorization/cookie headers and query values are excluded from recorded
metadata. Body capture is explicitly enabled by **Bật plaintext** and is bounded
by the configured capture limit. Header details are available by selecting the
corresponding `PLAINTEXT_HTTP_HEADERS` event. HTTP bodies are available as live
fragments and a bounded assembled `PLAINTEXT_HTTP_BODY_FINISHED` event.

If the hook attaches after a connection's headers were sent, the endpoint can
be unknown. Missing HPACK state is reported as `ENDPOINT_UNAVAILABLE`; unknown
raw bytes are discarded rather than guessed or persisted as an HTTP body.

### Outbound modification

`NativeInstrumentation.setOutboundRules()` installs host-scoped, equal-length
byte substitutions before `EncryptMessage`. No rules are active by default;
the user-specific filter interface is pending the requested filter definition.
Each actual edit produces `PLAINTEXT_OUTBOUND_MODIFIED` with before/after hashes.
This event proves a local plaintext edit, not remote server acceptance.

This primitive cannot change HTTP body lengths, repair compressed bodies,
reassemble matches spanning TLS records, or edit decoded masked WebSocket JSON.
Those operations need an HTTP client hook before compression/framing. The
Schannel adapter does **not** support arbitrary JSON transformation; use the
client JSON runtime above for that.

### Verified coverage and remaining limitation

The installed Extension discovered for this work is `openai.chatgpt`
`26.928.31416`, with bundled CLI `0.159.2`. The binary contains both Schannel
and Rustls. The Schannel interceptor attaches to the existing bundled
app-server and has been verified with a real Windows loopback TLS exchange:
outbound and inbound plaintext, endpoint extraction, and a server-confirmed
same-length body edit. No real model request was generated by this test.
An additional observe-only attach to the installed Codex app-server saw real
outbound/inbound Schannel plaintext for `POST /otlp/v1/metrics`. This is
telemetry evidence; it does not establish model/steer payload coverage.

**Rustls traffic is not intercepted by this Schannel hook.** In particular,
the presence of hooks in a Codex process is not proof that its Responses or
WebSocket transport uses them. The UI distinguishes `hook ATTACHED` from
`plaintext SEEN`. Full coverage of the current native client still requires a
verified Rustls/client-level adapter or an instrumented Codex runtime. This
adapter is experimental. The client JSON runtime above observes the shared
HTTP/WebSocket client across both TLS implementations.

Native helper tests (Windows, with the pinned dependencies installed):

```powershell
python test/h2_headers_test.py
python test/native_hook_integration.py
```

## Transport architecture

0.10.0/0.10.1 experimented with rewriting `chatgpt_base_url` to an HTTP localhost backend. That was the wrong layer for ChatGPT-authenticated Codex because workspace routing validates the application backend as an HTTPS origin.

0.10.2 no longer rewrites the ChatGPT backend URL.

Instead:

```text
VS Code Codex
    |
    | HTTP_PROXY / HTTPS_PROXY
    v
127.0.0.1:<gateway-port>
    |
    | CONNECT / ordinary forward proxy
    v
original HTTPS backend
```

The original destination remains `https://...`, so account/workspace routing still sees the real HTTPS origin.

When proxy mode or the proxy port changes, the Tracker reloads the VS Code window so the Codex extension starts with the new proxy environment.

Any legacy localhost `chatgpt_base_url` override created by 0.10.0/0.10.1 is automatically reverted before normal 0.10.2 startup.

## Gateway UI

Gateway settings are controlled from the Tracker UI rather than requiring manual edits.

Available controls include:

- local Gateway on/off;
- loopback port;
- Codex forward-proxy on/off;
- optional content capture where plaintext is available;
- capture-size limit;
- local trace rotation limit;
- one-click proxy enable + VS Code reload;
- one-click proxy disable / legacy route restore;
- dedicated Traffic Monitor.

The Gateway listens on `127.0.0.1` only.

## Dedicated Traffic Monitor

Open it with:

```text
Codex Tracker: Open Traffic Monitor
```

or **Mở Traffic Monitor** in the Tracker panel.

The monitor provides:

- visual **PAUSE ALL**;
- independent **PAUSE OUT**;
- independent **PAUSE IN**;
- direction filter: All / OUT / IN / Control;
- host/API filter when path information is available;
- text search;
- timestamps, byte counts, status, connection/request IDs;
- per-event details.

Pause controls freeze only the monitor presentation. They never pause or delay live Codex network traffic.

This is intentional: the diagnostic UI must not create the network stall it is trying to diagnose.

## HTTPS visibility

The 0.10.2 default transport is an ordinary HTTPS CONNECT pass-through proxy.

Therefore it can authoritatively observe:

- CONNECT destination;
- connection open/close/error;
- OUT byte flow;
- IN byte flow;
- timing;
- reconnect behavior;
- total bytes.

But HTTPS payload bytes remain encrypted inside the tunnel.

The UI must not label encrypted CONNECT bytes as a plaintext API request or response body.

Plaintext body/frame capture remains available for traffic that reaches the Gateway without an encrypted CONNECT tunnel. Exact HTTPS body inspection requires a separate trusted TLS-inspection or application-layer instrumentation mode.

## Steer semantics

A local steer acknowledgement is not proof that the remote server consumed the steer.

The Gateway keeps stages such as:

```text
LOCAL_CREATED
IPC_SENT
OWNER_DISCOVERED
OWNER_ROUTED
CORE_ACCEPTED
LOCAL_PERSISTED
UPSTREAM_REQUEST_OPENED
UPSTREAM_BYTES_SENT
UPSTREAM_RESPONSE_HEADERS
UPSTREAM_FIRST_EVENT
TURN_COMPLETED
```

Only evidence actually observed is emitted.

If the current transport exposes only encrypted tunnel bytes, the Tracker reports transport activity separately rather than fabricating model/API confirmation.

## Queue and Steer

### Steer ngay

Uses the currently running Codex Extension owner through its IPC path. It does not start a competing long-lived owner.

If delivery may already have happened before a disconnect/timeout, state remains unknown. The Tracker never silently retries and never silently converts steer to queue.

### Gửi sau

Uses the official Codex queue CLI flow for the exact thread.

## Legacy config recovery

The repository keeps the old config snapshot/revert helper only to safely migrate users who enabled the 0.10.0/0.10.1 localhost backend experiment.

0.10.2 does not create a new localhost `chatgpt_base_url` override.

## Privacy

Runtime traces are stored under the extension's VS Code `globalStorageUri`, not in the repository.

Authorization, cookies, API keys and secret-like headers are redacted from diagnostic logs. Sanitized diagnostic export excludes raw body content and headers.

## Build and install

Run tests:

```powershell
npm test
```

Build on Windows with Git Bash:

```powershell
& "C:\Program Files\Git\bin\bash.exe" ./build-vsix.sh
```

Expected artifact:

```text
codex-session-tracker-0.10.2.vsix
```

Install:

```powershell
code --install-extension .\codex-session-tracker-0.10.2.vsix --force
```

Then run **Developer: Reload Window** once.

## Automated tests

```powershell
npm test
```

Gateway integration tests use local fake endpoints only. They do not call the real OpenAI service.
