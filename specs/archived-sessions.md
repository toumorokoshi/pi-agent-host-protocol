# Spec: Archived sessions

Status: **implemented**.

## Problem

VS Code's Agents window "mark as done" sends `session/isArchivedChanged` (or `chat/isArchivedChanged`) with `isArchived: true`. The host applied it to the in-memory state only. pi's session files have no archived flag, so after a host restart every session was rebuilt with `Idle | IsRead`, and every session the user had marked done came back in the active list (VS Code's pinned sessions).

## Design

### Storage (`src/host/archive-store.ts`)

The host keeps the ids of archived sessions in `archived-sessions.json`, next to `settings.json` (`~/.pi/agent-host-protocol/` or `PI_AGENT_HOST_PROTOCOL_DIR`):

```json
{
	"version": 1,
	"archived": ["<pi session id>", "…"]
}
```

- Parsing, serializing and updating the set are pure functions (`parseArchive`, `serializeArchive`, `withArchived`).
- `fileArchiveStore` loads the file at startup (a missing file means nothing is archived; a malformed file is treated as empty) and writes it after each change. Writes are serialized and atomic (temp file, then rename). A failed write is logged (`could not save archived sessions`) and the flag stays in memory.
- `memoryArchiveStore` is used when no store is passed to `AgentHost`.
- pi session files are not modified.

### Writing the flag

`PiSession` records the flag in the store when a client action is accepted:

- `session/isArchivedChanged` (also mirrored onto the default chat);
- `chat/isArchivedChanged` on the default chat.

### Reading the flag

Every place that builds a status for a session loaded from disk uses `restoredStatus(archived)` (`Idle | IsRead`, plus `IsArchived` when archived):

- `listSessions` entries for session files the host has not loaded (`catalogSummary`);
- `PiSession.open` and `PiSession.live`, so session and chat snapshots and `listSessions` entries for loaded sessions keep the flag.

`AgentHost.dispose` waits for pending writes.

## Not covered

- The read/unread flag is still not persisted.
- Ids of deleted session files are not pruned.
