# Codex Session Tracker 0.6.0

A VS Code tracker for Codex sessions. It reads Codex rollout JSONL files so a gray or disconnected Codex panel does not hide work that is still running.

## What is shown

The selected chat now has a timestamped activity timeline. It understands the rollout schema used by current Codex VS Code builds, including `event_msg.payload.item_completed` records and `response_item` records.

- Command executions appear as **Ran command** entries with the exact command, exit code, output, actor, absolute time, and relative age.
- File changes appear as **Edited files** entries with one expandable child row per changed file.
- Image views appear as **Viewed image** entries, including the image path when Codex recorded one.
- Assistant and user messages are retained with their event time and expandable full text.
- Consecutive command/file/image operations are grouped into an expandable activity block. The block keeps each individual operation and its own timestamp.
- Root and child-agent current activity rows show the event time. Rollout file age is displayed only as a timestamp source fallback; it never changes a running state.
- Completed or aborted activity remains visible when the selected chat is no longer running.
- Activity history is collapsed to the newest summary row by default. Full history and each operation remain expandable, and open/collapsed choices plus the main scroll position survive polling refreshes.
- Long commands and file paths are ellipsized in summaries and wrap inside their own card when expanded; they cannot widen the dashboard and create a page-level horizontal scrollbar. Drag the divider to resize the chat-list column.
- Raw encrypted reasoning content is never rendered.

The active-chat list remains scoped to root chats with at least one running root/child thread in the current task lifecycle. Chat identity is the root `thread_id`; repository path and `cwd` are not used to merge unrelated chats. A child from an older root turn is ignored even if its old rollout file still ends in `task_started`; a terminal root also closes orphaned children whose start event precedes that root completion. No wall-clock timeout is used to decide whether a job is running.

For recency, the tracker prefers the read-only `threads.updated_at_ms` value from `<CODEX_HOME>/state_*.sqlite` when the VS Code host exposes Node's built-in SQLite driver. It falls back to `session_index.jsonl` and timestamps embedded in rollout events. This avoids reporting an old file flush time as the time of the latest chat message.

## Sending while the Codex panel is gray

The composer has two explicit actions:

- **Steer ngay** sends the official app-server `turn/steer` request with the selected root thread and the currently active `turn_id`. It is enabled only when a read-only probe confirms that a control socket is available. The installed VS Code Codex extension currently owns its app-server over a private stdio pipe, so this button is normally disabled with an explanation. The tracker never starts a second app-server; doing so conflicts with the active writer.
- **G&#7917;i sau** invokes the durable queue command below. It is the reliable action for the current VS Code stdio owner and does not interrupt the running turn.

The composer uses Codex's durable queue command:

```text
codex queue --thread <ROOT_THREAD_ID> --message <TEXT>
```

This is the safe insertion path. It writes to Codex's shared queue and lets the existing owner/app-server consume the message after the current turn becomes idle. A failed steer is never silently converted into a queued message. The tracker does not resume the chat, start a second owner, steer an unknown `turn_id`, interrupt a turn, edit rollout files, or change the model.

The executable resolver is platform-aware. On Windows it rejects Linux, macOS, and other Unix binaries shipped beside the Windows build, then prefers the `windows-*`/`win32-*` binary and finally `codex` from `PATH`. The bundled executable is probed for `queue --thread` and `--message` support before the composer is enabled. If an extension update leaves a cached path to a removed executable, an `ENOENT` error triggers one fresh platform re-probe and a single retry.

The queue operation preserves `CODEX_HOME`, the selected root thread ID, and the selected working directory. It never passes a model override. A successful notice includes the queue result; an error keeps the CLI diagnostic visible so the user can re-probe.

## Files read and writes performed

Monitoring reads:

```text
<CODEX_HOME>/session_index.jsonl
<CODEX_HOME>/sessions/**/rollout-*.jsonl
```

Sending invokes the detected Codex CLI's official `queue` command. A steer attempt uses only `codex app-server proxy` after a control-socket probe; it never starts `codex app-server` itself. The extension itself does not write rollout JSONL files or call `resume`, reload, or interrupt operations.

## Install

Build a VSIX with the repository's packaging script, then install it from VS Code's **Install from VSIX...** command:

```powershell
code --install-extension .\codex-session-tracker-0.6.0.vsix --force
```

Reloading VS Code is not requested by the tracker. If a window reload would interrupt an important turn, defer the reload until the turn is safe to stop.

## Settings

- `codexSessionTracker.codexHome`: override Codex home; otherwise `CODEX_HOME` or `~/.codex`.
- `codexSessionTracker.codexCliPath`: exact executable used for queue delivery.
- `codexSessionTracker.pollIntervalMs`: selected-chat refresh interval.
- `codexSessionTracker.activeScanEverySeconds`: active-chat list refresh interval.
- `codexSessionTracker.timelineLimit`: maximum merged activity entries retained per refresh.
- `codexSessionTracker.activityTailMb`: tail size used for activity parsing.
- `codexSessionTracker.treeScanLimit`: rollout metadata scan bound for root/child resolution.

## Tests

```bash
node --test test/*.test.js
```

The tests cover root/child identity, current Codex `item_completed` records, response-item tool calls, command/file/image/message extraction, timestamps, aborted turns, active-only chat discovery, activity grouping inputs, status colors, platform-safe CLI selection, and the exact queue argument/environment contract.
