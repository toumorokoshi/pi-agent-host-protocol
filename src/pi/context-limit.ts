import type { ConfigPropertySchema, ModelSelection } from "@microsoft/agent-host-protocol";
import type { UserCommand } from "./customizations.ts";

/**
 * Pure helpers for a session's context limit: the `contextSize` choice in VS Code's model picker
 * and `/context` typed in a client. pi (Bolt) keeps the limit and compacts against it; the host
 * only passes it on. See specs/context-limit.md.
 */

/** VS Code's model-config key for the context window, in tokens (its "tokens" picker group). */
export const CONTEXT_SIZE_KEY = "contextSize";

/** Windows offered below a model's own, when smaller than it. */
const CONTEXT_SIZE_CHOICES = [200_000, 300_000, 500_000] as const;

/** The command name, as typed after `/`. */
export const CONTEXT_COMMAND = "context";

export const CONTEXT_DESCRIPTION =
	"Show context usage, or set this session's context limit (e.g. 300k; default clears it)";

/**
 * VS Code's session `_meta` key for the context gauge (`readCopilotContextUsage`). When a session
 * has it, the gauge shows these tokens against this limit instead of working out a window from
 * the picker's model, which knows nothing of a `/context` limit and adds the model's output
 * allowance to a smaller Context Size (300K on a model with 1M of output read as 1M).
 */
export const CONTEXT_USAGE_META = "copilot.usageInfo";

/** The `copilot.usageInfo` value for `tokens` of context in a `window`, or undefined if either is unknown. */
export function contextUsageMeta(
	tokens: number | undefined,
	window: number | undefined,
): Record<string, number> | undefined {
	if (tokens === undefined || !Number.isFinite(tokens) || !window || window <= 0) return undefined;
	return { currentTokens: Math.max(0, Math.round(tokens)), tokenLimit: Math.round(window), messagesLength: 0 };
}

/** The window pi works with: the model's, lowered to the session's limit. */
export function effectiveWindow(modelWindow: number | undefined, limit: number | null | undefined): number | undefined {
	if (!limit) return modelWindow;
	return modelWindow ? Math.min(modelWindow, limit) : limit;
}

/** pi's custom session entry recording a context limit (Bolt's `pi.context-limit`). */
const CONTEXT_LIMIT_ENTRY = "pi.context-limit";

interface RecordedEntry {
	readonly type: string;
	readonly customType?: string;
	readonly data?: unknown;
	readonly provider?: string;
	readonly modelId?: string;
}

/** The latest context limit on a session branch (null: cleared), or undefined when none was set. */
export function restoredContextLimit(entries: readonly RecordedEntry[]): number | null | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.type !== "custom" || entry.customType !== CONTEXT_LIMIT_ENTRY) continue;
		const limit = (entry.data as { limit?: unknown } | undefined)?.limit;
		return typeof limit === "number" && limit > 0 ? limit : null;
	}
	return undefined;
}

/** The model (`provider/id`) a session branch last switched to, if any. */
export function restoredModel(entries: readonly RecordedEntry[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.type === "model_change" && entry.provider && entry.modelId) return `${entry.provider}/${entry.modelId}`;
	}
	return undefined;
}

/** A token count as `300K` or `1M`. */
export function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000 && tokens % 100_000 === 0) return `${tokens / 1_000_000}M`;
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
	return String(tokens);
}

/**
 * The `contextSize` property of a model's config schema: the windows from 200K, 300K and 500K
 * below the model's own, then the model's own, defaulting to it. Undefined when the model's window
 * is unknown or no smaller choice exists.
 */
export function contextSizeProperty(contextWindow: number | undefined): ConfigPropertySchema | undefined {
	if (!contextWindow || contextWindow <= 0) return undefined;
	const smaller = CONTEXT_SIZE_CHOICES.filter((size) => size < contextWindow);
	if (smaller.length === 0) return undefined;
	const sizes = [...smaller, contextWindow];
	return {
		type: "number",
		title: "Context Size",
		description: "The context window this session works with. Smaller compacts sooner and costs less per call.",
		default: contextWindow,
		enum: sizes,
		enumLabels: sizes.map(formatTokens),
		enumDescriptions: sizes.map((size) => (size === contextWindow ? "The model's full window" : "Compacts sooner")),
	};
}

/**
 * The context limit a message's model selection asks for: a number below the model's window, or
 * null for the model's own window (or no choice). Values not offered are ignored as null.
 */
