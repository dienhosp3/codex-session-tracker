# Speed selection, proxy dialog and emphasis — 0.12.46

Implemented and installed the three requested changes:

- Fresh-chat and handoff dialogs expose Standard, Fast and Ultrafast. Fresh-chat
  preferences persist; handoff starts from the source speed. Automatic successors
  prioritize the latest stopped-source native setting, including explicit Standard.
  Speed is applied to thread creation and the first normal/Plan turn or Goal
  settings before activation. Native persistence preserves it across resume.
- Available choices follow the live model catalog (`serviceTiers`, with legacy
  `additionalSpeedTiers` support). Fast is canonicalized to `priority`. Unsupported
  selections fail before dispatch instead of silently downgrading. The runtime
  can otherwise store an unsupported tier while omitting it from the model request;
  this behavior was observed in the isolated stock catalog and is guarded against.
- Runtime readers include trusted speed settings and clear Fast/Ultrafast when
  Standard is explicitly selected. Ultra reasoning has a violet badge; Ultrafast
  has an amber badge, emphasized model name and highlighted selector.
- Right-clicking Restart proxy opens one dialog with automatic restart, idle
  minutes and EXE selection. Browse does not persist. Save does not issue a manual
  restart; left-click behavior remains unchanged. Proxy path/settings commits are
  serialized and the previous path is restored if the paired settings write fails.

Validation:

- Full Node suite: **423 passed**. Includes tier validation, current native
  inheritance versus manual override, persistence, unsupported models, default
  resets, per-thread readers, proxy loading/browsing/saving without restart and
  rollback of a failed settings/path update.
- Actual Edge passed at 1000, 520 and 320 px for both speed pickers, saved selection,
  cancellation, unavailable-tier blocking, Ultra/Ultrafast emphasis, proxy modal,
  background-refresh draft retention, validation and duplicate-save protection.
  Existing fresh-chat, handoff and sound/layout browser checks also passed.
- Native speed smoke test verified the actual model-request payload and rollout
  setting for all three speeds, Standard overriding a global Fast default, and
  preservation after a full fixture-host restart. Ultrafast was tested against an
  isolated model catalog advertising that tier; the user's catalog and account
  access were not changed. The test reads public model metadata only, never auth.
- Native Normal → Goal → Goal → Plan → Normal test passed with Fast on the first
  Goal request, a native change to Standard inherited by automatic Goal transfer,
  explicit Fast for Plan and Fast inheritance by the normal successor. Existing
  mode/context/permission guarantees remained intact. External model calls: zero.
- Syntax and normal repository whitespace checks passed. Shared scratch helpers
  verified ordinary LEGION\SP3 access, direct SID grants and inherited ACLs, then
  removed all owned test/build/install directories. Existing user changes were
  retained; no user proxy was restarted for verification.

Package: `codex-session-tracker-0.12.46.vsix`, 292 archive entries checked against
source/runtime hashes. SHA-256:
`c8ba535d75e91d1ff865b87fbab904e181910b25f77d8dc79047439b44776b4a`.

VS Code CLI installation succeeded. CLI listing, registry and manifest confirm
**0.12.46**. All 289 installed payload files match archive hashes; package metadata
was verified semantically because VS Code appends its installation metadata.
No forced window reload, commit, push or publication was performed.

[Runtime provenance](../checkpoints/speed-proxy-dialog-0.12.46-20261110.json)
records the installed OpenAI Extension and CLI plus the isolated rollout metadata.
