# Spec: Context size and `/context`

## Problem

pi compacts automatically only when the context passes the model's window minus `compaction.reserveTokens` (16K by default): 98% of a 1M-token model. A long run on such a model carries hundreds of thousands of tokens of context, re-sent on every model call. There was no way, from VS Code, to have a session work with a smaller window, and nothing typed in the chat changed it.

VS Code's model picker has a native context-size choice. A host puts a numeric `contextSize` property in a model's `configSchema` (VS Code groups it under "tokens", next to Thinking), and VS Code sends the chosen value back with each message in `ModelSelection.config.contextSize`. VS Code's own Copilot and Codex hosts build the property the same way (`createContextSizeConfigSchemaPropertyFromLimits` in its `agentModelConfiguration.ts`). Its context meter divides the reported usage by the chosen size when one is set (`resolveContextWindowInputTokens` in `chatContextUsageWidget.ts`), so the meter follows the choice.

Bolt (cruise/bolt `feat(coding-agent): session context limit and percentage compaction threshold`) keeps a per-session context limit that compaction, overflow recovery and context usage treat as the window, set over RPC with `set_context_limit`, and reports it in `get_state` (`contextLimit`). With `compaction.thresholdPercent` in Bolt's settings, compaction then runs at a percentage of the chosen window (80% of 300K is 240K).

## Behavior

`src/pi/context-limit.ts` (pure helpers), `src/pi/models.ts`, `src/pi/pi-session.ts`, `src/pi/rpc-agent.ts`:

- **Picker:** each published model whose window is known gets a `contextSize` property next to `thinkingLevel`: a number enum of whichever of 200K, 300K and 500K are below the model's window, then the window itself, labelled `200K`, `1M` and so on, defaulting to the full window. A model with no smaller choice (window up to 200K) or no known window gets none.
- **Applying it:** VS Code sends the picker's value with every message, and the host can't move the picker (see Trade-offs). So before a prompt, after the model and thinking level, the host sends `set_context_limit` only when the picker **changed** since the session's previous message (the model's own window sends `null`). The first message applies a smaller pick; a first full-window pick leaves a limit restored from the session or set earlier. A limit set with `/context` therefore stays until the picker is changed.
- **`/context` typed in the chat** isn't sent to the model. It runs as a turn of its own, like `/compact`:
  - `/context`: ends the turn with the context in use, the window it's measured against, and the limit, e.g. "Context: 42K of 300K (14%); limit 300K (model 1M)." (from pi's `get_state` and `get_session_stats`);
  - `/context 300k`, `/context 1m`, `/context 200000`: sets the limit, then reports as above;
  - `/context default` (or `max`, `off`): clears it;
  - anything else ends the turn with a usage hint.

  `/context` is offered in `/` completions unless pi lists a command of that name.
- **`/context` sent while the agent works:** VS Code sends it as a steering message, which pi would hand to the model as text. Like `/compact`, the host doesn't pass it to pi: it moves it to the front of the chat's queue and it runs as its own turn when the current run ends.
- **A pi without context limits** (an older Bolt, stock pi; it answers "Unknown command"): a picker choice adds one note to that turn ("This session's pi can't set a context limit…") and is then ignored while that pi runs, so the prompt still runs; `/context` says the same. The limit isn't recorded, so the gauge keeps the model's window. Support is found out on first use, and is tried again once the pi is replaced.
- **A failed `set_context_limit`** (a crash, a timeout, anything but "Unknown command"): the turn fails with the error. Neither the limit nor the picker's choice is recorded, so the next message sends it again, and the gauge doesn't show it.
- **Sessions a pi terminal drives** (the bridge can't set the limit): `/context` replies to type it in the terminal; a picker choice is ignored and not recorded, so it applies when the host's own pi takes over again.
- **The context gauge:** VS Code works out the gauge's window from the picker's model: its configured Context Size **plus the model's output allowance**, capped at the model's window. That knows nothing of `/context`, and on a model whose output allowance is as large as its window (Gemini: 1M of output) every Context Size reads as the full window: 260K of a 300K limit showed as "260.6K / 1M, 25%". VS Code uses a host-reported context instead when the session's `_meta` has `copilot.usageInfo` (`{ currentTokens, tokenLimit, messagesLength }`, read by `readCopilotContextUsage`). The host publishes it with `session/metaChanged`: `currentTokens` is the context of the latest turn that reported usage (see [usage.md](usage.md)), `tokenLimit` the window pi works with, the model's lowered to the session's limit. It is refreshed when usage arrives, when a message selects the model or Context Size, when `/context` sets a limit, and when the model list is published (the model's window comes from it). A session loaded from disk takes its model and limit from the last `model_change` and `pi.context-limit` entries in its file. A forked chat doesn't publish it (`_meta` is per session, so it follows the default chat).

## Trade-offs

- The host remembers, per running pi, the limit pi accepted and the picker value it applied, and records them only after pi's answer. When another pi takes over the session (an idle pi stopped and restarted, an exited pi replaced, a handover to or from a terminal, which can change the limit) both are forgotten, so the next message applies the picker's size again (a first full-window pick sends nothing, leaving what Bolt restored from the session file). The gauge keeps the last limit the host set until then. After a host restart the host knows nothing and relies on the same restore.
- Whether pi has `set_context_limit` isn't probed up front: `RpcAgentOptions.contextLimit` offers the commands on a `pi --mode rpc` child, and an "Unknown command" answer marks that pi unsupported (`isUnknownCommandError`). The bridge and embedded agents don't offer them.
- Applying a picker choice sends only `set_context_limit`; `/context` reads `get_state` and `get_session_stats` for its report.
- A bare model id (from a turn's usage) that several providers publish with different windows has no known window for the gauge; a `provider/id` always does.
- **The picker doesn't follow `/context`.** VS Code shows a host-reported model configuration only through `session.config.values["vscode.modelConfiguration"]` (`readAgentModelConfigurationReport`), a per-chat report of each model's defaults, choices and current selection that VS Code's own Copilot host publishes. Using it needs the session-config channel (`resolveSessionConfig` and friends), which this host doesn't implement yet. Until then the picker keeps showing the last size picked, `/context` wins until the picker is changed, and `/context` reports the limit actually in effect.
- The choices are fixed (200K, 300K, 500K, full). `/context` takes any size.

## Tests

`test/context-limit.test.ts`:
- the property's choices, labels and default, and none for small or unknown windows; models carry it next to `thinkingLevel`;
- the gauge's value (tokens against the model's window lowered to the limit), and the model and limit a session file last recorded;
- against a scripted pi, the gauge's `copilot.usageInfo` follows the picker's Context Size and `/context`;
- reading a selection's limit (the full window and no choice are `null`);
- `/context` parsing, the report text, and completions;
- against a scripted pi: the published model offers Context Size; `/context 300k`, `/context` and `/context default` set, show and clear without a prompt; an unreadable argument; the picker's choice is applied once per change, before the prompt, and the full window clears it; an older Bolt gets one note, is not asked again, leaves the gauge on the model's window, and prompts still run; a failed request fails the turn and is retried with the next message; a replaced pi gets the picker's size again; a `/context` steer during a run is held, never sent to pi, and runs after it;
- against the bundled pi (which predates `set_context_limit`): `/context` says it can't, and the turn completes.

`test/bridge.test.ts`: `/context` in a session a pi terminal drives says to type it there and sends nothing to pi.
