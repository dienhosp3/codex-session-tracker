# Continue completed chat verification — Tracker 0.12.5

Runtime provenance is in `2026-10-05-continue-completed-chat-release-0.12.5.json`.
The development record references an older investigated rollout (CLI 0.159.2).
The release record references the isolated integration fixture (CLI 0.160.0).
Neither rollout version is inferred from the installed Extension version.

## Automated checks

`npm test`: 160 tests passed, zero failures. Coverage includes completed loaded
and unloaded chats, active-turn refusal, resume failure, mismatched thread/ACK,
unsupported turn paging, image-only and Unicode input, Ctrl+Enter, owner routing
without cached webview ownership, preserved native handlers, provider adoption
after module reload, and unknown delivery without a retry.

## Existing backend integration

- Created an isolated chat and completed its first turn using the existing
  Extension connection. The fixture rollout records CLI 0.160.0 and gpt-6.1-sol.
- Requested continuation from the other already-running VS Code Extension host.
  The original app-server still held the completed chat's writer lock.
- Backend-aware owner discovery found that original connection even without
  cached webview ownership. The version-2 `thread-follower-start-turn` route
  started new turns in the same thread and returned their ACKs.
- Confirmed completion from both the fixture rollout's `task_complete` records
  and the owning backend's `thread/read`. Reading the unloaded fixture from the
  other backend had temporarily classified the new turn as interrupted; that
  read was not used as authoritative evidence of completion.
- Deleted only the isolated fixture with its owning backend's `thread/delete`.
  Existing user app-servers remained alive and were not reloaded or interrupted.

This verifies continuation through the existing owner. Unloaded-thread resume
is covered by automated tests; the live fixture remained loaded in its original
owner. It does not prove recovery from every gray-webview failure or from a
dead owner. A timeout after sending remains unconfirmed and is not resent.

Installing the VSIX updates the extension files. Already-running Tracker UI
code needs normal VS Code extension activation/reload to show the new button;
the installation does not force a window reload.
