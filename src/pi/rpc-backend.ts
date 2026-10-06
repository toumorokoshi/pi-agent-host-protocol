import { existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";
import { type Logger, silentLogger } from "../core/logger.ts";
import type { PiAgent, PiBackend } from "./agent.ts";
import type { PiModel } from "./models.ts";
import { childrenOf, newChildren, type ProcessTable, readProcessTable } from "./processes.ts";
import { connectRpcAgent, type RpcAgent } from "./rpc-agent.ts";
import { type RpcProcess, spawnRpcProcess } from "./rpc-process.ts";

/** The pi extension every RPC child loads, so `chat/turnResume` works (see `extensions/ahp-resume.ts`). */
export const RESUME_EXTENSION = (() => {
	const here = fileURLToPath(import.meta.url);
	return join(dirname(here), "extensions", `ahp-resume${extname(here)}`);
})();

const MODELS_TTL_MS = 30_000;

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
	/** Reads the process table, for finding work pi started in the background (tests replace it). */
	processTable?: () => Promise<ProcessTable>;
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
		const { pid, channel } = this.#spawn(cwd, [...session, "-e", RESUME_EXTENSION], {
			session: sessionManager.getSessionId(),
		});
		// The baseline is taken once pi has answered its first commands, so the
		// helpers it starts at startup are in it.
		const background = Promise.withResolvers<() => Promise<number[]>>();
		const agent = await connectRpcAgent(channel, this.#logger, {
			backgroundProcesses: async () => (await background.promise)(),
		});
		background.resolve(pid === undefined ? async () => [] : await this.#backgroundProcesses(pid));
		this.#agents.add(agent);
		channel.onClose(() => this.#agents.delete(agent));
		return agent;
	}

	/**
	 * Returns a check for processes pi started after it became ready. Children
	 * that exist once pi answers its first commands (MCP servers and other
	 * extension helpers started with pi) are the baseline and don't count.
	 * If the process table cannot be read, pi always counts as busy.
	 */
	async #backgroundProcesses(pid: number): Promise<() => Promise<number[]>> {
		const read = this.#options.processTable ?? readProcessTable;
		try {
			const baseline = childrenOf(await read(), pid);
			return async () => newChildren(await read(), pid, baseline);
		} catch (error) {
			this.#logger.debug("could not read the process table", {
				pid,
				error: error instanceof Error ? error.message : String(error),
			});
			return async () => [pid];
		}
	}

	async dispose(): Promise<void> {
		await Promise.all([...this.#agents].map((agent) => agent.dispose()));
	}

	async #fetchModels(): Promise<PiModel[]> {
		const { channel: child } = this.#spawn(this.#options.cwd ?? process.cwd(), ["--no-session"], { purpose: "models" });
		try {
			const { models } = await child.request<{ models: PiModel[] }>({ type: "get_available_models" });
			return models;
		} finally {
			await child.close();
		}
	}

	#spawn(cwd: string, args: string[], logFields: Record<string, unknown>): RpcProcess {
		const { pi = "pi", agentDir, sessionDir, env } = this.#options;
		return spawnRpcProcess({
			command: pi,
			args: [...(sessionDir ? ["--session-dir", sessionDir] : []), ...args, ...(this.#options.args ?? [])],
			cwd,
			env: { ...(agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {}), ...env },
			logger: this.#logger,
			logFields,
		});
	}
}
