# Completed plan / implementation decision — 0.12.41

Root cause: the installed Codex UI creates a synthetic `implementPlan` pending
request from a completed `plan` item. The runtime can already be idle, so native
`waitingOnUserInput` active flags alone cannot identify the implementation dialog.
The inspected UI also removes that request locally for Skip/dismiss; that action
does not necessarily start a new app-server turn.

Changes:

- Typed native plan items plus successful completion identify the planning phase
  as ready for a decision. Root validation is preserved; a plan-ready event does
  not additionally emit the whole-task-completed sound.
- The existing authenticated UI observer reads the committed `implementPlan`
  pending-request prop and reports only local chat/turn IDs. It neither transmits
  plan content nor clicks/submits the native question. Detection is independent
  of the displayed language and cannot be triggered by quoted question text.
- Tracker shows **Plan xong · chờ xác nhận**, including for an idle runtime, and
  uses the existing input notification/reminder settings and audio clips.
- Skip/dismiss clears the exact observed decision. Navigation alone does not
  dismiss it. A new turn clears the old wait; late observations cannot revive it.
  New plans in the same chat notify separately. Coalesced polls complete queued
  refresh requests rather than losing a plan-state change during an active scan.

Validation:

- All 372 Node tests passed, including native/UI state merge, authenticated
  reports, idle plan detection, deduplication, reminders, active-goal planning,
  navigation, dismissal and repeated plans.
- Installed CLI smoke test against a loopback model produced real `plan` items,
  a completed turn and an idle thread; waiting was notified once, Skip cleared it,
  and implementation cleared the old plan before ordinary completion. Existing
  success/failure/manual-interrupt smoke checks also passed. External model calls: 0.
- Real Edge checks verified the installed UI's typed prop shape, same-route
  updates, Skip/dismiss, navigation behavior, locale-independent detection, no
  plan text in observer messages, and no automatic response to the dialog.
- Dashboard Edge checks at widths 1000, 520 and 320 passed with the new plan badge.
- Syntax checks and git diff --check passed. Existing audio assets were reused;
  no speech was regenerated. No native Codex extension source file was changed.
- All scratch uses the shared helper with the ordinary LEGION\SP3 token,
  inherited ACLs, direct user SID rights, access probes and cleanup.
- VSIX packaging verified all 281 entries against source/runtime hashes.
  SHA-256: `dec170f8238c97c33a34c15fe0311eaf3c58b3929cc4b574e233122e5ca9b54a`.
- Installed 0.12.41 through the VS Code CLI as explicitly requested. Installation
  used ACL-verified scratch and completed successfully. Payload hash verification
  and registry/manifest version checks were performed after installation.
- A running extension host must reload to load the updated code and UI observer;
  the user's active Codex work was not forcibly restarted.

[Runtime provenance](../checkpoints/plan-decision-detection-0.12.41-20261109.json).
