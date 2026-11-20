/**
 * The usage a turn reports, from pi's per-call usage on assistant messages.
 *
 * VS Code reads `inputTokens` of a chat's last turn as the size of the
 * context, so it is the full prompt of the turn's last model call: uncached
 * input plus the tokens read from and written to the cache. Summing a turn's
 * calls would count the shared prefix once per call, and leaving the cache
 * out would show a fraction of the context on a cached provider. Output is
 * what the turn generated, so it is summed across calls.
 */

import type { UsageInfo } from "@microsoft/agent-host-protocol";

/** Usage pi reports on an assistant message. */
export interface PiUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

/** What is known about a turn's usage so far; immutable. */
export interface TurnUsage {
	/** Full prompt of the last call. */
	readonly context: number;
	readonly cacheRead: number;
	/** Output summed over the turn's calls. */
	readonly output: number;
	readonly model?: string;
}

/**
 * Folds one assistant message's usage and model into a turn's.
 *
 * A message whose prompt is all zeros made no call that reported a context: pi gives a failed or
 * aborted call, one that failed before the provider answered, an empty usage. It leaves the
 * context and cache read of the turn's last real call as they were (pi's own context estimate
 * ignores such messages the same way); only its output and model are folded in.
 */
export function addCall(
	turn: TurnUsage | undefined,
	usage: PiUsage | undefined,
	model: string | undefined,
): TurnUsage | undefined {
	if (!usage) return turn && model ? { ...turn, model } : turn;
	const cacheRead = usage.cacheRead ?? 0;
	const context = (usage.input ?? 0) + cacheRead + (usage.cacheWrite ?? 0);
	const output = (turn?.output ?? 0) + (usage.output ?? 0);
	const resolvedModel = model ?? turn?.model;
	if (context === 0 && !turn && output === 0) return undefined;
	return {
		context: context === 0 ? (turn?.context ?? 0) : context,
		cacheRead: context === 0 ? (turn?.cacheRead ?? 0) : cacheRead,
		output,
		...(resolvedModel ? { model: resolvedModel } : {}),
	};
}

/**
 * A turn's usage after pi compacted the context to about `tokens`: the context the next call
 * starts from shrinks, nothing was read from the cache yet, and output so far is kept.
 */
export function afterCompaction(turn: TurnUsage | undefined, tokens: number): TurnUsage {
	return { context: tokens, cacheRead: 0, output: turn?.output ?? 0, ...(turn?.model ? { model: turn.model } : {}) };
}

/** The protocol's usage for a turn. */
export function usageInfo(turn: TurnUsage): UsageInfo {
	return {
		inputTokens: turn.context,
		outputTokens: turn.output,
		...(turn.cacheRead ? { cacheReadTokens: turn.cacheRead } : {}),
		...(turn.model ? { model: turn.model } : {}),
	};
}
