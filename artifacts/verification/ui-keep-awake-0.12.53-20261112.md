# Codex Session Tracker 0.12.53 — 2026-11-12

- Added a persistent Windows keep-awake switch beside sound settings, with green 100–50% opacity animation. Native SetThreadExecutionState accepts the request; off/dispose closes the helper and releases the request.
- Added FAST and XHIGH badges; removed separators adjacent to badges.
- Context and quota share a content-sized left column; action buttons wrap in the right column. Image and capability check share one row.
- Quota interval uses an in-panel dialog supporting ms/s/m/h, with minutes as the initial unit and legacy settings preserved. Command-palette quota settings open the corresponding in-panel dialogs.
- Validation: 47 Node tests passed; real Edge layout/interaction checks at widths 320, 440, 520, 1000 and existing sound/layout checks passed, without page errors. Includes real Windows power request and release, storage failure behavior, and interval timing.
- Package: 297 entries, all source/runtime hashes verified. VSIX SHA256: 68d622ef0b9f87052a9a5bc4c4348b3d84d7ec7cb5da51286ff885073c773d81.
- VS Code CLI reported successful installation. Installed registry/package version is 0.12.53; modified runtime files match the source hashes.
- Scratch: ordinary LEGION\SP3 token verified; user ACL and create/read/edit/rename/delete probes passed; owned test/UI/package/install scratch removed.
- Runtime provenance: ../checkpoints/ui-keep-awake-0.12.53-20261112.json. No commit, push or publish performed.