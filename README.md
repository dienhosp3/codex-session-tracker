# Codex Session Tracker 0.9.0

A VS Code tracker for Codex sessions with lifecycle-accurate activity, safe queue/steer controls, and a loopback diagnostic Gateway for separating **local Codex acceptance** from **actual upstream model traffic**.

## Why the Gateway exists

A successful local steer acknowledgement is not the same thing as proof that the remote Codex/OpenAI service received or consumed that steer. Codex may acknowledge a turn locally while prompt hooks, rollout persistence, model sampling, network transport, or UI reconciliation are still pending.

Version 0.9.0 therefore records explicit delivery stages instead of showing one ambiguous "sent" state:

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

Only stages with actual evidence are emitted. Timing-only network correlation is marked `heuristic`; rollout/message correlation can be `correlated`; direct protocol evidence is marked `authoritative`.

The tracker deliberately says **"Codex local đã nhận steer"** after the current Extension owner acknowledges a steer. It does not call that server delivery.

## Local Gateway

The extension starts a local Gateway by default on:

```text
127.0.0.1:8765
```

It never binds to `0.0.0.0`.

Control endpoints are protected by a random in-memory token and accept loopback clients only. The health endpoint intentionally does not expose that token.

Runtime traces are written under the VS Code extension's per-user `globalStorageUri`, not into the repository. They are JSONL metadata and do not contain prompt/response bodies by default. Use **Codex Tracker: Export Gateway Diagnostics** to save a filtered JSON report; the export omits headers and any unrecognized/raw body fields.

The Gateway currently handles:

- tracker -> Gateway -> existing Codex Extension owner steer;
- tracker -> Gateway -> official Codex CLI queue;
- stable `gatewayCommandId` and `clientUserMessageId` correlation;
- local rollout persistence observation;
- optional HTTP Responses reverse proxy;
- optional WebSocket Responses reverse proxy;
- HTTP timing and response milestones;
- WebSocket frame metadata (direction/opcode/size/timestamp only);
- request-body SHA-256 fingerprints for replay diagnostics;
- `POSSIBLE_REPLAY` observation without automatic blocking;
- diagnostic classifications such as `LOCAL_ACCEPTED_NO_UPSTREAM` and `UPSTREAM_NO_FIRST_BYTE`.

The Gateway does **not** automatically change Codex's model/network configuration. Model proxy mode must only be enabled after the installed Codex runtime is configured to use the local base URL.

## Model proxy mode

Settings:

- `codexSessionTracker.gateway.enabled` — start/stop the local Gateway.
- `codexSessionTracker.gateway.port` — loopback port, default `8765`.
- `codexSessionTracker.gateway.modelProxyEnabled` — enable HTTP/WS reverse proxying.
- `codexSessionTracker.gateway.upstreamBaseUrl` — real upstream base URL, for example a ChatGPT backend base path.

When model proxy mode is **off**, the Gateway still records local control-plane stages, but it cannot claim that Codex model traffic is captured.

When model proxy mode is configured, the UI distinguishes **SẴN SÀNG, CHƯA THẤY TRAFFIC** from **ĐÃ THẤY TRAFFIC**. Readiness only means the reverse proxy is listening with an upstream configured; it does not prove the installed Codex owner is routed through it. Only an observed `MODEL_REQUEST` or `MODEL_STREAM` marks model traffic as seen.

To prepare the current Gateway address for Codex, run the VS Code command **Codex Tracker: Copy Gateway Codex Config**. It copies a root-level `chatgpt_base_url` snippet for the current loopback port. Paste it into the `config.toml` under the active `CODEX_HOME`, then restart the Codex owner. Do not put this override in project-local config. The tracker does not silently edit the user's Codex configuration.

When the installed Codex owner is actually configured to use the Gateway base URL, HTTP and WebSocket model traffic can be correlated with recent steer commands. Non-model requests such as auth, thread sync, metadata, or telemetry are traced separately and never count as proof that a steer reached the model transport.

No TLS root certificate or HTTPS MITM is used. Codex connects to the local HTTP/WS Gateway; the Gateway opens HTTPS/WSS to the configured upstream.

### Network trace safety

The Gateway does not persist model request or response bodies by default.

Stored metadata can include:

- method and sanitized path;
- request/connection ID;
- request/response byte counts;
- request-body SHA-256;
- connect/request/response timestamps;
- upstream status code;
- WebSocket frame direction, opcode, size, and timestamp;
- disconnect/error code.

Headers containing authorization, cookies, tokens, secrets, or API keys are redacted.

## Sending while the Codex panel is gray

The composer has two separate actions.

### Steer ngay

Uses the installed Codex Extension's live IPC router and the existing owner for the selected conversation. It never creates a second owner.

A successful owner/Core acknowledgement is shown as local acceptance only:

```text
Codex local đã nhận steer vào turn đang chạy; chưa đồng nghĩa server đã nhận.
```

If IPC disconnects or times out after the steer may have been sent, delivery remains unknown. The tracker does not auto-retry and does not silently convert the steer into a queued message.

### Gửi sau

Uses the official Codex queue command:

```text
codex queue --thread <ROOT_THREAD_ID> --message <TEXT>
```

Queue and steer remain separate operations. Queue is text-only unless the installed Codex CLI officially exposes attachment support.

## Diagnostic classifications

Examples:

- `LOCAL_ACCEPTED_NO_UPSTREAM` — Codex locally accepted the steer but no correlated upstream model request was observed within the diagnostic threshold.
- `UPSTREAM_NO_FIRST_BYTE` — an upstream request was observed but no first response event arrived within the threshold.
- `POSSIBLE_REPLAY` — a later outbound request reused a prior request-body fingerprint. This is observation only; the Gateway never blocks it automatically.
- `DELIVERY_UNKNOWN` — transport failed after a local send may already have happened.

These are evidence-based diagnostic labels, not final root-cause claims.

## Current Stop/Interrupt limitation

The public Codex app-server protocol includes `turn/interrupt`, but this tracker does not invent a follower IPC method for it. Version 0.9.0 leaves Gateway interrupt unsupported until the installed Codex Extension owner exposes a verified safe routing contract for that operation.

Normal Stop must never be implemented by killing `codex.exe`.

## Chat/session tracking

The tracker still reads:

```text
<CODEX_HOME>/session_index.jsonl
<CODEX_HOME>/sessions/**/rollout-*.jsonl
```

It keeps root/child lifecycle separation, ignores stale orphan children after terminal root turns, uses no wall-clock timeout to decide whether a turn is running, and prefers Codex state/index timestamps when available.

The non-running tab can delete a stopped chat through Codex's native `thread/delete` operation after rechecking that the chat did not become active again. That deletion helper may start a short-lived isolated `codex app-server --stdio` process for the supported delete request; the tracker still does not create a competing long-lived owner for steering.

## Build and install

From the repository root in Git Bash:

```bash
bash ./build-vsix.sh
```

Expected artifact:

```text
codex-session-tracker-0.9.0.vsix
```

Install from PowerShell:

```powershell
code --install-extension .\codex-session-tracker-0.9.0.vsix --force
```

## Tests

```bash
node --test test/*.test.js
```

Gateway tests use local fake servers only and must not call the real OpenAI service.

## Privacy

Runtime diagnostics belong in VS Code per-user extension storage, not tracked repository artifacts. Do not commit browser profiles, auth files, cookies, OAuth tokens, API keys, raw model traffic, or private absolute paths.
