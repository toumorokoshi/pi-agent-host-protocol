# Spec: Turn usage and the context gauge

## Problem

VS Code's Agents window shows a context gauge from the `inputTokens` of a chat's last turn (`usageInfoToChatUsage` in its `stateToProgressAdapter.ts`). The host summed pi's `input` over every model call of a turn and left out the cache. On a provider with prompt caching (Anthropic, Vertex), most of each prompt is a cache read, so a session with about 42K tokens of context showed about 13K; on an uncached provider, a turn with several tool calls counted its shared prefix once per call and overstated the context.

## Behavior

`src/pi/usage.ts` folds pi's per-call usage (on each assistant message) into a turn's, for live turns (`TurnMapper`) and rebuilt history (`turnsFromEntries`) alike, one function (`addCall`) for both:

- **`inputTokens`:** the full prompt of the turn's last model call: `input + cacheRead + cacheWrite`. That is the context the next call starts from.
- **`cacheReadTokens`:** the last call's cache read, omitted when zero.
- **`outputTokens`:** summed over the turn's calls: everything the turn generated.
- **`model`:** the last call's model.
- **Calls that reported no prompt:** a call whose `input + cacheRead + cacheWrite` is 0 (pi gives a failed or aborted call, such as a provider error before the first token, an empty usage) leaves the turn's `inputTokens` and `cacheReadTokens` as the last real call had them, so a failed retry doesn't zero the gauge. Its `output` is still summed. This is the same rule as pi's own context estimate, which skips such messages. Live turns and rebuilt history apply it alike.
- A turn with no call that reported usage reports none.
- **When:** `chat/usage` is sent after every model call, not only when the turn ends, so the gauge follows a long run (a `/goal` run is one turn of hundreds of calls).
- **Compaction, live:** the gauge reads the last turn's usage, and a `/compact` turn makes no model call of its own, so without this it kept showing the size before. When pi compacts (a `/compact` turn's result, or `compaction_end` of an automatic compaction during a run), the turn's `inputTokens` becomes pi's `estimatedTokensAfter` and `cacheReadTokens` is cleared; the next call's usage replaces it. The events of a manual compaction are ignored by the mapper, since the `/compact` turn reports the result itself.
- **Compaction, reloaded history (known difference):** pi's session file records a compaction as a `compaction` entry (`summary`, `firstKeptEntryId`, `tokensBefore`) and no size after, and `/compact` leaves no user message, so there is no `/compact` turn on reload. The host doesn't invent a size: a `compaction` entry changes no turn's usage, and each turn reports its own last call's. A chat whose last turn ended before a compaction therefore shows the size before it until its next call, where live it shows `estimatedTokensAfter`.

## Tests

`test/usage.test.ts`: usage after each call; the drop after automatic compaction and the next call replacing it; a compaction entry in rebuilt history (shaped as pi writes it: no `/compact` message) changes no turn's usage; two calls (the second mostly cached) report the second call's full prompt and the summed output; cache writes count as context; a live turn and the same session rebuilt from its file report the same usage; a failed or aborted call with empty usage keeps the last real call's context, live and rebuilt (`test/history.test.ts` too).
