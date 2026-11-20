# Gaps

Known issues and features not yet implemented.

## Verification

- **Not yet tested against a real VS Code Agents window.** The VS Code workarounds (URI shapes, session renames sent to the chat channel, `reconnect` arriving without a `channel`) come from reading VS Code's source and Qusic/pi-ahp. The tests use a client that imitates them.
- No CI run has been observed yet. The workflow was added together with the first commit.
- **Session URI schemes:** sessions VS Code created as `ahp-session:/<id>` before `session-schemes.json` existed are still published as `pi:/<id>`. VS Code may show them with a nested second chat. See [specs/session-uris.md](specs/session-uris.md).

## Protocol coverage (milestone 1)

- **Tool approvals:** tools run without confirmation, because pi has no permission system. Planned: an opt-in `--approve-tools`.
- **Chats other than forks:** side chats, empty new chats (`createChat` without a source), `moveChat` and `disposeChat` are unsupported. See [Forked chats](#forked-chats).
- **`disposeSession`** only discards empty sessions, and pi session files are never deleted (see the README).
- **No paging:** `fetchTurns` does not page, so history is sent in full.
- **History gaps:** compaction summaries, the text of custom messages and bash executions are not shown in reloaded history. A custom message that woke the agent after a run starts a "Continued in pi" turn, as it does live.
- **pi extension dialogs** resolve with their defaults in embedded mode. See [Extension dialogs](#extension-dialogs) for rpc mode.
- **File edits** are shown as text results, not file diffs.
- **Not implemented:** changesets, MCP and automations. Annotations hold VS Code's review comments only; see [Review comments](#review-comments-annotations).
- **Activity text is English only and based on tool names:** custom tools from extensions show `Running <tool>`. Retries and compaction have no activity text of their own.
- **Read-only file access:** `resourceWrite` and the other write operations are refused.
- **Moving a session's working directory (`session/workingDirectoryReplaced`):** not supported while a turn is in progress or while a live pi TUI drives the session through the bridge; generic `session/workingDirectorySet` and `session/workingDirectoryRemoved` are rejected because pi has a single `cwd`. See [specs/working-directory-move.md](specs/working-directory-move.md).

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
- **Background work** (rpc): see [specs/background-work.md](specs/background-work.md).
  - Only pi's direct children are seen. A job pi's `bash` tool backgrounds with `&` (or `nohup`) is reparented when that shell exits and is not reported; jobs an extension keeps (such as `bash_bg`) are.
  - Every process other than pi-subagents' runners is a `shell` entry, and no entry has a `terminal` with its output. Subagents started by other tools (Bolt's `agent_bg`) are shells.
  - `startedAt` is when the host first saw the process, up to 5 s late, or when the turn that started it ended.
  - Nothing is reported for embedded sessions or pi terminals: their children are the host's or the terminal's own.
  - Each refresh runs `ps` once per running pi, every 5 s and at each turn start and end.
- **Model list cache (rpc):** models are cached for 30 s, so a provider added in pi shows up after that.
- **Session title of a running rpc session** is read from the session file only when the session is loaded. A rename made inside pi (for example by an extension) is not reflected until the host reloads the session.
- **Agent directory not detected (rpc):** the host does not ask the `pi` executable which agent directory it uses. If the installed `pi` defaults to a different directory than `~/.pi/agent` (for example a build with `userConfigDir: ".av-pi"`), pass `--agent-dir`, or saved sessions vanish from the list after a restart.
- **Version skew (rpc):** the host is tested against the pi bundled in `node_modules`. An installed `pi` with a different RPC protocol version is not detected.

## Subagent chats

See [specs/subagents.md](specs/subagents.md).

- **Read-only:** a subagent can't be stopped or steered from its chat. pi-subagents has `/subagents-stop` and `/subagents-steer`, but AHP has no action for it on a worker chat; stop the parent's turn or use the commands in a pi terminal.
- **Polled transcripts:** a child's session file is re-read when it changed, on the host's background work refresh (5 s from the CLI, or at a turn's start and end) and on `status.json` changes, not streamed token by token, so its chat updates in steps. It is re-parsed whole each time, not read from the appended bytes.
- **Rows for children found late:** a workflow whose arguments don't name its children gets their rows in the parent's turn only while that turn is running; after it ended they show only after a restart.
- **Nested subagents:** a subagent's own `subagent` calls are shown in its transcript but get no chats of their own.
- **0.73 after a cleaned `/tmp`:** pi-subagents 0.73 writes no child run ids into its completion notice and keeps children's session files under per-launch directories, so its runs can't be rebuilt without their `status.json`. 0.84 runs can.
- **Forks:** a fork made after a `subagent` call repeats that call in its history, so once the fork is loaded it gets its own copies of those subagent chats (ids scoped to the fork), linked from its copy of the tool call. After a cleaned `/tmp` their transcripts are found under the fork's session file or the files it was forked from (up to 8 generations).
- **Subagent chats are not a chat kind of their own:** they share `ChatRef` and the store's chat maps with forks, so `AgentHost` finds their owner by asking each `PiSession` (`ownsSubagentChat`); a `kind: "subagent"` on `ChatRef` would let it route by ref.
- **Not yet tried in a real VS Code window**, only against the test client, VS Code's source and a throwaway host running real Bolt subagents (0.73.1 and 0.84.0).

## Steering and queued messages

- **A steer waits behind a long tool call.** pi delivers a steering message once the current reply's tool calls finish, as VS Code's "Steer with Message" describes, so a tool that blocks holds it until the tool returns. Bolt's `bash` and pi-subagents' `bg_wait` (from 0.84.0) return early on new input; other blocking tools need to do the same. Use "Stop and Send" to interrupt.
- **Extension messages dropped with a cleared queue:** pi's `clear_queue` also drops messages extensions queued during the run (a background subagent's result, Bolt's job notices) and returns only the user's. The host clears pi's queue after a client cancel (as pi's Esc does) and when Bolt's `bash` resent a steer as a follow-up; a subagent result queued in that turn is then lost. pi would need a call that clears only the user's messages.
- **No notice for a dropped steer:** after a client cancel, the turn has already ended, so a steer the host drops gets no notice in the chat, only an info log line.
- **Messages can't be held while the session is idle.** The host starts a queued message straight away when no turn is running. AHP has no "paused" queue state.
- **Not checked against VS Code:** "send immediately" on a queued message was read from VS Code's documentation, and its exact action sequence hasn't been observed.

## Resuming errored turns

- **pi's run loop is bypassed (embedded mode):** a resumed run calls `agent.continue()` directly because pi has no public continue API. pi's auto-retry, automatic compaction, `agent_settled` and `agent_before_settle` hooks therefore don't run for the continuation. Asking pi for a public `AgentSession.continue()` would remove this.
- **Hidden marker entries (rpc mode):** every resume adds an `ahp-resume` custom message to the session file. pi's TUI does not display it, and it is filtered from model context only while the resume extension is loaded. If you continue the session in a plain `pi` later, the failed reply is sent to the model again.
- **Lost on restart:** resumability is kept in memory only. After a host restart, a turn reloaded from history that ended in an error cannot be resumed; send a new message instead.
- **Usage:** the resumed run's token usage replaces the turn's usage rather than adding to it.

## Truncation (`chat/truncated`)

- **Not for pi terminal sessions:** while an interactive pi drives a session through the bridge, `chat/truncated` is rejected, because extensions cannot invoke the `/ahp-truncate` command by name. The bridge would need its own way to call `navigateTree`. This rejection has no test yet.
- **Mapping by position:** the cut is found by counting the kept turns that pi has a user message for. A turn whose prompt pi recorded without the host seeing it (none known today) would shift the cut by one. Turns loaded from history could be matched by id instead, since their ids are pi's entry ids.
- **Compaction:** a cut before a compaction entry moves the leaf before it, so pi's context is rebuilt from the uncompacted history and may compact again on the next run.
- **A failed truncation** is only logged; the client learns of it when its next turn fails.
- **Racing a queued message:** a queued message can start in the moment between the aborted run settling and the client's `chat/turnStarted` arriving, the same race a cancellation followed by a new message has.

## Forked chats

See [specs/forks.md](specs/forks.md).

- **No delete:** a fork cannot be removed (`disposeChat`), and its pi session file and its entry in `forked-chats.json` are kept for good. A fork whose file was deleted outside the host is skipped with a warning but stays in the file.
- **Not in the session's status:** a running or unread fork changes only its own catalog entry. The session's summary status, activity text and background work count follow its default chat, so a session list shows a session as idle while only a fork runs.
- **Fork point after an edit:** the fork point is found on the source file's current branch. Right after `chat/truncated`, before the edited message is written, pi's file still ends on the abandoned branch, so a fork made in that moment counts along the old branch.
- **Origin turn ids:** a fork's `origin.turnId` is the id the client knew when forking. Turns started in this host run have client ids, which become pi's entry ids when the session is reloaded, so after a restart the origin can name a turn the source chat no longer lists by that id.
- **Fork files in pi:** each fork is an ordinary pi session (with `parentSession` set), so `pi --resume` lists it. Opening one in a pi terminal while the bridge runs attaches it as a session of its own, not as a chat of its session.
## Skills and prompt templates

- **No refresh on `/reload`:** the list is read once per pi process. Skills added later, or reloaded in a pi terminal with `/reload`, appear only when pi next starts for that session.
- **Sessions from history** list their folder's commands from a short-lived pi (rpc mode) when a client opens them, so a `/` typed right after opening waits for one pi start (a few hundred milliseconds locally, longer where pi's extensions start slowly). The list is not kept across host restarts; a cache on disk, refreshed in the background, would make it instant there too. In embedded mode the folder list misses skills that extensions add until the session's first turn.
- **Read-only:** `session/customizationToggled` is rejected (pi cannot disable one skill per session), and clients cannot create skills in the listed directories.
- **Root-level listing is global only:** `AgentInfo.customizations` holds pi's global skills and prompt templates (read from an empty folder), so a new session's project skills appear only once it starts. In embedded mode, skills added by extensions are left out there. Each refresh costs a short-lived pi in rpc mode (cached for 30 seconds).
- **Project trust in host sessions:** `pi --mode rpc` skips project skills unless the project is trusted (`/trust` or `defaultProjectTrust: "always"`). The host could offer a setting to pass `--approve`.
- **Extension commands are completed but not listed:** they have no file, so they are not customizations.
- **At most 50 completions:** a bare `/` in a folder with hundreds of skills lists prompt templates and extension commands first, then the first skills by name. The rest appear as the user types more of the name.
- **Not yet confirmed in VS Code:** completions were checked against the live host and VS Code's source, but not yet in a reloaded Agents window. VS Code reuses the `InitializeResult` from its first handshake, so a window that last initialized against an older host needs one `NotFound` reconnect (now automatic) or a window reload.
- **Skill argument hints are not shown:** VS Code shows `argumentHint` only for command items, and skills are sent as skill references to get a skill chip. A skill's `argument-hint` is read but not displayed.
- **Mid-message skills need the chip:** a skill later in a message is loaded only when it was picked from the completion list. Typing `/skill:<name>` there by hand, or pi terminal input, is not expanded. Prompt templates still work only at the start.
- **`/name` vs `/skill:name`:** VS Code's hosts insert `/<skill-name>`, while this host inserts `/skill:<name>` because pi expands only that form. Typing `/yft-pr-commit-description` by hand is therefore not expanded by pi.

