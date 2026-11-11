# New chat dialog — 0.12.37

Replaced the fresh-task native QuickPick/InputBox sequence with an accessible
HTML dialog inside Tracker. Workspace selection, a native folder Browse button,
four context cards, model/capacity details and a multiline prompt share one form.
The settings button uses the same dialog without creating a task. The command
palette opens it after a webview readiness handshake.

The dialog remembers the last context, keeps a draft when cancelled and during
background polling, supports Ctrl/Cmd+Enter, traps Tab focus, and fits narrow
panels with a scrolling body and fixed footer. Pending creation disables repeat
submission and dismissal. Errors appear inline; a known created ID has a recovery
button and uncertain delivery cannot be automatically resubmitted. Starting a
different task explicitly clears the previous draft.

The host validates the working directory, preset and non-empty prompt. It resolves
model/config itself and retains recent request acknowledgements to deduplicate
repeated messages. Radio preference writes are serialized. Native permission
inheritance, context config and the model protocol are unchanged.

Verification:

- All 345 Node tests passed, including real extension/controller functions with
  VS Code API fixtures. Coverage includes last-choice persistence after reload,
  multiline Unicode, workspace browse/loading errors, trusted config generation,
  duplicate and concurrent submission, validation, storage errors, unknown
  delivery, recovery identity and command-palette readiness.
- Real Edge dialog tests passed at 1000x900, 520x740 and 320x568: exact Unicode,
  context cards in K, multiline Enter, Ctrl+Enter, focus trapping, narrow layout,
  draft retention, live polling, loading retry, cancelled browse, folder changes,
  repeated submission, in-flight Escape, inline failure/retry, recovery, success,
  settings mode and stale reply isolation. No browser errors.
- Existing dashboard/context-watch Edge checks also passed at widths 1000, 520
  and 320, including the new modal launch buttons.
- Visually inspected a 520px rendered dialog screenshot in owned scratch; the
  screenshot and browser profile were removed after inspection.
- JavaScript syntax and git diff --check passed. Packaging checks the dialog HTML,
  JavaScript and host module as required entries, and hashes all packaged files.
  All 270 entries passed. VSIX SHA-256:
  `eabeebe8fbecbdfcda0a9780811056990403bcb6dc18d790c54394be1f2c2cbb`.
- Tests and preview used the shared scratch helper and the ordinary LEGION\SP3
  token, with inherited ACLs, explicit user SID rights, access probes and cleanup.
  Zero scratch run directories remain after packaging.
- No live chat/model call, installation, publish or push was performed. The
  actual native VS Code webview host was represented by its API fixture; browser
  rendering and keyboard behavior were tested in real Edge.

[Runtime provenance](../checkpoints/new-chat-dialog-0.12.37-20261109.json).
