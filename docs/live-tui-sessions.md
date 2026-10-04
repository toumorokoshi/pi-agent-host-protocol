# Sharing pi terminal sessions with VS Code

`pi-agent-host-protocol` ships a pi extension. With it installed, every interactive `pi` shares its session with the host, and the session shows up in the VS Code Agents window while you work in the terminal.

## Setup

```sh
cd /path/to/pi-agent-host-protocol && npm install && npm run build
pi install /path/to/pi-agent-host-protocol
```

Once the package is published, `pi install npm:pi-agent-host-protocol` will be enough. pi loads `dist/extension/index.js` from the package (the `"pi"` field in `package.json`).

Start `pi`. If no host is running, the extension starts one in the background and shows:

```
pi-agent-host-protocol started. Add this URL to VS Code once (Agents: Add Remote Agent Host…):
ws://127.0.0.1:63877?tkn=…
```

Add it in VS Code (see [Connecting from VS Code](../README.md#connecting-from-vs-code)). You only do this once: the port and token are saved in `~/.pi/agent-host-protocol/settings.json`.

## What you get

- **History:** the session appears in VS Code with its history, read from pi's live session.
- **Terminal → VS Code:** a prompt you type in the terminal streams into VS Code as a turn, including reasoning, tool calls and results. A run that pi continues without a prompt (for example, from an extension) appears as a "Continued in pi" turn.
- **VS Code → terminal:** a prompt from VS Code runs in the terminal's pi, and the terminal shows it like any other prompt. If pi is busy, VS Code queues the message and sends it when pi is done. Steering, cancelling and resuming after a model-server error also work.
- **Session switches:** `/new`, `/resume` and `/fork` in the terminal share the new session instead of the old one.
- **Quitting:** when you quit `pi`, the session stays in VS Code. Its next turn runs in a `pi` started by the host, on the same session file.

## Commands

| Command | Effect |
|---|---|
| `/ahp` or `/ahp status` | Whether this session is shared, and the URL for VS Code |
| `/ahp off` | Stop sharing this session (until `/ahp on` or the next `pi`) |
| `/ahp on`, `/ahp start` | Share this session, starting the host if it is not running |

## How it works

The extension connects to the host over `~/.pi/agent-host-protocol/host.sock` (or `$PI_AGENT_HOST_PROTOCOL_DIR/host.sock`). It speaks pi's own RPC protocol there: it forwards session events, and runs the host's commands with pi's extension API. If the host goes away, the extension reconnects quietly when one is back. It only starts a host when a session starts or on `/ahp start`.

A session file has one writer at a time. When a terminal opens a session that the host is running in its own `pi`, the host finishes the current run and then hands the session to the terminal.

The extension does nothing inside the host's own `pi --mode rpc` processes (they inherit `PI_AGENT_HOST_PROTOCOL_DAEMON=1`), or when pi is not in interactive mode. A `pi` started in a VS Code terminal does share its session.

## Troubleshooting

- **Nothing appears in VS Code:** run `/ahp status`. If it says "not connected", check `~/.pi/agent-host-protocol/host.log`.
- **"bridge protocol" error:** the extension and the running host come from different versions. Stop the host (it restarts on the next `pi`) or update both.
- **Logs:** start the host yourself with `pi-agent-host-protocol --debug` to see every live session event (see [logging.md](logging.md)).
