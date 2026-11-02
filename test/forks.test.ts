import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { type Context, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { MessageKind, type SessionState, type Turn, TurnState } from "@microsoft/agent-host-protocol";
import {
	type ForkRecord,
	fileForkStore,
	forkByChat,
	forksOf,
	parseForks,
	serializeForks,
} from "../src/host/fork-store.ts";
import { forkKeep, forkLeaf, forkTitle, forkTurnError } from "../src/pi/forks.ts";
import { newSession, PI_MODES, startHost, startTurn, TestClient, type TestHost } from "./helpers.ts";

function entry(id: string, parentId: string | null, role?: string) {
	return role
		? { type: "message", id, parentId, message: { role } }
		: { type: "model_change", id, parentId, message: undefined };
}

function turn(id: string, state = TurnState.Complete, kind = MessageKind.User): Turn {
	return { id, message: { text: id, origin: { kind } }, responseParts: [], usage: undefined, state };
}

const record = (session: string, chat: string): ForkRecord => ({ session, chat, source: `src-${chat}`, turnId: "t" });

describe("fork helpers", () => {
	const branch = [
		entry("m", null),
		entry("u1", "m", "user"),
		entry("a1", "u1", "assistant"),
		entry("u2", "a1", "user"),
		entry("a2", "u2", "assistant"),
	];

	test("forkLeaf ends before the next user message, or at the branch's end", () => {
		assert.equal(forkLeaf(branch, 1), "a1");
		assert.equal(forkLeaf(branch, 2), "a2");
		assert.equal(forkLeaf([], 1), undefined);
	});

	test("forkKeep counts the user messages through the turn", () => {
		const turns = [turn("t1"), turn("c", TurnState.Complete, MessageKind.SystemNotification), turn("t2"), turn("t3")];
		assert.equal(forkKeep(turns, "t1", new Set()), 1);
		assert.equal(forkKeep(turns, "t2", new Set()), 2);
		assert.equal(forkKeep(turns, "t3", new Set(["t2"])), 2);
	});

	test("forkTurnError accepts only completed turns", () => {
		const turns = [turn("done"), turn("failed", TurnState.Error)];
		assert.equal(forkTurnError(turns, "done"), undefined);
		assert.equal(forkTurnError(turns, "failed"), "Turn failed is not complete");
		assert.equal(forkTurnError(turns, "nope"), "Unknown turn: nope");
	});

	test("forkTitle marks the fork", () => {
		assert.equal(forkTitle("Fix the build"), "Fix the build (fork)");
	});
});

describe("fork store", () => {
	test("round-trips and drops malformed entries", () => {
		const forks = new Map([["b", record("s", "chat-b")]]);
		assert.deepEqual(parseForks(serializeForks(forks)), forks);
		assert.deepEqual(parseForks('{"forks":{"x":{"session":1}}}'), new Map());
		assert.deepEqual(parseForks("not json"), new Map());
	});

	test("finds forks by chat URI and by session, oldest first", () => {
		const forks = new Map([
			["2", record("s", "chat-2")],
			["1", record("s", "chat-1")],
			["3", record("other", "chat-3")],
		]);
		assert.deepEqual(forkByChat(forks, "chat-3")?.[0], "3");
		assert.equal(forkByChat(forks, "missing"), undefined);
		assert.deepEqual(
			forksOf(forks, "s").map(([id]) => id),
			["1", "2"],
		);
	});

	test("persists to its file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-agent-host-protocol-forks-"));
		try {
			const path = join(dir, "forked-chats.json");
			const store = await fileForkStore(path);
			store.add("f", record("s", "chat-f"));
			await store.flush();
			assert.deepEqual(parseForks(await readFile(path, "utf8")).get("f"), record("s", "chat-f"));
			assert.deepEqual((await fileForkStore(path)).all().get("f"), record("s", "chat-f"));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

/** The text of each user message the model was sent. */
function userTexts(context: Context): string[] {
	return context.messages
		.filter((message) => message.role === "user")
		.map((message) =>
			typeof message.content === "string"
				? message.content
				: message.content.map((block) => ("text" in block ? block.text : "")).join(""),
		);
}

for (const mode of PI_MODES) {
	describe(`forking a chat (${mode})`, () => {
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

		const complete = (id: string) =>
			client.waitFor((m) => m.params?.action?.type === "chat/turnComplete" && m.params.action.turnId === id);

		/** A session with two completed turns, "first" and "second". */
		async function twoTurns(): Promise<{ session: string; chat: string; first: string; second: string }> {
			const { session, chat } = await newSession(host, client);
			host.faux.setResponses([fauxAssistantMessage("One."), fauxAssistantMessage("Two.")]);
			const first = startTurn(client, chat, "first");
			await complete(first);
			const second = startTurn(client, chat, "second");
			await complete(second);
			return { session, chat, first, second };
		}

		test("advertises forking", () => {
			assert.equal(client.root?.agents[0]?.capabilities?.multipleChats?.fork, true);
		});

		test("a fork keeps the turns through the forked one and continues on its own", async () => {
			const { session, chat, first } = await twoTurns();
			const fork = `ahp-chat:/${crypto.randomUUID()}`;
			await client.request("createChat", {
				channel: session,
				chat: fork,
				source: { kind: "fork", chat, turnId: first },
			});
			const added = client.sessions.get(session)!.chats.find((summary) => summary.resource === fork);
			assert.ok(added, "session/chatAdded lists the fork");
			assert.equal(added.title, "first (fork)");
			assert.deepEqual(added.origin, { kind: "fork", chat, turnId: first });

			await client.subscribe(fork);
			assert.deepEqual(
				client.chats.get(fork)!.turns.map((t) => t.message.text),
				["first"],
			);

			let sent: string[] = [];
			host.faux.setResponses([
				(context) => {
					sent = userTexts(context);
					return fauxAssistantMessage("Forked.");
				},
			]);
			await complete(startTurn(client, fork, "another way"));
			assert.deepEqual(sent, ["first", "another way"], "the model sees the history through the fork point");
			assert.deepEqual(
				client.chats.get(fork)!.turns.map((t) => t.message.text),
				["first", "another way"],
			);
			assert.deepEqual(
				client.chats.get(chat)!.turns.map((t) => t.message.text),
				["first", "second"],
				"the source chat is unchanged",
			);
		});

		test("a fork at the latest turn keeps them all, and can start with a message", async () => {
			const { session, chat, second } = await twoTurns();
			const fork = `ahp-chat:/${crypto.randomUUID()}`;
			let sent: string[] = [];
			host.faux.setResponses([
				(context) => {
					sent = userTexts(context);
					return fauxAssistantMessage("Third.");
				},
			]);
			await client.request("createChat", {
				channel: session,
				chat: fork,
				source: { kind: "fork", chat, turnId: second },
				initialMessage: { text: "third", origin: { kind: "user" } },
			});
			await client.subscribe(fork);
			const running = client.chats.get(fork)!.activeTurn;
			if (running) await complete(running.id);
			assert.deepEqual(sent, ["first", "second", "third"]);
			assert.deepEqual(
				client.chats.get(fork)!.turns.map((t) => t.message.text),
				["first", "second", "third"],
			);
		});

		test("rejects forks it cannot make", async () => {
			const { session, chat, first } = await twoTurns();
			const other = await newSession(host, client);
			const fork = () => `ahp-chat:/${crypto.randomUUID()}`;
			const create = (params: Record<string, unknown>) =>
				client.request("createChat", { channel: session, chat: fork(), ...params });
			await assert.rejects(create({}), /fork source/);
			await assert.rejects(create({ source: { kind: "sideChat", chat, turnId: first } }), /Unsupported chat source/);
			await assert.rejects(create({ source: { kind: "fork", chat, turnId: "nope" } }), /Unknown turn/);
			await assert.rejects(
				create({ source: { kind: "fork", chat: other.chat, turnId: first } }),
				/not a chat of/,
				"the source must be a chat of the session",
			);
			await assert.rejects(
				client.request("createChat", { channel: session, chat, source: { kind: "fork", chat, turnId: first } }),
				/already exists/,
			);
		});
	});

	describe(`forked chats after a restart (${mode})`, () => {
		test("stay chats of their session", async () => {
			const first = await startHost({ mode });
			const client = await TestClient.connect(first.url);
			await client.initialize();
			const { session, chat } = await newSession(first, client);
			const complete = (id: string) =>
				client.waitFor((m) => m.params?.action?.type === "chat/turnComplete" && m.params.action.turnId === id);
			first.faux.setResponses([fauxAssistantMessage("A."), fauxAssistantMessage("B.")]);
			const one = startTurn(client, chat, "one");
			await complete(one);
			await complete(startTurn(client, chat, "two"));
			const fork = `ahp-chat:/${crypto.randomUUID()}`;
			await client.request("createChat", { channel: session, chat: fork, source: { kind: "fork", chat, turnId: one } });
			client.close();
			await first.stop();

			const second = await startHost({ dir: first.dir, mode });
			try {
				const reconnected = await TestClient.connect(second.url);
				await reconnected.initialize();
				const { items } = await reconnected.request("listSessions");
				assert.deepEqual(
					items.map((item: { resource: string }) => item.resource),
					[session],
					"the fork is not listed as a session",
				);
				assert.deepEqual(
					items[0].chats.map((summary: { resource: string }) => summary.resource),
					[chat, fork],
				);
				await reconnected.subscribe(fork);
				assert.deepEqual(
					reconnected.chats.get(fork)!.turns.map((t) => t.message.text),
					["one"],
				);
				const state = (await reconnected.subscribe(session)).state as SessionState;
				assert.deepEqual(
					state.chats.map((summary) => summary.resource),
					[chat, fork],
				);
				reconnected.close();
			} finally {
				await second.cleanup();
			}
		});
	});
}
