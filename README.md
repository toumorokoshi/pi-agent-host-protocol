# pi-agent-host-protocol

An [Agent Host Protocol](https://github.com/microsoft/agent-host-protocol) (AHP) server for the [pi coding agent](https://github.com/earendil-works/pi). It lets the VS Code Agents window, and other AHP clients, create, list, resume and drive pi sessions over WebSocket.

> **Status: milestone 2 of 3.** Sessions created by AHP clients run in `pi --mode rpc` processes started by the host (or in-process with `--pi-mode embedded`). pi sessions open in terminals are shared live through a pi extension (see [Sharing pi terminal sessions](#sharing-pi-terminal-sessions)).

## Usage

Requirements: Node.js 24 or later, and at least one model provider configured for pi (`~/.pi/agent`). In the default `rpc` mode, the [`pi` CLI](https://github.com/earendil-works/pi) must also be installed and on your `PATH`, or passed with `--pi`.

Run it with npx, no checkout needed (the first run installs and builds it, which takes a little while):

```sh
npx github:toumorokoshi/pi-agent-host-protocol             # any option below can follow
npx github:toumorokoshi/pi-agent-host-protocol --debug
```

Once the package is published to npm, `npx pi-agent-host-protocol` will work too. From a checkout:

```sh
npm install                  # also builds dist/
npm start                    # or: node src/bin/pi-agent-host-protocol.ts
```

On first run the host creates `~/.pi/agent-host-protocol/settings.json` with a free port and a random connection token. Then it prints the URL to connect to:

```
pi-agent-host-protocol listening on ws://127.0.0.1:63877?tkn=…
```

| Option | Default | Description |
|---|---|---|
| `--host <address>` | from settings (`127.0.0.1`) | Interface to listen on |
| `--port <port>` | from settings | Port to listen on |
| `--no-token` | off | Disable the connection token for this run |
| `--cwd <dir>` | current directory | Default working directory offered to clients |
| `--log-level <level>` | `info` (or `$PI_AGENT_HOST_PROTOCOL_LOG_LEVEL`) | `error`, `warn`, `info` or `debug` |
| `--debug` | off | Shorthand for `--log-level debug`: logs every session interaction |
| `--pi-mode <mode>` | from settings, else `rpc` (or `$PI_AGENT_HOST_PROTOCOL_PI_MODE`) | `rpc` runs each session in its own `pi --mode rpc` process; `embedded` runs pi's SDK inside the host |
| `--pi <path>` | from settings, else `pi` on `PATH` | The `pi` executable used in `rpc` mode |
| `--agent-dir <dir>` | from settings, else `$PI_CODING_AGENT_DIR`, else `~/.pi/agent` | pi's agent directory. Sessions are listed from `<dir>/sessions` |
| `--session-dir <dir>` | from settings, else `$PI_CODING_AGENT_SESSION_DIR` | A flat session directory, like pi's own `--session-dir` |
| `--idle-timeout <minutes>` | from settings, else `$PI_AGENT_HOST_PROTOCOL_IDLE_TIMEOUT`, else `30` | In `rpc` mode, stop a session's `pi` process after this many minutes without activity. `0` keeps them running |
| `--no-bridge` | off | Don't accept sessions from interactive `pi` processes |

Logs go to stderr. At the default level they show client connections and handshakes; `--debug` adds every request, client action, turn and tool call. See [docs/logging.md](docs/logging.md).

### pi modes

| | `rpc` (default) | `embedded` |
|---|---|---|
| How pi runs | One `pi --mode rpc` child process per open session | pi's SDK inside the host process |
| pi version, settings and extensions | Your installed `pi` | The `@earendil-works/pi-coding-agent` bundled with the host |
| A crashing session | Ends its own turn with an error; the next turn starts a new `pi` | Can take the host down |
| First turn of a session | Waits for `pi` to start (about 0.7 s) | Immediate |
| Idle sessions | `pi` is stopped after `--idle-timeout` minutes; the next turn starts it again | Stay in memory |

Both modes share the same session files, so you can switch between them. Settings can also hold `"piMode"`, `"pi"`, `"agentDir"`, `"sessionDir"` and `"idleTimeoutMinutes"`. See [specs/pi-backends.md](specs/pi-backends.md).

In `rpc` mode an idle `pi` process takes a few hundred MB, so the host stops one after 30 minutes without activity. The session stays listed and its state is unchanged. The next turn starts a new `pi` on the same session file, which costs about 0.7 s. A `pi` that is running a turn, has queued messages, or has started background processes (such as background jobs or subagents) is kept. `pi` sessions open in a terminal are never stopped. See [specs/idle-sessions.md](specs/idle-sessions.md).

### Where sessions are stored

The host and the `pi` it runs must agree on pi's agent directory, or sessions are written to one place and listed from another. This happens when the host runs as a service without your shell's environment, or when your `pi` build uses a different directory than `~/.pi/agent`. For example, a distribution with `userConfigDir: ".av-pi"` stores sessions under `~/.av-pi/agent/sessions`.

Pass the directory your `pi` uses:

```sh
pi-agent-host-protocol --pi /opt/av-pi/bin/pi --agent-dir ~/.av-pi/agent
```

The host sets `PI_CODING_AGENT_DIR` (and `PI_CODING_AGENT_SESSION_DIR` for `--session-dir`) on itself. Its session listing and every `pi` it starts then use the same store. Use `--session-dir` only if you run `pi` with a flat `--session-dir` too. pi groups sessions per working directory only under the agent directory.

The project used to be called `pi-agent-host`. On first start, settings from `~/.pi/agent-host/settings.json` are copied to `~/.pi/agent-host-protocol/`, so a URL already added to VS Code keeps working.

`PI_AGENT_HOST_PROTOCOL_DIR` overrides the settings directory and must be an absolute path. To disable the token permanently, set `"token": null` in the settings file. Keep the token enabled whenever the listener can be reached from beyond localhost.

### Connecting from VS Code

Remote agent hosts only appear in the **Agents window**, not in a regular editor window.

1. If the remote-host commands are missing, or you want to connect without signing in to GitHub, add these to your user `settings.json`:
   ```json
   {
     "chat.remoteAgentHostsEnabled": true,
     "chat.agentHost.allowSignedOutWhenUsable": true
   }
   ```
2. Run **Chat: Open Agents Window**.
3. Run **Agents: Add Remote Agent Host...** and paste the URL the host printed.

Your available pi models appear in the model picker as `provider/model`. Reasoning models also offer a thinking-level option.

### Sharing pi terminal sessions

This package is also a pi package. Its extension shares the session of every interactive `pi` with the host, so VS Code can follow it and drive it.

```sh
npm install && npm run build
pi install /path/to/pi-agent-host-protocol       # once published: pi install npm:pi-agent-host-protocol
```

Then start `pi` as usual:

- If no host is running, the extension starts one in the background (output in `~/.pi/agent-host-protocol/host.log`). It shows the URL to add to VS Code **once**; the URL stays the same afterwards. `/ahp status` shows it again.
- The session appears in the Agents window with its history. Prompts typed in the terminal stream into VS Code; prompts, steering and cancel from VS Code run in the terminal.
- `/ahp off` stops sharing this session, and `/ahp on` shares it again.
- When you quit `pi`, the session stays in VS Code and continues in a `pi` started by the host.

See [docs/live-tui-sessions.md](docs/live-tui-sessions.md).

## What works

- Handshake: negotiates protocol 0.9.x (what VS Code currently speaks) or 1.x, answers `ping` at any time, and supports `reconnect` with action replay.
- Creating sessions in any local working directory. Session ids are reused as pi session ids, so the files land in pi's normal session store and also appear in `pi --resume`.
- Streaming turns: text, reasoning, tool calls and their results, token usage and errors.
- **Busy indicator:** a session's summary status shows `InProgress` for as long as a turn runs, including after the client marks the session read or archived. Its `activity` text says what the turn is doing (`Thinking`, `Responding`, `Running npm test`, `Reading src/a.ts`). See [specs/session-activity.md](specs/session-activity.md).
- Cancellation, steering messages, and queued messages that run once the current turn ends. A steering message opens a new turn when pi delivers it. A steering message that arrives when no turn is running (for example "send immediately" on a queued message just as the turn ends) starts a turn of its own instead of staying pending (see [specs/steering.md](specs/steering.md)).
- **Resumable errors:** when the model server fails mid-turn (for example llama.cpp's `Failed to parse input` on a malformed tool call), the turn ends with a resumable error. The client can then continue the same turn without sending a new message, and the failed reply is left out of the model's context, the same as pi's own auto-retry.
- `listSessions` covers existing pi sessions on disk. Subscribing to one loads its history; new turns continue the same session file.
- Session titles: the first prompt sets the title, and renaming from the client writes the name back to pi.
- **Live terminal sessions:** interactive `pi` processes share their sessions through the bundled pi extension, in both directions. A session is written by only one pi at a time: when a terminal opens a session the host is running, the host hands it over.
- Read-only `resourceRead`, `resourceList` and `resourceResolve` on host-local `file:` URIs, used for browsing to pick a working directory. Write operations are refused.
- **Terminals:** `createTerminal` and `disposeTerminal` run your `$SHELL` in a real pty in the requested directory. Keystrokes, resizes, renames, `clear` and exit codes all work, and `RootState.terminals` lists every terminal.
- **Skills and prompt templates:** each session publishes the skills and prompt templates pi loaded as read-only customizations, and typing `/` at the start of a message completes them. See [docs/skills.md](docs/skills.md).
- **Resource watches:** `createResourceWatch` watches files and directories with `@parcel/watcher`, recursively or not, with include/exclude globs. A watch is released when its last subscriber unsubscribes. See [docs/terminals-and-watches.md](docs/terminals-and-watches.md).

### Known limitations

- One chat per session. Forks, side chats and `createChat` are not supported.
- No tool-approval prompts: pi has no permission system, and tools run without confirmation.
- `disposeSession` only discards **empty** sessions. A session with history stays listed, and pi session files are never deleted. VS Code currently disposes sessions it is still showing, so treating dispose as delete would lose work.
- pi extension dialogs (`ctx.ui.confirm` and similar) resolve with their defaults, because there is no UI on the host side.
- History is always sent in full; there is no `fetchTurns` paging. Compaction summaries and custom messages are not shown.
- Changesets, MCP and automations are not implemented. Terminals have no shell-integration command detection.

## Supported AHP operations

Status is one of: supported; partial (works with the noted restriction); stub (answers with an empty result so clients don't fail); refused (returns an error); not supported (`MethodNotFound`).

### Commands (client → host)

| Command | Status | Notes |
|---|---|---|
| `initialize` | supported | Negotiates protocol 0.9.x or 1.x. Unsupported versions get `-32005` with `supportedVersions`. |
| `ping` | supported | Answered at any time, including before `initialize`. |
| `reconnect` | supported | Replays missed actions from a buffer, or sends fresh snapshots when the gap is too large. A client this host instance never initialized (for example after a host restart) gets `NotFound` (`-32008`), so it runs `initialize` again and picks up the current capabilities. |
| `subscribe` / `unsubscribe` | supported | Root, session, chat, terminal and resource-watch channels. Subscribing to a saved pi session loads its history. |
| `createSession` | supported | Accepts any local working directory. The session id becomes the pi session id. |
| `disposeSession` | partial | Discards empty sessions only. Sessions with history stay listed, and pi session files are never deleted. |
| `listSessions` | supported | Live sessions plus pi sessions on disk, newest first, paginated. |
| `fetchTurns` | stub | History is always sent in full, so there are never older turns to page in. |
| `resolveSessionConfig` / `sessionConfigCompletions` | stub | No session config options; models and thinking level are chosen per message instead. |
| `completions` | partial | `/` at the start of a user message completes pi's skills and prompt templates. Other text gets no items. |
| `authenticate` | stub | Accepted; pi manages model credentials itself. |
| `resourceRead` / `resourceList` / `resourceResolve` | supported | Host-local `file:` URIs only. |
| `resourceWrite` / `resourceCopy` / `resourceDelete` / `resourceMove` / `resourceMkdir` / `resourceRequest` | refused | `PermissionDenied` (`-32009`). |
| `createResourceWatch` | supported | `@parcel/watcher` with recursive, include and exclude options. Released when the last subscriber leaves. |
| `createTerminal` / `disposeTerminal` | supported | Runs `$SHELL` in a pty. |
| `createChat` / `moveChat` / `disposeChat` | not supported | One chat per session. |
| `invokeChangesetOperation` | not supported | No changesets. |
| `listAutomationTriggerDefinitions` / `runAutomation` / `fetchAutomationRuns` | not supported | No automations. |

### Client actions (`dispatchAction`)

| Channel | Accepted | Rejected |
|---|---|---|
| Chat | `chat/turnStarted`, `chat/turnCancelled`, `chat/turnResume` (after a resumable model-server error), `chat/pendingMessageSet` / `chat/pendingMessageRemoved` (steering and queued messages), `chat/queuedMessagesReordered`, `chat/draftChanged`, `chat/isReadChanged`, `chat/isArchivedChanged` | `chat/toolCallConfirmed` and `chat/toolCallResultConfirmed` (tools never wait for approval), `chat/truncated`, input requests, working-directory changes, client-executed tools |
| Session | `session/titleChanged` (saved to pi; VS Code's form addressed to the chat is also accepted), `session/isReadChanged`, `session/isArchivedChanged`, `session/activeClientSet` / `session/activeClientRemoved`, `session/configChanged` | Working-directory, customization and MCP actions |
| Terminal | `terminal/input`, `terminal/resized`, `terminal/claimed`, `terminal/titleChanged`, `terminal/cleared` | Host-only actions such as `terminal/data` |
| Root | `root/configChanged` (no root config exists, so it has no effect) | Everything else |
| Resource watch | None | Everything |

Rejected actions are echoed only to the sending client, with a `rejectionReason`.

### Sent by the host

| Channel | Actions and notifications |
|---|---|
| Root | `root/agentsChanged` (the pi agent and its available models), `root/activeSessionsChanged`, `root/terminalsChanged`; notifications `root/sessionAdded`, `root/sessionRemoved`, `root/sessionSummaryChanged` |
| Session | `session/ready`, `session/creationFailed`, `session/titleChanged`, `session/chatUpdated`, `session/activityChanged`, `session/customizationsChanged` (pi's skills and prompt templates) |
| Chat | `chat/turnStarted` (queued messages, and runs started in a pi terminal), `chat/responsePart`, `chat/delta`, `chat/reasoning`, `chat/toolCallStart` / `chat/toolCallDelta` / `chat/toolCallReady` / `chat/toolCallContentChanged` / `chat/toolCallComplete`, `chat/activityChanged`, `chat/usage`, `chat/turnComplete`, `chat/error` (with `resumable` for model-server errors), `chat/pendingMessageRemoved` |
| Terminal | `terminal/data`, `terminal/exited` |
| Resource watch | `resourceWatch/changed` |

Not used: changesets, MCP, annotations, automations, canvases, input requests (elicitation), tool confirmations, terminal command detection, and OTLP telemetry.

## Design notes

- **Protocol state** (`src/core/state-store.ts`) uses the official reducers from `@microsoft/agent-host-protocol`, so host state is exactly what clients rebuild. Every action gets a host-wide `serverSeq` and is kept in a replay buffer for `reconnect`.
- **URIs** (`src/core/uris.ts`): VS Code addresses sessions as `<provider>:/<id>` and derives chat URIs as `ahp-chat://default/<base64url(sessionUri)>`. It does not use the URIs the host publishes. So this host publishes exactly those shapes, and also accepts the spec's `ahp-session:/` and `ahp-chat:/` forms. No per-connection URI rewriting is needed.
- **Connections** (`src/host/connection.ts`) process messages in order, except `ping`. A subscription's snapshot is taken, registered and sent in the same tick, so no action can slip in between.
- **Live sessions**: the pi extension in `src/extension/` connects to `src/host/bridges.ts` over a unix socket (`~/.pi/agent-host-protocol/host.sock`, which is also the single-instance lock). It speaks pi's own RPC command and event protocol (`src/pi/rpc-channel.ts`), so the host drives a terminal session with the same `RpcAgent` it uses for its own `pi --mode rpc` children. `PiSession` turns runs started outside the host into turns. See [specs/live-tui-sessions.md](specs/live-tui-sessions.md).
- **pi binding**: `src/pi/pi-session.ts` maps one AHP session to one pi agent through the `PiAgent` / `PiBackend` shim in `src/pi/agent.ts`. Two backends implement it: `src/pi/rpc-backend.ts` (a `pi --mode rpc` child per session) and `src/pi/embedded-backend.ts` (pi's SDK in-process). `src/pi/turn-mapper.ts` turns pi's event stream into chat actions. `src/pi/history.ts` rebuilds turns from session files.

## Development

```sh
just fix            # format and apply safe lint fixes (Biome)
just lint           # lint, check formatting, typecheck
just test           # unit and end-to-end tests against pi's scripted "faux" model
npm run build       # compile to dist/ (the published bin)
```

Known gaps are tracked in [GAPS.md](GAPS.md), and design notes for individual features are in [specs/](specs/).

The tests start a real host on a random port in a temporary directory, with pi's faux provider standing in for a model. Session tests run in both pi modes. In `rpc` mode the test host runs pi's CLI from `node_modules` and loads a test extension that fetches the faux responses from the test process. `test/tui.test.ts` runs a real interactive `pi` in a pseudo-terminal with the bridge extension loaded. A minimal client then speaks VS Code's URI dialect over WebSocket and checks its state using the official reducers.

## Roadmap

1. **Host for client-created sessions**: done.
2. **Live TUI sessions** ([spec](specs/live-tui-sessions.md)): done. A pi extension, loaded into every interactive `pi` process, registers its session with this host over a local socket and starts the host if needed. VS Code and the terminal then share the same conversation in real time, with `/ahp` commands to control it.
3. **Polish**: optional tool approvals (`--approve-tools`), richer edit rendering (file diffs), `fetchTurns` paging and Dev Tunnels.
