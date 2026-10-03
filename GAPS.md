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
- **Not implemented:** terminals, changesets, resource watches, MCP and automations.
- **Read-only file access:** `resourceWrite` and the other write operations are refused.

## Live TUI sessions (milestone 2)

Not started. A bridge extension in each interactive `pi` process would register its live session with the host over a local socket. `PI_AGENT_HOST_DAEMON=1` is already set in the host process, so that extension can stay inactive there.

## Logging

- Text lines only: no JSON output option and no log file. Redirect stderr if you need a file.
- Actions the host sends (for example streaming `chat/delta`) are not logged, even at debug.
- Model-catalog refreshes on `initialize` are not logged.

## Tooling

- The npm name `pi-agent-host` is a placeholder (`pi-ahp` is taken).
