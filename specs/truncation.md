# Spec: Truncating a chat to edit a message

## Problem

A client that lets the user edit an earlier message, or the message the agent is working on, and restart from there has to drop that turn and the ones after it, then send the edited message. AHP does this with `chat/truncated` (keep the turns up to `turnId`, or none without it, and drop the running turn), followed by `chat/turnStarted` with the edited message. The host rejected `chat/truncated` as unsupported, so a client could only send the edit as a new turn, and the model still saw the message it replaced.

## Behavior

- **Validation** (`PiSession.validateChatAction`): accepted unless `turnId` is not one of the chat's turns (`Unknown turn`; the reducer would ignore it), or an interactive pi drives the session through the bridge (`Not supported while the session is open in a pi terminal`; the bridge cannot run extension commands).
- **State:** the official reducer keeps the turns up to `turnId`, drops the running turn and keeps steering and queued messages.
- **Side effects** (`PiSession.#truncate`):
  1. A running turn is ended as a client cancellation does: its later events are dropped and pi is aborted.
  2. The number of kept turns pi has a user message for is counted (`recordedUserTurns`): turns pi started without one ("Continued in pi") and turns whose prompt never reached pi (an unknown model, cancelled before it started) do not count. AHP turns and pi's user messages are in the same order, so this count identifies the cut.
  3. Once the aborted run has settled (truncation is queued on the same per-session run chain as prompts), the agent moves pi back (`PiAgent.truncate(keep)`). A `chat/turnStarted` sent right after queues behind it and runs on the truncated context.
- **Moving pi back** re-edits from the first dropped user message, as pi's own `/tree` does: `truncationTarget` finds it on the current branch, and pi's `navigateTree` moves the session's leaf to its parent. The next message is appended there, starting a new branch. Nothing is deleted: the dropped turns stay in the session file on the abandoned branch, and reloaded history follows the new leaf.
  - **Embedded mode** calls `AgentSession.navigateTree` directly.
  - **RPC mode** has no RPC command for it, so the extension every child loads (`src/pi/extensions/ahp-resume.ts`) registers `/ahp-truncate <entryId>`, which calls `ctx.navigateTree`. The host reads the branch with `get_entries` before and after: pi awaits a command's handler before answering but reports its errors only as events, so the host checks that the leaf moved to the target's parent.
- **Failure:** if pi could not move back, the error is logged and the next run fails with `pi could not drop the edited turns: …` rather than run on a context that still holds the dropped turns.

## Tests

`test/truncation.test.ts`:
- `branchTo`, `truncationTarget` and `recordedUserTurns` cases.
- End to end, in both modes: editing an earlier message sends only the kept turns and the edit to the model; editing the running message cancels it and restarts with a context of just the edit; an unknown turn is rejected; a restarted host reloads the edited branch.
