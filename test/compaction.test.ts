import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { type ChatAction, type ResponsePart, TurnState } from "@microsoft/agent-host-protocol";
import { AgentHost } from "../src/host/agent-host.ts";
import {
	ACTIVITY_COMPACTING,
	COMPACT_DESCRIPTION,
	COMPACT_IN_TERMINAL,
	compactDoneText,
	compactInstructions,
	withCompactCommand,
} from "../src/pi/compaction.ts";
import { slashCompletions } from "../src/pi/customizations.ts";
import { ACTIVITY_THINKING, TurnMapper } from "../src/pi/turn-mapper.ts";
import { listen } from "../src/transport/websocket.ts";
import { FakeBackend, type FakePi, runEvents } from "./fake-pi.ts";
import { newSession, PI_MODES, startHost, startTurn, TestClient, type TestHost, waitUntil } from "./helpers.ts";

describe("compaction helpers", () => {
	test("compactInstructions recognizes /compact with or without instructions, and nothing else", () => {
		assert.equal(compactInstructions("/compact"), "");
		assert.equal(compactInstructions("  /compact  "), "");
		assert.equal(compactInstructions("/compact keep the key decisions"), "keep the key decisions");
		assert.equal(compactInstructions("/compact\nkeep\nthis"), "keep\nthis");
		assert.equal(compactInstructions("/compactor"), undefined);
		assert.equal(compactInstructions("please /compact"), undefined);
		assert.equal(compactInstructions("compact"), undefined);
	});

	test("compactDoneText gives the estimate before and after when pi has them", () => {
		assert.equal(
			compactDoneText({ tokensBefore: 123_456, estimatedTokensAfter: 4_321 }),
			"Compacted the session context: about 123k tokens before, 4.3k after.",
		);
		assert.equal(compactDoneText({ tokensBefore: 900 }), "Compacted the session context (about 900 tokens before).");
		assert.equal(compactDoneText(undefined), "Compacted the session context.");
	});

	test("/compact is offered in completions unless pi has a command of that name", () => {
		const items = slashCompletions(withCompactCommand([]), "/comp", 5);
		assert.equal(items.length, 1);
		assert.equal(items[0]?.insertText, "/compact ");
		assert.equal(
			(items[0]?.attachment?._meta as { description?: string } | undefined)?.description,
			COMPACT_DESCRIPTION,
		);
		const own = [{ name: "compact", kind: "extension" as const, description: "pi's own" }];
		assert.equal(withCompactCommand(own), own);
	});

	test("a manual compaction's events leave the turn alone: the /compact turn reports its own result", () => {
		const actions: ChatAction[] = [];
		const mapper = new TurnMapper("t", (action) => actions.push(action));
		mapper.handle({ type: "compaction_start", reason: "manual" } as never);
		mapper.handle({
			type: "compaction_end",
			reason: "manual",
			result: { estimatedTokensAfter: 3_000 },
			aborted: false,
			willRetry: false,
		} as never);
		assert.deepEqual(
			actions.map((action) => action.type === "chat/activityChanged" && action.activity),
			[ACTIVITY_COMPACTING],
		);
		assert.equal(
			actions.some((action) => action.type === "chat/usage"),
			false,
		);
	});

	test("an aborted automatic compaction does not claim the model is thinking", () => {
		const actions: ChatAction[] = [];
		const mapper = new TurnMapper("t", (action) => actions.push(action));
		mapper.handle({ type: "compaction_start", reason: "threshold" } as never);
		mapper.handle({ type: "compaction_end", reason: "threshold", aborted: true, willRetry: false } as never);
		assert.deepEqual(
			actions.map((action) => action.type === "chat/activityChanged" && action.activity),
			[ACTIVITY_COMPACTING],
		);
	});

	test("automatic compaction shows as the turn's activity", () => {
		const actions: ChatAction[] = [];
		const mapper = new TurnMapper("t", (action) => actions.push(action));
		mapper.handle({ type: "compaction_start", reason: "threshold" } as never);
		mapper.handle({ type: "compaction_end", reason: "threshold", aborted: false, willRetry: false } as never);
		assert.deepEqual(
			actions.map((action) => action.type === "chat/activityChanged" && action.activity),
			[ACTIVITY_COMPACTING, ACTIVITY_THINKING],
		);
	});
});

