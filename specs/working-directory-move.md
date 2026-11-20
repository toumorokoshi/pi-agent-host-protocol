# Spec: Moving a session's working directory

Status: **implemented**.

## Problem

A client may want to move an existing session's working directory (for example when moving work between a workspace and a git worktree). AHP models this with `capabilities.multipleWorkingDirectories` (`primaryReplacement: true`) and the `session/workingDirectoryReplaced` action, where the host must validate and apply the backend side effect before broadcasting the accepted action. Previously the host did not advertise `multipleWorkingDirectories` and rejected `session/workingDirectoryReplaced`.

## Behavior

- **Capability:** the pi agent in `RootState.agents` advertises `capabilities.multipleWorkingDirectories: { immutablePrimary: true, primaryReplacement: true }`. Setting `immutablePrimary: true` alongside `primaryReplacement: true` preserves immutable-primary behavior for older clients while allowing newer clients to atomically replace index `0`.
- **Rejected generic actions:** `session/workingDirectorySet` and `session/workingDirectoryRemoved` remain rejected, because pi sessions have a single working directory (`cwd`).
- **Validation (`AgentHost.#moveSessionWorkingDirectory`):** before accepting `session/workingDirectoryReplaced`, the host checks:
  - `action.directory` is present in the session's current `workingDirectories`;
  - `action.replacement` is a `file:` URI pointing to an existing local directory;
  - neither the session nor any of its forked chats has a turn in progress (`isRunning`) or a live pi TUI attached (`isTuiAttached`).
- **Backend side effect (`PiSession.moveWorkingDirectory` & `src/pi/session-move.ts`):**
  - Any started `PiAgent` (in `rpc` or `embedded` mode) for the session and its forked chats is disposed so the next turn starts a fresh agent rooted in the new `cwd`.
  - `moveSessionManager` updates the pi session file's `SessionHeader.cwd` (rewriting only the header line atomically) and, when pi groups sessions per working directory (no `--session-dir`), moves the file into the new directory's session folder (`--<encoded-cwd>--`). Unpersisted sessions get a fresh `SessionManager` in the new `cwd`, preserving any session name.
  - The host clears its session catalog cache (`#catalog`), refreshes the session's folder commands/customizations for the new `cwd`, broadcasts `session/workingDirectoryReplaced`, and emits `root/sessionSummaryChanged` with the updated `workingDirectories`.

## Tests

`test/session-move.test.ts`:
- Unit tests for `rewriteSessionHeaderCwd` and `moveSessionManager` (unpersisted with title, grouped per-cwd relocation, and flat `sessionDir` in-place header update).
- End-to-end tests in both `rpc` and `embedded` modes:
  - capability advertisement (`immutablePrimary: true, primaryReplacement: true`);
  - moving a session with history updates `SessionState`, `root/sessionSummaryChanged`, and `listSessions`, and persists across a host restart;
  - moving an empty session before any turn, and moving a session with a forked chat;
  - rejecting `session/workingDirectorySet`, `session/workingDirectoryRemoved`, unknown source directory, non-existent replacement directory, and moves while a turn is in progress.
