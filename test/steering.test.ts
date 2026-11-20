import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { AgentHost } from "../src/host/agent-host.ts";
import { listen } from "../src/transport/websocket.ts";
import { FakeBackend, type FakePi, runEvents } from "./fake-pi.ts";
import { newSession, startTurn, TestClient, waitUntil } from "./helpers.ts";

/** The start of a host prompt's run: pi echoes the prompt as a user message. */
const promptStart = (text: string) => runEvents(text, "").slice(0, 3);
const writing = [
	{ type: "message_start", message: { role: "assistant", content: [] } },
	{ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
	{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Building" } },
];
const toolStart = { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "make" } };
/** How pi ends a run aborted during a tool call: the tool fails, and the run ends without an aborted message. */
const toolAborted = [
	{
		type: "tool_execution_end",
		toolCallId: "t1",
		toolName: "bash",
		result: { content: [{ type: "text", text: "Command aborted" }] },
		isError: true,
	},
	{ type: "agent_end", messages: [] },
	{ type: "agent_settled" },
];

function commands(pi: FakePi, type: string) {
	return pi.commands.filter((command) => command.type === type);
}

function steer(client: TestClient, chat: string, text: string): void {
	client.dispatch(chat, {
		type: "chat/pendingMessageSet",
		kind: "steering",
		id: crypto.randomUUID(),
		message: { text, origin: { kind: "user" } },
	});
}

describe("steering messages pi has not delivered when its run ends", () => {
	let dir: string;
	let backend: FakeBackend;
	let client: TestClient;
	let close: () => Promise<void>;

	before(async () => {
		dir = await mkdtemp(join(tmpdir(), "pi-agent-host-protocol-steering-"));
		backend = new FakeBackend(dir, { clearQueue: true });
		const host = new AgentHost({ backend, defaultDirectory: dir });
		const listener = await listen(host, { host: "127.0.0.1", port: 0, token: undefined });
		client = await TestClient.connect(listener.url);
		await client.initialize();
		close = async () => {
			client.close();
			await listener.close();
			await host.dispose();
		};
	});
	after(async () => {
		await close();
		await rm(dir, { recursive: true, force: true });
	});

	/** A new session whose pi is in manual mode, running a prompt whose run has started. */
	async function running(prompt: string): Promise<{ chat: string; pi: FakePi; first: string }> {
		const { chat } = await newSession({ cwd: dir } as never, client);
		const pi = backend.pis.at(-1)!;
		pi.manual = true;
		const first = startTurn(client, chat, prompt);
		await waitUntil(() => commands(pi, "prompt").length === 1);
		pi.emit(promptStart(prompt));
		return { chat, pi, first };
	}

	/**
	 * Waits for the steering message to start its own turn and plays its run.
	 * `resumed`: pi still held it, so a run without a new message lets pi
	 * deliver it. `queued`: it went through the chat's queue and was sent as a
	 * prompt. Returns the turn id.
	 */
	async function steeredTurn(
		chat: string,
		pi: FakePi,
		text: string,
		how: "resumed" | "queued" = "resumed",
	): Promise<string> {
		const started = await client.waitFor(
			(m) =>
				m.params?.action?.type === "chat/turnStarted" &&
				m.params.channel === chat &&
				m.params.action.message.text === text,
		);
		if (how === "queued") {
			assert.match(started.params.action.queuedMessageId, /^steer-/);
			await waitUntil(() => commands(pi, "prompt").some((command) => command.message === text));
		} else {
			assert.equal(started.params.action.queuedMessageId, undefined);
			await waitUntil(() => commands(pi, "prompt").some((command) => command.message === "/ahp-resume"));
		}
		pi.emit(runEvents(text, "On it"));
		const turnId = started.params.action.turnId;
		await client.waitFor((m) => m.params?.action?.type === "chat/turnComplete" && m.params.action.turnId === turnId);
		return turnId;
	}

	test("a steer pi had not delivered runs as the next turn, without clearing pi's queue", async () => {
		const { chat, pi, first } = await running("Quick one");
		pi.emit(writing);
		steer(client, chat, "Then this");
		await waitUntil(() => commands(pi, "steer").length === 1);
		// pi's loop had already made its last check, so the run ends with the steer still queued.
		pi.emit(runEvents("Quick one", "Done").slice(5));
		await steeredTurn(chat, pi, "Then this");
		// Extensions queue their own messages in pi's queue too (a subagent's result), so it is left alone.
		assert.equal(commands(pi, "clear_queue").length, 0);
		assert.equal(commands(pi, "abort").length, 0);
		assert.deepEqual(pi.steering, []);
		const state = client.chats.get(chat)!;
		assert.deepEqual(
			state.turns.map((turn) => [turn.id === first, turn.message.text, turn.state]),
			[
				[true, "Quick one", "complete"],
				[false, "Then this", "complete"],
			],
		);
		assert.equal(state.queuedMessages?.length ?? 0, 0);
		assert.equal(state.steeringMessage, undefined);
	});

	test("a steer waits for a running tool call; the host does not stop it", async () => {
		const { chat, pi } = await running("Run the build");
		pi.emit([toolStart]);
		steer(client, chat, "After that, test");
		await waitUntil(() => commands(pi, "steer").length === 1);
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(commands(pi, "abort").length, 0);
		pi.emit([{ ...toolAborted[0]!, isError: false }, ...toolAborted.slice(1)]);
		await steeredTurn(chat, pi, "After that, test");
		assert.equal(client.chats.get(chat)!.turns[0]!.state, "complete");
	});

	test("a steer Bolt's bash resent as a follow-up runs as the next turn without a duplicate", async () => {
		const { chat, pi, first } = await running("Run the build");
		pi.steerAsFollowUp = true;
		pi.emit([toolStart]);
		steer(client, chat, "Check the logs instead");
		await waitUntil(() => pi.followUp.length === 1);
		// Bolt backgrounds the command and aborts the turn itself.
		pi.emit(toolAborted);
		await steeredTurn(chat, pi, "Check the logs instead", "queued");
		assert.equal(commands(pi, "clear_queue").length, 1, "pi's copy is cleared so it is not delivered twice");
		assert.deepEqual(pi.followUp, []);
		assert.equal(commands(pi, "abort").length, 0);
		assert.deepEqual(
			client.chats.get(chat)!.turns.map((turn) => [turn.id === first, turn.message.text]),
			[
				[true, "Run the build"],
				[false, "Check the logs instead"],
			],
		);
	});

	test("cancelling a turn drops a steer pi had not delivered, so the next run does not get it", async () => {
		const { chat, pi, first } = await running("Long job");
		pi.emit([toolStart]);
		steer(client, chat, "Forget it");
		await waitUntil(() => commands(pi, "steer").length === 1);
		client.dispatch(chat, { type: "chat/turnCancelled", turnId: first, duration: 1 });
		await waitUntil(() => commands(pi, "abort").length === 1);
		pi.emit(toolAborted);
		await waitUntil(() => commands(pi, "clear_queue").length === 1);
		assert.deepEqual(pi.steering, []);
		await new Promise((resolve) => setTimeout(resolve, 100));
		const state = client.chats.get(chat)!;
		assert.deepEqual(
			state.turns.map((turn) => [turn.message.text, turn.state]),
			[["Long job", "cancelled"]],
		);
		assert.equal(state.queuedMessages?.length ?? 0, 0);
	});
});
