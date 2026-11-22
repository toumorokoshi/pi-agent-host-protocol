import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentSessionEvent,
	JsonAgentSessionEvent,
	SessionInfo,
	SessionManager,
	SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import type { PiUiHandler } from "./dialogs.ts";
import type { PiModel, ThinkingLevel } from "./models.ts";
import type { BackgroundProcess } from "./processes.ts";

/**
 * How the host runs pi:
 * - `rpc` (default): one `pi --mode rpc` child process per session.
 * - `embedded`: pi's SDK inside the host process.
 */
export const PI_MODES = ["rpc", "embedded"] as const;
export type PiMode = (typeof PI_MODES)[number];

export function parsePiMode(value: string): PiMode {
	const mode = value.toLowerCase();
	if ((PI_MODES as readonly string[]).includes(mode)) return mode as PiMode;
	throw new Error(`Invalid pi mode: ${value} (expected one of ${PI_MODES.join(", ")})`);
}

/**
 * A pi session event: the SDK's form (embedded) or the RPC wire form, which
 * drops the cumulative `partial` snapshots from `message_update`.
 */
export type PiEvent = AgentSessionEvent | JsonAgentSessionEvent;

export interface ImageInput {
	type: "image";
	data: string;
	mimeType: string;
}

export interface PromptInput {
	text: string;
	images: ImageInput[];
}

/** Messages waiting in pi's queues, as the text pi was given. */
export interface PiQueue {
	steering: readonly string[];
	followUp: readonly string[];
}

/**
 * One running pi agent bound to one session file. `PiSession` only talks to
 * this interface, so both backends share all protocol logic above it.
 */
export interface PiAgent {
	/** The selected model, as `{ provider, id }`. */
	readonly model: { provider: string; id: string } | undefined;
	readonly thinkingLevel: string | undefined;
	/** True once the agent can no longer run (its pi process exited); the session starts a new one. */
	readonly closed: boolean;
	/** Delivers pi's session events. */
	subscribe(listener: (event: PiEvent) => void): () => void;
	/** Sends a user prompt. Resolves once the run has settled; rejects if pi refuses it. */
	prompt(input: PromptInput): Promise<void>;
	/**
	 * Continues after a run that ended in a model-provider error, without a new
	 * user message, and drops the failed reply from the model's context.
	 */
	resume(): Promise<void>;
	/**
	 * Starts a run without a new user message so pi delivers the steering
	 * messages it still holds (pi checks its steering queue at the start of
	 * every run). Resolves once the run has settled. Call only while pi's
	 * queue holds steering messages, and not after a resumable provider error,
	 * which `resume()` owns: unlike it, this leaves the context as it is.
	 */
	runQueued(): Promise<void>;
	/**
	 * Moves the session back so only its first `keep` user messages, and what
	 * followed them, remain in context; later ones stay in the file on an
	 * abandoned branch. Call only while no run is in flight. Rejects if pi
	 * did not move.
	 */
	truncate(keep: number): Promise<void>;
	steer(input: PromptInput): Promise<void>;
	/**
	 * Empties pi's steering and follow-up queues and resolves with the
	 * messages it removed. pi's `abort` leaves them queued, to be delivered
	 * in the next run. Unset on agents that cannot (a pi terminal through
	 * the bridge, whose extension API has no such call).
	 */
	readonly clearQueue?: () => Promise<PiQueue>;
	abort(): Promise<void>;
	/** Selects a model by provider and id. Rejects if pi does not know it. */
	setModel(provider: string, id: string): Promise<void>;
	setThinkingLevel(level: ThinkingLevel): Promise<void>;
	setSessionName(name: string): Promise<void>;
	/** pi's slash commands: extension commands, prompt templates and skills (`skill:<name>`). */
	commands(): Promise<readonly SlashCommandInfo[]>;
	/**
	 * Routes the dialogs and notifications pi's extensions open to `handler`.
	 * Without one, dialogs are cancelled and notifications dropped. Only
	 * agents over pi's RPC protocol support it.
	 */
	setUiHandler?(handler: PiUiHandler | undefined): void;
	/**
	 * Set only on agents the host may stop when idle (its own `pi --mode rpc`
	 * children). Resolves with the processes pi started after it became
	 * ready, such as background jobs or subagents; while there are any, the
	 * agent is kept, and they are published as the chat's background work.
	 * Rejects when the process table cannot be read.
	 */
	readonly backgroundProcesses?: () => Promise<BackgroundProcess[]>;
	dispose(): Promise<void>;
}

/** Creates agents and reads pi's session store for one host. */
export interface PiBackend {
	readonly mode: PiMode;
	/** Models pi can use right now. */
	models(): Promise<readonly PiModel[]>;
	/** Sessions in pi's session store, read from disk (no agent is started). */
	listSessions(): Promise<SessionInfo[]>;
	/** A not-yet-persisted session with the given id. */
	newSessionManager(cwd: string, id: string): SessionManager;
	/** A saved session file, for reading its history. */
	openSessionManager(path: string): SessionManager;
	/** Moves a session manager to a new working directory, relocating its file if needed. */
	moveSessionManager(manager: SessionManager, newCwd: string): Promise<SessionManager>;
	/** Starts an agent on a session created or opened by this backend. */
	startAgent(cwd: string, sessionManager: SessionManager): Promise<PiAgent>;
	/**
	 * pi's commands outside any project: what `PiAgent.commands()` lists for
	 * an agent started in an empty folder. No session is saved.
	 */
	globalCommands(): Promise<readonly SlashCommandInfo[]>;
	/**
	 * pi's commands in `cwd`: what `PiAgent.commands()` lists for an agent
	 * started there, project resources included, without starting a
	 * session's agent. No session is saved.
	 */
	folderCommands(cwd: string): Promise<readonly SlashCommandInfo[]>;
	dispose(): Promise<void>;
}

/**
 * How long backends reuse `globalCommands()` and `folderCommands()`: the
 * host asks on every `initialize` and for every session it loads.
 */
export const COMMANDS_TTL_MS = 30_000;

/** Runs `run` in a new empty temporary folder, removed afterwards. */
export async function inEmptyDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "pi-agent-host-protocol-empty-"));
	try {
		return await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