## Extension dialogs

See [specs/extension-dialogs.md](specs/extension-dialogs.md).

- **rpc only:** embedded sessions and pi terminal sessions do not forward dialogs, and a dialog an extension opens outside a turn (for example at startup or from a timer) is dismissed. Runs pi starts on its own (such as `/plan <prompt>`'s planning run) do show them.
- **No status line or widgets:** `setStatus`, `setWidget`, `setTitle` and `set_editor_text` are ignored. An extension's footer status, such as a plan's progress, is not shown.
- **Notifications outside a turn** are logged only, and ones pi sends while it starts (such as an extension's greeting) are dropped. One an extension sends just after its turn was cancelled can appear in the next turn.
- **No multi-line editor:** `editor` dialogs are a text question with the prefill as its default value. VS Code may show it as a single-line field.
- **Not yet tried in a real VS Code window**, only against the test client and VS Code's source.

## Review comments (annotations)

See [specs/annotations.md](specs/annotations.md).

- **No comment tools:** pi reads submitted comments as prompt text. It cannot list, reply to or add comments, as VS Code's own host lets its agent do.
- **Resolved on completion:** a completed turn resolves every comment it was given, whether or not the agent addressed each one. A comment sent as a steering message is not resolved.
- **VS Code-specific `_meta` keys:** `agentFeedback` and `vscode.agentFeedback` are read from VS Code's attachments and annotations, as the completion items' `_meta` are. If VS Code renames them, comments still reach pi from the channel, but without the selection and diff text.
- **Forks share the session's channel:** a comment submitted in a forked chat is read from the session's channel and resolved there.
- **Not yet tried in a real VS Code window**, only against the test client and VS Code's source.

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
