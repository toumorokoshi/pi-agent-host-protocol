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
- **Run end:** the run's outcome (complete, cancelled or error) ends the last turn of the run. Messages still in `#steered` were never delivered (see below).
- **Cancel:** cancelling a steered turn aborts pi the same way as any host turn.
- **When pi delivers it:** pi checks its steering queue at `turn_end` (`pi-agent-core`'s `agent-loop.js`), after every tool call of the current reply has finished. That matches VS Code's "Steer with Message", which yields after the current tool call finishes, so the host never stops a run for a steer. A tool that blocks for a long time holds the message as long as it runs, unless the tool returns early on new input as Bolt's `bash` does. "Stop and Send" is the way to interrupt.
- **Undelivered at run end** (`#settleUndelivered`): a steer can arrive just after pi's loop made its last check, or the run can be aborted with it still queued (pi's `abort` leaves its queues alone). Before, such a message stayed in pi's queue: it either never ran or came back at the start of the next run, so after Stop and Send the agent got the instruction twice. The host now tracks pi's queues from its `queue_update` events and, for host runs on agents with `clearQueue` (`pi --mode rpc` children and embedded mode):
  - **pi still holds them as steers:** the host opens a turn with the first message, keeping its attachments, and starts a `steering` run with `/ahp-resume`. pi checks its steering queue at the start of every run, so it delivers the steer right after the hidden resume marker, along with anything extensions queued. The first user message pi delivers in that run belongs to the turn already opened; later ones open their own turns as usual. pi's queue is not cleared: extensions queue their own messages there while a run streams (pi-subagents' "background run finished" message, Bolt's job notices), and `clear_queue` would drop them without returning them.
  - **pi holds them as follow-ups:** Bolt's `bash` tool (`pi-patty-bg-tasks`' `input` hook) handles new input during a foreground command itself: it moves the command to the background, aborts the turn and resends the input as a follow-up. A run would answer before pi delivered a follow-up, so the host calls `clear_queue` and puts the messages at the front of the chat's queue (`chat/pendingMessageSet` as queued, then `chat/queuedMessagesReordered`); the first starts as the next turn.
  - **pi holds neither** (a failed `steer`): the messages go to the front of the chat's queue the same way.
  - **After a client cancel or truncation** (including Stop and Send): the host calls `clear_queue`, as pi's own Esc does, so the steer can't come back in the next run. The messages are dropped and logged at info.
  - A run a pi terminal drives is left alone, because pi's extension API cannot clear pi's queue.
- **Steering with no turn running** (`PiSession.#consumePending`): a client can set a steering message when no turn is running. For example, VS Code's "send immediately" on a queued message turns it into a steering message, and the turn may end just before that arrives. Steering would then have nothing to steer, and the message would stay pending forever. Instead the host removes it and starts it as a normal turn (`chat/turnStarted` without `queuedMessageId`), ahead of any queued messages. The same check runs when a turn ends, so a steering message that arrives while a cancelled run is still unwinding starts once that run settles.
- **Runs started in a pi TUI** already open a turn for every user message (`#onAgentEvent`), so a steering message sent from VS Code during such a run is not added to `#steered`.
- **History:** live turns now split the same way as turns reloaded from the session file.

## Tests

`test/external-turns.test.ts`, "a steering message sent during a host turn opens its own turn when pi delivers it", plays a run with `FakePi` in manual mode. It checks that `steer` is sent, that the steered message opens a second turn, and that each turn keeps its own reply.

Two tests in the same file cover steering with no turn running: "a steering message sent while no turn runs starts its own turn instead of staying pending" and "a steering message sent while no turn runs goes ahead of queued messages".

`test/steering.test.ts` covers undelivered steers, with `FakePi` keeping steering and follow-up queues and emitting `queue_update` the way pi does: a steer pi had not delivered when its run ended runs as the next turn without clearing pi's queue; a steer waits for a running tool call and the host does not stop it; a steer Bolt resent as a follow-up runs next without a duplicate; and a cancel clears pi's queue and drops it.
