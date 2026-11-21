import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { type ResponsePart, TurnState } from "@microsoft/agent-host-protocol";
import { AgentHost } from "../src/host/agent-host.ts";
import {
	CONTEXT_UNSUPPORTED,
	contextCommand,
	contextLimitOf,
	contextSizeProperty,
	contextText,
	contextUsageMeta,
	effectiveWindow,
	pickerChange,
	restoredContextLimit,
	restoredModel,
	withContextCommand,
} from "../src/pi/context-limit.ts";
import { toSessionModelInfo } from "../src/pi/models.ts";
import { listen } from "../src/transport/websocket.ts";
import { FakeBackend, type FakePi, runEvents } from "./fake-pi.ts";
import { newSession, startHost, startTurn, TestClient, type TestHost, waitUntil } from "./helpers.ts";

describe("context limit helpers", () => {
	test("offers the windows below the model's, then its own, defaulting to it", () => {
		const property = contextSizeProperty(1_000_000);
		assert.deepEqual(property?.enum, [200_000, 300_000, 500_000, 1_000_000]);
		assert.deepEqual(property?.enumLabels, ["200K", "300K", "500K", "1M"]);
		assert.equal(property?.default, 1_000_000);
		assert.deepEqual(contextSizeProperty(272_000)?.enum, [200_000, 272_000]);
		assert.equal(contextSizeProperty(128_000), undefined, "no choice below a small window");
		assert.equal(contextSizeProperty(undefined), undefined);
	});

	test("models carry contextSize next to thinkingLevel", () => {
		const info = toSessionModelInfo({ provider: "locksmith", id: "m", reasoning: true, contextWindow: 1_000_000 });
		assert.deepEqual(Object.keys(info.configSchema?.properties ?? {}), ["thinkingLevel", "contextSize"]);
		const plain = toSessionModelInfo({ provider: "locksmith", id: "m", contextWindow: 1_000_000 });
		assert.deepEqual(Object.keys(plain.configSchema?.properties ?? {}), ["contextSize"]);
		assert.equal(toSessionModelInfo({ provider: "faux", id: "m" }).configSchema, undefined);
	});

	test("a selection's limit is null for the model's own window or no choice", () => {
		const pick = (contextSize: unknown) => ({ id: "locksmith/m", config: { contextSize } as never });
		assert.equal(contextLimitOf(pick(300_000), 1_000_000), 300_000);
		assert.equal(contextLimitOf(pick(1_000_000), 1_000_000), null);
		assert.equal(contextLimitOf(pick("300000"), 1_000_000), 300_000);
		assert.equal(contextLimitOf({ id: "locksmith/m" }, 1_000_000), null);
		assert.equal(contextLimitOf(pick("lots"), 1_000_000), null);
	});

	test("only a change of the picker is applied", () => {
		assert.equal(pickerChange(undefined, 300_000), 300_000);
		assert.equal(pickerChange(undefined, null), undefined, "a first full-window pick leaves a restored limit");
		assert.equal(pickerChange(300_000, 300_000), undefined);
		assert.equal(pickerChange(300_000, null), null);
		assert.equal(pickerChange(null, 200_000), 200_000);
	});

	test("the gauge's context: tokens against the model's window lowered to the limit", () => {
		assert.equal(effectiveWindow(1_000_000, 300_000), 300_000);
		assert.equal(effectiveWindow(1_000_000, null), 1_000_000);
		assert.equal(effectiveWindow(undefined, 300_000), 300_000);
		assert.equal(effectiveWindow(200_000, 300_000), 200_000);
		assert.deepEqual(contextUsageMeta(260_600, 300_000), {
			currentTokens: 260_600,
			tokenLimit: 300_000,
			messagesLength: 0,
		});
		assert.equal(contextUsageMeta(undefined, 300_000), undefined);
		assert.equal(contextUsageMeta(10, undefined), undefined);
	});

	test("reads the limit and model a session file last recorded", () => {
		const entries = [
			{ type: "model_change", provider: "locksmith", modelId: "anthropic/claude-opus-5-5" },
			{ type: "custom", customType: "pi.context-limit", data: { limit: 300_000 } },
			{ type: "model_change", provider: "locksmith", modelId: "vertex/gemini-4-neon" },
		];
		assert.equal(restoredContextLimit(entries), 300_000);
		assert.equal(restoredModel(entries), "locksmith/vertex/gemini-4-neon");
		assert.equal(
			restoredContextLimit([...entries, { type: "custom", customType: "pi.context-limit", data: { limit: null } }]),
			null,
		);
		assert.equal(restoredContextLimit([]), undefined);
		assert.equal(restoredModel([]), undefined);
	});

	test("parses /context", () => {
		assert.deepEqual(contextCommand("/context"), { kind: "show" });
		assert.deepEqual(contextCommand("/context 300k"), { kind: "set", limit: 300_000 });
		assert.deepEqual(contextCommand("/context 1.5m"), { kind: "set", limit: 1_500_000 });
		assert.deepEqual(contextCommand("/context default"), { kind: "set", limit: null });
		assert.deepEqual(contextCommand("/context lots"), { kind: "invalid", argument: "lots" });
		assert.equal(contextCommand("/contexts"), undefined);
		assert.equal(contextCommand("what is /context"), undefined);
	});

	test("describes the context and adds /context to completions", () => {
		assert.equal(
			contextText({ limit: 300_000, contextWindow: 300_000, modelWindow: 1_000_000, tokens: 150_000 }),
			"Context: 150K of 300K (50%); limit 300K (model 1M).",
		);
		assert.equal(
			contextText({ limit: null, contextWindow: 1_000_000, tokens: null }),
			"Context: unknown until the next response; the model's full window, no limit set.",
		);
		assert.equal(withContextCommand([]).at(-1)?.name, "context");
		const own = [{ name: "context", kind: "extension" as const }];
		assert.equal(withContextCommand(own), own);
	});
});

