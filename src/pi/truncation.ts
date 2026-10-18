/**
 * Pure helpers for `chat/truncated`: which entry of pi's session tree a
 * truncation re-edits from. See specs/truncation.md.
 */
import { MessageKind, type Turn } from "@microsoft/agent-host-protocol";

/** The fields of a pi session entry these helpers read. */
export interface EntryLike {
	readonly type: string;
	readonly id: string;
	readonly parentId: string | null;
	readonly message?: unknown;
}

/** The entries from the root to `leafId`, following parent links (empty for a `null` leaf). */
export function branchTo<T extends EntryLike>(entries: readonly T[], leafId: string | null): T[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const branch: T[] = [];
	const seen = new Set<string>();
	for (let id = leafId; id !== null && !seen.has(id); ) {
		const entry = byId.get(id);
		if (!entry) break;
		seen.add(id);
		branch.push(entry);
		id = entry.parentId;
	}
	return branch.reverse();
}

/**
 * The user-message entry on `branch` to re-edit from so that only the first
 * `keep` user messages (and what followed them) remain: pi moves the leaf to
 * its parent. `undefined` when the branch has no more than `keep`.
 */
export function truncationTarget<T extends EntryLike>(branch: readonly T[], keep: number): T | undefined {
	const users = branch.filter(
		(entry) => entry.type === "message" && (entry.message as { role?: string } | undefined)?.role === "user",
	);
	return users[keep];
}

/**
 * How many of `turns` opened with a user message pi recorded: all but the
 * turns pi started without one ("Continued in pi") and the turns whose
 * prompt never reached pi (`unrecorded`, for example an unknown model).
 * AHP turns and pi's user messages are in the same order, so this is the
 * `keep` for `truncationTarget`.
 */
export function recordedUserTurns(turns: readonly Turn[], unrecorded: ReadonlySet<string>): number {
	return turns.filter((turn) => turn.message.origin.kind === MessageKind.User && !unrecorded.has(turn.id)).length;
}
