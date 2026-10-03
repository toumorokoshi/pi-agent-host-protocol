import {
	type AgentSession,
	createAgentSession,
	ModelRuntime,
	type SessionInfo,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

export interface PiServicesOptions {
	/** pi agent directory (defaults to pi's own, `~/.pi/agent`). */
	agentDir?: string;
	/** Session directory override; by default pi groups sessions per cwd under the agent dir. */
	sessionDir?: string;
	modelRuntime?: ModelRuntime;
	/** Extra options merged into every `createAgentSession` call (tests use this). */
	sessionOverrides?: Partial<Parameters<typeof createAgentSession>[0]>;
}

/** The pi SDK surface the host depends on. */
export class PiServices {
	readonly agentDir: string | undefined;
	readonly sessionDir: string | undefined;
	readonly modelRuntime: ModelRuntime;
	readonly #overrides: PiServicesOptions["sessionOverrides"];

	private constructor(options: PiServicesOptions, modelRuntime: ModelRuntime) {
		this.agentDir = options.agentDir;
		this.sessionDir = options.sessionDir;
		this.modelRuntime = modelRuntime;
		this.#overrides = options.sessionOverrides;
	}

	static async create(options: PiServicesOptions = {}): Promise<PiServices> {
		const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create());
		return new PiServices(options, modelRuntime);
	}

	newSessionManager(cwd: string, id: string): SessionManager {
		return SessionManager.create(cwd, this.sessionDir, { id });
	}

	openSessionManager(path: string): SessionManager {
		return SessionManager.open(path, this.sessionDir);
	}

	async createAgentSession(cwd: string, sessionManager: SessionManager): Promise<AgentSession> {
		const { session } = await createAgentSession({
			cwd,
			sessionManager,
			modelRuntime: this.modelRuntime,
			...(this.agentDir ? { agentDir: this.agentDir } : {}),
			...this.#overrides,
		});
		// Fires `session_start` for extensions. There is no interactive UI on
		// this side; extension dialogs resolve with their defaults.
		await session.bindExtensions({ mode: "rpc" });
		return session;
	}

	async listSessions(): Promise<SessionInfo[]> {
		return this.sessionDir ? SessionManager.listAll(this.sessionDir) : SessionManager.listAll();
	}
}
