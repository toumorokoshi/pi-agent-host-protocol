# Spec: Idle sessions

Status: **implemented**.

## Problem

In `rpc` mode the host starts one `pi --mode rpc` child per session that runs a turn, a rename or a `/` completion. Before this change a child lived until the session was disposed or the host stopped. Each one holds a full pi runtime plus whatever its extensions start (MCP servers, for example). On a real workstation an idle child took 240–295 MB RSS, and a host open for a day accumulated one per session used.

## Goal

Stop a session's pi process after a period without activity, without the client noticing, and without killing work pi is still doing.

## Design

### When a session is idle (`src/pi/idle.ts`)

`suspendBlocker(state, cutoff)` is a pure function over an `IdleState`. A session may be suspended only when all of these hold:

- **suspendable**: its agent is a `pi --mode rpc` child the host started, and it has not exited. Agents report this through `PiAgent.backgroundProcesses`, which only `RpcBackend` sets. Live TUI sessions (the user owns that process) and embedded agents (no process to stop) are never suspended.
- **not running**: no host turn, no turn typed in a terminal (`#externalRun`), and no `chat.activeTurn`.
- **nothing pending**: no steering message and no queued messages.
- **idle long enough**: `lastActivity <= now - idleTimeout`.

`lastActivity` is updated by:
- every client chat action and session action accepted for the session (turn start, cancel, pending messages, rename, read/archive flags);
- `completions` requests;
- a turn finishing, whether it was started by the host or in pi.

Client subscriptions do **not** count. VS Code stays subscribed to the sessions it shows all day, and restarting pi costs under a second.

### Background work (`src/pi/processes.ts`)

"No turn running" does not mean pi is doing nothing: extensions can run background jobs (`bash_bg`), async subagents or monitors that outlive a turn. Those run as child processes of pi.

pi also has children that are always there: MCP servers and other helpers that extensions start with pi. So the check is relative to a **baseline**:

1. When `RpcBackend.startAgent` has a ready pi (it answered `get_state` and `get_commands`), it reads the process table and records pi's direct children.
2. `backgroundProcesses()` reads the table again and returns pi's children that are not in the baseline.
3. A session with any such process is kept.

The process table comes from `ps -A -o pid=,ppid=` (Linux and macOS). Parsing and comparison are pure functions. If the table cannot be read, the session always counts as busy, so a failure never stops a process that might be working.

### Suspending (`PiSession.suspend`)

`suspend(cutoff)`:

1. Checks `suspendBlocker`. Returns `false` if anything blocks.
2. Asks `backgroundProcesses()`. Returns `false` if there are any.
3. Checks again, because a turn may have started while `ps` ran.
4. Clears `#agent` and disposes the agent: stdin closes (pi's orderly shutdown), then SIGTERM and SIGKILL after the existing grace period.
5. Re-opens the session file, so a rename made while no pi runs appends to its latest entry.

`#disposed` is **not** set. The session stays in `AgentHost.#sessions` and in the state store.

### What clients see

Nothing. Suspension cannot be seen over the protocol:
- `listSessions` builds live entries from `AgentHost.#sessions`, so the session is listed with the same title, status and `modifiedAt`;
- session and chat state and subscriptions are unchanged, and no action is sent;
- the next prompt, resume, rename or `/` completion goes through `PiSession.#ensureAgent()`, which starts a new `pi --mode rpc --session <file>`. The only cost is pi's startup, about 0.7 s, before that action runs.

State that survives the restart:
- **history**: in the session file, and the host's turns are in the store;
- **model and thinking level**: sent with each prompt by `#applyModel`;
- **resumable turns**: tracked by the host (`#resumableTurn`), so `chat/turnResume` still works;
- **skills and prompt templates**: `#loadCommands` runs again for the new pi.

Lost: anything an extension kept only in pi's memory.

### The sweep (`AgentHost.suspendIdleSessions`)

- An `unref`'d interval of `sweepInterval(timeout)`: half the timeout, between 1 s and 1 min. A process therefore stops between 1× and about 1.5× the timeout after its last activity.
- Sessions are checked one at a time. Concurrent calls share one sweep.
- Each suspension logs `idle session suspended` at info, with `session` and `idleMinutes`. A failure logs `could not suspend idle session` at warn. A session kept because of background processes logs `idle session kept (background processes)` at debug, with their `pids`.
- `dispose()` clears the interval and waits for a running sweep.

### Configuration

| Source | Value |
|---|---|
| `--idle-timeout <minutes>` | |
| `$PI_AGENT_HOST_PROTOCOL_IDLE_TIMEOUT` | |
| `idleTimeoutMinutes` in `settings.json` | |
| default | 30 |

The first one set wins. `0` keeps processes running. Fractions are allowed (`0.5` is 30 s). The setting has no effect in `embedded` mode.

`AgentHostOptions.idleTimeoutMs` takes milliseconds, and `AgentHostOptions.now` replaces the clock in tests. Both default to off and `Date.now`, so library users keep the old behaviour unless they opt in.

## Alternatives considered

- **Counting subscriptions as activity:** VS Code would keep every session it lists alive, which is the case this is meant to fix.
- **Treating any child of pi as background work:** with MCP servers configured, every pi has children from startup, so nothing would ever be suspended.
- **Asking pi whether it is busy:** pi's RPC protocol has no such command, and extensions have no common way to report background work.
- **Dropping idle sessions from memory as well:** a new session with no messages is not in pi's on-disk catalog and would disappear from `listSessions`. The process is where the memory goes, so only the process is stopped.

## Tests (`test/idle.test.ts`)

- Pure helpers: timeout parsing, sweep interval, `suspendBlocker`, process table parsing and the baseline comparison.
- With a fake backend:
  - an idle pi is stopped, the session is still listed with its state unchanged, and the next turn starts a new pi;
  - client activity restarts the idle clock;
  - a pi with background processes is kept until they are gone;
  - a pi running a turn typed in the terminal is kept;
  - a pi the host did not start is never stopped.
- With pi's real CLI in rpc mode: after suspension, the next turn's model request contains the earlier exchange.
