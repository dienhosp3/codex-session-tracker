# Codex Session Tracker 0.12.22

## Vietnamese quota voice alerts

The Usage alert dialog can optionally read the primary quota percentage in
Vietnamese when two consecutive checks differ. The value is rounded and
clamped to an integer from 0 through 100. Normal changes and large changes
can be enabled independently; the large-change threshold is configurable from
1 through 100 percentage points. Windows speech prefers an installed `vi-*`
voice and falls back to the default Windows voice while preserving Vietnamese
text. The feature is disabled by default and does not change the existing MP3
error, model-capacity or user-input sound choices.

## Retry-limit error alerts, MP3 sound and history (0.12.15)

Tracker watches Codex rollout files in the background, including when its
panel is hidden. A failed `task_complete` or `turn_complete` with structured
`response_too_many_failed_attempts.http_status_code = 429` triggers one
MP3 playback per new error. The exact legacy error message
`exceeded retry limit, last status: 429 Too Many Requests` is also recognized.
Transient retries, unrelated HTTP 429 responses and quoted chat text do not
trigger the alert. This alert does not restart the proxy or send chat messages.

The package includes `media/error_429.mp3`, derived from the supplied
`Phung-Cong.mp3` clip and normalized to an actual MP3 stream. It plays once
per new matching error without extra setup. To replace it, run **Codex Tracker:
Chọn âm thanh lỗi 429 (MP3)** in the Command Palette. The selected absolute path is saved across
reloads; keep the file at that location. Use **Codex Tracker: Nghe thử âm thanh
lỗi 429** to play it once. Playback uses Windows MCI in a hidden process and
does not substitute system beeps. The bundled sound is used until another file
is selected. An unavailable or
invalid file preserves pending notifications for a later retry after selection.

## Session runtime diagnostics and stop

Running and selected sessions show the latest model, reasoning effort and
output-token speed when the rollout provides those records. The **Dừng** button
sends the app-server `turn/interrupt` request for the selected active turn and
reports unsupported or unconfirmed delivery instead of pretending that the
turn stopped.

Use **Codex Tracker: Xem lịch sử lỗi 429** in the Command Palette to open the
saved history. `codex-retry-errors.jsonl` lives in the extension's VS Code
global storage, outside this repository. Each entry includes occurrence and
detection time, conversation title, thread/turn identifiers and the error.
The first scan imports historical errors silently; new errors play the sound.
An error followed by a successful turn before the next scan is still recorded.

File cursors persist across reloads. Duplicate rollout copies and repeated scans
do not repeat a history entry or its notification. An exclusive history lock
coordinates windows. Failed history writes retry before advancing the cursor;
pending sound deliveries survive reloads. History is retained until removed by
the user; builds and repository cleanup do not delete it.

## Restart a local proxy (0.12.13)

The yellow restart icon on the compact **Trạng thái giao tiếp** row restarts
your local proxy EXE. On the first click, choose its `.exe`; Tracker saves the
absolute path in VS Code global extension state for subsequent sessions.
Expand the row and use **…** to change the executable. The tooltip shows the
saved path and latest result. Selecting a replacement path only saves it.
Hover the yellow icon to see the last successful reset (date/time, manual or
automatic, PID and stopped-process count), the last attempt, idle threshold,
running-task count, newest task activity and current watchdog decision.
Successful reset history persists across window reloads. A failed attempt
does not overwrite the last success; older versions did not retain this history.

Restart stops processes whose complete executable path matches the selected
file, rechecks each process before stopping it, waits for exit, and launches
the EXE with its own folder as the working directory. Same-named executables
elsewhere are left alone. With no matching process running, the button starts
the EXE. A missing file or stop failure aborts the restart and preserves the
saved path. The process runs with the current user's permissions and a hidden
window; proxy arguments and Windows-service control are not configured here.
The success message confirms process launch, not proxy endpoint readiness.

Commands: **Codex Tracker: Restart Local Proxy** and
**Codex Tracker: Choose Local Proxy EXE**. Packaging can put the installer
outside this checkout with `CODEX_TRACKER_VSIX_OUTPUT` set to an absolute
`.vsix` filename in an existing directory.

Right-click the yellow icon to enable/disable automatic restart, set the idle
threshold, or change the EXE. Automatic restart starts disabled; the initial
threshold is **5 minutes**. Both values persist. While enabled, background
observations run about every 15 seconds even when the Tracker is hidden and
scan all discovered task rollouts, including chats beyond the visible history
limit. There must be at least one unfinished running task, every such task
must have been inactive for the configured interval, and the observation must
be complete and fresh. A single recently active task prevents restart. Every
restart attempt records a persistent cooldown of the configured interval.

