import { stat } from "node:fs/promises";
import { basename } from "node:path";
import pty, { type IPty } from "@lydell/node-pty";
import {
	ActionType,
	AhpErrorCodes,
	type StateAction,
	type TerminalClaim,
	type TerminalContentPart,
	type TerminalInfo,
	TerminalLifecycleStatus,
	type TerminalState,
} from "@microsoft/agent-host-protocol";
import type { Logger } from "../core/logger.ts";
import type { StateStore } from "../core/state-store.ts";
import { fileUri, pathFromFileUri, ROOT_CHANNEL } from "../core/uris.ts";
import { ProtocolError } from "../protocol/jsonrpc.ts";

/** Retained scrollback per terminal in host state (new subscribers' snapshots). */
export const MAX_SCROLLBACK_CHARS = 256 * 1024;
/** Output is coalesced for this long before being dispatched as one `terminal/data`. */
const DATA_FLUSH_MS = 5;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/** Client actions accepted on a terminal channel (all others are rejected). */
const CLIENT_ACTIONS = new Set<string>([
	ActionType.TerminalInput,
	ActionType.TerminalResized,
	ActionType.TerminalClaimed,
	ActionType.TerminalTitleChanged,
	ActionType.TerminalCleared,
]);

function partLength(part: TerminalContentPart): number {
	return part.type === "unclassified" ? part.value.length : part.output.length;
}

/** Keeps the last `max` characters of terminal output, trimming the oldest part. */
export function trimContent(content: TerminalContentPart[], max: number): TerminalContentPart[] {
	let total = 0;
	for (let i = content.length - 1; i >= 0; i--) {
		const part = content[i]!;
		total += partLength(part);
		if (total > max) {
			const keep = partLength(part) - (total - max);
			const head =
				part.type === "unclassified"
					? { ...part, value: part.value.slice(part.value.length - keep) }
					: { ...part, output: part.output.slice(part.output.length - keep) };
			return [head, ...content.slice(i + 1)];
		}
	}
	return content;
}

export function terminalInfo(resource: string, state: TerminalState): TerminalInfo {
	return { resource, title: state.title, claim: state.claim, lifecycle: state.lifecycle };
}

/** The user's interactive shell. */
export function defaultShell(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
	if (platform === "win32") return env.COMSPEC ?? "powershell.exe";
	return env.SHELL || "/bin/sh";
}

/** Environment for terminal processes: the host's, minus host-internal markers. */
export function shellEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined && key !== "PI_AGENT_HOST_DAEMON") out[key] = value;
	}
	out.TERM = "xterm-256color";
	return out;
}

interface CreateTerminalInput {
	claim: TerminalClaim;
	name?: string;
	cwd?: string;
	cols?: number;
	rows?: number;
}

interface LiveTerminal {
	process: IPty;
	pending: string;
	timer: NodeJS.Timeout | undefined;
}

/**
 * Pseudo-terminals for the terminal channel. Each terminal runs the user's
 * shell in a pty; output becomes `terminal/data`, and client `terminal/input`
 * and `terminal/resized` are forwarded to the pty.
 */
export class TerminalService {
	readonly #store: StateStore;
	readonly #logger: Logger;
	readonly #defaultDirectory: string;
	readonly #live = new Map<string, LiveTerminal>();
	/** Every terminal channel this service created, live or exited, in creation order. */
	readonly #uris: string[] = [];

	constructor(store: StateStore, logger: Logger, defaultDirectory: string) {
		this.#store = store;
		this.#logger = logger;
		this.#defaultDirectory = defaultDirectory;
	}

	has(uri: string): boolean {
		return this.#store.channel(uri)?.kind === "terminal";
	}

