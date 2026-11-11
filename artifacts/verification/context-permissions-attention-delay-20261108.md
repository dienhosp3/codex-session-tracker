# Context handoff and waiting alerts — 0.12.31

Fixed automatic handoff dropping the source thread's approval policy and
permission profile. The successor receives those settings at thread creation
and again before its first turn. Metadata is read from the stopped source's
verified rollout, including settings changed since the last turn.

Added a persistent handoff delay, default 10 seconds, configurable from the
context card (0–3600 seconds). The journal records the wait deadline. Before
opening the successor, Tracker rechecks that the source has not resumed.

Live Codex waiting flags now drive a beep on each new approval/input wait,
then a reminder every five minutes while still waiting. Each chat has its
own reminder clock. Prominent badges, a clickable banner, waiting-first
ordering, and the VS Code status bar clear after resolution. Ordinary polling
and resolving one of two simultaneous waiting kinds do not replay the beep.
Existing custom user-input sounds remain honored.

Validation:

- 321 Node tests passed, including exact five-minute boundaries, separate
  chat clocks, repeated reminders, resolution and a subsequent new wait.
- Installed Codex app-server exercised real interrupt, the default 10-second
  wait, successor creation, naming and exact deeplink submission against a
  loopback model fixture. Full access/never survived on-request/read-only
  server defaults. No external model requests were made.
- Native requestUserInput and command approval RPCs produced the expected
  live labels and one notification each, then cleared after reply/decline.
- Real Edge checks passed at widths 1000, 520 and 320, including delay control,
  waiting labels, navigation, resolution and existing threshold-save behavior.
  No page errors. Windows beep execution returned successfully.
- VSIX contains 168 entries; every archived file and the reused runtime binary
  matched source SHA-256. Package SHA-256:
  `32d913fbd5e311ab16d6b7cdfd19e254e135e72fc9539b77fec71c15de6686b2`.
- Scratch creation/access probes ran under ordinary LEGION\SP3; owned
  test/browser/package directories were removed.

[Runtime provenance](../checkpoints/context-permissions-attention-delay-0.12.31-20261108.json).
