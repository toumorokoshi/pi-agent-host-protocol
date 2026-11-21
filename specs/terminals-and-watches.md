# Spec: Terminal and resource-watch channels

## Problem

When VS Code's Agents window connects, it immediately issues about 10 `createResourceWatch` requests and a `createTerminal` for an `agenthost-terminal:/<id>` URI. The host rejected all of them as unsupported. VS Code then disposed its terminal, and the terminal and file-watching features of the Agents window did not work.

## State store

Terminal and resource-watch channels are **exact-URI channels**. They are addressed by the URI string itself, not parsed into a session id.

- Terminal URIs are client-chosen with a server-defined scheme, so any scheme is valid. Resource-watch URIs are allocated by the host.
- `StateStore` keeps them in a separate map: `addChannel`, `removeChannel` and `channel`.
- `snapshot` and `dispatch` consult that map before parsing session and chat URIs.
- Reducers come from `@microsoft/agent-host-protocol`: `terminalReducer` and `resourceWatchReducer`.
- `replaceTerminalState` is the one deliberate escape from the reducers. It trims retained scrollback for new subscribers' snapshots and never emits an action.

## Terminals: `src/host/terminals.ts`

- **Library:** `@lydell/node-pty`. It ships per-platform prebuilt binaries. Upstream `node-pty@1.1.0`'s macOS prebuild installs `spawn-helper` without the execute bit, and spawning then fails with `posix_spawnp failed`.
- **Pure helpers (unit-tested):**
  - `trimContent(content, max)` keeps the newest `max` characters.
  - `terminalInfo` builds catalogue entries.
  - `defaultShell(env, platform)` picks the shell.
  - `shellEnv(env)` sets `TERM` and drops `PI_AGENT_HOST_PROTOCOL_DAEMON`, so a `pi` started inside the terminal doesn't think it is the host process.
- **`TerminalService` (stateful):**
  - `create` validates the URI is unused and `cwd` is a local directory, spawns the pty, registers the channel and publishes `root/terminalsChanged`.
  - pty output is coalesced for 5 ms, then dispatched as one `terminal/data`.
  - On exit it dispatches `terminal/exited { exitCode }`. The channel stays until `disposeTerminal`, which kills the pty and removes it.
  - `validate` accepts only the client-dispatchable actions: `input`, `resized`, `claimed`, `titleChanged` and `cleared`. Input to an exited terminal is rejected.
  - `onAction` forwards input and resizes to the pty, and republishes the catalogue on title or claim changes.

## Resource watches: `src/host/resource-watches.ts`

- **Library:** `@parcel/watcher` (FSEvents, inotify or Windows). Its events map directly to `added`, `updated` and `deleted`.
- **Attached in the background, one at a time per connection:** `createResourceWatch` answers once the path is checked; the OS watch attaches afterwards, and a connection's watches attach one after another (another connection's watches don't wait for them). `@parcel/watcher` runs each subscribe on libuv's thread pool (4 threads), and a subscribe on a cruise/cruise checkout takes 15-40 s. VS Code asks for recursive watches on `~/workspaces` and each open checkout, so four ran at once, the pool was full, and every other file operation in the host waited behind them (a plain `stat` took 13 s; opening a new chat took about 40 s). One at a time leaves the rest of the pool free. Changes made before the attach finishes are not reported; the watch has no resync signal. A watch that fails to attach (inotify limit, permissions) is logged as `resource watch error` (`phase: attach`) and its channel is removed, so subscribers see it disappear instead of getting a channel that never reports; `createResourceWatch` itself has already succeeded.
- **Excludes as `ignore`:** `@parcel/watcher` matches globs against absolute paths and resolves plain paths from the watched directory, which differs from `watchFilter`'s root-relative `matchesGlob`. So only excludes that mean the same in both are passed as `ignore` (`parcelIgnore`: `**/…` globs, and plain relative paths made absolute under the root), so those trees aren't watched at all. Every exclude still goes through `watchFilter`, which decides what is reported.
- **Release waits for unsubscribes:** `release` and `disposeAll` resolve once the released watches have unsubscribed, which waits for an attach still in flight. Requests don't await `release`; host shutdown does.
- **Injectable subscribe:** `ResourceWatchService` takes the `subscribe` function as a constructor argument (default `@parcel/watcher`'s), so `test/resource-watches.test.ts` tests it without the OS.
- **Pure helpers (unit-tested):**
  - `watchFilter({ root, isFile, recursive, includes, excludes })`:
    - Matches globs with Node's `path.matchesGlob` against the root-relative posix path.
    - An exclude also matches any ancestor directory.
    - Non-recursive watches keep direct children only.
    - A file watch keeps only that path.
  - `clientPath(path, realRoot, root)` maps OS-resolved paths back under the requested root.
    - The OS reports symlink-resolved paths, so the root is `realpath`'d for filtering and event paths are mapped back for reporting.
- **`ResourceWatchService` (stateful):**
  - `create` allocates `ahp-resource-watch:/<uuid>` and subscribes the watcher. The channel state is captured once and never mutated, as the spec requires.
  - Lifetime follows the spec: the host calls `release(isSubscribed, closedOwner)` after each `unsubscribe` and each disconnect, and every watch without a subscriber is released.
  - A watch that has not been subscribed yet is kept until its creating connection closes. This covers the window between `createResourceWatch` and `subscribe`.

## Host wiring: `src/host/agent-host.ts`

- **Routing:** `createTerminal`, `disposeTerminal` and `createResourceWatch` are routed to the services. They are no longer in the unsupported list.
- **Subscriptions:** `#load` skips exact-URI channels. `subscribe` and the handshake snapshots call `watches.subscribed`.
- **Client actions:** `#applyClientAction` checks exact channels first. Terminal actions go through the service's validate, dispatch and side-effect steps; all client actions on resource-watch channels are rejected.
- **Shutdown:** `dispose()` kills all ptys and unsubscribes all watchers.
