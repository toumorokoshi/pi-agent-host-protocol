import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ImageInput } from "../pi/agent.ts";
import { RESUME_COMMAND, resumeRun } from "../pi/extensions/ahp-resume.ts";
import type { RpcRecord } from "../pi/rpc-channel.ts";

/** The parts of pi's extension API that host commands use. */
export type BridgeApi = Pick<
	ExtensionAPI,
	| "sendUserMessage"
	| "sendMessage"
	| "setModel"
	| "getThinkingLevel"
	| "setThinkingLevel"
	| "setSessionName"
	| "getCommands"
>;
export type BridgeContext = Pick<ExtensionContext, "isIdle" | "abort" | "model" | "modelRegistry" | "sessionManager">;

function content(command: RpcRecord): string | Array<{ type: "text"; text: string } | ImageInput> {
	const text = String(command.message ?? "");
	const images = Array.isArray(command.images) ? (command.images as ImageInput[]) : [];
	return images.length > 0 ? [{ type: "text", text }, ...images] : text;
}

/**
 * Runs one host command against the live pi session and returns the response
 * data, mirroring what `pi --mode rpc` answers for the same command. Throws
 * to answer with an error.
 */
export async function executeHostCommand(command: RpcRecord, pi: BridgeApi, ctx: BridgeContext): Promise<unknown> {
	switch (command.type) {
		case "get_state":
			return {
				model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
				thinkingLevel: pi.getThinkingLevel(),
				isStreaming: !ctx.isIdle(),
			};
		case "get_commands":
			return { commands: pi.getCommands().map((info) => ({ name: info.name })) };
		case "get_branch":
			return { entries: ctx.sessionManager.getBranch() };
		case "prompt": {
			// Extension commands cannot be invoked by name; the host only sends this one.
			if (command.message === `/${RESUME_COMMAND}`) {
				resumeRun(pi);
				return { disposition: "handled" };
			}
			const idle = ctx.isIdle();
			pi.sendUserMessage(content(command), {
				expandPromptTemplates: true,
				...(idle ? {} : { deliverAs: "followUp" as const }),
			});
			return { disposition: idle ? "started" : "queued" };
		}
		case "steer":
			pi.sendUserMessage(content(command), { expandPromptTemplates: true, deliverAs: "steer" });
			return { disposition: "queued" };
		case "abort":
			ctx.abort();
			return undefined;
		case "set_model": {
			const model = ctx.modelRegistry.find(String(command.provider), String(command.modelId));
			if (!model) throw new Error(`Model not found: ${command.provider}/${command.modelId}`);
			if (!(await pi.setModel(model))) throw new Error(`No credentials for ${model.provider}/${model.id}`);
			return { provider: model.provider, id: model.id };
		}
		case "set_thinking_level":
			pi.setThinkingLevel(command.level as Parameters<BridgeApi["setThinkingLevel"]>[0]);
			return undefined;
		case "set_session_name":
			pi.setSessionName(String(command.name));
			return undefined;
		default:
			throw new Error(`Unknown command: ${command.type}`);
	}
}
