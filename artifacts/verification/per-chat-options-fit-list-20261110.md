# Per-chat options and list fitting — 0.12.44

Every chat row now has a settings gear targeting that exact chat ID. The
selected chat also exposes **Tuỳ chọn chat** beside the manual handoff action.
The previous expanded context-settings card is removed. The options dialog
contains exactly three fields: handoff delay in seconds, polling interval in
milliseconds, and the completion-sound switch. Model, context, series and
Auto resume remain in the separate successor/handoff dialog.

Options persist in the chat's workspace entry and do not modify other chats,
global defaults, tracking enablement or thresholds. A successor starts with its
own defaults rather than inheriting these source-only preferences. The manual
handoff dialog initially reads the source's delay. Automatic polling schedules
each enabled chat at its own interval. Settings saves serialize edits and
persistence so a failed write for one chat cannot leak into another chat's save.

Completion muting affects successful completion for the specified root only.
Other terminal/error sounds retain global behavior; the global master and
completion switches still apply. Muted completed turns are recorded as handled
and do not play retroactively. Playback rechecks the local mute after waiting
for the shared audio queue.

Double-clicking **Resize chat list height** restores automatic fitting to all
currently rendered rows, including search-filtered lists. It resets list scroll
to the top and saves the resulting UI height. Lists taller than the viewport use
the maximum available height and remain scrollable. Manual resizing still works.

Validation:

- Full Node suite: 404 passed, including timing isolation, reload persistence,
  allowed-fields validation, source routing, global sound precedence,
  completion-only suppression, handoff defaults, rollback and concurrent saves.
- Actual Edge options checks passed at 1000, 520 and 320 px. Verified a gear for
  each chat, exactly three dialog inputs, no global/model/threshold settings,
  saving the clicked chat without changing selection, preserved edits during
  refresh, stale reply handling, error retry and per-chat isolation.
- Edge layout checks passed for drag then double-click, full visible-list fit,
  search-filtered fit, saved height, and 35-row viewport overflow at 520 and
  320 px. Existing sound toggles and layout checks passed with no page errors.
- Existing handoff and fresh-chat dialog browser tests passed at all three
  panel widths. Manual continuation and successor recovery remain available.
- Installed-runtime smoke tests passed for normal completion, locally muted
  completion, terminal failure and manual interrupt. Real native handoffs from
  both idle and running sources also passed, with the selected model and
  context retained. All model requests used loopback fixtures; no external
  model quota was consumed and no user chat was interrupted.
- JavaScript syntax and normal repository whitespace checks passed. Scratch
  used the shared helpers with the ordinary LEGION\SP3 token, direct user SID
  grants and inherited ACLs. Probes and cleanup passed for all owned run roots.

Package: `codex-session-tracker-0.12.44.vsix`, 287 entries verified against
source and runtime hashes. SHA-256:
`7a3484d482b631db2b5206036eed7f94f2cb540f73829f774294fe83ffde59bb`.
Prepared locally; not installed or published. Pre-existing changes were retained.

[Runtime provenance](../checkpoints/per-chat-options-fit-list-0.12.44-20261110.json)
records the freshly detected installed Extension/CLI and isolated rollout metadata.
