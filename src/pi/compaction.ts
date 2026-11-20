import type { CompactionResult } from "@earendil-works/pi-coding-agent";
import type { UserCommand } from "./customizations.ts";

/**
 * Pure helpers for `/compact` typed in a client (pi handles it only in its
 * own terminal UI) and for showing pi's automatic compaction. See
 * specs/compaction.md.
 */

/** The command name, as typed after `/`. */
export const COMPACT_COMMAND = "compact";

/** The completion item's description, as pi's terminal shows it. */
export const COMPACT_DESCRIPTION = "Manually compact the session context";

/** Activity text while pi compacts on its own. */
export const ACTIVITY_COMPACTING = "Compacting context";

/** What pi's `compact` returns (`CompactionResult`), as far as the host reads it. */
export type CompactResult = Partial<Pick<CompactionResult, "tokensBefore" | "estimatedTokensAfter">>;

/**
 * The instructions of a `/compact` message, or undefined when the message is
 * not one: `/compact` alone (empty instructions) or `/compact <instructions>`.
 * Anything else, such as `/compactor`, is an ordinary message.
 */
export function compactInstructions(text: string): string | undefined {
	const match = /^\/compact(?:\s+([\s\S]*))?$/.exec(text.trim());
	return match ? (match[1] ?? "").trim() : undefined;
}

/** The text a finished `/compact` turn shows: done, with the token estimate before and after when pi gave them. */
export function compactDoneText(result: CompactResult | undefined): string {
	const before = result?.tokensBefore;
	const after = result?.estimatedTokensAfter;
	if (before !== undefined && after !== undefined) {
		return `Compacted the session context: about ${formatTokens(before)} tokens before, ${formatTokens(after)} after.`;
	}
	if (before !== undefined) return `Compacted the session context (about ${formatTokens(before)} tokens before).`;
	return "Compacted the session context.";
}

/** `commands` with the host's `/compact`, unless pi already lists a command of that name. */
export function withCompactCommand(commands: readonly UserCommand[]): readonly UserCommand[] {
	if (commands.some((command) => command.name === COMPACT_COMMAND)) return commands;
	return [...commands, { name: COMPACT_COMMAND, description: COMPACT_DESCRIPTION, kind: "extension" }];
}

/** The reply to `/compact` in a session a pi terminal drives, where only the terminal can compact. */
export const COMPACT_IN_TERMINAL =
	"This session is open in a pi terminal. Type `/compact` there: the host can't compact a session a terminal drives.";

function formatTokens(tokens: number): string {
	if (tokens >= 10_000) return `${Math.round(tokens / 1000)}k`;
	if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
	return String(Math.round(tokens));
}
