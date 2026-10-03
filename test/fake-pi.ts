import type { RpcChannel, RpcRecord } from "../src/pi/rpc-channel.ts";

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

	constructor(channel: RpcChannel) {
		this.channel = channel;
		channel.onRecord((record) => this.#onCommand(record));
	}

	emit(events: Record<string, unknown>[]): void {
		for (const event of events) this.channel.send(event);
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
			case "prompt":
				this.channel.respond(command, { data: { disposition: "started" } });
				this.emit(runEvents(String(command.message), this.replies.shift() ?? "OK"));
				break;
			default:
				this.channel.respond(command, {});
		}
	}
}
