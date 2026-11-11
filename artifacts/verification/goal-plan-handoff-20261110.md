# Goal/Plan handoff, Plan notice and current threshold — 0.12.45

Implemented and installed the approved handoff plan, including the subsequent
request to edit a running chat's threshold in its own options.

Behavior:

- The handoff dialog offers Normal, Goal and Plan. Goal uses one editable
  objective field with outcome/completion-criteria sections, seeded from the
  source's native Goal when available. Empty/incomplete templates and objectives
  beyond 4000 Unicode characters fail before source mutation. Unsupported modes
  are disabled and do not fall back silently.
- Goal settings, permissions, model and effort are applied before injecting the
  continuation/deeplink and fixed scope/stop instructions. Native Goal activation
  starts the first generation; Tracker does not send an additional normal turn.
  No token budget is supplied. The journal records mode and objective as well as
  configuration, injection and activation progress for duplicate protection.
- Automatic Goal successors read the latest native objective, including edits.
  Goal carries through the chain; Plan is one-hop and its successor is Normal.
  Paused, completed or cleared Goals are not automatically revived. Changes to a
  source Goal during the wait prevent creating another Goal.
- Settings/Delete buttons sit at the right of the Context row, outside the
  title row. Delete remains restricted to stopped chats. Context text truncates
  with a full tooltip in narrow panels; nested actions do not select the chat
  or toggle context monitoring.
- Plan-ready text and its bundled Vietnamese speech are exactly:
  **Đã lập xong kế hoạch. Có triển khai luôn không?** The existing input-alert
  switch controls it. A Plan-ready event does not also play generic input or
  whole-task completion speech. Native decision/dismissal behavior is unchanged.
- Chat options now include **Ngưỡng chat hiện tại (%)**, accepting 1–99. It
  updates that source chat's threshold while preserving Auto resume and other
  chats. Lowering it applies at the next scheduled check. The handoff dialog
  explicitly labels its separate setting **Ngưỡng chat kế tiếp (%)**.

Verification:

- Full Node suite: 418 passed. New coverage includes templates, capabilities,
  native method ordering, no extra Goal start, Plan first-turn settings, unknown
  delivery, failures without fallback, live Goal edits, chain inheritance,
  paused/terminal Goal suppression, current-threshold isolation and exact speech.
- Native installed CLI: Normal → Goal → Goal → Plan → Normal completed against
  a local model fixture. Verified exactly one initial Goal generation, injected
  context and guardrails, no inherited token budget, current native objective,
  570K context, high reasoning, Full access preservation, native Plan item and
  stopped-source safety. The native Plan decision/Skip/implementation smoke test
  also passed with the new speech clip. External model calls: zero.
- Actual Edge checks passed at 1000, 520 and 320 px for Goal drafts, required
  completion criteria, mode changes, model/context changes, cancellation, stale
  acknowledgements, duplicate protection, source routing and recovery. Verified
  right-aligned row actions, exact Plan message and local threshold controls.
  Existing fresh-chat, sound/layout, resize and native plan-observer checks passed.
- Syntax and normal repository whitespace checks passed. A final targeted
  handoff suite and native transition run passed after recording Goal intent in
  the initial durable journal state.
- Scratch used the shared helpers with the ordinary LEGION\SP3 token, direct
  SID permissions and inherited ACLs. All test, audio, build and installation
  scratch directories were verified and removed. Pre-existing user changes,
  including an existing deletion, were retained.

Distribution and installation:

- `codex-session-tracker-0.12.45.vsix`: 289 archive entries verified against
  source/runtime hashes. SHA-256:
  `0c8b2b3cafcb1685c6cb620a10b3fcd200ece152d2cc36f4ed6b568b35d0863a`.
- Installed with the user's VS Code CLI using `--install-extension --force`.
  CLI listing, extension registry and manifest all confirm **0.12.45**.
- All 286 installed payload files match archive SHA-256 values. Package metadata
  was checked semantically because VS Code adds installation metadata; the two
  VSIX container manifests are outside the installed payload.
- No window reload or user-chat interruption was forced. An existing extension
  host may require **Developer: Reload Window** to load the installed version.
- No commit, push or publication was performed.

[Runtime provenance](../checkpoints/goal-plan-handoff-0.12.45-20261110.json)
records installed OpenAI Extension 26.51021.22027, its bundled CLI
0.164.0-alpha.11.1, and the isolated runtime/model used for verification.
