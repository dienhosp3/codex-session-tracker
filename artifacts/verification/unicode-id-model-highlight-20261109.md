# Unicode IDs, model selection and visible selection — 0.12.39

- Series IDs accept 1–10 Unicode letters or numbers, including lowercase,
  leading digits and Vietnamese. Case is preserved; NFC normalizes composed and
  decomposed accents. Existing uppercase IDs and sequence padding still work.
  Runtime thread IDs are unchanged. Series parsing, preview, validation and
  continuation all use the same rules.
- The new-chat dialog lists models from the active Codex model/list endpoint,
  supports pagination and uses actual model identifiers rather than display IDs.
  A configured custom-provider model remains available. The chosen model is
  remembered, its context metadata refreshes on selection, and unknown model
  submissions fail before thread creation.
- Selected context cards have an explicit blue background, bright cyan border and
  checkmark. Chat New, Create, selected chat and selected list tab use distinct
  blue treatments independent of muted theme colors. Captions are shortened and
  only one context detail line is visible; raw caps are available as a tooltip.

Validation:

- All 353 Node tests passed, including Unicode normalization and automatic
  continuation, Vietnamese series across reload, model pagination, hidden models,
  actual model IDs, persistent selection, model-specific context and rejected
  unknown submissions.
- Real Edge dashboard checks passed at widths 1000, 520 and 320, including editing
  and saving a mixed-case Vietnamese ID with digits and background draft updates.
- Real Edge dialog checks passed at 1000x900, 520x740 and 320x568 using a muted
  olive/gray theme matching the reported contrast problem. Tests assert the actual
  selected background, cyan border, visible checkmark and New Chat background;
  model changes update capacity without losing prompt text and are sent on submit.
  Existing focus, keyboard, errors, duplicate prevention and recovery also passed.
- Visually inspected the new button and dialog on that theme. Temporary preview
  images and browser profiles were removed.
- Installed Codex CLI smoke passed against the loopback model fixture. It read
  the native model catalog and confirmed gpt-6.1-sol reaches the real Responses
  request with its 475000 usable default context, including after process restart.
  All four existing context presets, isolated histories and unchanged global
  config also passed. External model requests: zero.
- Syntax checks and git diff --check passed. The package script verifies all
  packaged entries against source/runtime hashes.
  All 272 entries passed; VSIX SHA-256:
  `0f8507b27239008853b24baadbebdc5132bb9af8835761aca41afc0484514367`.
- Scratch uses the shared ACL helper with ordinary LEGION\SP3 rights, access
  probes and verified cleanup. No install, publish or push was performed.
  Zero scratch run directories remain after packaging.

[Runtime provenance](../checkpoints/unicode-id-model-highlight-0.12.39-20261109.json).
