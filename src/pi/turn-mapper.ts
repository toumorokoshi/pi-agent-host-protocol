import {
	ActionType,
	type ChatAction,
	ResponsePartKind,
	type ToolCallCompletedState,
	ToolCallConfirmationReason,
} from "@microsoft/agent-host-protocol";
import type { PiEvent } from "./agent.ts";
import { ACTIVITY_COMPACTING } from "./compaction.ts";
import { completedToolCallActions } from "./tool-call-actions.ts";
import { firstText, toolActivity, toolInputText, toolLabels, toolResultContent } from "./tool-display.ts";
import { addCall, afterCompaction, type PiUsage, type TurnUsage, usageInfo } from "./usage.ts";

/**
 * How a run ended. A `resumable` error came from the model provider (the run
 * stopped on an assistant message with `stopReason: "error"`) and can be
 * continued with `chat/turnResume`; other errors (e.g. an unknown model) are
 * final.
 */
export type TurnOutcome =
	| { kind: "complete" }
	| { kind: "cancelled" }
	| { kind: "error"; message: string; resumable?: boolean };

/**
 * Completed tool calls the host adds to a turn after the tool call with this
 * id completes (undefined for none): a row per subagent a `subagent` call
 * started.
 */
export type ExtraToolCalls = (toolCallId: string) => readonly ToolCallCompletedState[] | undefined;

/** Activity text while the model produces output that is not a tool call. */
export const ACTIVITY_THINKING = "Thinking";
export const ACTIVITY_RESPONDING = "Responding";

interface AssistantLike {
	role: "assistant";
	stopReason?: string;
	errorMessage?: string;
	model?: string;
	usage?: PiUsage;
	content?: Array<{ type: string; id?: string; name?: string }>;
}

function asAssistant(message: unknown): AssistantLike | undefined {
	return (message as { role?: string } | undefined)?.role === "assistant" ? (message as AssistantLike) : undefined;
}

/**
 * The tool call a `toolcall_start` opens. The RPC wire form carries `id` and
 * `toolName`; the SDK form carries the cumulative `partial` message instead.
 */
