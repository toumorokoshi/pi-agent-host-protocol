# Spec: Background work

Status: **implemented** (`rpc` mode).

## Problem

A turn can end while pi keeps working: an extension's background job (`bash_bg`), an async subagent or a dev server started by a tool. The session's status then goes back to `Idle`, so a client shows it as done while it is not, and a user who waits for "finished" is told too early.

AHP 1.0 has a place for this: `ChatState.backgroundWork`, kept current with `chat/backgroundWorkSet` and `chat/backgroundWorkRemoved` (known since 0.9.0, so VS Code receives them too). It is deliberately left out of `SessionSummary` and `ChatSummary`, so a client only learns about it by subscribing to each chat, and pi has no way to tell the host about it.

## Goal

Publish what pi is still running after a turn as the chat's background work, and tell clients that only follow the session list that a session has some.

## Design

### Finding the work

The idle-session check already finds it (see [idle-sessions.md](idle-sessions.md)): pi's direct children that were not there when pi became ready. `PiAgent.backgroundProcesses()` now resolves with each process's pid and command line (`ps -A -o pid=,ppid=,args=`), and rejects when the process table cannot be read. Only `RpcBackend` agents have it.

### Publishing it (`src/pi/background-work.ts`, pure)

- pi-subagents' runner processes are left out: their subagents are `subagent` entries instead (see [subagents.md](subagents.md)). They still count when deciding whether an idle pi may be stopped.
- Each other process becomes a `BackgroundShellWork`: id `process:<pid>`, `command` the full command line, `label` the command cut to 80 characters, `startedAt` when the host first saw it, and `_meta.pid`.
- `backgroundWorkActions(current, { processes, running, now })` returns the actions that bring the chat in line: `chat/backgroundWorkRemoved` for entries whose process ended, `chat/backgroundWorkSet` for processes not listed yet. Entries whose id does not start with `process:` are left alone.
- **While a turn runs, nothing is added.** A new child during a turn is most likely a tool the turn is waiting on (a `bash` call). Processes still running when the turn ends are added by the next refresh. Ended ones are removed at any time.

### When it is refreshed

`PiSession.refreshBackgroundWork()` reads the session's current agent only; it never starts pi, so sessions loaded from history cost nothing. With no agent (never started, suspended, exited, embedded, or a pi terminal) the entries are cleared. A failed read keeps them as they are.

`AgentHost.refreshBackgroundWork()` refreshes every loaded session:
- every `backgroundWorkIntervalMs` (5 s from the CLI; off by default for library users);
- whenever a session starts or ends a turn (`activityChanged`), so work left by a turn shows within one `ps`;
- after an idle session is suspended (which needs no background work), its entries are cleared.

`PiSession.refreshBackgroundWork()` also refreshes the session's subagent tracker (status and session files, see [subagents.md](subagents.md)), whether or not pi is running, so subagent chats follow the same schedule.

A call made while a refresh runs waits for it and then refreshes once more; calls made meanwhile share that one.

### Telling the session list

The session summary's `_meta` carries the count under `pi-agent-host-protocol/backgroundWork` while there is any. It is in `listSessions` items and in a `root/sessionSummaryChanged` (`changes._meta`) whenever the count changes; `_meta: {}` says there is none. A client that only follows the root channel (shireitou's session list) can show the session as working without subscribing to its chat.

The status is **not** changed: `InProgress` still means a turn is running, as AHP defines it.

## Alternatives considered

- **Keeping `InProgress` set while background work runs:** every client would see the session as busy, but it changes what `InProgress` means (VS Code would show a running turn with nothing to stop).
- **A new notification:** `_meta` on the existing summary needs no protocol change and reaches clients that do not know about it as an ignored field.
- **Publishing children during a turn:** every `bash` tool call would flash as background work.
- **Following grandchildren:** a job backgrounded with `&` by pi's `bash` tool is reparented once that shell exits, so it is no longer pi's child. Walking the whole tree would include MCP servers' own children and the tools a turn runs; see GAPS.md.

## Tests

- `test/background-work.test.ts`: entries, labels, the actions (add, remove, nothing while running, foreign ids kept) and the `_meta`.
- `test/idle.test.ts`: process table parsing with command lines, the real `ps`, and with a fake backend: the chat's entries, the summary `_meta` in `listSessions` and `root/sessionSummaryChanged`, a failed read, nothing published during a turn but after it, and none for a pi the host did not start.
