/**
 * Pure helpers for forking a chat at a completed turn (`createChat` with a
 * fork source). See specs/forks.md.
 */
import { type Turn, TurnState } from "@microsoft/agent-host-protocol";
import { type EntryLike, recordedUserTurns, truncationTarget } from "./truncation.ts";

/** Why `turnId` cannot be a fork point of `turns`, or `undefined` when it can. */
export function forkTurnError(turns: readonly Turn[], turnId: string): string | undefined {
	const turn = turns.find((candidate) => candidate.id === turnId);
	if (!turn) return `Unknown turn: ${turnId}`;
	return turn.state === TurnState.Complete ? undefined : `Turn ${turnId} is not complete`;
}

/**
 * How many of pi's user messages the turns through `turnId` cover: the
 * fork keeps those and what followed them. Counted as truncation counts its
 * kept turns, so turns pi has no user message for do not shift the cut.
 */
export function forkKeep(turns: readonly Turn[], turnId: string, unrecorded: ReadonlySet<string>): number {
	const index = turns.findIndex((turn) => turn.id === turnId);
	return recordedUserTurns(turns.slice(0, index + 1), unrecorded);
}

/**
 * The entry on `branch` a fork keeping `keep` user messages ends at: the
 * entry before the next user message, or the branch's last entry when the
 * fork keeps them all. `undefined` for an empty branch.
 */
export function forkLeaf<T extends EntryLike>(branch: readonly T[], keep: number): string | undefined {
	const next = truncationTarget(branch, keep);
	return next ? (next.parentId ?? undefined) : branch.at(-1)?.id;
}

/** The title of a chat forked from a chat titled `title`. */
export function forkTitle(title: string): string {
	return `${title} (fork)`;
}
