import { connect } from "node:net";
import { dirname, join } from "node:path";
import type { AgentSessionEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AttachResult, BRIDGE_PROTOCOL, bridgeSocketPath } from "../bridge/protocol.ts";
import { settingsPath } from "../host/settings.ts";
import { JsonlChannel, type RpcRecord } from "../pi/rpc-channel.ts";
import { toWireEvent } from "../pi/wire.ts";
import { startHostDetached } from "./autostart.ts";
import { executeHostCommand } from "./commands.ts";

const START_TIMEOUT_MS = 5_000;
const START_POLL_MS = 100;
const RECONNECT_MS = 5_000;

export interface BridgeClientOptions {
	socketPath: string;
	logFile: string;
	/** Starts the host; replaced in tests. */
	startHost?: (logFile: string) => void;
}

/**
 * The bridge's connection to the host, one per pi process. It outlives
 * extension reloads (it is kept on `globalThis`), so `bind` points it at the
 * newest `pi` and `ctx` objects each time a session starts.
 */
export class BridgeClient {
	readonly #options: BridgeClientOptions;
	#pi: ExtensionAPI | undefined;
	#ctx: ExtensionContext | undefined;
	#channel: JsonlChannel | undefined;
	#connecting: Promise<JsonlChannel | undefined> | undefined;
	#attached: string | undefined;
	#enabled = true;
	#startedHost = false;
	#urlShown = false;
	#url: string | undefined;
	#reconnect: NodeJS.Timeout | undefined;

	constructor(options: BridgeClientOptions) {
		this.#options = options;
	}

	get attachedSession(): string | undefined {
		return this.#attached;
	}

