# Spec: Turn paging (`view.turns` and `fetchTurns`)

## Problem

Subscribing to a long-running session sent every historical turn in the initial `subscribe` snapshot, increasing WebSocket payload size and client rendering work.

## Design

- **Pure pagination helpers (`src/pi/turn-paging.ts`):**
  - `splitTailTurns(turns, tailCount)` splits an oldest-first `Turn[]` into `{ older, visible, nextCursor }`.
  - `takeTurnsPage(older, pageSize = 50)` pops up to `pageSize` turns from the newest end of `older` and returns `{ page, remaining, nextCursor }`.
  - `trimChatSnapshot(state, tailCount, olderRemaining)` trims an already-loaded `ChatState` snapshot for a subscriber that requested a smaller `view.turns`, adjusting `turnsNextCursor` to include both `olderRemaining` and the trimmed prefix.
  - Cursors are opaque strings (`"turns:<remainingCount>"`) validated by `parseTurnsCursor`.
- **`subscribe` (`AgentHost.#subscribe`):**
  - Validates `view.turns` (non-negative integer when present).
  - When loading a chat from history for the first time with `view.turns`, `PiSession.#fromHistory` keeps only the tail in `StateStore` with `turnsNextCursor` set, and holds `#olderTurns` in `PiSession`.
  - If the chat was already loaded in `StateStore` with more turns than `view.turns` requested, `#subscribe` returns a `trimChatSnapshot` copy without shrinking `StateStore`.
  - When `view.turns` is omitted (including `initialize` / `reconnect` via `#subscribeAll`), `PiSession.loadAllTurns()` flushes any `#olderTurns` via `chat/turnsLoaded` so all retained turns are returned.
- **`fetchTurns` (`AgentHost.#fetchTurns` / `PiSession.fetchTurns`):**
  - Rejects non-chat channels and invalid or out-of-range cursors with `InvalidParams` (`-32602`).
  - Dispatches `chat/turnsLoaded` (`ActionType.ChatTurnsLoaded`) with the next older page and updated `turnsNextCursor` (omitted when all turns are loaded) before returning `{}`.
  - If a client holds a trimmed snapshot whose cursor points inside `StateStore`'s already-loaded `chat.turns`, dispatches the prefix up to `#olderTurns.length` so the client catches up while `StateStore` deduplicates via `chatReducer`.
- **Eager backfill for turn-referencing operations:**
  - `PiSession.fork` calls `loadAllTurns()` before checking `forkTurnError` / `forkKeep`.
  - `AgentHost.#applyClientAction` flushes `#olderTurns` (and any `#trimmedChats` prefix) before `ChatTruncated` with a `turnId` so `validateChatAction`, `chatReducer`, and `#truncate`'s `recordedUserTurns` see the full prefix.
  - `PiSession.refreshContextUsage` falls back to `#olderTurns` when `chat.turns` is empty (`view.turns === 0`).

## Caveats

- `SessionManager.open(path)` still reads and parses the full JSONL session file from disk on initial load, so this saves WebSocket transfer and client rendering time rather than disk I/O time.

## Verification

- `test/turn-paging.test.ts`: unit tests for `turn-paging.ts` and e2e tests for `view.turns`, `view.turns: 0`, `fetchTurns`, invalid cursors, multi-client differing `view.turns`, and eager backfill on `createChat` (fork) and `chat/truncated`.
