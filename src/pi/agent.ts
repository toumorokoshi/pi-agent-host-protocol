import type {
	AgentSessionEvent,
	JsonAgentSessionEvent,
	SessionInfo,
	SessionManager,
	SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import type { PiModel, ThinkingLevel } from "./models.ts";

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
	/** Continues after a run that ended in a model-provider error, without a new user message. */
	resume(): Promise<void>;
	steer(input: PromptInput): Promise<void>;
	abort(): Promise<void>;
	/** Selects a model by provider and id. Rejects if pi does not know it. */
	setModel(provider: string, id: string): Promise<void>;
	setThinkingLevel(level: ThinkingLevel): Promise<void>;
	setSessionName(name: string): Promise<void>;
	/** pi's slash commands: extension commands, prompt templates and skills (`skill:<name>`). */
	commands(): Promise<readonly SlashCommandInfo[]>;
	/**
	 * Set only on agents the host may stop when idle (its own `pi --mode rpc`
	 * children). Resolves with the pids of processes pi started after it
	 * became ready, such as background jobs or subagents; while there are
	 * any, the agent is kept.
	 */
	readonly backgroundProcesses?: () => Promise<number[]>;
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
	/** Starts an agent on a session created or opened by this backend. */
	startAgent(cwd: string, sessionManager: SessionManager): Promise<PiAgent>;
	dispose(): Promise<void>;
}
