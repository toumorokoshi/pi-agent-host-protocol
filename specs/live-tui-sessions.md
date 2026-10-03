# Spec: Live TUI sessions — milestone 2

Status: **implemented** (see "Implementation notes" at the end for where it differs from the plan).

## Goal

pi sessions open in terminals show up in the VS Code Agents window while they run, and both sides can drive them:
- a prompt typed in the TUI streams into VS Code as a turn;
- a prompt, steer or cancel from VS Code runs in the TUI, which shows it as usual.

Decisions (2026-10-03):
- Every interactive `pi` with the extension installed shares its session **automatically**. `/ahp off` detaches one session.
- If no host is running, the extension **starts one detached**, and it keeps running after the TUI exits.
- The extension ships **in the `pi-agent-host` npm package**, so one `pi install npm:pi-agent-host` provides both.

## Architecture

```
VS Code ──ws──▶ pi-agent-host (daemon)
                 ├─ RpcBackend: `pi --mode rpc` child per host-created session   (milestone 1)
                 └─ BridgeRegistry ◀── unix socket ── bridge extension in pi TUI #1
                                   ◀── unix socket ── bridge extension in pi TUI #2
```

The bridge speaks **the same JSONL protocol as `pi --mode rpc`**, but over a unix socket instead of stdio:
- commands (`prompt`, `steer`, `abort`, `set_model`, …) go host → bridge;
- responses and session events (wire form) go bridge → host.

The host can therefore drive a TUI session with the existing `RpcAgent`, `TurnMapper` and resume logic. Only the transport and the session's origin differ.

## Components

### 1. Shared JSONL channel (refactor)

