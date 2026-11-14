# Tracker 0.13.1 — Account manager dialog

Installed locally; registered extension version and all 324 installed payload files verified against the VSIX. Package metadata added by VS Code is excluded from semantic manifest comparison. Runtime provenance is in the matching checkpoint JSON.

- The entry button is inside the existing account area. The modal reuses Tracker dialog controls and theme tokens; account rows show identity, plan, linked BAT, quota meters and labelled icon actions. Linking and per-account options open on demand.
- The policy tab, inputs, selection, focus, launcher selection and scroll survive background updates. Closing and reopening retains the draft in the current webview. Explicit save waits for a correlated backend result; failure and edits made during saving keep the unsaved draft.
- Existing Chrome BAT entries without Codex account links appear separately. Read-only inspection found three BAT entries and zero Codex account links; descriptive browser identities are not represented as verified account sessions.
- 531 Node tests passed. Real headless Edge checks passed with 1,000 chat rows, 25 account rows, repeated background updates, stale state, save failures, duplicate clicks, empty registries, account chooser cancellation, keyboard navigation and four viewport sizes. Existing account/usage/composer layout checks also passed. No page errors.
- Visually inspected the dark account list, dark policy panel and 320×480 light policy panel. Header and footer controls remain visible; content scrolls inside the dialog.
- Scratch was created through the shared helper, checked with the ordinary Explorer user's token and removed after each run. Test browser processes were closed before cleanup.

Reload VS Code windows to load the installed update. No live account switch, message send, remote publication or Git push was performed during this UI repair.
