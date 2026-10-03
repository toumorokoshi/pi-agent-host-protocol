# Logging

`pi-agent-host` writes its log to **stderr**, one line per event. The connection URL is still printed to stdout, so it can be captured on its own.

```
2026-10-03T20:09:24.974Z INFO  client connected client=127.0.0.1:65484
2026-10-03T20:09:24.976Z INFO  client initialized client=127.0.0.1:65484 clientName=vscode-agents-window clientId=… protocolVersion=0.9.0
```

## Choosing a level

| Option | Effect |
|---|---|
| `--log-level <level>` | One of `error`, `warn`, `info` (default) or `debug` |
| `--debug` | Shorthand for `--log-level debug` |
| `PI_AGENT_HOST_LOG_LEVEL=<level>` | Default level when no flag is given |

```sh
pi-agent-host --debug
PI_AGENT_HOST_LOG_LEVEL=debug pi-agent-host
```

## What is logged

**`info`** (default): connection lifecycle.

- `pi backend`: at startup, the pi mode in use (`rpc` or `embedded`).
- `client connected`: a WebSocket connection was accepted.
- `client initialized` / `client reconnected`: the handshake finished. Includes the client's name (VS Code reports `vscode-agents-window` or `vscode-editor-window`), its `clientId` and the negotiated protocol version.
- `client disconnected`

**`warn`**: things that usually explain why a client can't connect or something failed.

- `connection rejected: missing or invalid token`: the URL's `?tkn=` didn't match the settings file.
- `request failed`: a request returned an error. Includes the method, channel and error message.
- `request before initialize`, `could not load models`, `could not save session title`

**`debug`**: every interaction with a session.

- `request` / `request done`: each JSON-RPC request, with its method, channel and duration in ms. `ping` is not logged, because VS Code sends one every 5 seconds.
- `action accepted` / `action rejected` / `action ignored`: each action a client dispatches, such as `chat/turnStarted` or `chat/turnCancelled`. Rejections include the reason.
- `session created`, `session loaded` (opened from a pi session file), `session ready`, `session disposed`
- `turn started` (model, prompt length, attachment count), `turn resumed` (a `chat/turnResume` after a resumable error), and `turn finished` (outcome `complete`, `cancelled` or `error`, plus duration)
- `tool started` / `tool finished`, `model retry`, `turn cancelled by client`, `steering message sent`, `queued message started`
- `terminal created` (shell, cwd, pid), `terminal exited` (exit code), `terminal disposed`
- `resource watch created` (root, recursive) and `resource watch released`. Watcher failures are logged as `resource watch error` at warn.
- In `rpc` mode: `pi stderr`, one line per line pi writes to stderr (tagged `session=<id>`, or `purpose=models` for the process that lists models), and `extension dialog dismissed` when a pi extension asks for input that the host cannot show.

Each line carries `client=<address>` and `clientName=…`, or `session=<id>` and `turn=<id>`, so you can follow one client or one conversation with `grep`.

Prompt text, model output and tool output are **never** logged, only their sizes and identifiers.