Before either manual or automatic restart, Tracker saves the original running
chat IDs and turn IDs in extension state. For up to ten minutes after restart,
it checks those chats and sends exactly **Tiếp tục công việc (nếu còn)** only
to an original chat that stopped after the snapshot. A chat still running, or
one that has moved to another turn, is left alone. Definite non-delivery may
retry after ten seconds, at most six attempts with the same message UUID;
unknown delivery is retained without an automatic resend. Restart recovery
uses the existing Codex connection and does not open a separate Codex window.
Pending recovery no longer blocks the watchdog for the entire ten-minute
recovery window. A running chat still idle for the configured threshold may
trigger the next reset after the normal cooldown. If recovery attempts to send
a continuation, the watchdog waits for a fresh task scan before another reset.

Stopped-chat composers now attach the same input/event handlers as running
chats. Drafts survive polling and switching chats. Each send has its own
request ID; only the matching successful acknowledgement clears the unchanged
draft. Failed/unknown sends and text edited while sending remain in place.

## Compact account and single usage status item (0.12.11)

The account card contains the current email and **Deactive**, with no login
heading. **Usage** occupies one line inside that same card: remaining quota,
**↻** to check now, and **⚙** to change the interval. Reset times, other buckets
and the last successful check are available in the tooltip. There are no
progress bars or extra information rows. The interval dialog accepts 1–1440
minutes; the default is 5. Set 0 for manual checks. This preference survives
VS Code restarts, and automatic checks continue while the Tracker is hidden.
Overlapping checks share one request. Failed checks retain the previous values
with the error in the tooltip; missing usage is never presented as zero usage.

The single **Codex Usage** item on the right of the VS Code status bar shows
only the primary (5h) remaining percentage, for example `46%`. There are no
separate window labels or extra status items. Hover for all buckets, both
window percentages, reset times and the configured interval. Missing primary
quota is never replaced with the weekly percentage. The Usage row inside the
account card still shows both windows, for example `5h 55% - 7d 93%`, with
yellow and green percentages.
Click it, or run **Codex Tracker: Check Usage**, to refresh the same data shown
in the Tracker. Both locations show remaining quota; the tooltip identifies it. The
Command Palette also exposes **Codex Tracker: Set Usage Check Interval**.

