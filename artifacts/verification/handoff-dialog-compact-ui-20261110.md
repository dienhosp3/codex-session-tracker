# Handoff dialog and compact controls — 0.12.43

The manual handoff button and Command Palette action now open a dialog before
any stop, save or successor creation. The dialog loads the source model and
settings, supports model selection from the live catalog, updates context
choices for that model, and accepts optional multiline continuation text.
Per-chat drafts survive cancellation and background refreshes. The captured
source ID stays fixed when the selected chat changes.

The same form includes context, series ID and next number, Auto resume,
threshold and delay. IDs accept 1–30 Unicode letters/digits after NFC
normalization; thresholds accept integers 1–99 with compact inputs. Explicit
handoff settings override global defaults for new conversations. The added
message is appended once after the original continuation/deeplink; model
selection reaches native thread creation. The existing journal, exact-turn
checks, permission inheritance and duplicate guards remain in use. Bridge
revision 18 exposes the catalog to the handoff path.

UI changes:

- Sound settings open from a small button beside Running / Not running, with
  the existing master switch, ten sound toggles and previews in a dialog.
- Stopped chat status dots are gray. Window focus and document visibility no
  longer reset the tab after native delete confirmation. View reveal while
  deletion is pending also preserves it.
- Save actions use compact SVG icons with accessible names and tooltips,
  including context, series, gateway, quota alerts and traffic filters.
- Account context uses rounded values such as `Context 14% of 828K`, with live
  updates. The token-speed display and requested explanatory captions are gone.
- Metadata activity text is concise Vietnamese. The automatic continuation
  label is Auto resume throughout the affected controls.

Verification:

- Full Node suite: 396 passed. Tests cover read-only option loading, model
  changes, 30/31-character boundaries, 99/100-percent boundaries, empty and
  multiline extra text, cancellation prerequisites, source routing, settings
  inheritance, global-default precedence, duplicate requests and uncertain
  delivery. Delete integration tests cover success, cancellation and failure
  while simulating confirmation-related visibility changes.
- Subsequent targeted checks: 26 passed after the final markup cleanup.
- Actual Edge: handoff dialog and compact-control checks passed at 1000, 520
  and 320 pixels with no page errors. Covered draft recovery, no mutation on
  cancel, model context refresh, long Unicode IDs, invalid thresholds, selected
  chat changes, keyboard submission, stale replies, duplicate blocking and
  successor recovery. Sound placement, gray dots, focus/tab behavior, icon
  buttons, integer account context and absence of removed captions were checked.
- Existing context-watch, new-chat dialog, sound/layout and plan-prompt browser
  checks passed. Sound toggles retain pending edits and late-ACK protection.
- Installed native CLI smoke tests passed for idle and running sources. The
  successor used `gpt-6.1-sol`, selected from the runtime catalog, instead of
  the fixture source model `gpt-6-astra`. Verified exact multiline prompt,
  30-character series, threshold 99, Auto resume both off/on, 570K effective
  context, inherited Full access and no duplicate successor on replay.
- Existing automatic-handoff native smoke test passed separately. All model
  traffic ended at local loopback fixtures; external model calls: zero.
- Syntax and normal repository whitespace checks passed. Scratch helpers ran
  with the ordinary LEGION\SP3 token, required SID permissions and inherited
  ACLs. Access probes passed and all owned test/build directories were removed,
  including failed development runs.

Package: `codex-session-tracker-0.12.43.vsix`, 284 entries verified against
source and runtime hashes. SHA-256:
`339cb291a58be508ff69e409ba552565dac434af531072449cf344dd29a1980e`.
Prepared locally, not installed or published. No existing user conversation was
interrupted for testing. Existing uncommitted work was preserved.

[Runtime provenance](../checkpoints/handoff-dialog-compact-ui-0.12.43-20261110.json)
records installed Extension 26.51021.22027, bundled CLI 0.164.0-alpha.11.1,
and isolated rollout model/runtime metadata.
