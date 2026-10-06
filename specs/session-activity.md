# Spec: Session status and activity text

## Problem

The VS Code Agents window shows a spinner and a one-line description for each running session. Both come from the session summary:

- `SessionSummary.status`: the `InProgress` bit shows the spinner.
- `SessionSummary.activity`: the text shown under the title, for example "Running npm test". Without it, VS Code shows a generic "Working...".

Two problems needed fixing. The spinner went away when the user opened a running session and then navigated away. And the host never set `activity` at all.

## Behavior

### Status (busy indicator)

- The default chat's `status` is the source of truth. The AHP chat reducer derives its activity bits from `activeTurn`.
- `session/isReadChanged` and `session/isArchivedChanged` are mirrored onto the chat as `chat/isReadChanged` / `chat/isArchivedChanged`. The summary is then published from the chat status, so marking a session read never drops `InProgress`.
- `SessionState.status` is overwritten with the chat status outside the action stream (`StateStore.setSessionStatus`), because no AHP action sets it. This keeps session snapshots accurate.

### Activity text

`TurnMapper` emits `chat/activityChanged` whenever the description of the current step changes:

| pi event | Activity |
|---|---|
| assistant `message_start`, `thinking_start` | `Thinking` |
| `text_start` | `Responding` |
| `toolcall_start` (arguments still streaming) | generic tool label, e.g. `Running command` |
| `toolcall_end`, `tool_execution_start` | tool invocation label, e.g. `Running npm test`, `Reading src/a.ts` |
| `tool_execution_end` | the most recent tool still running, else `Thinking` (the model is called again) |
| end of the turn (`finish`) | cleared |

- Labels come from `toolLabels` in `src/pi/tool-display.ts`, the same text as the tool call's invocation message, with inline-code backticks removed (`toolActivity`) because clients render activity as plain text.
- Repeated identical values are not emitted.
- `PiSession` mirrors the chat activity, as AHP's summary aggregation rules ask, into:
  - `session/activityChanged` on the session channel;
  - `session/chatUpdated` with `changes.activity` on the chat catalog;
  - `root/sessionSummaryChanged` with `activity`, using `null` to clear. A field left out means "unchanged" to clients, and VS Code treats `null` as an explicit clear.
- A turn the client cancels drops the mapper's remaining actions, so `PiSession.#syncSummary` clears any activity left over once no turn is active.
- `listSessions` and `root/sessionAdded` include the current `activity` for live sessions.

Turns started in a pi terminal (live TUI sessions) use the same `TurnMapper`, so they report activity too.

## Tests

- `test/turn-mapper.test.ts`: the activity sequence for thinking, responding, tools streaming and running, parallel tools, and the clear at the end.
- `test/e2e.test.ts`: a tool-using turn publishes `activity: "Reading activity.txt"` in `root/sessionSummaryChanged` and clears it (`null`) after the turn. Marking a running session read keeps `InProgress`.
