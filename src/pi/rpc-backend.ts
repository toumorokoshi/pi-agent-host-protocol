import { existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type SessionInfo, SessionManager, type SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { cached } from "../core/cached.ts";
import { type Logger, silentLogger } from "../core/logger.ts";
import { GLOBAL_COMMANDS_TTL_MS, inEmptyDir, type PiAgent, type PiBackend } from "./agent.ts";
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
	/** Lists models through a short-lived child, cached briefly because clients ask on every `initialize`. */
	readonly models: () => Promise<readonly PiModel[]>;
	/** Lists commands through a short-lived child in an empty folder. */
	readonly globalCommands: () => Promise<readonly SlashCommandInfo[]>;

	constructor(options: RpcBackendOptions = {}) {
		this.#options = options;
		this.#logger = options.logger ?? silentLogger;
		this.models = cached(MODELS_TTL_MS, () => this.#fetchModels());
		this.globalCommands = cached(GLOBAL_COMMANDS_TTL_MS, () => inEmptyDir((cwd) => this.#fetchCommands(cwd)));
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

	async #fetchCommands(cwd: string): Promise<SlashCommandInfo[]> {
		const { channel: child } = this.#spawn(cwd, ["--no-session"], { purpose: "commands" });
		try {
			const { commands } = await child.request<{ commands: SlashCommandInfo[] }>({ type: "get_commands" });
			return commands;
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
