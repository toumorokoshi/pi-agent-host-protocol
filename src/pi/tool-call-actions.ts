import {
	ActionType,
	type ChatAction,
	type ToolCallCompletedState,
	ToolCallConfirmationReason,
	type ToolCallState,
	type ToolCallStatus,
} from "@microsoft/agent-host-protocol";

/** A tool call that has its arguments: anything but a streaming one. */
export type ReadyToolCall = Exclude<ToolCallState, { status: ToolCallStatus.Streaming }>;

/** The actions that open a tool call in a turn: `chat/toolCallStart`, then `chat/toolCallReady`. */
export function toolCallStartActions(turnId: string, call: ReadyToolCall): ChatAction[] {
	const { toolCallId, _meta } = call;
	return [
		{
			type: ActionType.ChatToolCallStart,
			turnId,
			toolCallId,
			toolName: call.toolName,
			displayName: call.displayName,
			...(_meta ? { _meta } : {}),
		},
		{
			type: ActionType.ChatToolCallReady,
			turnId,
			toolCallId,
			invocationMessage: call.invocationMessage,
			...(call.toolInput !== undefined ? { toolInput: call.toolInput } : {}),
			confirmed: "confirmed" in call ? call.confirmed : ToolCallConfirmationReason.NotNeeded,
			...(_meta ? { _meta } : {}),
		},
	];
}

/** The `chat/toolCallComplete` action for a completed tool call. */
export function toolCallCompleteAction(turnId: string, call: ToolCallCompletedState): ChatAction {
	const { toolCallId, _meta } = call;
	return {
		type: ActionType.ChatToolCallComplete,
		turnId,
		toolCallId,
		result: {
			success: call.success,
			pastTenseMessage: call.pastTenseMessage,
			...(call.content ? { content: call.content } : {}),
			...(call.error ? { error: call.error } : {}),
		},
		...(_meta ? { _meta } : {}),
	};
}

/** The actions that add an already completed tool call to a turn. */
export function completedToolCallActions(turnId: string, call: ToolCallCompletedState): ChatAction[] {
	return [...toolCallStartActions(turnId, call), toolCallCompleteAction(turnId, call)];
}
