import { connect } from "node:net";
import { type SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";
import { type AttachRequest, BRIDGE_PROTOCOL } from "../src/bridge/protocol.ts";
import { silentLogger } from "../src/core/logger.ts";
import type { PiAgent, PiBackend } from "../src/pi/agent.ts";
import { connectRpcAgent } from "../src/pi/rpc-agent.ts";
import { JsonlChannel, type RpcChannel, type RpcRecord } from "../src/pi/rpc-channel.ts";
import { channelPair } from "./helpers.ts";

const USAGE = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** pi's events for one run: an optional user message, then one assistant text reply. */
export function runEvents(user: string | undefined, reply: string): Record<string, unknown>[] {
	const assistant = {
		role: "assistant",
		content: [{ type: "text", text: reply }],
		stopReason: "stop",
		model: "faux-1",
		usage: USAGE,
	};
	const userMessage = { role: "user", content: [{ type: "text", text: user }] };
	return [
		{ type: "agent_start" },
		...(user === undefined
			? []
			: [
					{ type: "message_start", message: userMessage },
					{ type: "message_end", message: userMessage },
				]),
		{ type: "message_start", message: { ...assistant, content: [] } },
		{ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
		{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: reply } },
		{ type: "message_end", message: assistant },
		{ type: "agent_end", messages: [] },
		{ type: "agent_settled" },
	];
}

/**
 * The pi side of an RPC channel, scripted by tests: it answers the commands
 * the host sends and emits session events, the way a TUI bridge does.
 */
export class FakePi {
	readonly channel: RpcChannel;
	readonly commands: RpcRecord[] = [];
	/** Reply text for host prompts; each prompt plays one run. */
	replies: string[] = [];
	/** The live branch returned for `get_branch`. */
	entries: unknown[] = [];
	/** When set, host prompts start no run; the test emits the run's events itself. */
	manual = false;
	/** Steering messages pi has queued and not yet delivered, as pi's `clear_queue` returns them. */
	steering: string[] = [];
	/** Follow-up messages pi has queued. */
	followUp: string[] = [];
	/**
	 * When set, a steer is queued as a follow-up instead, as Bolt's `bash`
	 * input hook resends input that arrives during a foreground command.
	 */
	steerAsFollowUp = false;

	constructor(channel: RpcChannel) {
		this.channel = channel;
		channel.onRecord((record) => this.#onCommand(record));
	}

	/** Sends events; a user message delivers the queued message with its text, as pi does. */
	emit(events: Record<string, unknown>[]): void {
		for (const event of events) {
			const message = event.message as { role?: string; content?: Array<{ text?: string }> } | undefined;
			if (event.type === "message_start" && message?.role === "user") {
				const text = message.content?.[0]?.text ?? "";
				for (const queue of [this.steering, this.followUp]) {
					const index = queue.indexOf(text);
					if (index < 0) continue;
					queue.splice(index, 1);
					this.#queueUpdate();
					break;
				}
			}
			this.channel.send(event);
		}
	}

	#queueUpdate(): void {
		this.channel.send({ type: "queue_update", steering: [...this.steering], followUp: [...this.followUp] });
	}

	#onCommand(command: RpcRecord): void {
		this.commands.push(command);
		switch (command.type) {
			case "get_state":
				this.channel.respond(command, { data: { model: { provider: "faux", id: "faux-1" }, isStreaming: false } });
				break;
			case "get_commands":
				this.channel.respond(command, { data: { commands: [{ name: "ahp-resume" }] } });
				break;
			case "get_branch":
				this.channel.respond(command, { data: { entries: this.entries } });
				break;
			case "prompt":
				this.channel.respond(command, { data: { disposition: "started" } });
				if (this.manual) break;
				this.emit(runEvents(String(command.message), this.replies.shift() ?? "OK"));
				break;
			case "steer":
				(this.steerAsFollowUp ? this.followUp : this.steering).push(String(command.message));
				this.#queueUpdate();
				this.channel.respond(command, {});
				break;
			case "clear_queue": {
				const data = { steering: this.steering.splice(0), followUp: this.followUp.splice(0) };
				this.#queueUpdate();
				this.channel.respond(command, { data });
				break;
			}
			case "extension_ui_response":
				break;
			default:
				this.channel.respond(command, {});
		}
	}
}

/** A backend whose agents are `FakePi`s, so tests script every event pi sends. */
export class FakeBackend implements PiBackend {
	readonly mode = "rpc";
	readonly pis: FakePi[] = [];
	readonly #dir: string;
	readonly #clearQueue: boolean;

	/** `clearQueue` makes the agents answer `clear_queue`, as `pi --mode rpc` does. */
	constructor(dir: string, options: { clearQueue?: boolean } = {}) {
		this.#dir = dir;
		this.#clearQueue = options.clearQueue ?? false;
	}

	async models() {
		return [{ provider: "faux", id: "faux-1" }];
	}

	async globalCommands() {
		return [];
	}

	async folderCommands() {
		return [];
	}

	listSessions(): Promise<SessionInfo[]> {
		return SessionManager.listAll(this.#dir);
	}

	newSessionManager(cwd: string, id: string): SessionManager {
		return SessionManager.create(cwd, this.#dir, { id });
	}

	openSessionManager(path: string): SessionManager {
		return SessionManager.open(path, this.#dir);
	}

	async startAgent(): Promise<PiAgent> {
		const [host, pi] = channelPair();
		this.pis.push(new FakePi(pi));
		return connectRpcAgent(host, silentLogger, { clearQueue: this.#clearQueue });
	}

	async dispose(): Promise<void> {}
}

/** A fake interactive pi connected to the host's bridge socket. */
export class FakeBridge extends FakePi {
	static connect(path: string): Promise<FakeBridge> {
		return new Promise((resolve, reject) => {
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
			socket.once("close", () => channel.end(new Error("Socket closed")));
			socket.once("connect", () => resolve(new FakeBridge(channel)));
			socket.once("error", reject);
		});
	}

	attach(info: Partial<AttachRequest> & { sessionId: string; cwd: string }): Promise<{ url?: string }> {
		return this.channel.request({ type: "attach", protocol: BRIDGE_PROTOCOL, pid: process.pid, ...info });
	}

	detach(sessionId: string): Promise<unknown> {
		return this.channel.request({ type: "detach", sessionId });
	}

	close(): Promise<void> {
		return this.channel.close();
	}
}
