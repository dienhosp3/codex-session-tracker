# Context window display

The chat list, Usage row and context watch card now show the session's full
context window size in tokens, formatted for Vietnamese (for example,
`272.000 tokens`). Live context readings take precedence over the runtime
snapshot. Unknown or invalid capacity displays `—`; a known capacity remains
visible before usage is available. Background readings update all three labels
without replacing a threshold input being edited.

Validation:

- Real Edge checks passed at widths of 1000, 520 and 320 pixels, including
  runtime fallback, live capacity changes, unknown capacity, capacity without
  usage, switching to an untracked stopped chat and overflow checks.
- The existing checkbox, threshold save, input preservation and attention
  scenarios passed with no browser page errors.
- 59 relevant Node tests passed across context watch/compact, tracker,
  continuation UI and proxy UI.
- Tests used the ordinary LEGION\SP3 token and the shared scratch helper.
  User access probes and cleanup passed for both owned run directories.
- On the user's subsequent installation request, packaged and installed Tracker
  0.12.33 in VS Code. The package's 265 entries matched source/runtime hashes;
  all 262 installed payload files matched the VSIX, excluding VS Code's mutable
  package metadata. The installed manifest and extension registry both report
  0.12.33, and the installed dashboard matches the verified source.
- VSIX SHA-256:
  `01126d1cf16afffa54de3747e13263e0977e141e9c14cb4453b4cd5e1aeaf326`.
- Package/install scratch access checks and cleanup passed; no run directories
  remain in the project's scratch root. No publication was performed.

[Runtime provenance](../checkpoints/context-window-display-20261108.json).
[Installation provenance](../checkpoints/context-window-installed-0.12.33-20261108.json).
