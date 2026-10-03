# Spec: Resuming errored turns

## Problem

Local model servers sometimes fail a request after the model has started answering. For example, llama.cpp's `llama-server` rejects malformed Qwen XML tool calls with `Failed to parse input at pos N`. pi records the failed assistant message with `stopReason: "error"`, and the host ended the turn with a final `chat/error`. In VS Code the turn was then a dead end, and the user had to send a new message to try again.

AHP 0.9 lets a host mark a turn error as resumable (`ErrorResponsePart.resumable`). A client can then dispatch `chat/turnResume` to continue the same turn without another user message.

## Behavior

- **Resumable vs. final errors** (`TurnMapper.impliedOutcome`):
  - A run that ends on a model-provider error is resumable. That means the last assistant message has `stopReason: "error"`, after pi's own auto-retries. Its `chat/error` part carries `resumable: true`.
  - Errors thrown before or around the run are final, for example an unknown model, missing credentials or a disposed session.
- **Validation** (`PiSession.validateChatAction`): a `chat/turnResume` is rejected unless all of these hold, matching the spec and the reducer's own preconditions:
  - no turn is active;
  - `turnId` is the latest turn and its state is `error`;
  - that turn's final part is a resumable error;
  - the host recorded that turn as resumable in this process.
- **Continuation** depends on the pi mode (see [pi-backends.md](pi-backends.md)).
- **Embedded mode** (`continueAfterError` in `src/pi/embedded-backend.ts`): pi has no public continue API, so the host does what pi's auto-retry does internally, using public pieces:
  1. Find the trailing errored assistant entry on the branch (`lastErroredAssistantEntry`).
  2. Append a `context_edit` entry with a `null` replacement (`sessionManager.appendContextEdit`), so the failed reply is dropped from the model context while the raw transcript keeps it.
  3. Call `refreshContext()`, then `agent.continue()` to run the agent loop again from the user message or tool results.
- **RPC mode** (`src/pi/extensions/ahp-resume.ts`): pi's RPC protocol has no continue command, so every child loads a small extension. The host sends the prompt `/ahp-resume`, an extension command that pi handles without a model call.
  1. The command appends a hidden custom message (`customType: "ahp-resume"`) with `triggerTurn: true`, which starts a normal run.
  2. A `context` handler (`omitResumedErrors`) removes every marker, and the errored assistant reply just before it, from each model request. The session file keeps both.
  3. The run goes through pi's full run loop (auto-retry, compaction, `agent_settled`). The host waits for `agent_settled` even though the command reports `handled`.
  4. If the extension did not load, `resume()` fails instead of sending `/ahp-resume` to the model as text.
- **Turn continuity:** the reducer reopens the same turn, keeping its message, earlier parts and the error part. The new run uses a `TurnMapper` with an attempt number, so new response part ids are `<turn>.r<n>.<message>.<content>` and never collide with the first attempt's ids. Success ends the turn with `chat/turnComplete`; another provider error appends another resumable error.
- **Serialization:** resume runs go through the same per-session run queue as prompts, and `chat/turnCancelled` aborts them the same way.

## Trade-offs

In embedded mode, calling `agent.continue()` directly skips `AgentSession`'s run loop: auto-retry, automatic compaction, `agent_settled` and the `agent_before_settle` hooks. Messages are still persisted, because `AgentSession` saves agent events through its own subscription. Cancellation still works, because `abort()` always calls `agent.abort()`. See GAPS.md.

## Tests

`test/resume.test.ts` (end-to-end cases run in both modes):
- `lastErroredAssistantEntry` cases.
- End to end: a scripted provider error is marked resumable. Resuming completes the same turn while keeping the error part, and the model's context on the second attempt is `[system, user]`, without the failed reply.
- Resuming a completed turn is rejected, and a non-provider error (unknown model) is not resumable.
