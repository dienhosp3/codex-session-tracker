# New chat choice and Unicode fix — 0.12.36

- Every confirmed context choice in the fresh-chat wizard is saved immediately
  using the existing global setting. The next wizard initializes the native
  QuickPick's active item to that value; pressing Enter retains it after reload.
  Cancelling the picker preserves the previous choice. Cancelling the task prompt
  preserves the context already confirmed. Per-chain overrides remain separate.
- Fixed literal question marks in the new-chat button, busy label, tooltips,
  settings icon, command titles and README. These were corrupted text in the
  source, not a font selection problem. All repaired text was written as UTF-8.
- Context labels now use K without full token counts, including the model default,
  effective capacity, model cap, chat cards, Usage and context-watch display.
  Numeric configuration sent to Codex is unchanged.

Validation:

- 344 Node tests passed. New regression coverage exercises the actual wizard
  functions with VS Code API fixtures: saved 900K after reload, Enter on that
  active item, switching to 400K, cancellation, storage failure before dispatch,
  and preservation of the separate per-chain preference.
- Real Edge tests passed at widths 1000, 520 and 320 with no page errors. Tests
  assert exact Vietnamese text and icons, busy-to-idle labels, the saved-choice
  tooltip, and K formatting during live updates and chat switching.
- Syntax checks, damaged-label scan and git diff --check passed.
- The package script verifies every VSIX entry against the source file hash.
  The existing instrumented runtime is copied from installed Tracker 0.12.35
  only after checking its SHA-256 against runtime/manifest.json.
- Package verification passed for all 267 entries. VSIX SHA-256:
  `bcbe8b8461589d90ea6ec838eb8b4aac2c9fca5d5822f9039b545acc0b27b7c3`.
- Test and build scratch uses the shared helper with the ordinary LEGION\SP3
  token, inherited ACLs, explicit user SID rights, access probes and cleanup.
  The scratch root has zero remaining run directories after packaging.
- No service/model request, production chat creation, install, publish or push
  was needed for this UI/preference fix. Native VS Code QuickPick behavior was
  checked through its API fixture; dashboard rendering used real Edge.

[Runtime provenance](../checkpoints/new-chat-choice-unicode-0.12.36-20261109.json).
