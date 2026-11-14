# Delete confirmation latency — 0.12.55

The installed 0.12.54 handler scanned up to 10,000 rollout files and built a
session-tree snapshot before requesting the native confirmation dialog. Even
Cancel depended on that work completing.

The 0.12.55 handler requests confirmation synchronously using the displayed row.
History scanning, lifecycle checks and CLI resolution start only after explicit
confirmation. It still rejects running/missing threads, checks children, prevents
duplicate deletion, preserves the stopped-chat tab and does not clear another
selection. The redundant snapshot before confirmation was removed.

Verification:

- Regression tests failed against the old handler, then passed with the fix.
- Full Node suite: **479 passed, 0 failed**. Includes stalled scanning, cancellation,
  a resumed root/child, missing threads, scan failure/retry, duplicate clicks and
  changing selection while confirmation is open.
- Headless Edge `chat_feedback_ui.py`: passed six viewport cases, zero page errors.
  This verifies the row action and feedback; the native Windows dialog was mocked
  in host tests, not timed in a foreground VS Code window.
- Syntax checks and `git diff --check` passed.
- The installed extension.js was the same as the pre-edit working copy. Comparing
  it with the new source confirms only the delete handler changed in this task.
- Test and package scratch used the ordinary LEGION\SP3 token, inherited ACLs and
  user FullControl; access probes and run-directory cleanup passed.
- [Runtime checkpoint](../checkpoints/delete-confirmation-latency-0.12.55-20261114.json):
  OpenAI extension 26.51021.22027, bundled CLI 0.164.0-alpha.11.1. No rollout
  provenance was inferred for this change.
- VSIX: 297 entries; every source/runtime hash verified. SHA256:
  `fd999ebe54dd1a0df79423739943e16b71387c56c38433fae4235e51bf7954a1`.

Package 0.12.55 was prepared locally and was not installed at this checkpoint.
It was superseded by verified, locally installed 0.12.56 in the following task;
the obsolete 0.12.55 VSIX was removed. Its deletion fix is included in 0.12.56.
No publication, commit or push. Existing working-copy changes were preserved.
