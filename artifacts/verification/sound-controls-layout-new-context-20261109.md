# Sound controls, responsive chat list and new-chat context — 0.12.40

Implemented all additions requested during this task:

- Dedicated sound settings region with master switch, ten independently saved
  categories, enable/disable all and explicit previews. Initial waits, reminders,
  specific errors and quota speech use the central settings. Legacy quota controls
  remain synchronized. Muted events are consumed rather than replayed later.
- Two new bundled phrases: “Codex đã hoàn tất tác vụ” and “Codex đã dừng do lỗi”.
  Terminal lifecycle events drive classification. Normal user interrupts, tool
  retries, compaction and child agents are excluded. Error-tagged forced stops
  and runtime failure with active turns are failures. Ongoing chats/goals suppress
  success. Completed-turn IDs deduplicate live/log deliveries and survive reload.
  Enabled 429/capacity sounds take priority over the generic failure sound; the
  existing capacity cooldown is retained. Failed playback remains retryable.
- Running-list height is measured from actual DOM card sizes on startup, reveal
  and responsive resize. When all cards fit, the stacked list shows all of them;
  otherwise a full first card has priority. Very short viewports scroll the header
  away as needed. Revealing/focusing the host selects Running and clears filtering.
- Cards use a square-bordered context ring button, blue when monitoring is on.
  Ring progress is the actual percentage; the adjacent text is one line, e.g.
  `57.8% / 85% of 828,4K`. Clicking the ring does not select another chat.
  Context text and row whitespace are inert: only the square ring button can
  toggle monitoring, by pointer or keyboard.
- New-chat threshold defaults live in the new-chat/settings dialog. Exactly three
  scopes: all new chats in the connected Codex window; Tracker's New Chat button;
  context successors. Default is off. Rules persist, apply only to new roots and
  retain existing/manual per-chat choices. Resume does not count as creation.
  Successor overrides preserve inherited series and respect cancellation.

Validation:

- All 366 Node tests passed, including persistence, save rollback, muted queues,
  all categories, quota selection, lifecycle deduplication and retry, capacity
  cooldown, manual/forced stop, origins, new-chat rule scopes and inheritance.
- Real installed CLI tests used a loopback model server: success, terminal HTTP
  failure and user interruption yielded the expected sound decisions; native,
  Tracker and successor creation were distinguished; resume was excluded. The
  native new-chat event exposed valid metadata and applied an 85% rule. No external
  model requests were made by these tests.
- Real Windows SoundPlayer played both new completion clips from memory.
- Before/after hashes confirm all **201 previously existing audio files** are
  unchanged. Only `chat_completed.wav` and `chat_failed.wav` were added.
- Real Edge checks covered all sound switches, rapid edits/late acknowledgements,
  previews, ring state/progress, exact context text, sidebar widths down to 190px,
  full-list fitting, at least one visible card in short viewports, reveal/reset,
  switching between one/two columns, and the three-scope new-chat settings UI.
  Existing dialog/context controls also passed, with no browser errors.
  A targeted regression test confirms text/whitespace clicks emit no action,
  while a ring click and Enter each emit exactly one toggle.
- Visually inspected the sound panel/list and the new-chat threshold settings.
  Preview screenshots, downloaded test files and browser profiles were removed.
- JavaScript syntax and git diff --check passed. Package validation includes all
  new modules, CSS/JS assets and both completion WAVs, and hashes packaged files.
  All 280 entries passed. Final VSIX SHA-256:
  `77888f33b41d05a92397d0146172581e81de3e6addba42c48f515128b2b57b49`.
- Scratch used the common ACL helper and ordinary LEGION\SP3 token with explicit
  user SID rights, inherited ACLs, access probes and cleanup. No install, publish
  or push was performed. Existing production chats were not modified during tests.
  Zero scratch run directories remain. Superseded packages were hash-checked and
  removed before rebuilding. The saved automatic rule also remains visible if
  model/workspace loading fails; targeted host and Edge checks passed for this.

[Runtime provenance](../checkpoints/sound-controls-layout-new-context-0.12.40-20261109.json).
