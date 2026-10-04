# Spec: pi backends (rpc and embedded)

## Problem

The host used to embed pi's SDK (`createAgentSession`) in its own process. That ties the host to pi's in-process API and to the pi version bundled in `node_modules`. It also means one misbehaving session or extension can take down every session. pi offers a stable subprocess interface, `pi --mode rpc` (JSONL commands on stdin, responses and events on stdout), that IDEs use for the same job.

## Behavior

The host can run pi in either of two modes, chosen at startup:

| Source | Example |
|---|---|
| `--pi-mode <rpc\|embedded>` | `pi-agent-host-protocol --pi-mode embedded` |
| `$PI_AGENT_HOST_PROTOCOL_PI_MODE` | `PI_AGENT_HOST_PROTOCOL_PI_MODE=embedded pi-agent-host-protocol` |
| `piMode` in `settings.json` | `"piMode": "embedded"` |
| default | `rpc` |

In rpc mode, `--pi <path>` (or `"pi"` in `settings.json`) picks the executable. A `.js`/`.ts` path is run with the host's Node. If `pi` cannot be started, startup fails with a hint to install it, pass `--pi`, or use `--pi-mode embedded`.

### The shim

`PiSession` (protocol logic: turns, queueing, steering, cancellation, resume validation, titles) talks only to two interfaces in `src/pi/agent.ts`:

- `PiBackend`: `models()`, `listSessions()`, `newSessionManager()`, `openSessionManager()`, `startAgent()` and `dispose()`.
- `PiAgent`: `prompt()` (resolves when the run settles), `resume()`, `steer()`, `abort()`, `setModel()`, `setThinkingLevel()`, `setSessionName()`, `commands()` (pi's slash commands, see [skills.md](skills.md)), `subscribe()`, `dispose()`, plus `model`, `thinkingLevel` and `closed`.

Events are `PiEvent`, the union of the SDK's `AgentSessionEvent` and the RPC wire form (`JsonAgentSessionEvent`). The wire form drops the cumulative `partial` snapshots from `message_update`, so `TurnMapper` reads tool-call ids from either form (`startedToolCall`).

### Embedded (`src/pi/embedded-backend.ts`)

This is the previous behaviour, moved behind the shim. `createAgentSession` runs in the host process with a shared `ModelRuntime`, and turn-resume uses `context_edit` plus `agent.continue()` (see [turn-resume.md](turn-resume.md)).

### RPC (`src/pi/rpc-backend.ts`, `src/pi/rpc-process.ts`)

- **One child per session.** The child is started when a session is created, or on the first turn of a session loaded from disk:
  - new sessions: `pi --mode rpc --session-id <id>`;
  - saved sessions: `--session <file>`;
  - every child also gets `-e <ahp-resume extension>`.

  The working directory is the session's cwd. Session ids and files are the same as in embedded mode, so sessions remain visible to `pi --resume`.
- **No process for reading.** `listSessions` and history loading read pi's session files directly through `SessionManager`, so browsing old sessions never starts pi.
- **Models.** A short-lived `pi --mode rpc --no-session` answers `get_available_models`. The result is cached for 30 s, because clients ask on every `initialize`.
- **Runs.** `prompt` registers an `agent_settled` waiter before sending the command, then waits for it. A `handled` disposition (an extension command) returns immediately.
- **Crashes.** If a child exits, pending commands and the active run fail, and the turn ends with a final (non-resumable) `chat/error`: `pi exited with code N: <stderr tail>`. `PiAgent.closed` becomes true, and the session's next turn starts a new child on the same session file.
- **Extension dialogs.** `extension_ui_request` dialogs (`select`, `confirm`, `input`, `editor`) are answered with `cancelled: true`, so they resolve with their defaults as in embedded mode. Fire-and-forget UI requests are ignored.
- **Logging.** Child stderr is logged at debug as `pi stderr`; stdout carries only protocol records.
- **Shutdown.** `dispose` closes the child's stdin (pi's orderly shutdown), then sends SIGTERM and finally SIGKILL, each after a 2 s grace period.

`RpcProcess` is a small JSONL client written for the host. pi's exported `RpcClient` was not used because:
- it always spawns `node <cliPath>`;
- it copies child stderr to the host's stderr;
- it times commands out after 30 s;
- it does not tell event listeners about an exit, so a crash mid-run would hang;
- it cannot answer extension dialogs.

Records are split on LF only, because JSON strings may contain U+2028/U+2029.

## Mode differences

| | rpc (default) | embedded |
|---|---|---|
| Needs `pi` installed | yes | no (bundled SDK) |
| pi version, settings and extensions | the user's installed `pi` | the bundled `@earendil-works/pi-coding-agent` |
| Crash isolation | per session | none |
| First-turn latency | child startup (about 0.7 s) | none |
| Turn resume | `/ahp-resume` extension command, runs through pi's full run loop | `context_edit` + `agent.continue()`, skips pi's run loop |

## Trade-offs

- One Node process per open session costs memory. Children live until the session is disposed or the host stops.
- The resume extension adds a hidden `custom_message` entry (`customType: "ahp-resume"`) to the session file for each resume. History rebuilding already ignores custom messages.
- Neither mode shares a session with a pi TUI open in a terminal. That is milestone 2.

## Tests

- The e2e, resume and logging suites run once per mode (`PI_MODES` in `test/helpers.ts`).
- In rpc mode the tests run pi's CLI from `node_modules`, with `test/fixtures/faux-provider.ts` loaded via `-e`. That extension registers the faux provider in the child, and each response comes over HTTP from the test process, so tests script responses (including factories) the same way in both modes.
- `test/rpc.test.ts` covers:
  - JSONL splitting, spawn commands, mode parsing, model ids and both `toolcall_start` forms;
  - the resume context filter;
  - an executable that cannot start;
  - a pi crash mid-turn followed by a working next turn.
