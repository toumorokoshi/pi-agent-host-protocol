# pi-agent-host

An [Agent Host Protocol](https://github.com/microsoft/agent-host-protocol) (AHP) server for the [pi coding agent](https://github.com/earendil-works/pi). It lets the VS Code Agents window, and other AHP clients, create, list, resume and drive pi sessions over WebSocket.

> **Status: milestone 1 of 3.** Sessions created by AHP clients run inside the host process. Live pi TUI sessions are not exposed yet; that is milestone 2 (see [Roadmap](#roadmap)).

## Usage

Requirements: Node.js 24 or later, and at least one model provider configured for pi (`~/.pi/agent`).

```sh
npm install
npm start                    # or: node src/bin/pi-agent-host.ts
```

On first run the host creates `~/.pi/agent-host/settings.json` with a free port and a random connection token. Then it prints the URL to connect to:

```
pi-agent-host listening on ws://127.0.0.1:63877?tkn=…
```

| Option | Default | Description |
|---|---|---|
| `--host <address>` | from settings (`127.0.0.1`) | Interface to listen on |
| `--port <port>` | from settings | Port to listen on |
| `--no-token` | off | Disable the connection token for this run |
| `--cwd <dir>` | current directory | Default working directory offered to clients |
| `--log-level <level>` | `info` (or `$PI_AGENT_HOST_LOG_LEVEL`) | `error`, `warn`, `info` or `debug` |
| `--debug` | off | Shorthand for `--log-level debug`: logs every session interaction |

Logs go to stderr. At the default level they show client connections and handshakes; `--debug` adds every request, client action, turn and tool call. See [docs/logging.md](docs/logging.md).

`PI_AGENT_HOST_DIR` overrides the settings directory and must be an absolute path. To disable the token permanently, set `"token": null` in the settings file. Keep the token enabled whenever the listener can be reached from beyond localhost.

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

## What works

- Handshake: negotiates protocol 0.9.x (what VS Code currently speaks) or 1.x, answers `ping` at any time, and supports `reconnect` with action replay.
- Creating sessions in any local working directory. Session ids are reused as pi session ids, so the files land in pi's normal session store and also appear in `pi --resume`.
- Streaming turns: text, reasoning, tool calls and their results, token usage and errors.
- Cancellation, steering messages, and queued messages that run once the current turn ends.
- **Resumable errors:** when the model server fails mid-turn (for example llama.cpp's `Failed to parse input` on a malformed tool call), the turn ends with a resumable error. The client can then continue the same turn without sending a new message, and the failed reply is left out of the model's context, the same as pi's own auto-retry.
- `listSessions` covers existing pi sessions on disk. Subscribing to one loads its history; new turns continue the same session file.
- Session titles: the first prompt sets the title, and renaming from the client writes the name back to pi.
- Read-only `resourceRead`, `resourceList` and `resourceResolve` on host-local `file:` URIs, used for browsing to pick a working directory. Write operations are refused.
- **Terminals:** `createTerminal` and `disposeTerminal` run your `$SHELL` in a real pty in the requested directory. Keystrokes, resizes, renames, `clear` and exit codes all work, and `RootState.terminals` lists every terminal.
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
| `reconnect` | supported | Replays missed actions from a buffer, or sends fresh snapshots (for example after a host restart). |
| `subscribe` / `unsubscribe` | supported | Root, session, chat, terminal and resource-watch channels. Subscribing to a saved pi session loads its history. |
| `createSession` | supported | Accepts any local working directory. The session id becomes the pi session id. |
| `disposeSession` | partial | Discards empty sessions only. Sessions with history stay listed, and pi session files are never deleted. |
| `listSessions` | supported | Live sessions plus pi sessions on disk, newest first, paginated. |
| `fetchTurns` | stub | History is always sent in full, so there are never older turns to page in. |
| `resolveSessionConfig` / `sessionConfigCompletions` | stub | No session config options; models and thinking level are chosen per message instead. |
| `completions` | stub | Returns no completions. |
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
| Session | `session/ready`, `session/creationFailed`, `session/titleChanged`, `session/chatUpdated` |
| Chat | `chat/turnStarted` (queued messages), `chat/responsePart`, `chat/delta`, `chat/reasoning`, `chat/toolCallStart` / `chat/toolCallDelta` / `chat/toolCallReady` / `chat/toolCallContentChanged` / `chat/toolCallComplete`, `chat/usage`, `chat/turnComplete`, `chat/error` (with `resumable` for model-server errors), `chat/pendingMessageRemoved` |
| Terminal | `terminal/data`, `terminal/exited` |
| Resource watch | `resourceWatch/changed` |

Not used: changesets, MCP, annotations, automations, canvases, input requests (elicitation), tool confirmations, terminal command detection, and OTLP telemetry.

## Design notes

- **Protocol state** (`src/core/state-store.ts`) uses the official reducers from `@microsoft/agent-host-protocol`, so host state is exactly what clients rebuild. Every action gets a host-wide `serverSeq` and is kept in a replay buffer for `reconnect`.
- **URIs** (`src/core/uris.ts`): VS Code addresses sessions as `<provider>:/<id>` and derives chat URIs as `ahp-chat://default/<base64url(sessionUri)>`. It does not use the URIs the host publishes. So this host publishes exactly those shapes, and also accepts the spec's `ahp-session:/` and `ahp-chat:/` forms. No per-connection URI rewriting is needed.
- **Connections** (`src/host/connection.ts`) process messages in order, except `ping`. A subscription's snapshot is taken, registered and sent in the same tick, so no action can slip in between.
- **pi binding**: `src/pi/pi-session.ts` maps one AHP session to one pi `AgentSession`. `src/pi/turn-mapper.ts` turns pi's event stream into chat actions. `src/pi/history.ts` rebuilds turns from session files.

## Development

```sh
just fix            # format and apply safe lint fixes (Biome)
just lint           # lint, check formatting, typecheck
just test           # unit and end-to-end tests against pi's scripted "faux" model
npm run build       # compile to dist/ (the published bin)
```

Known gaps are tracked in [GAPS.md](GAPS.md), and design notes for individual features are in [specs/](specs/).

The tests start a real host on a random port in a temporary directory, with pi's faux provider standing in for a model. A minimal client then speaks VS Code's URI dialect over WebSocket and checks its state using the official reducers.

## Roadmap

1. **Host for client-created sessions**: this release.
2. **Live TUI sessions**: a pi extension, loaded into every interactive `pi` process, registers its session with this host over a local socket and starts the host if needed. VS Code and the terminal then share the same conversation in real time, with `/ahp` commands to control it.
3. **Polish**: optional tool approvals (`--approve-tools`), richer edit rendering (file diffs), `fetchTurns` paging and Dev Tunnels.
