import type { ChatState, Turn } from "@microsoft/agent-host-protocol";

export const DEFAULT_TURNS_PAGE_SIZE = 50;

const CURSOR_PREFIX = "turns:";

/** Encodes the number of remaining older turns as an opaque `turnsNextCursor`. */
export function turnsCursor(remainingCount: number): string | undefined {
	return remainingCount > 0 ? `${CURSOR_PREFIX}${remainingCount}` : undefined;
}

/** Parses an opaque `turnsNextCursor` into the remaining older turn count, or `undefined` if invalid. */
export function parseTurnsCursor(cursor: string): number | undefined {
	if (!cursor.startsWith(CURSOR_PREFIX)) return undefined;
	const raw = cursor.slice(CURSOR_PREFIX.length);
	if (!/^\d+$/.test(raw)) return undefined;
	const count = Number(raw);
	return Number.isSafeInteger(count) && count > 0 ? count : undefined;
}

/** Splits `turns` (oldest-first) into an unloaded older prefix and the visible tail. */
export function splitTailTurns(
	turns: readonly Turn[],
	tailCount: number | undefined,
): { older: Turn[]; visible: Turn[]; nextCursor: string | undefined } {
	if (tailCount === undefined || tailCount >= turns.length) {
		return { older: [], visible: [...turns], nextCursor: undefined };
	}
	const keep = Math.max(0, tailCount);
	const splitAt = turns.length - keep;
	return {
		older: turns.slice(0, splitAt),
		visible: turns.slice(splitAt),
		nextCursor: turnsCursor(splitAt),
	};
}

/** Takes the newest page (up to `pageSize` turns) from `older` (oldest-first). */
export function takeTurnsPage(
	older: readonly Turn[],
	pageSize = DEFAULT_TURNS_PAGE_SIZE,
): { page: Turn[]; remaining: Turn[]; nextCursor: string | undefined } {
	if (older.length <= pageSize) {
		return { page: [...older], remaining: [], nextCursor: undefined };
	}
	const splitAt = older.length - pageSize;
	return {
		page: older.slice(splitAt),
		remaining: older.slice(0, splitAt),
		nextCursor: turnsCursor(splitAt),
	};
}

/**
 * Returns a copy of `state` whose `turns` window is trimmed to at most
 * `tailCount` most-recent turns, updating `turnsNextCursor` accordingly.
 * `olderRemaining` is the number of turns not yet in `state.turns`.
 */
export function trimChatSnapshot(state: ChatState, tailCount: number, olderRemaining = 0): ChatState {
	const keep = Math.max(0, tailCount);
	if (keep >= state.turns.length) return state;
	const dropped = state.turns.length - keep;
	const nextCursor = turnsCursor(olderRemaining + dropped);
	const trimmed: ChatState = {
		...state,
		turns: keep === 0 ? [] : state.turns.slice(-keep),
	};
	if (nextCursor !== undefined) trimmed.turnsNextCursor = nextCursor;
	else delete trimmed.turnsNextCursor;
	return trimmed;
}
