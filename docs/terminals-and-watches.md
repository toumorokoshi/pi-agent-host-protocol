# Terminals and resource watches

The VS Code Agents window opens terminals and file watchers on the host as soon as it connects. Without them it logs `createTerminal` / `createResourceWatch` failures and disposes its terminal straight away.

## Terminals

- Each `createTerminal` starts your login shell (`$SHELL`, falling back to `/bin/sh`; `%COMSPEC%` on Windows) in a pseudo-terminal.
  - It starts in the requested `cwd`, or the host's default directory.
  - The terminal size comes from `cols` and `rows`.
  - `TERM` is set to `xterm-256color`.
- The client chooses the terminal URI. VS Code uses `agenthost-terminal:/<id>`.
- Input and control:
  - Typing (`terminal/input`) goes to the shell.
  - `terminal/resized` resizes the pty.
  - `terminal/titleChanged`, `terminal/claimed` and `terminal/cleared` are accepted.
  - Clients cannot send `terminal/data` or `terminal/exited`; the host rejects them.
- When the shell exits, the terminal stays visible with its exit code until it is disposed.
- `RootState.terminals` lists every terminal with its title, owner and running/exited state.
- The host keeps the last 256 KiB of output for clients that subscribe later.
- Terminals run with your full user permissions, like any shell you open yourself. Keep the connection token enabled.

## Resource watches

- `createResourceWatch` on a host-local `file:` URI returns an `ahp-resource-watch:/<id>` channel. Subscribe to it to receive `resourceWatch/changed` batches with `added`, `updated` and `deleted` entries.
- Options:
  - `recursive: false` reports only direct children.
  - `excludes` globs hide matching paths and everything below them. For example, `**/node_modules` hides all dependencies.
  - `includes` globs restrict which paths are reported.
  - Globs are matched against the path relative to the watched root.
- Watching a single file reports changes to that file only.
- A watch is released when its last subscriber unsubscribes or disconnects. A watch that is never subscribed to is released when the connection that created it closes.
- Paths are reported under the URI you asked for, even when the OS resolves symlinks. For example, macOS reports `/private/var/...` for `/var/...`.

With `--debug`, terminal and watch activity shows up in the log; see [logging.md](logging.md).
