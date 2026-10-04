import type { JsonAgentSessionEvent, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { Logger } from "../core/logger.ts";
import type { PiAgent, PiEvent, PromptInput } from "./agent.ts";
import { RESUME_COMMAND } from "./extensions/ahp-resume.ts";
import type { ThinkingLevel } from "./models.ts";
import type { RpcChannel, RpcCommand, RpcRecord } from "./rpc-channel.ts";

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

export interface RpcState {
	model?: { provider: string; id: string };
	thinkingLevel?: string;
	isStreaming?: boolean;
}

/** Reads pi's state over `channel` and returns an agent for it. Closes the channel on failure. */
export async function connectRpcAgent(channel: RpcChannel, logger: Logger): Promise<RpcAgent> {
	try {
		const [state, commands] = await Promise.all([
			channel.request<RpcState>({ type: "get_state" }),
			channel.request<{ commands: Array<{ name: string }> }>({ type: "get_commands" }),
		]);
		const canResume = commands.commands.some((command) => command.name === RESUME_COMMAND);
		return new RpcAgent(channel, state, canResume, logger);
	} catch (error) {
		await channel.close();
		throw error;
	}
}

interface SettleWaiter {
	resolve: () => void;
	reject: (error: Error) => void;
}

/**
 * A `PiAgent` over pi's RPC protocol: a `pi --mode rpc` child, or a live TUI
 * session through the bridge extension.
 */
export class RpcAgent implements PiAgent {
	readonly #child: RpcChannel;
	readonly #canResume: boolean;
	readonly #logger: Logger;
	readonly #listeners = new Set<(event: PiEvent) => void>();
	readonly #settleWaiters = new Set<SettleWaiter>();
	#model: { provider: string; id: string } | undefined;
	#thinkingLevel: string | undefined;

	constructor(child: RpcChannel, state: RpcState, canResume: boolean, logger: Logger) {
		this.#child = child;
		this.#canResume = canResume;
		this.#logger = logger;
		this.#model = state.model && { provider: state.model.provider, id: state.model.id };
		this.#thinkingLevel = state.thinkingLevel;
		child.onRecord((record) => this.#onRecord(record));
		child.onClose((error) => {
			for (const waiter of this.#settleWaiters) waiter.reject(error);
			this.#settleWaiters.clear();
		});
	}

	get model(): { provider: string; id: string } | undefined {
		return this.#model;
	}

	get thinkingLevel(): string | undefined {
		return this.#thinkingLevel;
	}

	get closed(): boolean {
		return this.#child.closed;
	}

	subscribe(listener: (event: PiEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async prompt({ text, images }: PromptInput): Promise<void> {
		await this.#runUntilSettled({ type: "prompt", message: text, images }, false);
	}

	async resume(): Promise<void> {
		if (!this.#canResume) throw new Error("pi did not load the pi-agent-host-protocol resume extension");
		// The command itself is "handled"; the run it triggers starts right after.
		await this.#runUntilSettled({ type: "prompt", message: `/${RESUME_COMMAND}` }, true);
	}

	async steer({ text, images }: PromptInput): Promise<void> {
		await this.#child.request({ type: "steer", message: text, images });
	}

	async abort(): Promise<void> {
		if (!this.#child.closed) await this.#child.request({ type: "abort" });
	}

	async setModel(provider: string, id: string): Promise<void> {
		if (this.#model?.provider === provider && this.#model.id === id) return;
		const model = await this.#child.request<{ provider: string; id: string }>({
			type: "set_model",
			provider,
			modelId: id,
		});
		this.#model = { provider: model.provider, id: model.id };
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		if (this.#thinkingLevel === level) return;
		await this.#child.request({ type: "set_thinking_level", level });
		this.#thinkingLevel = level;
	}

	async setSessionName(name: string): Promise<void> {
		await this.#child.request({ type: "set_session_name", name });
	}

	async commands(): Promise<readonly SlashCommandInfo[]> {
		const result = await this.#child.request<{ commands: SlashCommandInfo[] }>({ type: "get_commands" });
		return result.commands;
	}

	dispose(): Promise<void> {
		return this.#child.close();
	}

	/**
	 * Sends a command that may start a run and waits for `agent_settled`. The
	 * waiter is registered first so a fast run cannot settle unseen.
	 * `alwaysRuns` covers extension commands, which report `handled` but start
	 * a run of their own.
	 */
	async #runUntilSettled(command: RpcCommand, alwaysRuns: boolean): Promise<void> {
		let waiter: SettleWaiter | undefined;
		const settled = new Promise<void>((resolve, reject) => {
			waiter = { resolve, reject };
			this.#settleWaiters.add(waiter);
		});
		settled.catch(() => {});
		try {
			const result = await this.#child.request<{ disposition?: string } | undefined>(command);
			if (result?.disposition === "handled" && !alwaysRuns) return;
			await settled;
		} finally {
			this.#settleWaiters.delete(waiter!);
		}
	}

	#onRecord(record: RpcRecord): void {
		if (record.type === "extension_ui_request") {
			this.#onExtensionUi(record);
			return;
		}
		const event = record as unknown as JsonAgentSessionEvent;
		for (const listener of [...this.#listeners]) listener(event);
		if (record.type === "agent_settled") {
			for (const waiter of this.#settleWaiters) waiter.resolve();
			this.#settleWaiters.clear();
		}
	}

	/** There is no UI on the host side: dialogs are dismissed so they resolve with their defaults. */
	#onExtensionUi(record: RpcRecord): void {
		if (typeof record.method !== "string" || !DIALOG_METHODS.has(record.method)) return;
		this.#logger.debug("extension dialog dismissed", { method: record.method });
		this.#child.send({ type: "extension_ui_response", id: record.id, cancelled: true });
	}
}