describe("context limit from a client", () => {
	let dir: string;
	let backend: FakeBackend;
	let client: TestClient;
	let close: () => Promise<void>;

	before(async () => {
		dir = await mkdtemp(join(tmpdir(), "pi-agent-host-protocol-context-"));
		backend = new FakeBackend(dir, { clearQueue: true, contextLimit: true });
		backend.modelListings = [[{ provider: "faux", id: "faux-1", contextWindow: 1_000_000 }]];
		const host = new AgentHost({ backend, defaultDirectory: dir });
		await host.refreshAgents();
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
	const markdown = (chat: string, turnId: string) =>
		client.chats
			.get(chat)!
			.turns.find((t) => t.id === turnId)!
			.responseParts.flatMap((part: ResponsePart) => (part.kind === "markdown" ? [part.content.trim()] : []))
			.join("\n");
	const commands = (pi: FakePi, type: string) => pi.commands.filter((command) => command.type === type);
	const send = (chat: string, text: string, config?: Record<string, unknown>) => {
		const turnId = crypto.randomUUID();
		client.dispatch(chat, {
			type: "chat/turnStarted",
			turnId,
			startedAt: new Date().toISOString(),
			message: {
				text,
				origin: { kind: "user" },
				...(config ? { model: { id: "faux/faux-1", config } } : {}),
			},
		});
		return turnId;
	};

	async function session(): Promise<{ chat: string; pi: FakePi; session: string }> {
		const { chat, session } = await newSession({ cwd: dir } as never, client);
		return { chat, pi: backend.pis.at(-1)!, session };
	}
	const gauge = (session: string) => client.sessions.get(session)?._meta?.["copilot.usageInfo"];

	test("the published model offers Context Size", () => {
		const model = client.root?.agents[0]?.models[0];
		assert.deepEqual(model?.configSchema?.properties.contextSize?.enum, [200_000, 300_000, 500_000, 1_000_000]);
	});

	test("/context 300k sets the limit without a prompt and reports it", async () => {
		const { chat, pi } = await session();
		const turnId = send(chat, "/context 300k");
		await ended(turnId);
		assert.equal(commands(pi, "prompt").length, 0);
		assert.deepEqual(
			commands(pi, "set_context_limit").map((command) => command.limit),
			[300_000],
		);
		assert.equal(client.chats.get(chat)!.turns.find((t) => t.id === turnId)!.state, TurnState.Complete);
		assert.equal(markdown(chat, turnId), "Context: 42K of 300K (14%); limit 300K (model 1M).");

		const shown = send(chat, "/context");
		await ended(shown);
		assert.equal(commands(pi, "set_context_limit").length, 1, "showing doesn't set anything");
		assert.match(markdown(chat, shown), /limit 300K/);

		const cleared = send(chat, "/context default");
		await ended(cleared);
		assert.deepEqual(commands(pi, "set_context_limit").at(-1)?.limit, null);
		assert.match(markdown(chat, cleared), /no limit set/);
	});

	test("an unreadable argument ends the turn with usage", async () => {
		const { chat, pi } = await session();
		const turnId = send(chat, "/context lots");
		await ended(turnId);
		assert.equal(commands(pi, "set_context_limit").length, 0);
		assert.match(markdown(chat, turnId), /isn't a context size/);
	});

	test("the picker's Context Size is applied once per change before the prompt", async () => {
		const { chat, pi } = await session();
		await ended(send(chat, "hello", { contextSize: 300_000 }));
		await ended(send(chat, "again", { contextSize: 300_000 }));
		assert.deepEqual(
			commands(pi, "set_context_limit").map((command) => command.limit),
			[300_000],
		);
		const order = pi.commands.map((command) => command.type).filter((type) => type !== "get_commands");
		assert.ok(order.indexOf("set_context_limit") < order.indexOf("prompt"), "set before the prompt");
		await ended(send(chat, "full", { contextSize: 1_000_000 }));
		assert.deepEqual(commands(pi, "set_context_limit").at(-1)?.limit, null, "the model's own window clears it");
		assert.equal(commands(pi, "prompt").length, 3);
	});

	test("/context isn't undone by the next message's unchanged picker value; a new pick still applies", async () => {
		const { chat, pi } = await session();
		await ended(send(chat, "first", { contextSize: 300_000 }));
		await ended(send(chat, "/context default"));
		await ended(send(chat, "hello", { contextSize: 300_000 }));
		assert.deepEqual(
			commands(pi, "set_context_limit").map((command) => command.limit),
			[300_000, null],
			"the unchanged 300K pick doesn't reset the cleared limit",
		);
		await ended(send(chat, "smaller", { contextSize: 200_000 }));
		assert.deepEqual(commands(pi, "set_context_limit").at(-1)?.limit, 200_000);
	});

	test("a first message picking the full window leaves pi's limit alone", async () => {
		const { chat, pi } = await session();
		await ended(send(chat, "hello", { contextSize: 1_000_000 }));
		assert.equal(commands(pi, "set_context_limit").length, 0);
	});

	test("the gauge shows the context against the session's limit, not the model's window", async () => {
		const { chat, pi, session: resource } = await session();
		await ended(send(chat, "hello", { contextSize: 300_000 }));
		assert.deepEqual(gauge(resource), { currentTokens: 1, tokenLimit: 300_000, messagesLength: 0 });
		await ended(send(chat, "/context default"));
		assert.equal((gauge(resource) as { tokenLimit?: number } | undefined)?.tokenLimit, 1_000_000, "/context moves it");
		await ended(send(chat, "/context 200k"));
		assert.equal((gauge(resource) as { tokenLimit?: number } | undefined)?.tokenLimit, 200_000);
		assert.equal(commands(pi, "prompt").length, 1);
	});

	test("an older Bolt gets one note and the prompt still runs", async () => {
		const { chat, pi } = await session();
		pi.noContextLimit = true;
		const first = send(chat, "hello", { contextSize: 300_000 });
		await ended(first);
		assert.match(markdown(chat, first), new RegExp(CONTEXT_UNSUPPORTED.slice(0, 30).replace(/[()]/g, "\\$&")));
		const second = send(chat, "again", { contextSize: 300_000 });
		await ended(second);
		assert.doesNotMatch(markdown(chat, second), /can't set a context limit/);
		const third = send(chat, "smaller", { contextSize: 200_000 });
		await ended(third);
		assert.doesNotMatch(markdown(chat, third), /can't set a context limit/, "one note, then ignored");
		assert.equal(commands(pi, "set_context_limit").length, 1, "never asked again");
		assert.equal(commands(pi, "prompt").length, 3);

		const typed = send(chat, "/context 300k");
		await ended(typed);
		assert.equal(markdown(chat, typed), CONTEXT_UNSUPPORTED);
		assert.equal(commands(pi, "set_context_limit").length, 1);
	});

	test("a pi without set_context_limit leaves the gauge on the model's window", async () => {
		const { chat, pi, session: resource } = await session();
		pi.noContextLimit = true;
		await ended(send(chat, "hello", { contextSize: 300_000 }));
		assert.equal((gauge(resource) as { tokenLimit?: number } | undefined)?.tokenLimit, 1_000_000);
	});

	test("a failed set_context_limit fails the turn, is not recorded, and is tried again", async () => {
		const { chat, pi, session: resource } = await session();
		pi.contextLimitError = "pi timed out";
		const failed = send(chat, "hello", { contextSize: 300_000 });
		await ended(failed);
		assert.equal(client.chats.get(chat)!.turns.find((t) => t.id === failed)!.state, TurnState.Error);
		assert.notEqual((gauge(resource) as { tokenLimit?: number } | undefined)?.tokenLimit, 300_000);
		await ended(send(chat, "retry", { contextSize: 300_000 }));
		assert.deepEqual(
			commands(pi, "set_context_limit").map((command) => command.limit),
			[300_000, 300_000],
			"the same pick is sent again",
		);
		assert.equal((gauge(resource) as { tokenLimit?: number } | undefined)?.tokenLimit, 300_000);
	});

	test("a replaced pi gets the picker's size again", async () => {
		const { chat, pi } = await session();
		await ended(send(chat, "hello", { contextSize: 300_000 }));
		await pi.channel.close();
		await ended(send(chat, "after restart", { contextSize: 300_000 }));
		const restarted = backend.pis.at(-1)!;
		assert.notEqual(restarted, pi);
		assert.deepEqual(
			commands(restarted, "set_context_limit").map((command) => command.limit),
			[300_000],
		);
	});

	test("a /context steer during a run is held, never sent to pi, and runs after the run", async () => {
		const { chat, pi } = await session();
		pi.manual = true;
		const first = send(chat, "Run the build");
		await waitUntil(() => commands(pi, "prompt").length === 1);
		pi.emit(runEvents("Run the build", "").slice(0, 3));
		client.dispatch(chat, {
			type: "chat/pendingMessageSet",
			kind: "steering",
			id: "s1",
			message: { text: "/context 300k", origin: { kind: "user" } },
		});
		await waitUntil(() => client.chats.get(chat)!.queuedMessages?.[0]?.message.text === "/context 300k");
		assert.equal(commands(pi, "steer").length, 0, "never handed to pi as text");
		assert.equal(commands(pi, "set_context_limit").length, 0, "not while the agent works");
		assert.equal(client.chats.get(chat)!.steeringMessage, undefined);
		pi.emit(runEvents("Run the build", "Built").slice(3));
		await ended(first);
		const held = await client.waitFor(
			(m) => m.params?.action?.type === "chat/turnStarted" && m.params.action.message?.text === "/context 300k",
		);
		await ended(held.params.action.turnId);
		assert.deepEqual(
			commands(pi, "set_context_limit").map((command) => command.limit),
			[300_000],
		);
		assert.equal(commands(pi, "prompt").length, 1);
	});
});

describe("/context against the bundled pi (rpc)", () => {
	let host: TestHost;
	let client: TestClient;

	before(async () => {
		host = await startHost({ mode: "rpc" });
		client = await TestClient.connect(host.url);
		await client.initialize();
	});

	after(async () => {
		client.close();
		await host.cleanup();
	});

	// The pi in node_modules predates set_context_limit, as an older Bolt does.
	test("a pi without set_context_limit says so and the turn completes", async () => {
		const { chat } = await newSession(host, client);
		const turnId = startTurn(client, chat, "/context 300k");
		await client.waitFor(
			(m) => m.params?.action?.turnId === turnId && ["chat/turnComplete", "chat/error"].includes(m.params.action.type),
		);
		const done = client.chats.get(chat)!.turns.find((t) => t.id === turnId)!;
		assert.equal(done.state, TurnState.Complete);
		assert.ok(
			done.responseParts.some((part) => part.kind === "markdown" && part.content.trim() === CONTEXT_UNSUPPORTED),
		);
	});
});
