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

## pi modes

- **One process per session (rpc):** every open session keeps a `pi --mode rpc` child until it is disposed or the host stops. Idle children are never stopped early.
- **Extension dialogs are not forwarded (rpc):** pi sends them over RPC, but the host dismisses them. They could be mapped to AHP input requests.
- **Dialog dismissal is untested:** no test drives an extension that opens a dialog in an RPC child.
- **Model list cache (rpc):** models are cached for 30 s, so a provider added in pi shows up after that.
- **Session title of a running rpc session** is read from the session file only when the session is loaded. A rename made inside pi (for example by an extension) is not reflected until the host reloads the session.
- **Version skew (rpc):** the host is tested against the pi bundled in `node_modules`. An installed `pi` with a different RPC protocol version is not detected.

## Resuming errored turns

- **pi's run loop is bypassed (embedded mode):** a resumed run calls `agent.continue()` directly because pi has no public continue API. pi's auto-retry, automatic compaction, `agent_settled` and `agent_before_settle` hooks therefore don't run for the continuation. Asking pi for a public `AgentSession.continue()` would remove this.
- **Hidden marker entries (rpc mode):** every resume adds an `ahp-resume` custom message to the session file. pi's TUI does not display it, and it is filtered from model context only while the resume extension is loaded. If you continue the session in a plain `pi` later, the failed reply is sent to the model again.
- **Lost on restart:** resumability is kept in memory only. After a host restart, a turn reloaded from history that ended in an error cannot be resumed; send a new message instead.
- **Usage:** the resumed run's token usage replaces the turn's usage rather than adding to it.

## Terminals and resource watches

- **Terminal lifetime:** a terminal lives until a client calls `disposeTerminal` or the host stops. One whose client disconnects for good is never cleaned up.
- **No command detection:** `terminal/commandExecuted` and `terminal/commandFinished` are never sent, because there is no shell integration.
- **Terminal output after a restart:** output is not persisted, so terminals and their scrollback end when the host stops. Each terminal keeps only the last 256 KiB of scrollback for new subscribers.
- **pi's `bash` tool** does not run in an AHP terminal, so tool calls have no live terminal view (`ToolResultTerminalContent`).
- **Watch cost:** watches use `@parcel/watcher`. On Linux, a recursive watch of a large tree (such as a home directory) costs inotify watches. VS Code currently opens about 10 watches when it connects.
- **Watch permissions:** `createResourceWatch` has no permission gate beyond requiring a host-local `file:` path, the same as `resourceRead`.

## Live TUI sessions (milestone 2)

- **Not yet tried against a real VS Code window**, only against the test client and a real `pi` TUI in a pty.
- **Not published:** `pi install npm:pi-agent-host-protocol` does not work until the package is published to npm. Install from a built checkout.
- **Mid-run attach:** when a TUI attaches while a run is streaming, the host picks up from that run's next user or assistant message. Earlier output of that run is missing until the session is reloaded.
- **Steering typed in the terminal** during a run appears as a new turn, because each user message opens a turn.
- **Two writers, briefly:** if a terminal opens a session while the host's own `pi` is mid-run, both can write to the file until that run ends.
- **No auto-retry events** reach the host from a TUI (the extension API has none), so retries are not logged for live sessions.
- **Extension dialogs** in the TUI still show in the terminal only; VS Code is not asked.
- **Unix only:** the bridge uses a unix socket. Windows would need a named pipe.
- **Host lifetime:** a host started by the extension runs until it is killed; it does not exit when the last terminal closes.

## Logging

- Text lines only: no JSON output option and no log file. Redirect stderr if you need a file.
- Actions the host sends (for example streaming `chat/delta`) are not logged, even at debug.
- Model-catalog refreshes on `initialize` are not logged.

## Tooling

- **Not published:** the package is named `pi-agent-host-protocol` (free on npm as of 2026-10-04; `pi-ahp` is taken) but has not been published.
