# Spec: `/compact` and compaction

Status: **implemented** (`rpc` and `embedded` modes).

## Problem

pi compacts a long session's context: it summarizes older turns with the model and keeps the most recent ones. pi's terminal UI has a `/compact [instructions]` command for doing it on demand, but pi handles it only there. It isn't an extension command, so `get_commands` doesn't list it, and a `prompt` that says `/compact` reaches the model as ordinary text. From VS Code's Agents window there was no way to compact a session, and typing `/compact` sent it to the model.

pi's RPC protocol has the operation: `{ type: "compact", customInstructions? }` runs `AgentSession.compact()`, which first aborts any running work, emits `compaction_start` (`reason: "manual"`) and `compaction_end` (`result` with `tokensBefore` and `estimatedTokensAfter`, or `aborted` and `errorMessage`), and answers with the result or an error ("Nothing to compact (session too small)", "Already compacted", "Compaction cancelled"). Embedded mode calls `AgentSession.compact()` directly.

## Behavior

- **Recognizing it** (`compactInstructions`, `src/pi/compaction.ts`): a message that is `/compact`, or starts with `/compact` and whitespace, is a compaction; the rest is its instructions. `/compactor` and text that only mentions `/compact` are ordinary messages.
- **A turn of its own** (`PiSession.#runTurn`, `#compact`): the message opens a turn as usual, but the host sends pi `compact` with the instructions instead of a prompt. The turn ends with "Compacted the session context: about 58k tokens before, 23k after." (from pi's result; less when pi gave less), or as an error with pi's message. Runs are serialized, so pi is never asked to compact while a run streams.
- **Cancel:** cancelling the turn aborts pi, which cancels the compaction (pi's `abort` calls `abortCompaction`). pi's RPC mode handles commands concurrently, so `abort` reaches it while `compact` is still waiting.
- **Sent while the agent works:** VS Code sends a message typed during a turn as a steering message. pi would hand `/compact` to the model as text, and compacting would abort the run, so the host doesn't pass it to pi: it moves it to the front of the chat's queue (`chat/pendingMessageRemoved` for the steer, `chat/pendingMessageSet` as queued, `chat/queuedMessagesReordered`) and it runs as its own turn when the current run ends. A queued `/compact` simply runs when its turn comes.
- **Sessions a pi terminal drives:** the bridge's extension API can only start compaction without waiting for it (`ctx.compact()`), so those agents have no `compact`. The turn says to type `/compact` in the terminal.
- **The turn's model:** the model (and thinking level) picked for the message is applied before pi compacts, as for a prompt, since pi summarizes with its current model.
- **Completions:** `/compact` is offered in `/` completions ("Manually compact the session context") unless pi lists a command of that name itself, and only where the agent can compact: not in a session a pi terminal drives.
- **Compaction events:** pi emits `compaction_start` and `compaction_end` for every compaction, with a `reason`. While pi compacts, the turn's activity reads "Compacting context". For an automatic one (`threshold` or `overflow`, during a run), `compaction_end` reports the size after (see [usage.md](usage.md)) and the activity goes back to "Thinking" while pi carries on, unless it was aborted. For a manual one (`reason: "manual"`, the `/compact` turn itself) `compaction_end` is ignored: the turn reports pi's result once, from the answer to `compact`, and its end clears the activity.
- **Capability:** an agent compacts when it has `compact`, which `rpc-backend.ts` sets (`compact: true`, independent of `clearQueue`) for `pi --mode rpc` children and embedded pi has natively; the bridge to a pi terminal has neither.

## Alternatives considered

- **Passing `/compact` to pi as a prompt:** pi's RPC mode doesn't run it; the model gets the text.
- **A host-side extension command that calls `ctx.compact()`:** it returns before compaction finishes and reports only through callbacks, so the turn couldn't end with the result.
- **Compacting immediately when a `/compact` steer arrives:** pi's `compact` aborts the run first, which turns "Steer" into "Stop".

## Tests

`test/compaction.test.ts`:
- `compactInstructions`, `compactDoneText`, the completion item, and the automatic-compaction activity.
- With a scripted pi (`FakePi`): `/compact` sends `compact` and no prompt (after `set_model` when the message picked a model) and ends the turn with the estimate; instructions are passed; pi's error ends the turn as an error; cancelling aborts pi and the session takes new turns; a `/compact` steer during a run is never sent to pi, waits in the queue, and compacts after the run ends; an agent without `compact` (a pi terminal) gets the terminal notice and no `/compact` completion; manual and aborted compaction events leave the activity alone.
- Against pi's real CLI (`rpc`) and SDK (`embedded`): the command reaches pi, and a fresh session's "Nothing to compact" ends the turn as an error.
