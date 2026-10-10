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
- **Activity text is English only and based on tool names:** custom tools from extensions show `Running <tool>`. Retries and compaction have no activity text of their own.
- **Read-only file access:** `resourceWrite` and the other write operations are refused.

## Archived sessions

See [specs/archived-sessions.md](specs/archived-sessions.md).

- The read/unread flag is not persisted: every session loaded from disk starts as read.
- Archived ids are never pruned, so the file keeps ids of session files deleted outside the host.
- Two hosts sharing one state directory (`PI_AGENT_HOST_PROTOCOL_DIR`) would overwrite each other's archive file. The bridge socket lock normally prevents this.

## pi modes

- **Idle sessions (rpc):** see [specs/idle-sessions.md](specs/idle-sessions.md).
  - Extension state kept only in pi's memory is lost when an idle pi is stopped.
  - Background work is detected only as child processes pi started after it became ready. Work an extension does inside pi itself (timers, open sockets) is not seen, and such a pi can be stopped.
  - A helper process an extension starts lazily on the first turn (for example an MCP server started on first use) counts as background work, so that pi is never stopped.
  - Not tested on Windows (`ps` is used to read the process table; if it fails, nothing is stopped).
  - Embedded mode keeps idle sessions in memory.
- **Extension dialogs are not forwarded (rpc):** pi sends them over RPC, but the host dismisses them. They could be mapped to AHP input requests.
- **Dialog dismissal is untested:** no test drives an extension that opens a dialog in an RPC child.
- **Model list cache (rpc):** models are cached for 30 s, so a provider added in pi shows up after that.
- **Session title of a running rpc session** is read from the session file only when the session is loaded. A rename made inside pi (for example by an extension) is not reflected until the host reloads the session.
- **Agent directory not detected (rpc):** the host does not ask the `pi` executable which agent directory it uses. If the installed `pi` defaults to a different directory than `~/.pi/agent` (for example a build with `userConfigDir: ".av-pi"`), pass `--agent-dir`, or saved sessions vanish from the list after a restart.
- **Version skew (rpc):** the host is tested against the pi bundled in `node_modules`. An installed `pi` with a different RPC protocol version is not detected.

## Steering and queued messages

- **A steer that pi receives as its run settles can be lost or delayed.** If the host sends `steer` just after pi's loop last checked its steering queue, pi stores the message but doesn't start a run for it. The message then runs with the next prompt, or never runs. The host can't tell, because the steering message has already left the pending state. Fixing this needs pi to report its queue (for example `queue_update`), or the host to send `steer` only while pi is still streaming.
- **Messages can't be held while the session is idle.** The host starts a queued message straight away when no turn is running. AHP has no "paused" queue state.
- **Not checked against VS Code:** "send immediately" on a queued message was read from VS Code's documentation, and its exact action sequence hasn't been observed.

## Resuming errored turns

- **pi's run loop is bypassed (embedded mode):** a resumed run calls `agent.continue()` directly because pi has no public continue API. pi's auto-retry, automatic compaction, `agent_settled` and `agent_before_settle` hooks therefore don't run for the continuation. Asking pi for a public `AgentSession.continue()` would remove this.
- **Hidden marker entries (rpc mode):** every resume adds an `ahp-resume` custom message to the session file. pi's TUI does not display it, and it is filtered from model context only while the resume extension is loaded. If you continue the session in a plain `pi` later, the failed reply is sent to the model again.
- **Lost on restart:** resumability is kept in memory only. After a host restart, a turn reloaded from history that ended in an error cannot be resumed; send a new message instead.
- **Usage:** the resumed run's token usage replaces the turn's usage rather than adding to it.

## Skills and prompt templates

- **No refresh on `/reload`:** the list is read once per pi process. Skills added later, or reloaded in a pi terminal with `/reload`, appear only when pi next starts for that session.
- **Sessions from history** show no customizations until their first turn or `/` completion, because the list comes from a running pi.
- **Read-only:** `session/customizationToggled` is rejected (pi cannot disable one skill per session), and clients cannot create skills in the listed directories.
- **No root-level listing:** `AgentInfo.customizations` is not published, so clients see skills only per session.
- **Project trust in host sessions:** `pi --mode rpc` skips project skills unless the project is trusted (`/trust` or `defaultProjectTrust: "always"`). The host could offer a setting to pass `--approve`.
- **Extension commands** are neither listed nor completed.
- **Not yet confirmed in VS Code:** completions were checked against the live host and VS Code's source, but not yet in a reloaded Agents window. VS Code reuses the `InitializeResult` from its first handshake, so a window that last initialized against an older host needs one `NotFound` reconnect (now automatic) or a window reload.
- **Skill argument hints are not shown:** VS Code shows `argumentHint` only for command items, and skills are sent as skill references to get a skill chip. A skill's `argument-hint` is read but not displayed.
- **Mid-message skills need the chip:** a skill later in a message is loaded only when it was picked from the completion list. Typing `/skill:<name>` there by hand, or pi terminal input, is not expanded. Prompt templates still work only at the start.
- **`/name` vs `/skill:name`:** VS Code's hosts insert `/<skill-name>`, while this host inserts `/skill:<name>` because pi expands only that form. Typing `/yft-pr-commit-description` by hand is therefore not expanded by pi.

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
- **Steering typed in the terminal** during a run appears as a new turn, because each user message opens a turn. Steering sent from VS Code works the same way (see [specs/steering.md](specs/steering.md)).
- **Steering that pi never delivers** (the run ends first, for example after a cancel) is dropped without a notice. pi keeps it in its own queue and may deliver it at the start of its next run, where it appears as part of that run's first turn.
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
