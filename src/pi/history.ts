import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	MessageKind,
	type ResponsePart,
	ResponsePartKind,
	ToolCallCancellationReason,
	ToolCallConfirmationReason,
	type ToolCallState,
	ToolCallStatus,
	type Turn,
	TurnState,
	type UsageInfo,
} from "@microsoft/agent-host-protocol";
import { firstText, toolInputText, toolLabels, toolResultContent } from "./tool-display.ts";

interface ContentBlock {
	type: string;
	text?: string;
	thinking?: string;
	id?: string;
	name?: string;
	arguments?: unknown;
}

interface PiMessage {
	role: string;
	content?: string | ContentBlock[];
	stopReason?: string;
	errorMessage?: string;
	model?: string;
	usage?: { input?: number; output?: number; cacheRead?: number };
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
}

/** Plain text of a pi user message. */
export function userMessageText(content: PiMessage["content"]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

interface TurnBuilder {
	turn: Turn;
	endedAt: number;
	usage: { input: number; output: number; cacheRead: number; model?: string; seen: boolean };
	/** Index into `responseParts` of each tool call awaiting its result. */
	pendingTools: Map<string, number>;
	errorMessage?: string;
}

/**
 * Reconstructs AHP turns from the active branch of a pi session. Each user
 * message starts a turn; assistant messages and tool results that follow it
 * become that turn's response parts.
 */
export function turnsFromEntries(entries: readonly SessionEntry[]): Turn[] {
	const turns: Turn[] = [];
	let current: TurnBuilder | undefined;

	const close = () => {
		if (!current) return;
		const { turn } = current;
		for (const index of current.pendingTools.values()) {
			const part = turn.responseParts[index];
			if (part?.kind === ResponsePartKind.ToolCall) {
				part.toolCall = cancelled(part.toolCall);
			}
		}
		if (current.usage.seen) {
			turn.usage = usageInfo(current.usage);
		}
		if (current.errorMessage !== undefined && turn.state === TurnState.Error) {
			turn.responseParts.push({
				kind: ResponsePartKind.Error,
				error: { errorType: "agentError", message: current.errorMessage },
			});
		}
		const started = turn.startedAt ? Date.parse(turn.startedAt) : Number.NaN;
		if (Number.isFinite(started)) turn.duration = Math.max(0, current.endedAt - started);
		turns.push(turn);
		current = undefined;
	};

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message as unknown as PiMessage;
		const at = Date.parse(entry.timestamp);
		if (message.role === "user") {
			close();
			current = {
				turn: {
					id: entry.id,
					startedAt: entry.timestamp,
					message: { text: userMessageText(message.content), origin: { kind: MessageKind.User } },
					responseParts: [],
					usage: undefined,
					state: TurnState.Complete,
				},
				endedAt: at,
				usage: { input: 0, output: 0, cacheRead: 0, seen: false },
				pendingTools: new Map(),
			};
			continue;
		}
		if (!current) continue;
		if (Number.isFinite(at)) current.endedAt = at;
		if (message.role === "assistant") {
			appendAssistant(current, entry.id, message);
		} else if (message.role === "toolResult" && message.toolCallId) {
			const index = current.pendingTools.get(message.toolCallId);
			const part = index === undefined ? undefined : current.turn.responseParts[index];
			if (part?.kind === ResponsePartKind.ToolCall && index !== undefined) {
				part.toolCall = completed(part.toolCall, message);
				current.pendingTools.delete(message.toolCallId);
			}
		}
	}
	close();
	return turns;
}

function appendAssistant(builder: TurnBuilder, entryId: string, message: PiMessage): void {
	const parts = builder.turn.responseParts;
	const blocks = Array.isArray(message.content) ? message.content : [];
	blocks.forEach((block, index) => {
		const id = `${entryId}.${index}`;
		if (block.type === "text" && block.text) {
			parts.push({ kind: ResponsePartKind.Markdown, id, content: block.text });
		} else if (block.type === "thinking" && block.thinking) {
			parts.push({ kind: ResponsePartKind.Reasoning, id, content: block.thinking });
		} else if (block.type === "toolCall" && block.id && block.name) {
			const labels = toolLabels(block.name, block.arguments as Record<string, unknown> | undefined);
			const toolCall: ToolCallState = {
				status: ToolCallStatus.Running,
				toolCallId: block.id,
				toolName: block.name,
				displayName: labels.displayName,
				invocationMessage: labels.invocation,
				toolInput: toolInputText(block.arguments),
				confirmed: ToolCallConfirmationReason.NotNeeded,
			};
			builder.pendingTools.set(block.id, parts.length);
			parts.push({ kind: ResponsePartKind.ToolCall, toolCall } satisfies ResponsePart);
		}
	});
	if (message.usage) {
		builder.usage.seen = true;
		builder.usage.input += message.usage.input ?? 0;
		builder.usage.output += message.usage.output ?? 0;
		builder.usage.cacheRead += message.usage.cacheRead ?? 0;
	}
	if (message.model) builder.usage.model = message.model;
	if (message.stopReason === "aborted") {
		builder.turn.state = TurnState.Cancelled;
	} else if (message.stopReason === "error") {
		builder.turn.state = TurnState.Error;
		builder.errorMessage = message.errorMessage ?? "The model returned an error";
	} else {
		builder.turn.state = TurnState.Complete;
		builder.errorMessage = undefined;
	}
}

function completed(toolCall: ToolCallState, message: PiMessage): ToolCallState {
	if (toolCall.status !== ToolCallStatus.Running) return toolCall;
	const content = toolResultContent(message);
	const labels = toolLabels(toolCall.toolName, parseArgs(toolCall.toolInput));
	return {
		...toolCall,
		status: ToolCallStatus.Completed,
		success: !message.isError,
		pastTenseMessage: labels.pastTense,
		content,
		...(message.isError ? { error: { message: firstText(content) ?? "Tool failed" } } : {}),
	};
}

function cancelled(toolCall: ToolCallState): ToolCallState {
	if (toolCall.status !== ToolCallStatus.Running) return toolCall;
	return {
		status: ToolCallStatus.Cancelled,
		toolCallId: toolCall.toolCallId,
		toolName: toolCall.toolName,
		displayName: toolCall.displayName,
		invocationMessage: toolCall.invocationMessage,
		toolInput: toolCall.toolInput,
		reason: ToolCallCancellationReason.Skipped,
	};
}

function parseArgs(input: unknown): Record<string, unknown> | undefined {
	if (typeof input !== "string") return undefined;
	try {
		const value = JSON.parse(input);
		return typeof value === "object" && value !== null ? value : undefined;
	} catch {
		return undefined;
	}
}

function usageInfo(usage: TurnBuilder["usage"]): UsageInfo {
	return {
		inputTokens: usage.input,
		outputTokens: usage.output,
		...(usage.cacheRead ? { cacheReadTokens: usage.cacheRead } : {}),
		...(usage.model ? { model: usage.model } : {}),
	};
}
