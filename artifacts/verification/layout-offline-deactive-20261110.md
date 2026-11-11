# Header, controls and offline Deactive — 0.12.47

- Removed the Model prefix from runtime metadata while retaining model names
  and Ultra/Ultrafast badges. The selected-chat header uses a two-column first
  row for title/status; workspace and runtime rows span the full width below.
  Completed occupies only the upper-right corner.
- Removed the visible Usage heading and changed the graph button to an accessible
  line-chart SVG. Tooltip, pressed state and graph toggling remain intact.
- Grouped composer statuses separately from the fixed-size reprobe button, which
  stays at the right edge in running and stopped states, including narrow panels.
- Deactive availability depends only on an in-flight deactivation. Failure to
  load Codex, an unknown/signed-out account and a pending reload do not disable
  this local action. Existing atomic file replacement and duplicate prevention
  are retained. No real user account was deactivated during verification.

Verification:

- Full Node suite: **424 passed**, including deactivation while owner loading
  fails, repeat use after deferring reload, local-only writes and duplicate clicks.
- Real Edge passed at 1000, 520, 440 and 320 px. Bounding-box assertions verify
  the status stays in the top-right row, lower metadata spans beneath it, and
  the reprobe button stays compact/right-aligned with and without statuses.
  Checked absence of Model/Usage labels, graph SVG/toggling, retained badges,
  offline Deactive without a selected chat and busy-state protection. Page errors: 0.
- JavaScript syntax and normal repository whitespace checks passed. Test/build/
  install scratch used the shared helpers with the ordinary LEGION\SP3 token,
  required SID grants and inherited ACLs. All owned run directories were removed.
  The legacy standalone dashboard script was inspected but not executed because
  it uses an unmanaged Python temporary directory; the shared runner was used.

Package: `codex-session-tracker-0.12.47.vsix`, 292 verified archive entries.
SHA-256: `4ae2b7597d0288153e8abfc67ae0b75043b0793f1861c38148fcdaedaace679d`.

Installed through VS Code CLI. CLI listing, registry and manifest confirm
**0.12.47**; all 289 installed payload hashes match the archive. Package metadata
was checked semantically because VS Code appends installation metadata.
No window reload, commit, push or publication was forced. Existing user changes
were preserved. Reload Window may be needed to load the updated extension host.

[Runtime provenance](../checkpoints/layout-offline-deactive-0.12.47-20261110.json)
records installed Extension 26.51021.22027 and bundled CLI 0.164.0-alpha.11.1.
Rollout fields are empty because this layout/local-auth change required no native
model generation; account operations were tested only in isolated fixtures.