	async create(uri: string, input: CreateTerminalInput): Promise<void> {
		if (this.#store.channel(uri) || this.#store.snapshot(uri)) {
			throw new ProtocolError(AhpErrorCodes.AlreadyExists, `Channel already exists: ${uri}`);
		}
		const cwd = input.cwd ? pathFromFileUri(input.cwd) : this.#defaultDirectory;
		if (
			!cwd ||
			!(await stat(cwd).then(
				(info) => info.isDirectory(),
				() => false,
			))
		) {
			throw ProtocolError.invalidParams(`Terminal cwd is not a local directory: ${input.cwd}`);
		}
		const shell = defaultShell();
		const cols = input.cols ?? DEFAULT_COLS;
		const rows = input.rows ?? DEFAULT_ROWS;
		const child = pty.spawn(shell, [], { name: "xterm-256color", cols, rows, cwd, env: shellEnv() });
		this.#store.addChannel(uri, {
			kind: "terminal",
			state: {
				title: input.name || basename(shell),
				cwd: fileUri(cwd),
				cols,
				rows,
				content: [],
				lifecycle: { status: TerminalLifecycleStatus.Running },
				claim: input.claim,
				isPty: true,
			},
		});
		const live: LiveTerminal = { process: child, pending: "", timer: undefined };
		this.#live.set(uri, live);
		this.#uris.push(uri);
		child.onData((data) => this.#onData(uri, live, data));
		child.onExit(({ exitCode }) => this.#onExit(uri, live, exitCode));
		this.#logger.debug("terminal created", { terminal: uri, shell, cwd, pid: child.pid });
		this.#publishCatalog();
	}

	/** Returns a rejection reason for a client action, or `undefined` to accept it. */
	validate(uri: string, action: StateAction): string | undefined {
		if (!CLIENT_ACTIONS.has(action.type)) return `Unsupported action: ${action.type}`;
		if (action.type === ActionType.TerminalInput && !this.#live.has(uri)) return "Terminal has exited";
		return undefined;
	}

	/** Side effects of an accepted client action (already applied to state). */
	onAction(uri: string, action: StateAction): void {
		const live = this.#live.get(uri);
		switch (action.type) {
			case ActionType.TerminalInput:
				live?.process.write(action.data);
				break;
			case ActionType.TerminalResized:
				if (action.cols > 0 && action.rows > 0) live?.process.resize(action.cols, action.rows);
				break;
			case ActionType.TerminalTitleChanged:
			case ActionType.TerminalClaimed:
				this.#publishCatalog();
				break;
			default:
				break;
		}
	}

	dispose(uri: string): void {
		if (!this.has(uri)) throw ProtocolError.notFound(uri);
		this.#kill(uri);
		this.#store.removeChannel(uri);
		this.#uris.splice(this.#uris.indexOf(uri), 1);
		this.#logger.debug("terminal disposed", { terminal: uri });
		this.#publishCatalog();
	}

	disposeAll(): void {
		for (const uri of [...this.#live.keys()]) this.#kill(uri);
	}

	#kill(uri: string): void {
		const live = this.#live.get(uri);
		if (!live) return;
		this.#live.delete(uri);
		clearTimeout(live.timer);
		try {
			live.process.kill();
		} catch {
			// Already gone.
		}
	}

	#onData(uri: string, live: LiveTerminal, data: string): void {
		live.pending += data;
		live.timer ??= setTimeout(() => this.#flush(uri, live), DATA_FLUSH_MS);
	}

	#flush(uri: string, live: LiveTerminal): void {
		live.timer = undefined;
		if (!live.pending) return;
		const data = live.pending;
		live.pending = "";
		this.#store.dispatch(uri, { type: ActionType.TerminalData, data });
		const channel = this.#store.channel(uri);
		if (channel?.kind === "terminal") {
			const content = trimContent(channel.state.content, MAX_SCROLLBACK_CHARS);
			if (content !== channel.state.content) this.#store.replaceTerminalState(uri, { ...channel.state, content });
		}
	}

	#onExit(uri: string, live: LiveTerminal, exitCode: number): void {
		clearTimeout(live.timer);
		this.#flush(uri, live);
		if (this.#live.get(uri) === live) this.#live.delete(uri);
		if (!this.has(uri)) return;
		this.#store.dispatch(uri, { type: ActionType.TerminalExited, exitCode });
		this.#logger.debug("terminal exited", { terminal: uri, exitCode });
		this.#publishCatalog();
	}

	#publishCatalog(): void {
		const terminals: TerminalInfo[] = [];
		for (const uri of this.#uris) {
			const channel = this.#store.channel(uri);
			if (channel?.kind === "terminal") terminals.push(terminalInfo(uri, channel.state));
		}
		this.#store.dispatch(ROOT_CHANNEL, { type: ActionType.RootTerminalsChanged, terminals });
	}
}
