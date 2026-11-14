# Tracker 0.12.52 — async input, deeplink, delete feedback, list height

- Added incremental rollout reading for `request_user_input_async`, tracking
  question IDs independently of native `waitingOnUserInput`. Accepted tool
  output leaves the question pending; answers/Skip clear exact IDs. New or
  aborted turns clear obsolete prompts. Idle questions retain reminders and
  additional questions notify without repeating unchanged waits.
- Chat options copy the target chat's `codex://threads/<UUID>` through the
  VS Code clipboard API, with correlated success/error acknowledgements.
- Delete failures display a dismissible list overlay for 6.5 seconds. Repeated
  state polling neither extends its life nor resurrects the same notice.
- Stacked list sizing reserves the measured selected header, view tabs and
  account/context card when possible. Overflow scrolls; auto-fit, double-click
  and manual expansion respect the remaining height.

## Verification

- Full Node suite: **461 passed**, including async acceptance, partial answer,
  Skip, idle/running flags, repeated/reminder notifications, rejected calls,
  partial UTF-8, rewritten/missing rollouts, extension sound dispatch, clipboard
  errors and delete races. No real conversation was deleted.
- Replayed the original MathType async call and its accepted output through
  the new reducer and attention monitor: one pending question, exactly one
  notification across two polls, with native active flags empty.
- Real headless Edge: `chat_feedback_ui.py`, `sounds_layout_ui.py`,
  `context_watch_ui.py`, `layout_controls_ui.py` all passed with no page errors.
  Checked widths 320–1000px, viewport height down to 240px, long/short lists,
  resize and manual fit, exact options-row copy, stale ACK rejection,
  clipboard failure, scrolled-list error visibility, literal text rendering,
  timeout through seven periodic refreshes, repeat failure and manual close.
- Syntax checks and `git diff --check` passed. Test/build scratch uses the
  ordinary LEGION\SP3 token, explicit user FullControl, inherited ACLs, access
  probes and verified cleanup via the repository helpers.
- Provenance: [checkpoint](../checkpoints/async-input-list-feedback-0.12.52-20261111.json).
  Installed OpenAI extension 26.51021.22027; bundled CLI and original rollout
  CLI 0.164.0-alpha.11.1; model gpt-6-astra.

## Installation

- VSIX contains 296 entries; package helper verified every source/runtime hash.
  SHA256: `ef15314e0b4b789f598c133990fc756870b5cbe310882ebd909e5bf7b53e6440`.
- Visually inspected the rendered Edge list/error overlay and selected header
  at 520×720; preview image/profile were removed after inspection.
- VS Code CLI installed 0.12.52 successfully. Registry and installed manifest
  confirm the version; all 293 non-manifest payload files match VSIX hashes.
  Build/install/preview scratch was removed and the project scratch root has
  no run directories left. No commit, push or publication was performed.
- Existing extension hosts need **Developer: Reload Window** to load the new
  code. The active user conversations were not interrupted to force a reload.
