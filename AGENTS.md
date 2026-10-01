# Checkpoint provenance rules

Every coding checkpoint, release candidate, or automatic update record must capture the exact runtime versions used to produce and verify it. Run `node scripts/checkpoint.js` from the repository root and retain the JSON record with the work artifact. A checkpoint must record:

- the repository revision, tracker package version, and whether the checkout was dirty;
- the installed Codex VS Code Extension identifier and version;
- the bundled Codex CLI version used for inspection, including whether it was bundled or missing;
- the rollout metadata when available: `cliVersion` and `model` from the rollout/session record.

The checkpoint helper reads only Extension `package.json` metadata and executes the bundled CLI with `--version`. It must not read chat contents, environment secrets, authentication files, or persist private absolute paths. The `extensionRoots` input comes from VS Code discovery; callers must pass only candidate Extension directories.

Keep these provenance names distinct. `installedExtension` identifies the VS Code Extension package. `bundledCli` identifies the executable shipped with that Extension. `rollout.cliVersion` and `rollout.model` identify the runtime that wrote a particular rollout. A matching Extension and CLI version does not prove that every historical rollout used that version.

The known previous checkpoint is commit `8a2a76e5858db312f7c1ba3a0b71667810a51218` (`8a2a76e`), tracker `0.7.0`, tested with Extension `26.917.62051` and CLI `0.155.0-alpha.16.3`. The current installed Extension must be determined afresh; never copy the old values forward. On October 1, 2026 the installed Extension directory is `openai.chatgpt-26.928.31416-win32-x64`; the checkpoint helper should determine the actual bundled CLI version by running its Windows executable.

Do not create Git commits or push remotes as part of checkpoint collection. Checkpoint output is review metadata, not a substitute for tests or a release tag.
