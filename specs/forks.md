# Spec: Forking a chat

## Problem

A user who wants to try another direction from an earlier point of a conversation, without losing the original, needs a second chat that starts with the conversation up to that point. AHP has this as `createChat` with a `ForkChatSource` (a source chat and a completed turn), allowed only when the agent advertises `capabilities.multipleChats.fork`. The host had one chat per session and answered `createChat` with `MethodNotFound`, so clients (such as shireitou's "Fork from here" button) hid forking against pi.

## Behavior

- **Capability:** the pi agent in `RootState.agents` advertises `capabilities: { multipleChats: { fork: true } }`. Side chats are not advertised.
- **`createChat`** (`AgentHost.#createChat`) accepts only a fork source. It needs:
  - `channel`: a session the host knows (loaded from disk if needed);
  - `chat`: the client-chosen chat URI, not already used (`AlreadyExists`, `-32010`);
  - `source.chat`: a chat of that session, its default chat or another fork (`InvalidParams` otherwise);
  - `source.turnId`: a completed turn of the source chat (`InvalidParams` for an unknown, running, cancelled or failed turn).

  No source, or a `sideChat` source, is `InvalidParams`. An `initialMessage` starts the fork's first turn at once.
- **The fork is a pi session file.** `PiSession.fork` opens the source chat's session file afresh (a `pi --mode rpc` child may have written to it; one the child created is found through `listSessions`), finds the fork point and calls pi's `SessionManager.createBranchedSession(leaf)`. pi writes a new file holding the path from the root to that entry, with the same entry ids, and records the source file as `parentSession`. The host names it `<source title> (fork)`.
- **The fork point** is found as truncation finds its cut (see [truncation.md](truncation.md)): `forkKeep` counts the turns through the forked one that pi has a user message for (`recordedUserTurns`), and `forkLeaf` takes the entry before the next user message on the current branch, or the branch's last entry when the fork is at the latest turn.
- **Publishing:** the fork's `PiSession` is bound to its chat (`ChatBinding` `fork`): it dispatches to the client's chat URI and to the owning session's channel. It is announced with `session/chatAdded` (`origin: { kind: "fork", chat, turnId }`), and the session's `root/sessionSummaryChanged` carries the full chat catalog. Its status, `modifiedAt` and activity update its catalog entry only; the session's own status, title, activity, customizations, archived flag and background work stay those of its default chat.
- **Routing:** `StateStore` keys chats by the pi session backing them (`ChatRef.chatId`) and resolves forks' client-chosen URIs before parsing a URI's shape (`StateStore.ref`). `AgentHost` keeps forks in their own map; idle suspension, background work and disposal cover them like sessions' default chats. A session runs (for `root/activeSessionsChanged`) while any of its chats runs.
- **Persistence:** `~/.pi/agent-host-protocol/forked-chats.json` (`fork-store.ts`) maps each fork's pi session id to its session, chat URI and origin. pi's `parentSession` alone cannot tell them apart, because pi's own `/fork` writes it for sessions that stand alone. When a session loads (from disk or a pi terminal), its forks load with it; a fork's URI loads its session. `listSessions` leaves forks out and lists them as chats of their session.

## Tests

`test/forks.test.ts`:
- `forkLeaf`, `forkKeep`, `forkTurnError`, `forkTitle`, and the fork store's parsing, lookups and file.
- End to end, in both modes: the capability is advertised; a fork at the first of two turns has that turn, sends only it and the new message to the model, and leaves the source unchanged; a fork at the latest turn with an `initialMessage` runs it on the whole history; invalid sources, turns, sessions and URIs are rejected; after a restart, the fork is a chat of its session, not a session, and reloads its history.
