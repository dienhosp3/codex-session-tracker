# Gray webview steer verification — Tracker 0.12.4

Runtime provenance: `2026-10-05-gray-webview-direct-steer-0.12.4.json`.
Installed Extension: openai.chatgpt 26.930.41038. Bundled CLI: codex-cli 0.160.0.
Investigated rollout creation metadata: CLI 0.159.2. Its recorded model: gpt-6.1-sol.

## Reproduction and cause

On the reported chat, native IPC owner discovery succeeded in 3 ms. The following
targeted `thread-follower-steer-turn` failed with `no-client-found` after 5012 ms.
Before sending, a read-only probe through the existing Extension connection
confirmed the chat was loaded, its status was `active`, and its latest turn was
`inProgress`. This was a live backend observation, not an inference from elapsed
time or the rollout's modification time.

The installed Extension's owner discovery accepts its cached owned-thread set.
Its native follower-steer discovery separately calls the webview's
`getThreadRole` with a five-second timeout. A gray, unresponsive webview therefore
can fail the second check even when the same Extension still owns a running
app-server. Tracker previously mislabeled this as missing ownership.

## Changed behavior

The owner bridge uses the existing IPC client and app-server connection. It adds
an isolated result provider and advertises direct-steer support. Only Tracker's
explicit opt-in uses this route; native followers retain their original handlers.
It checks cached Extension ownership, live loaded-thread membership, live thread
status and the current turn, then calls `turn/steer` with `expectedTurnId` and one
stable client message UUID. It never issues `thread/resume`, `turn/start` or
`turn/interrupt`. A core rejection is not retried. A missing acknowledgement after
send stays unknown. Disposal restores both original IPC handlers.

## Evidence and limits

- Original attempt A: discovery succeeded; native steer was not routed (5012 ms).
- The user reloaded VS Code during investigation, which restarted the owner.
  Attempt B then succeeded
  through the native route in 72 ms; this is not evidence for the new bridge.
- Attempt C used `codex-existing-app-server`, received a matching turn ACK in
  14 ms, and kept the same active turn used by B. The rollout contains a
  `UserMessage` with the exact client UUID `e49dcf15-6c62-4d52-a15c-84a9a566be60`
  at `2026-10-04T21:47:00.312Z`, followed by an assistant acknowledgement of
  `CST_GRAY_STEER_VERIFY_20261005_C`. Vietnamese text was preserved.
- 132 automated tests passed. New coverage exercises the direct backend route,
  gray webview bypass, native-handler preservation, renamed module constructors,
  correct root identity, idle/unloaded/completed rejection, turn races, timeouts,
  acknowledgement validation, UUID propagation and IPC delivery classification.
- No test deliberately crashed or suspended the user's webview. The original
  gray condition was observed; the new direct route was verified on the restarted
  owner, and a non-responsive native webview handler is covered by regression
  tests. A dead Extension host/app-server cannot retain the lost active turn.

In-process binding does not pause execution or expose a debugger port. Temporary
external debugging was used only for this live investigation, without restarting
or replacing the owning process. Checkpoint metadata contains no chat contents,
authentication data or private absolute paths.

## Installed artifact

`codex-session-tracker-0.12.4.vsix` (94,778,145 bytes), SHA-256:
`0af6e6145d489475a44a623522c17f0ce51d0e1a4078a0fe3718accebb204d21`.
The VS Code CLI confirmed installation of 0.12.4. Installed `extension.js`,
`codex_steer.js`, `codex_live_backend.js` and `codex_owner_bridge.js` match the
workspace files by SHA-256. Update provenance is retained in
`2026-10-05-installed-update-0.12.4.json`.

The currently loaded steer module was updated in both running Extension hosts,
and both owner bridges were installed without a window reload. Both existing
app-server PIDs remained unchanged during this installation/update. Temporary
external inspector listeners were closed; the Tracker's existing Gateway
listener was retained. Full 0.12.4 activation runs on subsequent normal Extension
activation; the current UI already uses the updated steer implementation.

## Additional live handler-failure experiment

The user correctly rejected post-reload success as proof of recovery from an
actual gray webview. The real-gray validation remains open. Experiment provenance:
`2026-10-05-live-handler-failure-test.json`.

On the unchanged owner host/app-server, the original native follower-steer
callbacks were temporarily made to throw for only this chat's test marker
`CST_GRAY_HANDLER_FAILURE_20261005_D`. An automatic 30-second restoration guard
was installed before attempting either route. No renderer was crashed or paused.

- A native follower request without direct opt-in failed with `no-client-found`
  in 3 ms. The blocked role callback was reached exactly once.
- Tracker's direct route succeeded in 9 ms using the same app-server PID 21700
  and turn `01a108e9-8908-7a12-96c8-a9c1e9459fbe`, with client UUID
  `d5705104-00dc-45a4-ad0c-122a321f7872`. The blocked webview callbacks were not
  reached by this route. The matching UserMessage receipt was subsequently
  verified at `2026-10-04T21:56:41.557Z` in the target rollout.
- Original callbacks were restored immediately afterward. Process identity
  remained unchanged and the temporary inspector listener was closed.

This is a live injected handler-failure test. It strengthens the evidence that
the new route does not depend on those native webview callbacks, but does not
prove recovery from every real renderer/Extension failure that produces a gray
panel. No completion claim is made for that broader condition.
