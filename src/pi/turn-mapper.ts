import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
	ActionType,
	type ChatAction,
	ResponsePartKind,
	ToolCallConfirmationReason,
	type UsageInfo,
} from "@microsoft/agent-host-protocol";
import { firstText, toolInputText, toolLabels, toolResultContent } from "./tool-display.ts";

export type TurnOutcome = { kind: "complete" } | { kind: "cancelled" } | { kind: "error"; message: string };

interface AssistantLike {
	role: "assistant";
	stopReason?: string;
	errorMessage?: string;
	model?: string;
	usage?: { input?: number; output?: number; cacheRead?: number };
	content?: Array<{ type: string; id?: string; name?: string }>;
}

function asAssistant(message: unknown): AssistantLike | undefined {
	return (message as { role?: string } | undefined)?.role === "assistant" ? (message as AssistantLike) : undefined;
}

/**
 * Translates the pi event stream of one agent run into the AHP chat actions of
 * one turn. Stateless with respect to the protocol: it only emits actions; the
 * caller owns dispatch and turn lifecycle.
 */
export class TurnMapper {
	readonly turnId: string;
	readonly #emit: (action: ChatAction) => void;
	#messageIndex = -1;
	/** Response part ids created so far (markdown and reasoning). */
	readonly #parts = new Set<string>();
	/** Tool call ids by `${messageIndex}:${contentIndex}` while arguments stream. */
	readonly #streamingTools = new Map<string, string>();
	readonly #startedTools = new Set<string>();
	readonly #readyTools = new Set<string>();
	readonly #toolArgs = new Map<string, Record<string, unknown> | undefined>();
	readonly #usage = { input: 0, output: 0, cacheRead: 0, seen: false, model: undefined as string | undefined };
	#lastError: string | undefined;
	#aborted = false;

	constructor(turnId: string, emit: (action: ChatAction) => void) {
		this.turnId = turnId;
		this.#emit = emit;
	}

	get aborted(): boolean {
		return this.#aborted;
	}

