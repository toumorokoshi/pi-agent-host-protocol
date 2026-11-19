# Spec: Extension dialogs

## Problem

pi extensions ask the user questions with `ctx.ui.select`, `confirm`, `input` and `editor`, and report progress with `ctx.ui.notify`. Commands such as `/plan` stop to ask which plan to run or whether to continue. In a host session nothing showed them: the RPC backend answered every dialog with `cancelled: true` and dropped notifications. A command that needs an answer resolved with its default (`undefined` or `false`) and usually did nothing, without telling the user why.

AHP has input requests for this. A host adds a request to the active turn with `chat/inputRequested`, the chat's status becomes `InputNeeded`, and the client answers with `chat/inputAnswerChanged` and `chat/inputCompleted`. VS Code shows the request as a question carousel above the chat input.

## Behavior

- **Scope:** RPC mode, in turns the host runs (`src/pi/rpc-agent.ts`, `src/pi/pi-session.ts`). Embedded sessions and sessions a pi terminal drives are unchanged; see Trade-offs.
- **Dialogs** (`src/pi/dialogs.ts`): each `extension_ui_request` dialog becomes one input request with pi's request id and a single required question, `answer`:

  | pi dialog | Question | Answered with |
  |---|---|---|
  | `select{title, options}` | single select; option ids are the option indexes; no free-form text | `{value: <option label>}` |
  | `confirm{title, message}` | boolean, with the message | `{confirmed}` |
  | `input{title, placeholder}` | text, with the placeholder as its message | `{value}` |
  | `editor{title, prefill}` | text, with the prefill as its default value | `{value}` |

- **Answers:** `chat/inputCompleted` with `accept` and a submitted answer of the question's kind resolves the dialog. The host reads the answers from the request in its own state, so drafts the client synced with `chat/inputAnswerChanged` count when `chat/inputCompleted` carries none. Anything else (`decline`, `cancel`, a skipped answer, an option that does not exist) is answered with `cancelled: true`, which pi resolves to the dialog's default.
- **When a dialog is dismissed by the host** (`cancelled: true`, plus `chat/inputCompleted` with `cancel` while its turn is still running):
  - its `timeout` passes (pi stops waiting on its own at the same time);
  - the client cancels the turn, or the turn ends with the dialog still open;
  - a client truncates the chat or a steering message starts a new turn;
  - the session is disposed;
  - it arrives when no host turn is running, for example from a timer an extension started earlier.
- **Validation:** `chat/inputAnswerChanged` and `chat/inputCompleted` are rejected with `No open input request` unless they name a dialog that is open.
- **Status:** the chat status is `InputNeeded` while a request is open, and the session summary follows it, so a session list can show that the session is waiting.
- **Notifications:** `notify` during a host turn appends a markdown part to the turn, prefixed `**Warning:**` or `**Error:**` for those levels. The part is padded with blank lines, because VS Code joins adjacent markdown parts without a separator. Outside a turn it is logged at debug.
- **Other UI methods** (`setStatus`, `setWidget`, `setTitle`, `set_editor_text`) are ignored, as before.

## Trade-offs

- **Turn-bound:** AHP input requests live in a turn, so a dialog outside a host turn cannot be shown and is dismissed. Extensions mostly open dialogs from commands and tools, which run inside a turn.
- **Embedded mode** keeps pi's own no-UI behavior: dialogs resolve with their defaults and notifications are dropped. Forwarding them there means giving pi an extension UI context, which the embedded backend does not build.
- **pi terminal sessions** show dialogs in the terminal, which owns pi's UI. VS Code is not asked.
- **Timeouts:** pi resolves a timed-out dialog itself without telling the host, so the host keeps its own timer with the same timeout to close the request in the client.

## Tests

`test/dialogs.test.ts`:
- Parsing pi's dialog records, mapping each dialog to a question, and mapping answers back, including the cases that cancel.
- `RpcAgent` answers dialogs with `cancelled` when no handler can show them, forwards a handler's answer, and passes notifications on.
- End to end against a real `pi --mode rpc` child with `test/fixtures/dialogs.ts` loaded: a select answered by the client, an input answered through a synced draft, a declined confirm, a timeout, a cancelled turn, and a dialog opened outside a turn (dismissed without a request, and an answer to an unknown request rejected).
