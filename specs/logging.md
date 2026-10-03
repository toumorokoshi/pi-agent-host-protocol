# Spec: Logging

## Goal

Operators need to see when clients such as VS Code connect, and, when debugging, every interaction with a session. That means the requests and dispatched actions arriving from clients, and the turns and tool calls pi runs as a result.

## Design

- **Module:** `src/core/logger.ts`, with no dependencies.
  - `formatLine(time, level, message, fields)` is a pure function that produces `<ISO time> <LEVEL> <message> key=value…`. A value is JSON-quoted when it is empty or contains whitespace, `"` or `=`.
  - `createLogger(threshold, { write, now })` returns a `Logger`, a record of `error`, `warn`, `info` and `debug` functions. It writes to stderr by default. The `write` and `now` options are injectable for tests.
  - `silentLogger` is the default whenever no logger is supplied, so library users and tests get no output unless they ask for it.
- **Levels:** `error < warn < info < debug`. `isEnabled(threshold, level)` decides whether a line is written.
- **Wiring:** the logger is passed in explicitly. There is no global logger.
  - `AgentHostOptions.logger` sets it, and `AgentHost.logger` exposes it.
  - `AgentHost` passes it to each `Connection` it creates, and to `PiSession` through `SessionHostContext.logger`.
  - The WebSocket transport reads it from the host so it can log rejected upgrades.
- **Where each event is logged:**

  | Event | Location | Level |
  |---|---|---|
  | Connect, disconnect, handshake | `AgentHost.connect` / `disconnect` / `#initialize` / `#reconnect` | info |
  | Token rejection | `transport/websocket.ts` | warn |
  | Each request (except `ping`) and its duration | `Connection.#process` | debug; failures at warn |
  | Each client action and its outcome | `AgentHost.#dispatchAction` | debug |
  | Session lifecycle | `AgentHost` and `PiSession.initialize` | debug |
  | Turns, tools, retries, steering, queue | `PiSession` | debug |

- **Action outcomes:** `AgentHost.#applyClientAction` validates and applies an action and returns an outcome: `accepted`, `rejected` with a reason, or `ignored`. `#dispatchAction` is then the single place that logs the outcome and sends any rejection envelope.
- **Privacy:** prompt text, model output and tool output are never logged. Turn logs record `chars` (prompt length) and the number of attachments instead.

## CLI

- `--log-level <error|warn|info|debug>`
- `--debug`, an alias for `--log-level debug`
- The `PI_AGENT_HOST_LOG_LEVEL` environment variable sets the default. The order of precedence is `--debug`, then `--log-level`, then the environment variable, then `info`.

## Tests

`test/logger.test.ts` covers:

- formatting, filtering and level parsing
- an end-to-end run against a capturing logger, checking that connect, handshake (with client name and version), request, session, action and turn lines appear, and that prompt text does not.