	handle(event: AgentSessionEvent): void {
		switch (event.type) {
			case "message_start":
				if (asAssistant(event.message)) this.#messageIndex++;
				break;
			case "message_update":
				this.#onAssistantEvent(event.assistantMessageEvent);
				break;
			case "message_end":
				this.#onMessageEnd(event.message);
				break;
			case "tool_execution_start":
				this.#startTool(event.toolCallId, event.toolName);
				this.#readyTool(event.toolCallId, event.toolName, event.args);
				break;
			case "tool_execution_update": {
				const content = toolResultContent(event.partialResult);
				if (content.length > 0 && this.#readyTools.has(event.toolCallId)) {
					this.#emit({
						type: ActionType.ChatToolCallContentChanged,
						turnId: this.turnId,
						toolCallId: event.toolCallId,
						content,
					});
				}
				break;
			}
			case "tool_execution_end": {
				this.#startTool(event.toolCallId, event.toolName);
				this.#readyTool(event.toolCallId, event.toolName, undefined);
				const content = toolResultContent(event.result);
				const labels = toolLabels(event.toolName, this.#toolArgs.get(event.toolCallId));
				this.#emit({
					type: ActionType.ChatToolCallComplete,
					turnId: this.turnId,
					toolCallId: event.toolCallId,
					result: {
						success: !event.isError,
						pastTenseMessage: labels.pastTense,
						content,
						...(event.isError ? { error: { message: firstText(content) ?? "Tool failed" } } : {}),
					},
				});
				break;
			}
			default:
				break;
		}
	}

	/** Emits the actions that end the turn. */
	finish(outcome: TurnOutcome, durationMs: number): void {
		if (this.#usage.seen) {
			const usage: UsageInfo = {
				inputTokens: this.#usage.input,
				outputTokens: this.#usage.output,
				...(this.#usage.cacheRead ? { cacheReadTokens: this.#usage.cacheRead } : {}),
				...(this.#usage.model ? { model: this.#usage.model } : {}),
			};
			this.#emit({ type: ActionType.ChatUsage, turnId: this.turnId, usage });
		}
		const duration = Math.max(0, Math.round(durationMs));
		switch (outcome.kind) {
			case "complete":
				this.#emit({ type: ActionType.ChatTurnComplete, turnId: this.turnId, duration });
				break;
			case "cancelled":
				this.#emit({ type: ActionType.ChatTurnCancelled, turnId: this.turnId, duration });
				break;
			case "error":
				this.#emit({
					type: ActionType.ChatError,
					turnId: this.turnId,
					duration,
					part: { kind: ResponsePartKind.Error, error: { errorType: "agentError", message: outcome.message } },
				});
				break;
		}
	}

	/** The outcome implied by the events seen so far, for a run that returned normally. */
	impliedOutcome(): TurnOutcome {
		if (this.#aborted) return { kind: "cancelled" };
		if (this.#lastError !== undefined) return { kind: "error", message: this.#lastError };
		return { kind: "complete" };
	}

	#partId(contentIndex: number): string {
		return `${this.turnId}.${this.#messageIndex}.${contentIndex}`;
	}

	#ensurePart(kind: ResponsePartKind.Markdown | ResponsePartKind.Reasoning, id: string, content = ""): boolean {
		if (this.#parts.has(id)) return false;
		this.#parts.add(id);
		this.#emit({ type: ActionType.ChatResponsePart, turnId: this.turnId, part: { kind, id, content } });
		return true;
	}

	#onAssistantEvent(event: Extract<AgentSessionEvent, { type: "message_update" }>["assistantMessageEvent"]): void {
		switch (event.type) {
			case "text_start":
				this.#ensurePart(ResponsePartKind.Markdown, this.#partId(event.contentIndex));
				break;
			case "text_delta": {
				const id = this.#partId(event.contentIndex);
				if (!this.#ensurePart(ResponsePartKind.Markdown, id, event.delta)) {
					this.#emit({ type: ActionType.ChatDelta, turnId: this.turnId, partId: id, content: event.delta });
				}
				break;
			}
			case "thinking_start":
				this.#ensurePart(ResponsePartKind.Reasoning, this.#partId(event.contentIndex));
				break;
			case "thinking_delta": {
				const id = this.#partId(event.contentIndex);
				if (!this.#ensurePart(ResponsePartKind.Reasoning, id, event.delta)) {
					this.#emit({ type: ActionType.ChatReasoning, turnId: this.turnId, partId: id, content: event.delta });
				}
				break;
			}
			case "toolcall_start": {
				const block = event.partial.content[event.contentIndex];
				if (block?.type === "toolCall" && block.id) {
					this.#streamingTools.set(`${this.#messageIndex}:${event.contentIndex}`, block.id);
					this.#startTool(block.id, block.name);
				}
				break;
			}
			case "toolcall_delta": {
				const id = this.#streamingTools.get(`${this.#messageIndex}:${event.contentIndex}`);
				if (id && !this.#readyTools.has(id)) {
					this.#emit({ type: ActionType.ChatToolCallDelta, turnId: this.turnId, toolCallId: id, content: event.delta });
				}
				break;
			}
			case "toolcall_end":
				this.#startTool(event.toolCall.id, event.toolCall.name);
				this.#readyTool(event.toolCall.id, event.toolCall.name, event.toolCall.arguments);
				break;
			default:
				break;
		}
	}

	#onMessageEnd(message: unknown): void {
		const assistant = asAssistant(message);
		if (!assistant) return;
		if (assistant.usage) {
			this.#usage.seen = true;
			this.#usage.input += assistant.usage.input ?? 0;
			this.#usage.output += assistant.usage.output ?? 0;
			this.#usage.cacheRead += assistant.usage.cacheRead ?? 0;
		}
		if (assistant.model) this.#usage.model = assistant.model;
		if (assistant.stopReason === "aborted") {
			this.#aborted = true;
		} else if (assistant.stopReason === "error") {
			this.#lastError = assistant.errorMessage ?? "The model returned an error";
		} else {
			// A later successful message (e.g. after an automatic retry) clears the error.
			this.#lastError = undefined;
		}
	}

	#startTool(toolCallId: string, toolName: string): void {
		if (this.#startedTools.has(toolCallId)) return;
		this.#startedTools.add(toolCallId);
		this.#emit({
			type: ActionType.ChatToolCallStart,
			turnId: this.turnId,
			toolCallId,
			toolName,
			displayName: toolLabels(toolName, undefined).displayName,
		});
	}

	#readyTool(toolCallId: string, toolName: string, args: unknown): void {
		if (this.#readyTools.has(toolCallId)) return;
		this.#readyTools.add(toolCallId);
		this.#toolArgs.set(toolCallId, args as Record<string, unknown> | undefined);
		const labels = toolLabels(toolName, args as Record<string, unknown> | undefined);
		this.#emit({
			type: ActionType.ChatToolCallReady,
			turnId: this.turnId,
			toolCallId,
			invocationMessage: labels.invocation,
			...(args !== undefined ? { toolInput: toolInputText(args) } : {}),
			confirmed: ToolCallConfirmationReason.NotNeeded,
		});
	}
}