- Extract `RpcChannel` from `src/pi/rpc-process.ts`: request/response correlation, record listeners and LF-only framing over any `Duplex`, plus a `closed` signal.
- `RpcProcess` becomes "spawn a child, plus an `RpcChannel` on its stdio". A bridge connection is "a socket, plus an `RpcChannel`".
- `RpcAgent` takes an `RpcChannel` instead of an `RpcProcess`, so it serves both cases.
- Add `toWireEvent(event)` (drops `message` and `partial` from `message_update`, as pi's RPC mode does), for the bridge to use. pi does not export its own `toJsonEvent`.

### 2. Bridge protocol (`src/bridge/protocol.ts`)

Socket: `<agent-host dir>/host.sock`, in the `0700` settings directory (`~/.pi/agent-host`, or `$PI_AGENT_HOST_DIR`).

Bridge → host:
- `{type:"attach", protocol:1, pid, sessionId, sessionFile, cwd, name?, isStreaming}`: sent on connect, and again after each session switch.
- `{type:"detach", sessionId}`: sent on `/ahp off`, or before `/new` / `/resume` / `/fork` switch to another session.
- pi session events in wire form, plus `response` records for host commands.

Host → bridge (a subset of pi's RPC commands, same field names):
- `prompt` (with `streamingBehavior`), `steer`, `abort`;
- `set_model`, `set_thinking_level`, `set_session_name`;
- `get_state`, `get_commands`;
- `get_branch` (new): the live branch entries, used for history instead of reading a file that may lag behind.

A protocol version mismatch is rejected with a `response` error, and the bridge shows it in the TUI with `ctx.ui.notify`.

### 3. Bridge extension (`src/extension/index.ts`)

- **Activation:** only when `ctx.mode === "tui"` and `PI_AGENT_HOST_DAEMON` is unset. That excludes the host's own `pi --mode rpc` children, which inherit the variable. AHP terminals strip it, so a `pi` started in a VS Code terminal does bridge.
- **Reloads:** the socket lives on `globalThis`, and each extension instance rebinds it to the newest `pi`/`ctx`. pi replaces the extension runtime on `/reload`, which makes the old objects stale. Cleanup must be idempotent.
- **Lifecycle:**
  - `session_start` → `attach`;
  - `session_shutdown` → `detach` for `new`/`resume`/`fork`/`reload`, and closes the socket for `quit`.
- **Events:** forwards `agent_start` … `agent_settled`, `message_*` and `tool_execution_*` through `toWireEvent`.
- **Commands from the host:**

  | Command | Runs |
  |---|---|
  | `prompt` | `pi.sendUserMessage(content, ctx.isIdle() ? {} : { deliverAs: "followUp" })`, responds `started`/`queued` |
  | `steer` | `pi.sendUserMessage(…, { deliverAs: "steer" })` |
  | `abort` | `ctx.abort()` |
  | `set_model` | `ctx.modelRegistry` lookup, then `pi.setModel` |
  | `set_thinking_level` / `set_session_name` | the matching `pi` methods |
  | `get_branch` | `ctx.sessionManager.getBranch()` |

- **Resume:** reuses `src/pi/extensions/ahp-resume.ts` (the `/ahp-resume` command and the `omitResumedErrors` context filter), so `chat/turnResume` works on TUI sessions too.
- **Auto-start:** if connecting fails with `ENOENT`/`ECONNREFUSED`, spawn `process.execPath <package>/dist/bin/pi-agent-host.js`:
  - detached, with output to `~/.pi/agent-host/host.log`;
  - then retry with backoff for up to about 5 s.

  The bin is resolved relative to the extension file, so a `pi install` alone is enough and no global npm install is needed. If the daemon goes away later, reconnect with backoff.
- **Connection URL:** VS Code needs the `ws://…?tkn=` URL once. The port and token are persisted in `settings.json`, so the URL does not change. When the extension auto-starts the host, it shows the URL in the TUI once with `ctx.ui.notify`, and notes that it only needs adding to VS Code once.
- **`/ahp` commands:**
  - `status`: connected or not, session id, and the host URL;
  - `off` / `on`: detach or re-attach this session;
  - `start`: start the host now.
- **Origin of turns:** `input` events carry a `source`. A prompt the host sent arrives as `source: "extension"`, and one typed in the TUI as `"interactive"`. The bridge tags the next `agent_start` with this origin, so the host knows whether a turn is its own.

### 4. Host side

- **`BridgeRegistry`** (`src/host/bridges.ts`): listens on the socket and owns one `RpcChannel` per bridge connection.
  - On `attach` it creates a `BridgeAgent` (an `RpcAgent` over the channel) and hands it to the `PiSession` for that id. If no `PiSession` exists, it creates one with history from `get_branch`, and announces it with `root/sessionAdded`.
  - On `detach` or disconnect, the agent becomes `closed`. The session stays, as a normal on-disk session.
- **Single writer per session file.** pi has no file locking.
  - A bridge-attached session never starts an rpc child. If the host already runs a child for that id (opened in VS Code before the TUI ran `pi --resume`), the host stops that child once it is idle, then adopts the bridge.
  - When the TUI quits, the next VS Code turn starts an rpc child through the existing `#ensureAgent` restart path, so the session continues in the host.
- **Turns started outside the host** (`PiSession`):
  - Today a turn begins only from `chat/turnStarted`.
  - New: when the agent emits a user `message_start` while no host turn is active, the host dispatches `chat/turnStarted` itself (no client origin) with that message, maps events with a `TurnMapper`, and finishes the turn on `agent_settled`.
  - Host-started turns keep the current path.
  - A run already streaming when the bridge attaches (`isStreaming`) is picked up from its next `agent_start`.
- **Busy TUI:** the reducer already rejects `chat/turnStarted` while a turn is active, so VS Code queues instead (`chat/pendingMessageSet`). The existing queue then starts it after `agent_settled`.
- **Listing:** live sessions are listed like others, and while attached their summary status reflects the TUI's activity. AHP has no "live" flag. If we want to show it, the title can be suffixed (decide during implementation).
- **CLI and daemon:**
  - `pi-agent-host` listens on the socket unless `--no-bridge` is given.
  - A second daemon that finds a live socket exits 0, which handles the race when two TUIs auto-start at once.
  - A stale socket file is removed when nothing answers on it.

### 5. Packaging

- `package.json`: `"pi": { "extensions": ["./dist/extension/index.js"] }`. The bin stays.
- README install: `pi install npm:pi-agent-host`, then start `pi`. The first auto-start shows the URL to paste into VS Code; `/ahp status` shows it again later.

## Steps (each one a PR)

1. **Channel refactor:** `RpcChannel`, `toWireEvent`, and `RpcAgent` over a channel. No behaviour change; the existing suites pass in both modes.
2. **Turns started outside the host:** `PiSession` synthesizes turns from agent events. Tested with an in-memory `RpcChannel` pair that plays the role of a bridge.
3. **Bridge registry and socket:**
   - attach/detach, history via `get_branch`, single-writer adoption, rpc fallback after detach;
   - daemon single-instance;
   - tested with a fake bridge over a real unix socket.
4. **Bridge extension:**
   - activation guards, reload rebinding, command execution, resume reuse, auto-start with the one-time URL notice, `/ahp` commands;
   - unit tests drive it with a fake `pi`/`ctx`.
5. **End-to-end and docs:**
   - run a real interactive `pi` in a pty (`@lydell/node-pty`, already a dependency), with the faux fixture and the bridge extension;
   - covers: a turn typed in the TUI appears in the test client; a client prompt and cancel run in the TUI; `/new` switches sessions; quitting leaves a session that continues over rpc;
   - update the README, `docs/` and GAPS.md.

## Risks and open questions

- **Two writers:** a TUI can `pi --resume` a session while the host's rpc child is mid-turn. The host adopts the bridge only after the child is idle, so writes can briefly interleave.
- **Event coverage:** the extension API has no `auto_retry_*` events, so retries are not visible for TUI sessions (they only matter for logging today).
- **Steering typed in the TUI** during a run is not shown in VS Code (AHP has no host-originated steering part). Recorded as a gap.
- **Socket trust:** any local process of the same user can drive pi through the socket. That is the same trust level as pi itself. The socket is `0600` inside a `0700` directory.
- **Windows** needs a named pipe instead of a unix socket. Out of scope.
- **Out of scope (milestone 3):** tool approvals, forwarding extension dialogs, file diffs, `fetchTurns` paging.

## Implementation notes

- **Code:**
  - `src/pi/rpc-channel.ts` (`JsonlChannel`), `src/pi/rpc-agent.ts`, `src/pi/wire.ts`;
  - `src/bridge/protocol.ts`, `src/host/bridges.ts` (`BridgeServer`, `SessionLink`);
  - `PiSession.live` / `adoptAgent` / `agentDetached` and turns started outside the host in `src/pi/pi-session.ts`;
  - `src/extension/` (`index.ts`, `client.ts`, `commands.ts`, `autostart.ts`).
- **Attach races:**
  - The bridge counts itself as sharing from the moment it sends `attach`, because the host queries pi (`get_state`, `get_commands`, `get_branch`) before the bridge sees the response.
  - The host opens the socket before its WebSocket listener, so an `attach` waits up to 5 s for the URL (`BridgeServer.setUrl`). The CLI now listens before it lists models.
- **Resume through the bridge:** a `/ahp-resume` prompt from the host calls `resumeRun` directly, because extensions cannot invoke commands by name. Other prompts go through `sendUserMessage` with `expandPromptTemplates`, so templates and skills expand.
- **No "live" marker** in the session list. AHP has no such flag, and a title suffix would be written back to pi on rename.
- **Tests:**
  - `test/external-turns.test.ts` (in-memory channel pair);
  - `test/bridge.test.ts` (fake bridge over a real socket);
  - `test/extension.test.ts` (command mapping, client against a real host, auto-start);
  - `test/tui.test.ts` (a real interactive `pi` in a pty, with `HOME` and all pi directories isolated).