export function startedToolCall(event: {
	contentIndex: number;
	id?: string;
	toolName?: string;
	partial?: { content: ReadonlyArray<{ type: string; id?: string; name?: string }> };
}): { id: string; name: string } | undefined {
	if (event.id && event.toolName) return { id: event.id, name: event.toolName };
	const block = event.partial?.content[event.contentIndex];
	return block?.type === "toolCall" && block.id && block.name ? { id: block.id, name: block.name } : undefined;
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
	#usage: TurnUsage | undefined;
	#lastError: string | undefined;
	#aborted = false;
	#notices = 0;
	#activity: string | undefined;
	/** Activity text of tool calls that have not completed yet, in start order. */
	readonly #runningTools = new Map<string, string>();

	readonly #attempt: number;
	readonly #extraCalls: ExtraToolCalls | undefined;

	/**
	 * @param attempt Distinguishes the runs of one turn (0 for the first, then
	 *   one per `chat/turnResume`) so their response part ids never collide.
	 * @param extraCalls Tool calls the host adds after a tool call completes,
	 *   such as a row per subagent a `subagent` call started.
	 */
	constructor(turnId: string, emit: (action: ChatAction) => void, attempt = 0, extraCalls?: ExtraToolCalls) {
		this.#attempt = attempt;
		this.turnId = turnId;
		this.#emit = emit;
		this.#extraCalls = extraCalls;
	}

	get aborted(): boolean {
		return this.#aborted;
	}

	handle(event: PiEvent): void {
		switch (event.type) {
			case "message_start":
				if (asAssistant(event.message)) {
					this.#messageIndex++;
					this.#setActivity(ACTIVITY_THINKING);
				}
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
			case "compaction_start":
				this.#setActivity(ACTIVITY_COMPACTING);
				break;
			case "compaction_end": {
				// A `/compact` turn reports its result itself (`PiSession.#compact`) and the turn ends
				// with it, which clears the text. An automatic compaction ends, and pi carries on with
				// the run, unless it was aborted and the turn is about to end.
				if (event.reason === "manual") break;
				if (!event.aborted) this.#setActivity(ACTIVITY_THINKING);
				const after = event.result?.estimatedTokensAfter;
				if (after !== undefined) this.compacted(after);
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
				for (const call of this.#extraCalls?.(event.toolCallId) ?? []) {
					for (const action of completedToolCallActions(this.turnId, call)) this.#emit(action);
				}
				this.#runningTools.delete(event.toolCallId);
				// Another tool may still be running; otherwise the model is called again with the results.
				this.#setActivity([...this.#runningTools.values()].at(-1) ?? ACTIVITY_THINKING);
				break;
			}
			default:
				break;
		}
	}

	/** Records that pi compacted the context to about `tokens`, and reports it, so the context gauge drops. */
	compacted(tokens: number): void {
		this.#usage = afterCompaction(this.#usage, tokens);
		this.#emitUsage();
	}

	#emitUsage(): void {
		if (this.#usage) this.#emit({ type: ActionType.ChatUsage, turnId: this.turnId, usage: usageInfo(this.#usage) });
	}

	/** Emits the actions that end the turn. */
	finish(outcome: TurnOutcome, durationMs: number): void {
		this.#setActivity(undefined);
		this.#emitUsage();
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
					part: {
						kind: ResponsePartKind.Error,
						error: { errorType: "agentError", message: outcome.message },
						...(outcome.resumable ? { resumable: true } : {}),
					},
				});
				break;
		}
	}

	/**
	 * Adds a markdown part outside pi's messages, such as an extension's
	 * notification. VS Code joins adjacent markdown parts without a separator,
	 * so the notice is padded to stay its own paragraph.
	 */
	notice(markdown: string): void {
		this.#notices++;
		const attempt = this.#attempt === 0 ? "" : `r${this.#attempt}.`;
		this.#ensurePart(
			ResponsePartKind.Markdown,
			`${this.turnId}.${attempt}notice.${this.#notices}`,
			`\n\n${markdown}\n\n`,
		);
	}

	/** The outcome implied by the events seen so far, for a run that returned normally. */
	impliedOutcome(): TurnOutcome {
		if (this.#aborted) return { kind: "cancelled" };
		if (this.#lastError !== undefined) return { kind: "error", message: this.#lastError, resumable: true };
		return { kind: "complete" };
	}

	#partId(contentIndex: number): string {
		const attempt = this.#attempt === 0 ? "" : `r${this.#attempt}.`;
		return `${this.turnId}.${attempt}${this.#messageIndex}.${contentIndex}`;
	}

	#ensurePart(kind: ResponsePartKind.Markdown | ResponsePartKind.Reasoning, id: string, content = ""): boolean {
		if (this.#parts.has(id)) return false;
		this.#parts.add(id);
		this.#emit({ type: ActionType.ChatResponsePart, turnId: this.turnId, part: { kind, id, content } });
		return true;
	}

	#onAssistantEvent(event: Extract<PiEvent, { type: "message_update" }>["assistantMessageEvent"]): void {
		switch (event.type) {
			case "text_start":
				this.#ensurePart(ResponsePartKind.Markdown, this.#partId(event.contentIndex));
				this.#setActivity(ACTIVITY_RESPONDING);
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
				this.#setActivity(ACTIVITY_THINKING);
				break;
			case "thinking_delta": {
				const id = this.#partId(event.contentIndex);
				if (!this.#ensurePart(ResponsePartKind.Reasoning, id, event.delta)) {
					this.#emit({ type: ActionType.ChatReasoning, turnId: this.turnId, partId: id, content: event.delta });
				}
				break;
			}
			case "toolcall_start": {
				const tool = startedToolCall(event);
				if (tool) {
					this.#streamingTools.set(`${this.#messageIndex}:${event.contentIndex}`, tool.id);
					this.#startTool(tool.id, tool.name);
					// Arguments are still streaming, so only the generic label is known.
					this.#trackTool(tool.id, toolActivity(tool.name, undefined));
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
		this.#usage = addCall(this.#usage, assistant.usage, assistant.model);
		// After every call, not only at the turn's end, so VS Code's context gauge follows a long run.
		this.#emitUsage();
		if (assistant.stopReason === "aborted") {
			this.#aborted = true;
		} else if (assistant.stopReason === "error") {
			this.#lastError = assistant.errorMessage ?? "The model returned an error";
		} else {
			// A later successful message (e.g. after an automatic retry) clears the error.
			this.#lastError = undefined;
		}
	}

	/** Emits `chat/activityChanged` when the description of the current step changes. */
	#setActivity(activity: string | undefined): void {
		if (activity === this.#activity) return;
		this.#activity = activity;
		this.#emit({ type: ActionType.ChatActivityChanged, activity });
	}

	#trackTool(toolCallId: string, activity: string): void {
		this.#runningTools.set(toolCallId, activity);
		this.#setActivity(activity);
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
		this.#trackTool(toolCallId, toolActivity(toolName, args as Record<string, unknown> | undefined));
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
