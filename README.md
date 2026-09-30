# Codex Session Tracker 0.5.0

A VS Code tracker for Codex sessions. It reads Codex rollout JSONL files so a gray or disconnected Codex panel does not hide work that is still running.

## What is shown

The selected chat now has a timestamped activity timeline. It understands the rollout schema used by current Codex VS Code builds, including `event_msg.payload.item_completed` records and `response_item` records.

- Command executions appear as **Ran command** entries with the exact command, exit code, output, actor, absolute time, and relative age.
- File changes appear as **Edited files** entries with one expandable child row per changed file.
- Image views appear as **Viewed image** entries, including the image path when Codex recorded one.
- Assistant and user messages are retained with their event time and expandable full text.
- Consecutive command/file/image operations are grouped into an expandable activity block. The block keeps each individual operation and its own timestamp.
- Root and child-agent current activity rows show the event time, while a quiet running turn is explicitly marked as quiet. A quiet duration is not treated as proof that Codex stopped.
- Completed or aborted activity remains visible when the selected chat is no longer running.
- Raw encrypted reasoning content is never rendered.

The active-chat list remains scoped to root chats with at least one running root/child thread. Chat identity is the root `thread_id`; repository path and `cwd` are not used to merge unrelated chats.

## Sending while the Codex panel is gray

The composer uses Codex's durable queue command:

```text
codex queue --thread <ROOT_THREAD_ID> --message <TEXT>
```

This is the safe insertion path. It writes to Codex's shared queue and lets the existing owner/app-server consume the message after the current turn becomes idle. The tracker does not resume the chat, start a second owner, steer an unknown `turn_id`, interrupt a turn, edit rollout files, or change the model.

The executable resolver is platform-aware. On Windows it rejects Linux, macOS, and other Unix binaries shipped beside the Windows build, then prefers the `windows-*`/`win32-*` binary and finally `codex` from `PATH`. The bundled executable is probed for `queue --thread` and `--message` support before the composer is enabled. If an extension update leaves a cached path to a removed executable, an `ENOENT` error triggers one fresh platform re-probe and a single retry.

The queue operation preserves `CODEX_HOME`, the selected root thread ID, and the selected working directory. It never passes a model override. A successful notice includes the queue result; an error keeps the CLI diagnostic visible so the user can re-probe.

## Files read and writes performed

Monitoring reads:

```text
<CODEX_HOME>/session_index.jsonl
<CODEX_HOME>/sessions/**/rollout-*.jsonl
```

Sending invokes the detected Codex CLI's official `queue` command. The extension itself does not write rollout JSONL files or call `resume`, `turn/steer`, reload, or interrupt operations.

## Install

Build a VSIX with the repository's packaging script, then install it from VS Code's **Install from VSIX...** command:

```powershell
code --install-extension .\codex-session-tracker-0.5.0.vsix --force
```

Reloading VS Code is not requested by the tracker. If a window reload would interrupt an important turn, defer the reload until the turn is safe to stop.

## Settings

- `codexSessionTracker.codexHome`: override Codex home; otherwise `CODEX_HOME` or `~/.codex`.
- `codexSessionTracker.codexCliPath`: exact executable used for queue delivery.
- `codexSessionTracker.pollIntervalMs`: selected-chat refresh interval.
- `codexSessionTracker.activeScanEverySeconds`: active-chat list refresh interval.
- `codexSessionTracker.quietAfterSeconds`: quiet threshold shown while the rollout remains running.
- `codexSessionTracker.staleAfterSeconds`: default one hour without a rollout write before an unfinished turn is classified as stale and removed from active chats.
- `codexSessionTracker.timelineLimit`: maximum merged activity entries retained per refresh.
- `codexSessionTracker.activityTailMb`: tail size used for activity parsing.
- `codexSessionTracker.treeScanLimit`: rollout metadata scan bound for root/child resolution.

## Tests

```bash
node --test test/*.test.js
```

The tests cover root/child identity, current Codex `item_completed` records, response-item tool calls, command/file/image/message extraction, timestamps, aborted turns, active-only chat discovery, activity grouping inputs, status colors, platform-safe CLI selection, and the exact queue argument/environment contract.