	/** A session started (startup, `/new`, `/resume`, `/fork`, `/reload`): share it. */
	async sessionStarted(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
		this.#pi = pi;
		this.#ctx = ctx;
		if (this.#enabled) await this.#attach(true);
	}

	/** The session is ending: let go of it, and disconnect when pi quits. */
	async sessionEnding(reason: string): Promise<void> {
		await this.#detach();
		if (reason === "quit") await this.close();
	}

	/** Forwards one session event to the host while a session is attached. */
	forward(event: AgentSessionEvent): void {
		if (this.#attached) this.#channel?.send(toWireEvent(event) as unknown as Record<string, unknown>);
	}

	/** `/ahp on` and `/ahp start`: share this session, starting the host if needed. */
	async enable(): Promise<void> {
		this.#enabled = true;
		await this.#attach(true);
	}

	/** `/ahp off`: stop sharing this session (until `/ahp on` or the next pi). */
	async disable(): Promise<void> {
		this.#enabled = false;
		await this.#detach();
	}

	status(): string {
		if (!this.#enabled) return "pi-agent-host-protocol: sharing is off for this pi (/ahp on to share).";
		if (!this.#attached) return "pi-agent-host-protocol: not connected (/ahp start to start the host).";
		const url = this.#url ? `\nAdd to VS Code (Agents: Add Remote Agent Host…): ${this.#url}` : "";
		return `pi-agent-host-protocol: sharing session ${this.#attached}.${url}`;
	}

	async close(): Promise<void> {
		this.#enabled = false;
		clearTimeout(this.#reconnect);
		await this.#channel?.close();
		this.#channel = undefined;
	}

	async #attach(startIfNeeded: boolean): Promise<void> {
		const pi = this.#pi;
		const ctx = this.#ctx;
		if (!pi || !ctx) return;
		const channel = await this.#connect(startIfNeeded);
		if (!channel) return;
		const sessionId = ctx.sessionManager.getSessionId();
		// Shared from the moment `attach` is sent: the host queries pi before it answers.
		this.#attached = sessionId;
		try {
			const result = await channel.request<AttachResult>({
				type: "attach",
				protocol: BRIDGE_PROTOCOL,
				pid: process.pid,
				sessionId,
				sessionFile: ctx.sessionManager.getSessionFile(),
				cwd: ctx.cwd,
				name: pi.getSessionName(),
			});
			this.#url = result.url;
			if (this.#startedHost && !this.#urlShown && result.url) {
				this.#urlShown = true;
				ctx.ui.notify(
					`pi-agent-host-protocol started. Add this URL to VS Code once (Agents: Add Remote Agent Host…):\n${result.url}`,
					"info",
				);
			}
		} catch (error) {
			if (this.#attached === sessionId) this.#attached = undefined;
			ctx.ui.notify(`pi-agent-host-protocol: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	}

	async #detach(): Promise<void> {
		const sessionId = this.#attached;
		this.#attached = undefined;
		if (sessionId) await this.#channel?.request({ type: "detach", sessionId }).catch(() => {});
	}

	#connect(startIfNeeded: boolean): Promise<JsonlChannel | undefined> {
		if (this.#channel && !this.#channel.closed) return Promise.resolve(this.#channel);
		this.#connecting ??= this.#open(startIfNeeded).finally(() => {
			this.#connecting = undefined;
		});
		return this.#connecting;
	}

	async #open(startIfNeeded: boolean): Promise<JsonlChannel | undefined> {
		let channel = await openChannel(this.#options.socketPath);
		if (!channel && startIfNeeded) {
			(this.#options.startHost ?? startHostDetached)(this.#options.logFile);
			this.#startedHost = true;
			const deadline = Date.now() + START_TIMEOUT_MS;
			while (!channel && Date.now() < deadline) {
				await delay(START_POLL_MS);
				channel = await openChannel(this.#options.socketPath);
			}
		}
		if (!channel) return undefined;
		this.#channel = channel;
		channel.onRecord((record) => this.#onCommand(channel, record));
		channel.onClose(() => {
			if (this.#channel !== channel) return;
			this.#channel = undefined;
			this.#attached = undefined;
			this.#scheduleReconnect();
		});
		return channel;
	}

	/** After the host goes away, quietly reattach when one is back (never starts one). */
	#scheduleReconnect(): void {
		if (!this.#enabled || this.#reconnect) return;
		this.#reconnect = setTimeout(() => {
			this.#reconnect = undefined;
			void this.#attach(false).then(() => {
				if (!this.#attached) this.#scheduleReconnect();
			});
		}, RECONNECT_MS);
		this.#reconnect.unref();
	}

	#onCommand(channel: JsonlChannel, command: RpcRecord): void {
		const pi = this.#pi;
		const ctx = this.#ctx;
		if (!pi || !ctx || !this.#attached) {
			channel.respond(command, { error: "No session is shared" });
			return;
		}
		executeHostCommand(command, pi, ctx).then(
			(data) => channel.respond(command, { data }),
			(error) => channel.respond(command, { error: error instanceof Error ? error.message : String(error) }),
		);
	}
}

/** Connects to the host's socket, or resolves `undefined` if no host is listening. */
function openChannel(path: string): Promise<JsonlChannel | undefined> {
	return new Promise((resolve) => {
		const socket = connect(path);
		socket.setEncoding("utf8");
		const closed = new Promise<void>((done) => socket.once("close", () => done()));
		const channel = new JsonlChannel(
			{
				write: (text) => socket.write(text),
				close: async () => {
					socket.end();
					await closed;
				},
			},
			{ idPrefix: "bridge" },
		);
		socket.on("data", (chunk: string) => channel.push(chunk));
		socket.once("connect", () => {
			socket.on("error", () => {});
			socket.once("close", () => channel.end(new Error("pi-agent-host-protocol disconnected")));
			resolve(channel);
		});
		socket.once("error", () => resolve(undefined));
	});
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const CLIENT_KEY = Symbol.for("pi-agent-host-protocol.bridge-client");

/** The process-wide client, shared by every instance of the extension (pi recreates them on reload). */
export function bridgeClient(): BridgeClient {
	const store = globalThis as typeof globalThis & { [CLIENT_KEY]?: BridgeClient };
	const settings = settingsPath();
	store[CLIENT_KEY] ??= new BridgeClient({
		socketPath: bridgeSocketPath(settings),
		logFile: join(dirname(settings), "host.log"),
	});
	return store[CLIENT_KEY];
}