Usage comes from `account/rateLimits/read` through the existing Codex Extension
connection. It uses the quota data documented in the
[official OpenAI documentation](https://developers.openai.com/codex/app-server/).
It does not estimate quota from chat messages or token counts.

The name of the conversation currently displayed in Codex is yellow in the
Tracker. This follows Codex's current local route, including changes made in
Codex itself, separately from the row selected in the Tracker. For multiple
Codex surfaces, the most recently focused one determines the current chat.
Leaving the chat route clears the highlight. Opening Tracker never navigates
Codex automatically.

After installing this update, reload the VS Code window once so the observer
loads with Codex. The observer is added to newly initialized webview HTML in
memory, using a Tracker-owned script. Native extension files on disk remain
untouched. It reads the committed router location, not conversation contents.
This integration follows the installed Codex implementation and can require
an update if the native webview internals change.

**Trạng thái giao tiếp** is collapsed to one line by default. Click the line,
or focus it and press Enter/Space, to expand the existing controls. Expanded
state, settings drafts and focus survive Tracker refreshes.

## Compact login card (0.12.8)

**Phiên đăng nhập Codex** shows the current account email and a single
**Deactive** button. The card contains no Codex Home path or explanatory text.
The account label comes from `account/read` on the existing Codex Extension
connection with `refreshToken: false`; Tracker does not read credentials to
display it. Account metadata is refreshed while the Tracker is visible.

## Open the selected conversation in Codex (0.12.7)

Click a conversation in **Đang chạy** or **Không chạy** to select its Tracker
details and open that exact existing thread in the Codex sidebar in the same
VS Code window. Enter and Space on a conversation row do the same. Selecting
the same row again reopens it after navigating elsewhere in Codex.

Navigation activates Codex when needed and uses its existing sidebar route
queue, including while the sidebar is loading. Rapid selections keep the newest
choice. Restoring Tracker state or polling never switches the Codex conversation.
If navigation fails, Tracker retains the selected details and shows an error.

This integration locates the running Extension URI handler without editing the
OpenAI extension or opening an OS protocol link. It depends on Codex internals;
unsupported layouts fail explicitly. Opening a conversation sends no prompt or
turn request. It does not use the queue, steer, or continuation APIs.

## Deactivate the current login (0.12.6)

Use **Deactive** in the **Phiên đăng nhập Codex** card,
or run **Codex Tracker: Deactivate (Xoá phiên hiện tại)** from the Command Palette.
The card is available even without a selected conversation. Deactivation targets
Tracker's configured `codexHome`, then `CODEX_HOME`, then `~/.codex`.

This follows Swapper Codex 0.3.0's deactivation mechanism: replace `auth.json`
with `{ "OPENAI_API_KEY": null, "tokens": null }`, then offer to reload VS Code.
Tracker writes the replacement atomically without reading, logging, or backing
up credentials. Conversation files, indexes, settings, and Swapper's saved
accounts are untouched. This clears the saved file login; it does not revoke
tokens on the server or clear other credential stores/environment API keys.

Choose **Reload ngay** to apply it in this window, or **Để sau** to defer
until **Developer: Reload Window**. Other running Codex windows need
their own reload to discard credentials already in memory. Deactivation does
not run automatically on activation or installation.

## Continue a completed conversation (0.12.5)

Open **Không chạy**, select a completed conversation, then enter the
next request and click **Tiếp tục chat** (or press **Ctrl+Enter**). Text and image
attachments are supported. This starts a new turn in the same thread; while a
chat is running the composer continues to show **Steer ngay** and **Gửi sau**.

Tracker finds the existing Extension owner, including threads still loaded by
its app-server after the webview stopped advertising ownership. If no owner is
found, the local Extension connection can resume the existing stopped thread.
It checks the backend thread and latest turn before sending. It does not spawn
another app-server or interrupt a running job. A lost acknowledgement is shown
as an unknown outcome and does not trigger an automatic resend. Drafts are
retained on failure, including when the selected conversation changes.

Verified with Extension **26.930.41038** and bundled CLI **0.160.0**. The current
`thread-follower-start-turn` IPC method uses version **2**. Fresh threads whose
backend returns `list_turns is not supported yet` are checked with
`thread/read(includeTurns: true)` instead. An isolated completed chat received
new turns through its existing owner in another VS Code window and completed
them; the test chat was then deleted. This test does not establish that every
gray-webview failure is resolved.

## Steer while the Codex webview is gray (0.12.4)

The native IPC owner discovery uses cached ownership, but native steer discovery
asks the webview for its role again. A non-responsive webview can therefore
return `no-client-found` even while its app-server and turn are still running.
Tracker now reports these two failures separately.

On activation, Tracker installs an opt-in bridge into the existing Codex
Extension host. It adds a provider to the existing app-server connection and
advertises the bridge through the existing owner IPC router. Tracker steer
checks `thread/loaded/list`, the live thread status, and the newest turn before
calling `turn/steer` with `expectedTurnId`. It does not spawn, resume, start,
interrupt, or replace the owning app-server. Native Codex followers retain their
original handlers. Deactivating Tracker restores those handlers.

The bridge binds existing objects using an in-process inspector session without
pausing execution or opening a debugger port. This is an internal Extension
integration, so a changed module layout may require another compatibility fix.
If the owning Extension host or app-server has died, it cannot steer that lost
turn. A timeout after sending remains an unknown outcome and is never retried
automatically.

Verified with installed Extension **26.930.41038**, bundled CLI **0.160.0**.
The investigated historical rollout records CLI **0.159.2**, model
**gpt-6.1-sol**; those values are separate from the currently installed runtime.
Live direct steer returned an ACK in 14 ms on the existing turn. During this
investigation the owner was restarted externally, so the live test proves the
direct backend route, while regression tests cover a non-responsive webview.
Provenance and the verification note are retained under `artifacts/checkpoints`.

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
codex-session-tracker-0.12.21.vsix
```

Install:

```powershell
code --install-extension .\codex-session-tracker-0.12.21.vsix --force
```

Then run **Developer: Reload Window** once.

## Clean generated repository files

Run `python cleanup_repo.py` to list generated installers, build/test caches,
screenshots and test logs without deleting anything. Run
`python cleanup_repo.py --delete` to remove that list. Source, tests, the main
Git database and JSON/Markdown verification records are preserved.

The full cleanup also removes the generated `runtime/bin` after checking that
an identical runtime exists in an installed Tracker extension. Installed
extensions and Codex accounts are outside its scope. Rebuild that binary with
`scripts/build-runtime.ps1` before packaging again, or use
`python cleanup_repo.py --delete --keep-runtime` to retain the packaging binary.

For double-click deletion on Windows, open **XOA_RAC.py**. It runs the same
guarded cleanup with `--delete` and waits for Enter afterwards so the result
stays visible. If Windows opens an editor, use **Open with → Python** for this
file. `cleanup_repo.py` without arguments remains a preview.

## Automated tests

```powershell
npm test
```

Gateway integration tests use local fake endpoints only. They do not call the real OpenAI service.
