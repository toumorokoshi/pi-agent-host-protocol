import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelSelection, SessionModelInfo } from "@microsoft/agent-host-protocol";
import { PROVIDER } from "../core/uris.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

type PiModel = Awaited<ReturnType<ModelRuntime["getAvailable"]>>[number];

/** AHP model ids are `<pi provider>/<pi model id>`. */
export function modelSelectionId(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

export function toSessionModelInfo(model: PiModel): SessionModelInfo {
	const supportsImages = (model as { input?: readonly string[] }).input?.includes("image") ?? false;
	return {
		id: modelSelectionId(model),
		provider: PROVIDER,
		name: model.name || model.id,
		maxContextWindow: model.contextWindow,
		maxOutputTokens: model.maxTokens,
		supportsVision: supportsImages,
		...(model.reasoning
			? {
					configSchema: {
						type: "object",
						properties: {
							thinkingLevel: {
								type: "string",
								title: "Thinking",
								enum: [...THINKING_LEVELS],
								default: "medium",
							},
						},
					},
				}
			: {}),
	};
}

export async function availableModels(runtime: ModelRuntime): Promise<SessionModelInfo[]> {
	const models = await runtime.getAvailable();
	return models.map(toSessionModelInfo);
}

/** Resolves an AHP model selection to a pi model, or `undefined` if unknown. */
export function resolveModel(runtime: ModelRuntime, selection: ModelSelection): PiModel | undefined {
	const slash = selection.id.indexOf("/");
	if (slash <= 0) return undefined;
	return runtime.getModel(selection.id.slice(0, slash), selection.id.slice(slash + 1));
}

export function thinkingLevelOf(selection: ModelSelection | undefined): ThinkingLevel | undefined {
	const value = selection?.config?.thinkingLevel;
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)
		? (value as ThinkingLevel)
		: undefined;
}
