# Tracker 0.12.54 — question resolution and transfer shortcut

- Native Skip is local UI state and sends no empty rollout answer. Observe
  exact local question IDs on Skip, close, confirmed submission and committed
  native question state. Handle rapid skips and alternate React fibers;
  navigation, passive unmounts and failed submissions retain unanswered waits.
- Persist resolved IDs across reloads and filter them from rollout reads.
  Clear the visible attention entry immediately even when backend reads fail;
  preserve independent approval/native input waits and skip stale queued sounds.
  A replacement question starts its own reminder clock.
- Parse native replies with the editor-context delimiter and early user-message
  events. Only matched IDs resolve; no question/answer text is saved by the observer.
- Add an icon-only transfer button above the list, targeting the selected chat
  through the existing handoff dialog, with tooltip, accessible label and busy state.

Verification:

- Full Node suite: **470 passed, 0 failed**. Includes persistence, partial
  cancellation, 5/10-minute reminder cessation, failed reads and notification races.
- Headless Edge: `async_input_ui.py`, `handoff_dialog_ui.py` (320/520/1000px),
  `plan_prompt_ui.py` passed with zero page errors. Native question prop shapes
  were checked against the installed OpenAI extension and exercised in fixtures;
  no test question or transfer was sent to a real user conversation.
- Syntax checks and `git diff --check` passed. The standalone auth UI test was
  corrected to load its existing interval helper, omitted by its source slicing.
- All scratch runs used the ordinary LEGION\\SP3 token with inherited user ACLs,
  read/write/rename/delete probes, and verified cleanup. Remaining run directories: 0.
- [Runtime checkpoint](../checkpoints/input-resolution-transfer-0.12.54-20261112.json).
  OpenAI extension: 26.51021.22027; bundled CLI: 0.164.0-alpha.11.1.
- VSIX: 297 entries, source/runtime hashes verified. SHA256:
  `b0734eb31b0a530a93e08bc2c685f3092be5bf67d7475ac5dfa1c057b685286d`.
- Installed locally using VS Code CLI. Registry and manifest show 0.12.54;
  all 294 installed non-manifest payload files match the package hashes.
  Existing extension hosts require **Developer: Reload Window** to load this code.
  No forced reload, commit, push or publication was performed.
