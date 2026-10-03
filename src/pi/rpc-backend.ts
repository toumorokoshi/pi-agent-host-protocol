import { existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type JsonAgentSessionEvent, type SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";
import { type Logger, silentLogger } from "../core/logger.ts";
import type { PiAgent, PiBackend, PiEvent, PromptInput } from "./agent.ts";
import { RESUME_COMMAND } from "./extensions/ahp-resume.ts";
import type { PiModel, ThinkingLevel } from "./models.ts";
import { RpcProcess, type RpcRecord } from "./rpc-process.ts";

/** The pi extension every RPC child loads, so `chat/turnResume` works (see `extensions/ahp-resume.ts`). */
export const RESUME_EXTENSION = (() => {
	const here = fileURLToPath(import.meta.url);
	return join(dirname(here), "extensions", `ahp-resume${extname(here)}`);
})();

const MODELS_TTL_MS = 30_000;
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

export interface RpcBackendOptions {
	/** The `pi` executable or CLI script (default: `pi` on `PATH`). */
	pi?: string;
	/** pi agent directory, passed to children as `PI_CODING_AGENT_DIR`. */
	agentDir?: string;
	/** Session directory override, passed to children as `--session-dir`. */
	sessionDir?: string;
	/** Extra arguments for every child (tests load a faux provider this way). */
	args?: readonly string[];
	/** Extra environment for every child. */
	env?: Record<string, string>;
	/** Working directory of the short-lived process that lists models. */
	cwd?: string;
	logger?: Logger;
}

interface RpcState {
	model?: { provider: string; id: string };
	thinkingLevel?: string;
}

/** Runs each session's agent in its own `pi --mode rpc` child process. */
export class RpcBackend implements PiBackend {
	readonly mode = "rpc";
	readonly #options: RpcBackendOptions;
	readonly #logger: Logger;
	readonly #agents = new Set<RpcAgent>();
	#models: { at: number; models: Promise<readonly PiModel[]> } | undefined;

	constructor(options: RpcBackendOptions = {}) {
		this.#options = options;
		this.#logger = options.logger ?? silentLogger;
	}

	/** Lists models through a short-lived child, cached briefly because clients ask on every `initialize`. */
	models(): Promise<readonly PiModel[]> {
		const now = Date.now();
		if (!this.#models || now - this.#models.at > MODELS_TTL_MS) {
			const models = this.#fetchModels();
			this.#models = { at: now, models };
			models.catch(() => {
				if (this.#models?.models === models) this.#models = undefined;
			});
		}
		return this.#models.models;
	}

	listSessions(): Promise<SessionInfo[]> {
		const { sessionDir } = this.#options;
		return sessionDir ? SessionManager.listAll(sessionDir) : SessionManager.listAll();
	}

	newSessionManager(cwd: string, id: string): SessionManager {
		return SessionManager.create(cwd, this.#options.sessionDir, { id });
	}

	openSessionManager(path: string): SessionManager {
		return SessionManager.open(path, this.#options.sessionDir);
	}

	async startAgent(cwd: string, sessionManager: SessionManager): Promise<PiAgent> {
		const file = sessionManager.getSessionFile();
		const session = file && existsSync(file) ? ["--session", file] : ["--session-id", sessionManager.getSessionId()];
		const child = this.#spawn(cwd, [...session, "-e", RESUME_EXTENSION], { session: sessionManager.getSessionId() });
		try {
			const [state, commands] = await Promise.all([
				child.request<RpcState>({ type: "get_state" }),
				child.request<{ commands: Array<{ name: string }> }>({ type: "get_commands" }),
			]);
			const canResume = commands.commands.some((command) => command.name === RESUME_COMMAND);
			const agent = new RpcAgent(child, state, canResume, this.#logger);
			this.#agents.add(agent);
			child.onExit(() => this.#agents.delete(agent));
			return agent;
		} catch (error) {
			await child.stop();
			throw error;
		}
	}

	async dispose(): Promise<void> {
		await Promise.all([...this.#agents].map((agent) => agent.dispose()));
	}

	async #fetchModels(): Promise<PiModel[]> {
		const child = this.#spawn(this.#options.cwd ?? process.cwd(), ["--no-session"], { purpose: "models" });
		try {
			const { models } = await child.request<{ models: PiModel[] }>({ type: "get_available_models" });
			return models;
		} finally {
			await child.stop();
		}
	}

	#spawn(cwd: string, args: string[], logFields: Record<string, unknown>): RpcProcess {
		const { pi = "pi", agentDir, sessionDir, env } = this.#options;
		return new RpcProcess({
			command: pi,
			args: [...(sessionDir ? ["--session-dir", sessionDir] : []), ...args, ...(this.#options.args ?? [])],
			cwd,
			env: { ...(agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {}), ...env },
			logger: this.#logger,
			logFields,
		});
	}
}

interface SettleWaiter {
	resolve: () => void;
	reject: (error: Error) => void;
}

/** A `PiAgent` that drives a `pi --mode rpc` child. */
class RpcAgent implements PiAgent {
	readonly #child: RpcProcess;
	readonly #canResume: boolean;
	readonly #logger: Logger;
	readonly #listeners = new Set<(event: PiEvent) => void>();
	readonly #settleWaiters = new Set<SettleWaiter>();
	#model: { provider: string; id: string } | undefined;
	#thinkingLevel: string | undefined;

	constructor(child: RpcProcess, state: RpcState, canResume: boolean, logger: Logger) {
		this.#child = child;
		this.#canResume = canResume;
		this.#logger = logger;
		this.#model = state.model && { provider: state.model.provider, id: state.model.id };
		this.#thinkingLevel = state.thinkingLevel;
		child.onRecord((record) => this.#onRecord(record));
		child.onExit((error) => {
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
		return this.#child.exited;
	}

	subscribe(listener: (event: PiEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async prompt({ text, images }: PromptInput): Promise<void> {
		await this.#runUntilSettled({ type: "prompt", message: text, images }, false);
	}

	async resume(): Promise<void> {
		if (!this.#canResume) throw new Error("pi did not load the pi-agent-host resume extension");
		// The command itself is "handled"; the run it triggers starts right after.
		await this.#runUntilSettled({ type: "prompt", message: `/${RESUME_COMMAND}` }, true);
	}

	async steer({ text, images }: PromptInput): Promise<void> {
		await this.#child.request({ type: "steer", message: text, images });
	}

	async abort(): Promise<void> {
		if (!this.#child.exited) await this.#child.request({ type: "abort" });
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

	dispose(): Promise<void> {
		return this.#child.stop();
	}

	/**
	 * Sends a command that may start a run and waits for `agent_settled`. The
	 * waiter is registered first so a fast run cannot settle unseen.
	 * `alwaysRuns` covers extension commands, which report `handled` but start
	 * a run of their own.
	 */
	async #runUntilSettled(command: { type: string; [key: string]: unknown }, alwaysRuns: boolean): Promise<void> {
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
