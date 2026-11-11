# New chat context — 0.12.35

Implemented a fresh-task wizard (workspace, context preset, first request), a
persistent creation default, and a per-chain successor context setting. Four
presets are exposed: model default, 400K, 600K, 900K. Default metadata is read
from the configured model catalog/cache, independent of global context overrides.
Fresh tasks use thread/start and their own first turn without a source thread.
Successors retain the existing permission inheritance and handoff journal.

Context overrides are recorded per thread in Tracker global storage and restored
on the existing connection's thread/resume requests. The hook leaves unrelated
threads, other request methods, and unrelated config keys unchanged, and restores
the original method on disposal. Open recorded chats from Tracker after reload
to ensure the bridge is ready. A chat opened before the bridge is installed, or
outside Tracker's connected extension host, is outside that restoration path.

Validation completed:

- 341 Node tests passed, including cancellation, repeated-click suppression,
  fresh-history isolation, four model-aware presets, per-chain persistence and
  propagation, write-error rollback, partial-send reporting and hook disposal.
- Real Edge UI passed at widths 1000, 520 and 320 without page errors. Verified
  fresh-chat/settings buttons and the correctly targeted successor-setting
  action, plus existing polling, drafts, context, handoff and series controls.
- Installed Codex CLI smoke test used only a loopback model endpoint. Native
  context usage for gpt-6-astra: default 272000 -> 258400, 400000 -> 380000,
  600000 -> 570000, 900000 -> 828400 (native model cap 872000 before 95% usable
  context). Verified separate histories, first-request delivery, unchanged global
  config, and all presets after actual process restart through the resume hook.
- Real handoff smoke passed: source stop, new thread, 600K selection with native
  570000 usable context, exact continuation link, inherited full-access profile,
  and existing waiting-input/approval notifications. External model calls: zero.
- No high-token service stress test or interactive installed VS Code wizard test
  was performed. Wizard behavior was exercised with VS Code API fixtures; Edge
  exercised dashboard actions; the installed CLI exercised actual protocol behavior.
- Syntax checks and git diff --check passed. The checkpoint records the installed
  extension, its CLI and actual fixture rollout metadata separately.
- VSIX built with 267 entries. Every packaged file was checked against its source
  hash. The pre-existing instrumented runtime was sourced from installed Tracker
  0.12.34 and matched runtime/manifest.json; it was not rebuilt or replaced.
- VSIX SHA-256: 2337a9fbbc14262c389f8e8f6b83cfd869e9f67c0c7af6422294375402c4df20.
- All test/schema/build scratch used the shared ACL helper with the ordinary
  LEGION\SP3 token. Access probes and cleanup passed. No package was installed,
  published or pushed by this change.

Limits: context sizes are requested configuration, not a mechanism for increasing
the service's model limit. Picker estimates reflect the available catalog;
Tracker's context display remains based on actual runtime usage. The first
message is required in the wizard because the installed app-server cannot reopen
an unmaterialized blank thread. Auto-compaction is set below the usable window so
an inherited smaller global threshold does not undermine the chosen preset.

[Runtime provenance](../checkpoints/new-chat-context-0.12.35-20261108.json).
[Official config reference](https://learn.chatgpt.com/docs/config-file/config-reference).
[Official app-server reference](https://learn.chatgpt.com/docs/app-server).
