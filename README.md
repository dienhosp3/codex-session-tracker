# Codex Session Tracker 0.10.1

A VS Code tracker for Codex sessions with lifecycle-accurate local control, a loopback Codex Gateway, reversible Windows/VS Code routing, and optional full request/response inspection. Gateway settings are persisted by the Tracker UI itself; the extension no longer writes Gateway values into VS Code User Settings.

This build is designed for the user's current environment: **Codex inside VS Code on Windows 10**. It does not require manually editing `config.toml` for normal Gateway use.

## What 0.10.0 changes

The Gateway UI now owns the complete diagnostic setup:

- start/stop the local Gateway;
- choose the loopback port;
- enable/disable model/backend proxying;
- choose the real upstream base URL;
- enable/disable full body/frame capture;
- configure per-body/frame capture size;
- configure trace rotation size;
- backup the original Codex `config.toml`;
- route VS Code Codex through the local Gateway;
- reload VS Code automatically;
- revert only the Tracker-managed route while preserving later unrelated config edits;
- optionally restore the exact original config snapshot;
- inspect captured HTTP input/output and WebSocket frame contents directly in the Tracker UI.

The one-click action is:

```text
Bật bắt toàn bộ + backup config + Reload
```

No manual TOML editing is required.

## Why the Gateway exists

A successful local steer acknowledgement is not proof that the remote Codex/OpenAI service received or consumed that steer. Codex may accept input locally while rollout persistence, sampling, network transport, or UI reconciliation are still pending.

The tracker therefore records explicit evidence stages:

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
CODEX_CONSUMED_RESPONSE
TURN_COMPLETED
```

Timing-only correlation is marked `heuristic`; rollout/message correlation can be `correlated`; direct protocol evidence is `authoritative`.

The UI deliberately says:

```text
Codex local đã nhận steer vào turn đang chạy; chưa đồng nghĩa server đã nhận.
```

after the current Extension owner/Core acknowledgement.

## Local Gateway

Default listen address:

```text
127.0.0.1:8765
```

The Gateway never binds to `0.0.0.0` by default. Control endpoints require a random in-memory token and reject non-loopback clients.

When managed routing is enabled, the Tracker patches only the root-level Codex setting:

```toml
chatgpt_base_url = "http://127.0.0.1:<PORT>/backend-api"
```

Before the patch, the exact original `config.toml` is copied into VS Code extension `globalStorageUri`. The Tracker also remembers the previous Gateway settings.

### Safe revert

The UI exposes two revert modes.

`Revert an toàn + Reload` restores the original `chatgpt_base_url`. If `config.toml` changed after Gateway activation, unrelated later edits are preserved.

`Khôi phục snapshot gốc + Reload` restores the exact original file snapshot and is intentionally explicit because it can overwrite later manual changes.

If the original `config.toml` did not exist, exact revert removes the Tracker-created file.

## Full input/output viewer

When **Capture và cho xem nội dung đầy đủ request/response** is enabled, the Gateway records the actual proxied body/frame content locally and exposes it inside the Tracker UI.

HTTP inspection includes:

- request chunks while they are transmitted;
- the assembled request body;
- response chunks while the backend is streaming;
- the assembled response body;
- method/path/status/byte counts/timing/fingerprint.

WebSocket inspection includes:

- direction: Codex → server or server → Codex;
- opcode and frame size;
- decoded text-frame content when not compressed;
- base64 for binary/compressed frames;
- SHA-256 payload fingerprints;
- connection/open/close timing.

Transport forwarding is never truncated by the viewer. Only stored/displayed capture is bounded by the configured per-event capture limit.

This matters for diagnosing the observed failure mode:

```text
Codex local accepts steer
        ↓
no model request for a long time
        ↓
Codex/VS Code restarts
        ↓
old payload suddenly appears upstream
```

The Gateway keeps payload fingerprints across recent persisted trace data so delayed/replayed traffic can be identified without relying only on UI state.

## Traffic truthfulness

The UI distinguishes:

```text
model proxy: TẮT
model proxy: THIẾU UPSTREAM
model proxy: SẴN SÀNG, CHƯA THẤY TRAFFIC
model proxy: ĐÃ THẤY TRAFFIC
```

A listening proxy is not called active server traffic. Only an observed `MODEL_REQUEST` or `MODEL_STREAM` marks model traffic as seen.

Auth, thread-sync, metadata, telemetry and unknown requests can still be displayed in the traffic viewer, but they never count as evidence that a steer reached model transport.

## Content privacy

Full capture is intentionally optional because request/response bodies can contain prompts, code, file contents, tool data or other sensitive material.

When capture is enabled:

- raw captured content remains local under VS Code extension `globalStorageUri`;
- trace files rotate by the configured local size limit;
- `Authorization`, cookies, API keys, bearer tokens and secret-like headers are redacted;
- unknown headers are omitted from diagnostic logs;
- the sanitized **Export Gateway Diagnostics** report intentionally excludes raw body/frame content and headers.

The exact original Codex config backup also remains local and is not included in diagnostic export.

## HTTP and WebSocket transport

No custom root CA or HTTPS MITM is used.

Topology:

```text
VS Code Codex
    ↓ HTTP / WS
127.0.0.1 Gateway
    ↓ HTTPS / WSS
real ChatGPT/Codex backend
```

The Gateway streams HTTP bodies instead of buffering the complete request before forwarding it, so the diagnostic layer does not intentionally add a full-body delay.

## Steer and Queue

### Steer ngay

Uses the installed Codex Extension's live IPC owner. It never creates a competing long-lived owner.

If IPC disconnects or times out after the steer may have been transmitted, delivery remains unknown. There is no automatic resend and no silent conversion to queue.

### Gửi sau

Uses the official Codex queue command:

```text
codex queue --thread <ROOT_THREAD_ID> --message <TEXT>
```

Queue and steer remain distinct operations.

## Replay diagnostics

Outbound model request bodies and WebSocket payloads receive SHA-256 fingerprints.

A matching later payload can produce:

```text
POSSIBLE_REPLAY
```

Replay detection remains observe-only. It does not block or automatically retry traffic.

## Stop/Interrupt limitation

The public Codex app-server protocol includes `turn/interrupt`, but the Tracker still does not invent an unverified follower IPC method for the installed VS Code owner.

Normal Stop must not be implemented by killing `codex.exe`.

## Session tracking

The tracker continues reading:

```text
<CODEX_HOME>/session_index.jsonl
<CODEX_HOME>/sessions/**/rollout-*.jsonl
```

It preserves root/child lifecycle separation, ignores stale orphan children after a terminal root, uses no wall-clock timeout to decide whether a turn is running, and prefers Codex state/index timestamps when available.

The non-running tab can delete a stopped chat through Codex's native `thread/delete` operation after rechecking lifecycle state. That helper may start a short-lived isolated `codex app-server --stdio`; steering still uses the live Extension owner.

## Build and install

From Git Bash:

```bash
bash ./build-vsix.sh
```

Expected artifact:

```text
codex-session-tracker-0.10.1.vsix
```

Install from PowerShell:

```powershell
code --install-extension .\codex-session-tracker-0.10.0.vsix --force
```

Then run **Developer: Reload Window** once after installing a new VSIX.

## Tests

```bash
npm test
```

Automated Gateway tests use local fake servers only; they do not call the real OpenAI service.
