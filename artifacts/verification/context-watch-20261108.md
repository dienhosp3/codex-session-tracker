# Context watch 0.12.28 — verification

Implemented opt-in monitoring per chat, independent thresholds, a configurable
300 ms default polling interval, confirmed stop/goal pause, numbered fresh
conversations, and automatic deeplink continuation. Successors inherit tracking.
Journaled requests prevent duplicate creation/sends across reloads and windows.

- Node suite: 312 passed, zero failures/skips. The affected extension and watcher
  tests were rerun after the final integration guards: 44 passed.
- Real installed Codex app-server smoke: source turn interrupted, active goal
  paused, new thread created and named, exact continuation message received.
  Used an isolated Codex home and localhost model fixture; zero external model
  requests and no account quota consumed. No real user chat was stopped/sent.
- Real Edge UI: widths 1000, 520, 320 px; opt-in checkbox scope, threshold save,
  settings command, successor navigation, unknown percentage, and input stability
  across polling. No page errors; controls fit narrow panels.
- Package: 166 entries, required manifests/modules present, every entry's bytes
  checked against source, runtime digest matches its repository manifest.
  VSIX SHA-256: `53350fdb249891c534e6d855e5c57f15124207e7e1c31378aeeab514901b1902`.
- Installed locally as `local.codex-session-tracker@0.12.28`; installed feature
  files and runtime verified against source. Existing windows need Reload Window.
- Scratch: ordinary `LEGION\SP3` token; explicit user FullControl and inherited
  ACLs; create/read/edit/rename/delete probes passed. Processes/handles closed;
  all owned test, browser, packaging and installation run directories removed.

Context uses the latest reported inference total, not cumulative billing.
The 300 ms interval reads local logs; Codex determines when new token counts are
available. A chat must be owned by the connected Codex instance in this window;
otherwise the panel displays the connection issue and does not stop another
instance's task. Uncertain transfers are retained for manual inspection, never
blindly replayed. Automatic compaction and proxy recovery cannot restart the
source during transfer.

Runtime provenance: [checkpoint](../checkpoints/context-watch-0.12.28-20261108.json).
Inspected OpenAI extension: `26.51021.22027`; bundled CLI tested:
`0.164.0-alpha.11.1`. The existing optional instrumentation runtime packaged with
Tracker remains `0.159.2` with its original verified hash. These are distinct
runtime versions. No real user rollout metadata was collected.

Protocol reference: [official App Server documentation](https://learn.chatgpt.com/docs/app-server).
