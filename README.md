# Codex Session Tracker 0.10.2

VS Code tracker for Codex sessions with lifecycle-aware activity, queue/steer controls, a loopback transport Gateway, reversible proxy routing, and a dedicated traffic monitor.

This build targets **Codex in VS Code on Windows 10**.

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
