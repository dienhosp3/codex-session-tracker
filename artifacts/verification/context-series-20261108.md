# Custom chat series — 0.12.34

The selected chat's context watch card now has ID and starting-number fields,
a next-title preview, Save ID and Automatic buttons. Settings are per thread,
survive reloads and do not enable monitoring by themselves. IDs accept 1–10
ASCII letters/digits, start with a letter, and normalize to uppercase. Starting
numbers are positive decimal strings; padding and values above JavaScript's
safe integer limit remain exact.

A custom sequence applies only to the successor: ID DUAN and number 25 produce
`[DUAN-0025] Tiếp tục`, then 0026, 0027, and so on. The current source title is
never renamed by this custom plan. Each successor inherits the incremented
sequence, so later manual title edits do not reset it. Once a handoff starts,
its sequence is frozen; subsequent changes belong on the successor. Durable
handoff journals retain the actual sequence used and prevent duplicate sends.

Validation:

- 48 relevant Node tests passed across context handoff/watch, extension message
  handling, compact, live backend, permission inheritance and continuation UI.
- Coverage includes source-title preservation, starting at the exact number,
  large numbers/padding, per-chat persistence/reset, save failure rollback,
  rejecting edits during handoff and two successive handoffs across reload
  despite a manual title edit. Live account chats were not started by tests.
- Real Edge checks passed at widths 1000, 520 and 320 with no page errors:
  preview, save via button/Enter, input validation, updates while editing,
  late acknowledgements, save errors, automatic reset, handoff locking,
  changing selected chats and existing context/threshold behavior.
- Test/build scratch uses the shared helper and ordinary LEGION\SP3 token;
  access probes and cleanup passed.
- Installed 0.12.34 in VS Code. The VSIX's 265 entries matched source/runtime
  hashes; all 262 installed payload files matched the VSIX, excluding VS Code's
  mutable package metadata. Registry and installed manifest both report 0.12.34.
  The installed dashboard, extension and series modules match verified source.
- VSIX SHA-256:
  `3118d855378de3d9a0acce371cbd4012d46513fe20757cc551941d4965b93493`.
- Installation scratch was removed; the project's scratch root has zero run
  directories remaining.

[Runtime provenance](../checkpoints/context-series-0.12.34-20261108.json).
