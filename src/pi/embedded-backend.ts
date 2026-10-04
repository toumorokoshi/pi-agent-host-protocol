import {
	type AgentSession,
	createAgentSession,
	ModelRuntime,
	type SessionEntry,
	type SessionInfo,
	SessionManager,
	type SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import type { PiAgent, PiBackend, PiEvent, PromptInput } from "./agent.ts";
import type { PiModel, ThinkingLevel } from "./models.ts";

export interface EmbeddedBackendOptions {
	/** pi agent directory (defaults to pi's own, `~/.pi/agent`). */
	agentDir?: string;
	/** Session directory override; by default pi groups sessions per cwd under the agent dir. */
	sessionDir?: string;
	modelRuntime?: ModelRuntime;
	/** Extra options merged into every `createAgentSession` call (tests use this). */
	sessionOverrides?: Partial<Parameters<typeof createAgentSession>[0]>;
}

/** Runs pi's SDK inside the host process. */
export class EmbeddedBackend implements PiBackend {
	readonly mode = "embedded";
	readonly #options: EmbeddedBackendOptions;
	readonly #modelRuntime: ModelRuntime;

	private constructor(options: EmbeddedBackendOptions, modelRuntime: ModelRuntime) {
		this.#options = options;
		this.#modelRuntime = modelRuntime;
	}

	static async create(options: EmbeddedBackendOptions = {}): Promise<EmbeddedBackend> {
		return new EmbeddedBackend(options, options.modelRuntime ?? (await ModelRuntime.create()));
	}

	async models(): Promise<readonly PiModel[]> {
		return this.#modelRuntime.getAvailable();
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
		const { agentDir, sessionOverrides } = this.#options;
		const { session } = await createAgentSession({
			cwd,
			sessionManager,
			modelRuntime: this.#modelRuntime,
			...(agentDir ? { agentDir } : {}),
			...sessionOverrides,
		});
		// Fires `session_start` for extensions. There is no interactive UI on
		// this side; extension dialogs resolve with their defaults.
		await session.bindExtensions({ mode: "rpc" });
		return new EmbeddedAgent(session, this.#modelRuntime);
	}

	async dispose(): Promise<void> {}
}

/** A `PiAgent` backed by an in-process `AgentSession`. */
class EmbeddedAgent implements PiAgent {
	readonly #session: AgentSession;
	readonly #modelRuntime: ModelRuntime;

	constructor(session: AgentSession, modelRuntime: ModelRuntime) {
		this.#session = session;
		this.#modelRuntime = modelRuntime;
	}

	get model(): { provider: string; id: string } | undefined {
		return this.#session.model;
	}

	get thinkingLevel(): string | undefined {
		return this.#session.thinkingLevel;
	}

	get closed(): boolean {
		return false;
	}

	subscribe(listener: (event: PiEvent) => void): () => void {
		return this.#session.subscribe(listener);
	}

	async prompt({ text, images }: PromptInput): Promise<void> {
		await this.#session.prompt(text, { images, source: "rpc" });
	}

	resume(): Promise<void> {
		return continueAfterError(this.#session);
	}

	async steer({ text, images }: PromptInput): Promise<void> {
		await this.#session.steer(text, images, { source: "rpc" });
	}

	abort(): Promise<void> {
		return this.#session.abort();
	}

	async setModel(provider: string, id: string): Promise<void> {
		if (this.model?.provider === provider && this.model.id === id) return;
		const model = this.#modelRuntime.getModel(provider, id);
		if (!model) throw new Error(`Unknown model: ${provider}/${id}`);
		await this.#session.setModel(model);
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		if (this.#session.thinkingLevel !== level) this.#session.setThinkingLevel(level);
	}

	async setSessionName(name: string): Promise<void> {
		this.#session.sessionManager.appendSessionInfo(name);
	}

	/** The same list pi's RPC `get_commands` returns. */
	async commands(): Promise<readonly SlashCommandInfo[]> {
		const session = this.#session;
		return [
			...session.extensionRunner.getRegisteredCommands().map(
				(command): SlashCommandInfo => ({
					name: command.invocationName,
					description: command.description,
					source: "extension",
					sourceInfo: command.sourceInfo,
				}),
			),
			...session.promptTemplates.map(
				(template): SlashCommandInfo => ({
					name: template.name,
					description: template.description,
					source: "prompt",
					sourceInfo: template.sourceInfo,
				}),
			),
			...session.resourceLoader.getSkills().skills.map(
				(skill): SlashCommandInfo => ({
					name: `skill:${skill.name}`,
					description: skill.description,
					source: "skill",
					sourceInfo: skill.sourceInfo,
				}),
			),
		];
	}

	async dispose(): Promise<void> {
		await this.#session.abort();
		this.#session.dispose();
	}
}

/**
 * Continues pi's run after a provider error without a new user message, the
 * way pi's own auto-retry does: the failed assistant reply is omitted from the
 * model context (a `context_edit` entry; the raw transcript keeps it), then the
 * agent loop continues from the preceding user message or tool results.
 */
export async function continueAfterError(agent: AgentSession): Promise<void> {
	const failed = lastErroredAssistantEntry(agent.sessionManager.getBranch());
	if (failed) {
		agent.sessionManager.appendContextEdit(failed, null);
		agent.refreshContext();
	}
	await agent.agent.continue();
}

/** Id of the newest assistant entry if the branch ends in a provider error. */
export function lastErroredAssistantEntry(entries: readonly SessionEntry[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; stopReason?: string };
		if (message.role !== "assistant") return undefined;
		return message.stopReason === "error" ? entry.id : undefined;
	}
	return undefined;
}
