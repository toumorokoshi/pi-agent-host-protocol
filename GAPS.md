# Gaps

Known issues and features not yet implemented.

## Verification

- **Not yet tested against a real VS Code Agents window.** The VS Code workarounds (URI shapes, session renames sent to the chat channel, `reconnect` arriving without a `channel`) come from reading VS Code's source and Qusic/pi-ahp. The tests use a client that imitates them.
- No CI run has been observed yet. The workflow was added together with the first commit.

## Protocol coverage (milestone 1)

- **Tool approvals:** tools run without confirmation, because pi has no permission system. Planned: an opt-in `--approve-tools`.
- **One chat per session:** `createChat`, forks and side chats are unsupported.
- **`disposeSession`** only discards empty sessions, and pi session files are never deleted (see the README).
- **No paging:** `fetchTurns` does not page, so history is sent in full.
- **History gaps:** compaction summaries, custom messages and bash executions are not shown in reloaded history.
- **pi extension dialogs** resolve with their defaults in host sessions.
- **File edits** are shown as text results, not file diffs.
- **Not implemented:** changesets, MCP and automations.
- **Read-only file access:** `resourceWrite` and the other write operations are refused.

## Terminals and resource watches

- **Terminal lifetime:** a terminal lives until a client calls `disposeTerminal` or the host stops. One whose client disconnects for good is never cleaned up.
- **No command detection:** `terminal/commandExecuted` and `terminal/commandFinished` are never sent, because there is no shell integration.
- **Terminal output after a restart:** output is not persisted, so terminals and their scrollback end when the host stops. Each terminal keeps only the last 256 KiB of scrollback for new subscribers.
- **pi's `bash` tool** does not run in an AHP terminal, so tool calls have no live terminal view (`ToolResultTerminalContent`).
- **Watch cost:** watches use `@parcel/watcher`. On Linux, a recursive watch of a large tree (such as a home directory) costs inotify watches. VS Code currently opens about 10 watches when it connects.
- **Watch permissions:** `createResourceWatch` has no permission gate beyond requiring a host-local `file:` path, the same as `resourceRead`.

## Live TUI sessions (milestone 2)

Not started. A bridge extension in each interactive `pi` process would register its live session with the host over a local socket. `PI_AGENT_HOST_DAEMON=1` is already set in the host process, so that extension can stay inactive there.

## Logging

- Text lines only: no JSON output option and no log file. Redirect stderr if you need a file.
- Actions the host sends (for example streaming `chat/delta`) are not logged, even at debug.
- Model-catalog refreshes on `initialize` are not logged.

## Tooling

- The npm name `pi-agent-host` is a placeholder (`pi-ahp` is taken).