function commands(pi: FakePi, type: string) {
	return pi.commands.filter((command) => command.type === type);
}

describe("/compact from a client", () => {
	let dir: string;
	let backend: FakeBackend;
	let client: TestClient;
	let close: () => Promise<void>;

	before(async () => {
		dir = await mkdtemp(join(tmpdir(), "pi-agent-host-protocol-compact-"));
		backend = new FakeBackend(dir, { clearQueue: true, compact: true });
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

	const ended = (turnId: string) =>
		client.waitFor(
			(m) =>
				m.method === "action" &&
				m.params.action.turnId === turnId &&
				["chat/turnComplete", "chat/error", "chat/turnCancelled"].includes(m.params.action.type),
		);
	const turn = (chat: string, turnId: string) => client.chats.get(chat)!.turns.find((t) => t.id === turnId)!;
	const markdown = (chat: string, turnId: string) =>
		turn(chat, turnId)
			.responseParts.flatMap((part: ResponsePart) => (part.kind === "markdown" ? [part.content.trim()] : []))
			.join("\n");

	async function session(): Promise<{ chat: string; pi: FakePi }> {
		const { chat } = await newSession({ cwd: dir } as never, client);
		return { chat, pi: backend.pis.at(-1)! };
	}

	test("/compact compacts without a prompt and ends the turn with the estimate", async () => {
		const { chat, pi } = await session();
		const turnId = startTurn(client, chat, "/compact");
		await ended(turnId);
		assert.equal(commands(pi, "prompt").length, 0);
		assert.deepEqual(
			commands(pi, "compact").map((command) => command.customInstructions),
			[undefined],
		);
		assert.equal(turn(chat, turnId).state, TurnState.Complete);
		assert.match(markdown(chat, turnId), /about 12k tokens before, 3\.0k after/);
	});

	test("/compact with instructions passes them to pi", async () => {
		const { chat, pi } = await session();
		const turnId = startTurn(client, chat, "/compact keep the key decisions");
		await ended(turnId);
		assert.deepEqual(
			commands(pi, "compact").map((command) => command.customInstructions),
			["keep the key decisions"],
		);
	});

	test("/compact is offered in completions where pi can compact", async () => {
		const { chat } = await session();
		const result = await client.request("completions", {
			kind: "userMessage",
			channel: chat,
			text: "/comp",
			offset: 5,
		});
		assert.deepEqual(
			result.items.map((item: { insertText: string }) => item.insertText),
			["/compact "],
		);
	});

	test("/compact uses the model picked for the message", async () => {
		const { chat, pi } = await session();
		const turnId = crypto.randomUUID();
		client.dispatch(chat, {
			type: "chat/turnStarted",
			turnId,
			startedAt: new Date().toISOString(),
			message: { text: "/compact", origin: { kind: "user" }, model: { id: "faux/faux-2" } },
		});
		await ended(turnId);
		const order = pi.commands.map((command) => command.type).filter((type) => ["set_model", "compact"].includes(type));
		assert.deepEqual(order, ["set_model", "compact"], "the model is set before pi compacts");
		assert.deepEqual(
			commands(pi, "set_model").map((command) => [command.provider, command.modelId]),
			[["faux", "faux-2"]],
		);
	});

	test("pi's error ends the turn as an error", async () => {
		const { chat, pi } = await session();
		pi.compactWith = { error: "Nothing to compact (session too small)" };
		const turnId = startTurn(client, chat, "/compact");
		await ended(turnId);
		const last = turn(chat, turnId);
		assert.equal(last.state, TurnState.Error);
		assert.ok(
			last.responseParts.some((part) => part.kind === "error" && /Nothing to compact/.test(part.error.message)),
		);
	});

	test("cancelling aborts the compaction", async () => {
		const { chat, pi } = await session();
		pi.compactWith = undefined;
		const turnId = startTurn(client, chat, "/compact");
		await waitUntil(() => commands(pi, "compact").length === 1);
		client.dispatch(chat, { type: "chat/turnCancelled", turnId, duration: 0 });
		await waitUntil(() => commands(pi, "abort").length === 1);
		assert.equal(turn(chat, turnId)?.state, TurnState.Cancelled);
		// The session takes new turns once the aborted compaction settled.
		pi.compactWith = { result: {} };
		const next = startTurn(client, chat, "Hello");
		await ended(next);
		assert.equal(turn(chat, next).state, TurnState.Complete);
	});

	test("a /compact steer waits for the run to end, then compacts", async () => {
		const { chat, pi } = await session();
		pi.manual = true;
		const first = startTurn(client, chat, "Run the build");
		await waitUntil(() => commands(pi, "prompt").length === 1);
		pi.emit(runEvents("Run the build", "").slice(0, 3));
		client.dispatch(chat, {
			type: "chat/pendingMessageSet",
			kind: "steering",
			id: "s1",
			message: { text: "/compact", origin: { kind: "user" } },
		});
		await waitUntil(() => client.chats.get(chat)!.queuedMessages?.[0]?.message.text === "/compact");
		assert.equal(commands(pi, "steer").length, 0, "never handed to pi as text");
		assert.equal(commands(pi, "compact").length, 0, "not while the agent works");
		assert.equal(client.chats.get(chat)!.steeringMessage, undefined);
		pi.emit(runEvents("Run the build", "Built").slice(3));
		await ended(first);
		const compactTurn = await client.waitFor(
			(m) => m.params?.action?.type === "chat/turnStarted" && m.params.action.message?.text === "/compact",
		);
		await ended(compactTurn.params.action.turnId);
		assert.equal(commands(pi, "compact").length, 1);
		assert.equal(commands(pi, "prompt").length, 1);
	});
});

describe("/compact in a session a pi terminal drives", () => {
	test("the turn says to type it in the terminal", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-agent-host-protocol-compact-tui-"));
		// Agents without `clear_queue` and `compact`, as the bridge's.
		const backend = new FakeBackend(dir);
		const host = new AgentHost({ backend, defaultDirectory: dir });
		const listener = await listen(host, { host: "127.0.0.1", port: 0, token: undefined });
		const client = await TestClient.connect(listener.url);
		try {
			await client.initialize();
			const { chat } = await newSession({ cwd: dir } as never, client);
			const completions = await client.request("completions", {
				kind: "userMessage",
				channel: chat,
				text: "/comp",
				offset: 5,
			});
			assert.deepEqual(completions.items, [], "not offered where the host can't run it");
			const turnId = startTurn(client, chat, "/compact");
			await client.waitFor((m) => m.params?.action?.type === "chat/turnComplete" && m.params.action.turnId === turnId);
			const parts = client.chats.get(chat)!.turns.find((t) => t.id === turnId)!.responseParts;
			assert.ok(parts.some((part) => part.kind === "markdown" && part.content.trim() === COMPACT_IN_TERMINAL));
			assert.equal(backend.pis[0]!.commands.filter((command) => command.type === "compact").length, 0);
		} finally {
			client.close();
			await listener.close();
			await host.dispose();
			await rm(dir, { recursive: true, force: true });
		}
	});
});

for (const mode of PI_MODES) {
	describe(`/compact against pi (${mode})`, () => {
		let host: TestHost;
		let client: TestClient;

		before(async () => {
			host = await startHost({ mode });
			client = await TestClient.connect(host.url);
			await client.initialize();
		});

		after(async () => {
			client.close();
			await host.cleanup();
		});

		test("pi gets the command: a fresh session has nothing to compact, which ends the turn as an error", async () => {
			const { chat } = await newSession(host, client);
			const turnId = startTurn(client, chat, "/compact keep the key decisions");
			await client.waitFor(
				(m) =>
					m.params?.action?.turnId === turnId && ["chat/turnComplete", "chat/error"].includes(m.params.action.type),
			);
			const refused = client.chats.get(chat)!.turns.find((t) => t.id === turnId)!;
			assert.equal(refused.state, TurnState.Error);
			assert.ok(
				refused.responseParts.some((part) => part.kind === "error" && /Nothing to compact/.test(part.error.message)),
			);
		});
	});
}
