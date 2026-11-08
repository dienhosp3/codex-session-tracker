# Codex Session Tracker 0.12.27 verification

The quota graph highlights the nearest displayed sample and shows its time and
used percentage on hover. The tooltip stays inside the chart, survives state
refreshes, and clears when the pointer leaves. Proxy recovery now removes a
successfully completed original turn from pending recovery without sending a
continuation, including restored plans and pending delivery retries.

- `node --test test/*.test.js`: 300 passed, 0 failed, 0 skipped.
- Four completed-turn regression cases reproduced the old behavior before the fix.
- Real Edge browser verification passed at widths 1000, 520 and 320 pixels,
  including 0% and 100% endpoints, decimal values, polling, range changes,
  downsampling, single-sample and empty charts. No page errors were observed.
- The VSIX passed ZIP integrity, manifest/version, file allowlist, source-content
  and runtime SHA-256 checks. It contains 163 files and no test logs, private data
  or build caches. See `package.json` for its inventory and hashes.
- VS Code reports `local.codex-session-tracker@0.12.27`. Installed source files,
  package metadata and the bundled runtime match the verified package.
- Cleanup removed five generated targets totaling approximately 325.26 MiB,
  plus the temporary test log. A subsequent cleanup scan found zero targets.
  Source, Git history, verification records and installed extensions were retained.
  The VSIX is retained outside the repository.

The installed extension is ready for the next extension-host activation. Existing
VS Code windows may need **Developer: Reload Window** to load the new version.
No live chat was resumed or sent a message for these checks.

Runtime provenance is in `../../checkpoints/release-0.12.27-20261108.json`.
