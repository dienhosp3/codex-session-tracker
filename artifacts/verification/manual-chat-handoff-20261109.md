# Manual conversation handoff — 0.12.42

Selected conversations can move to a fresh continuation chat before reaching
their context threshold. The context card exposes **Chuyển sang chat mới**;
Command Palette exposes **Codex Tracker: Chuyển chat đang chọn sang chat mới**.
The source must be loaded in the local Codex connection. Running and terminal
turns are supported, including an idle conversation awaiting a plan decision.

The manual path shares the existing durable handoff journal. It claims the
source before the live preflight, preserves the explicit source ID across UI
selection changes, checks the latest native turn, pauses an active goal and
interrupts only when necessary. Stop confirmation and the configured delay
precede successor creation. It carries workspace, model, reasoning, permissions,
context preset and series forward; an untracked source does not become tracked.
The successor receives the existing series-prefixed continuation with the
source deeplink. Failed live reads remain retryable. Started/uncertain handoffs
cannot be replayed; a created successor remains available through its link.
Bridge revision 17 exposes the read-only manual preflight after a host reload.

Validation:

- `scripts/test.ps1`: all 385 Node tests passed. Coverage includes untracked,
  below-threshold and missing-usage transfers, stopped sources, settings
  inheritance, concurrent automatic polling, duplicate clicks, selection
  changes, explicit source routing, stale turns, goal pause, persistence and
  uncertain delivery. Existing automatic-handoff and continuation tests passed.
- `scripts/ui-test.ps1`: real Edge passed at 1000, 520 and 320 px, with zero page
  errors. The manual button works without monitoring; pending state survives
  refresh; stale acknowledgements are ignored; errors allow preflight retry;
  completed/uncertain transfers remain locked; stopped chats can transfer.
- `scripts/test.ps1 test/manual_handoff_smoke.js`: two installed-runtime cases
  passed, using an idle source and an interrupted running source. Verified one
  new conversation, exact source deeplink, unchanged original terminal turn,
  Full access inheritance, 570K effective successor context, durable deduplication
  and disabled monitoring. All model requests terminated at the loopback fixture.
- `scripts/test.ps1 test/context_handoff_smoke.js`: the existing native automatic
  handoff, goal pause, inherited permissions and approval/input checks passed in
  a separate run (10.7 seconds). Its first run alongside the other suites timed
  out after its assertions logged success; rerunning it alone completed cleanly.
- JavaScript syntax checks and the repository's normal `git diff --check` passed.
- Test/build scratch used the shared helpers with the ordinary LEGION\SP3 token,
  the required direct SID grant and inherited ACLs. Access probes and descendant
  checks passed; all run directories were removed, including failed runs.

Package: `codex-session-tracker-0.12.42.vsix`, 281 entries. The packaging helper
verified every entry against source and the existing bundled runtime manifest.
SHA-256: `50d7986c0cae7d96a5079324cc82e62c3c637b01a49c2ff849e94805f145aed4`.
The VSIX was prepared locally; it has not been installed or published. Existing
uncommitted work was retained, and the user's running Codex host was not restarted.

[Runtime provenance](../checkpoints/manual-chat-handoff-0.12.42-20261109.json)
records installed Extension 26.51021.22027, its bundled CLI 0.164.0-alpha.11.1,
and the isolated test rollout's CLI/model metadata.