export function contextLimitOf(
	selection: ModelSelection | undefined,
	contextWindow: number | undefined,
): number | null {
	const value = Number(selection?.config?.[CONTEXT_SIZE_KEY]);
	if (!Number.isFinite(value) || value <= 0) return null;
	if (contextWindow && value >= contextWindow) return null;
	return Math.round(value);
}

/**
 * The limit to set for a message's picker value, or undefined to leave pi's limit alone: the
 * first message applies a smaller pick (a full-window pick leaves a limit restored from the
 * session or set with `/context`), later ones apply only a change.
 */
export function pickerChange(previous: number | null | undefined, picked: number | null): number | null | undefined {
	if (previous === undefined) return picked === null ? undefined : picked;
	return picked === previous ? undefined : picked;
}

/** What `/context` asks for: show (no argument), set a limit, clear it, or an argument that isn't one. */
export type ContextCommand =
	| { kind: "show" }
	| { kind: "set"; limit: number | null }
	| { kind: "invalid"; argument: string };

/**
 * The `/context` command in a message, or undefined when the message isn't one. Arguments:
 * `300k`, `1m`, `1.5m`, `200000`, or `default` / `max` / `off` to clear the limit.
 */
export function contextCommand(text: string): ContextCommand | undefined {
	const match = /^\/context(?:\s+([\s\S]*))?$/.exec(text.trim());
	if (!match) return undefined;
	const argument = (match[1] ?? "").trim();
	if (!argument) return { kind: "show" };
	const value = argument.toLowerCase().replaceAll(",", "").replaceAll("_", "");
	if (["default", "max", "off", "none"].includes(value)) return { kind: "set", limit: null };
	const parsed = /^(\d+(?:\.\d+)?)\s*([km]?)$/.exec(value);
	const scale = parsed?.[2] === "m" ? 1_000_000 : parsed?.[2] === "k" ? 1_000 : 1;
	const tokens = parsed ? Math.round(Number(parsed[1]) * scale) : Number.NaN;
	return Number.isSafeInteger(tokens) && tokens >= 1_000
		? { kind: "set", limit: tokens }
		: { kind: "invalid", argument };
}

/** What pi reports about a session's context limit and usage, as far as `/context` shows it. */
export interface ContextReport {
	readonly limit: number | null;
	readonly contextWindow: number | null;
	readonly modelWindow?: number;
	readonly tokens?: number | null;
}

/** True for the error pi answers an RPC command it doesn't have with (a pi without `set_context_limit`). */
export function isUnknownCommandError(error: unknown): boolean {
	return error instanceof Error && /unknown command/i.test(error.message);
}

/** The text a `/context` turn ends with. */
export function contextText(report: ContextReport): string {
	const window = report.contextWindow;
	const used =
		report.tokens === undefined || report.tokens === null || !window
			? "unknown until the next response"
			: `${formatTokens(report.tokens)} of ${formatTokens(window)} (${Math.round((report.tokens / window) * 100)}%)`;
	const source =
		report.limit !== null && report.modelWindow && report.limit < report.modelWindow
			? `limit ${formatTokens(report.limit)} (model ${formatTokens(report.modelWindow)})`
			: report.limit !== null
				? `limit ${formatTokens(report.limit)}`
				: "the model's full window, no limit set";
	return `Context: ${used}; ${source}.`;
}

/** The usage hint for an argument `/context` can't read. */
export function contextUsageText(argument: string): string {
	return `\`${argument}\` isn't a context size. Use \`/context 300k\`, \`/context 1m\`, or \`/context default\` to clear the limit.`;
}

/** The reply in a session a pi terminal drives, where only the terminal can change the limit. */
export const CONTEXT_IN_TERMINAL =
	"This session is open in a pi terminal. Type `/context` there: the host can't change a terminal session's context limit.";

/** The reply when the session's pi has no context limit (an older Bolt, or stock pi). */
export const CONTEXT_UNSUPPORTED =
	"This session's pi can't set a context limit (it needs Bolt with `set_context_limit`). The model's full window applies.";

/** `commands` with the host's `/context`, unless pi already lists a command of that name. */
export function withContextCommand(commands: readonly UserCommand[]): readonly UserCommand[] {
	if (commands.some((command) => command.name === CONTEXT_COMMAND)) return commands;
	return [...commands, { name: CONTEXT_COMMAND, description: CONTEXT_DESCRIPTION, kind: "extension" }];
}
