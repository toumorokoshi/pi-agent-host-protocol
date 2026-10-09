# Spec: Steering messages

## Problem

A message sent while a turn is running did not show up in the conversation. VS Code sends it as a steering message (`chat/pendingMessageSet` with `kind: "steering"`). The host removed it from the pending state (`chat/pendingMessageRemoved`) and passed it to pi with `steer`. pi then delivered it mid-run as a user message, but the host's `TurnMapper` ignores user messages, so the text was never added to any turn. The model saw and answered the message, but the chat only showed the answer, appended to the first turn's response. After a reload the message appeared, because pi's session file has it and `turnsFromEntries` starts a turn at every user message.

AHP has no response part for a delivered steering message. VS Code's own Copilot agent host promotes a delivered steering message to its own turn, and that is what this host does too.

## Behavior

- **Sending** (`PiSession.#consumePending`): while a turn is running, a steering message is removed from the pending state and sent to pi with `steer`. During a run the host started, the message is also kept in `#steered` (oldest first), so the turn it opens keeps the original message, including its attachments and model.
- **Delivery** (`PiSession.#execute`): the first user `message_start` of a prompt run is the prompt itself. Each later user `message_start` (and every one in a resume run) is a delivered steering message. `#promoteSteering` then:
  1. completes the current turn (`chat/turnComplete`);
  2. starts a new turn with `chat/turnStarted`. The message is the matching entry of `#steered`, or the text pi delivered if there is none;
  3. sends the rest of the run's events to the new turn's `TurnMapper`.
- **Run end:** the run's outcome (complete, cancelled or error) ends the last turn of the run. `#steered` is cleared.
- **Cancel:** cancelling a steered turn aborts pi the same way as any host turn.
- **Steering with no turn running** (`PiSession.#consumePending`): a client can set a steering message when no turn is running. For example, VS Code's "send immediately" on a queued message turns it into a steering message, and the turn may end just before that arrives. Steering would then have nothing to steer, and the message would stay pending forever. Instead the host removes it and starts it as a normal turn (`chat/turnStarted` without `queuedMessageId`), ahead of any queued messages. The same check runs when a turn ends, so a steering message that arrives while a cancelled run is still unwinding starts once that run settles.
- **Runs started in a pi TUI** already open a turn for every user message (`#onAgentEvent`), so a steering message sent from VS Code during such a run is not added to `#steered`.
- **History:** live turns now split the same way as turns reloaded from the session file.

## Tests

`test/external-turns.test.ts`, "a steering message sent during a host turn opens its own turn when pi delivers it", plays a run with `FakePi` in manual mode. It checks that `steer` is sent, that the steered message opens a second turn, and that each turn keeps its own reply.

Two tests in the same file cover steering with no turn running: "a steering message sent while no turn runs starts its own turn instead of staying pending" and "a steering message sent while no turn runs goes ahead of queued messages".
