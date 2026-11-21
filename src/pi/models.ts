import type { ConfigPropertySchema, ModelSelection, SessionModelInfo } from "@microsoft/agent-host-protocol";
import { PROVIDER } from "../core/uris.ts";
import { CONTEXT_SIZE_KEY, contextSizeProperty } from "./context-limit.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** The fields of a pi model the host uses. SDK models and RPC model objects both fit. */
export interface PiModel {
	provider: string;
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: readonly string[];
	contextWindow?: number;
	maxTokens?: number;
}

/** AHP model ids are `<pi provider>/<pi model id>`. */
export function modelSelectionId(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

export function toSessionModelInfo(model: PiModel): SessionModelInfo {
	const supportsImages = model.input?.includes("image") ?? false;
	const properties: Record<string, ConfigPropertySchema> = {
		...(model.reasoning
			? {
					thinkingLevel: {
						type: "string",
						title: "Thinking",
						enum: [...THINKING_LEVELS],
						default: "medium",
					},
				}
			: {}),
	};
	const contextSize = contextSizeProperty(model.contextWindow);
	if (contextSize) properties[CONTEXT_SIZE_KEY] = contextSize;
	return {
		id: modelSelectionId(model),
		provider: PROVIDER,
		name: model.name || model.id,
		maxContextWindow: model.contextWindow,
		maxOutputTokens: model.maxTokens,
		supportsVision: supportsImages,
		...(Object.keys(properties).length > 0 ? { configSchema: { type: "object", properties } } : {}),
	};
}

/** Splits an AHP model id into pi's provider and model id, or `undefined` if malformed. */
export function parseModelSelection(selection: ModelSelection): { provider: string; id: string } | undefined {
	const slash = selection.id.indexOf("/");
	if (slash <= 0 || slash === selection.id.length - 1) return undefined;
	return { provider: selection.id.slice(0, slash), id: selection.id.slice(slash + 1) };
}

export function thinkingLevelOf(selection: ModelSelection | undefined): ThinkingLevel | undefined {
	const value = selection?.config?.thinkingLevel;
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)
		? (value as ThinkingLevel)
		: undefined;
}
