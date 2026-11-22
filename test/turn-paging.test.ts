import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
	ActionType,
	ChatOriginKind,
	type ChatState,
	JsonRpcErrorCodes,
	MessageKind,
	SessionStatus,
	type Turn,
	TurnState,
} from "@microsoft/agent-host-protocol";
import {
	parseTurnsCursor,
	splitTailTurns,
	takeTurnsPage,
	trimChatSnapshot,
	turnsCursor,
} from "../src/pi/turn-paging.ts";
import { startHost, TestClient, type TestHost } from "./helpers.ts";

function fakeTurn(id: string, text = `msg-${id}`): Turn {
	return {
		id,
		startedAt: new Date().toISOString(),
		message: { text, origin: { kind: MessageKind.User } },
		responseParts: [],
		usage: undefined,
		state: TurnState.Complete,
	};
}

function fakeChatState(turns: Turn[], turnsNextCursor?: string): ChatState {
	return {
		resource: "ahp-chat://default/test",
		title: "Test",
		status: SessionStatus.Idle,
		turns,
		...(turnsNextCursor !== undefined ? { turnsNextCursor } : {}),
		modifiedAt: new Date().toISOString(),
	};
}

describe("turn-paging helpers", () => {
	it("splits tail turns and encodes/parses cursors", () => {
		const turns = [fakeTurn("1"), fakeTurn("2"), fakeTurn("3"), fakeTurn("4"), fakeTurn("5")];

		const full = splitTailTurns(turns, undefined);
		assert.deepEqual(
			full.visible.map((t) => t.id),
			["1", "2", "3", "4", "5"],
		);
		assert.equal(full.older.length, 0);
		assert.equal(full.nextCursor, undefined);

		const tail2 = splitTailTurns(turns, 2);
		assert.deepEqual(
			tail2.visible.map((t) => t.id),
			["4", "5"],
		);
		assert.deepEqual(
			tail2.older.map((t) => t.id),
			["1", "2", "3"],
		);
		assert.equal(tail2.nextCursor, "turns:3");
		assert.equal(parseTurnsCursor("turns:3"), 3);

		const zero = splitTailTurns(turns, 0);
		assert.equal(zero.visible.length, 0);
		assert.equal(zero.older.length, 5);
		assert.equal(zero.nextCursor, "turns:5");

		assert.equal(turnsCursor(0), undefined);
		assert.equal(parseTurnsCursor("turns:0"), undefined);
		assert.equal(parseTurnsCursor("bogus"), undefined);
	});

	it("pages older turns from the newest end of the older prefix", () => {
		const older = [fakeTurn("1"), fakeTurn("2"), fakeTurn("3"), fakeTurn("4"), fakeTurn("5")];
		const page1 = takeTurnsPage(older, 2);
		assert.deepEqual(
			page1.page.map((t) => t.id),
			["4", "5"],
		);
		assert.deepEqual(
			page1.remaining.map((t) => t.id),
			["1", "2", "3"],
		);
		assert.equal(page1.nextCursor, "turns:3");

		const page2 = takeTurnsPage(page1.remaining, 5);
		assert.deepEqual(
			page2.page.map((t) => t.id),
			["1", "2", "3"],
		);
		assert.equal(page2.remaining.length, 0);
		assert.equal(page2.nextCursor, undefined);
	});

	it("trims an existing ChatState snapshot while preserving remaining cursor offset", () => {
		const state = fakeChatState([fakeTurn("3"), fakeTurn("4"), fakeTurn("5")], "turns:2");
		const trimmed = trimChatSnapshot(state, 1, 2);
		assert.deepEqual(
			trimmed.turns.map((t) => t.id),
			["5"],
		);
		assert.equal(trimmed.turnsNextCursor, "turns:4");

		const zero = trimChatSnapshot(state, 0, 2);
		assert.equal(zero.turns.length, 0);
		assert.equal(zero.turnsNextCursor, "turns:5");

		const unchanged = trimChatSnapshot(state, 10, 2);
		assert.equal(unchanged, state);
	});
});

async function seedSession(host: TestHost, turnCount: number): Promise<{ sessionUri: string; chatUri: string }> {
	const client = await TestClient.connect(host.url);
	try {
		await client.initialize();
		const id = crypto.randomUUID();
		const sessionUri = `ahp-session:/${id}`;
		const chatUri = `ahp-chat://default/${Buffer.from(sessionUri).toString("base64url")}`;
		await client.request("createSession", { channel: sessionUri, workingDirectory: `file://${host.cwd}` });
		await client.subscribe(sessionUri);
		await client.subscribe(chatUri);

		host.faux.setResponses(Array.from({ length: turnCount }, (_, i) => fauxAssistantMessage(`reply ${i + 1}`)));
		for (let i = 1; i <= turnCount; i++) {
			client.dispatch(chatUri, {
				type: ActionType.ChatTurnStarted,
				turnId: `seed-${i}`,
				startedAt: new Date().toISOString(),
				message: { text: `prompt ${i}`, origin: { kind: MessageKind.User } },
			});
			await client.waitFor(
				(m) =>
					m.method === "action" &&
					m.params?.action?.type === ActionType.ChatTurnComplete &&
					m.params?.action?.turnId === `seed-${i}`,
			);
		}
		return { sessionUri, chatUri };
	} finally {
		client.close();
	}
}

describe("view.turns and fetchTurns e2e", () => {
	let host: TestHost | undefined;
	afterEach(async () => {
		await host?.cleanup();
		host = undefined;
	});

	it("honors view.turns on subscribe and pages older turns via fetchTurns", async () => {
		host = await startHost({ mode: "embedded" });
		const { chatUri } = await seedSession(host, 5);
		const dir = host.dir;
		await host.stop();

		host = await startHost({ mode: "embedded", dir });
		const client = await TestClient.connect(host.url);
		try {
			await client.initialize();
			await client.subscribe(chatUri, { turns: 2 });

			const initial = client.chats.get(chatUri);
			assert.ok(initial);
			assert.deepEqual(
				initial.turns.map((t) => t.message.text),
				["prompt 4", "prompt 5"],
			);
			assert.ok(initial.turnsNextCursor);

			await client.request("fetchTurns", { channel: chatUri, cursor: initial.turnsNextCursor });
			const loaded = client.chats.get(chatUri);
			assert.ok(loaded);
			assert.deepEqual(
				loaded.turns.map((t) => t.message.text),
				["prompt 1", "prompt 2", "prompt 3", "prompt 4", "prompt 5"],
			);
			assert.equal(loaded.turnsNextCursor, undefined);
		} finally {
			client.close();
		}
	});

	it("supports view.turns = 0 and rejects invalid cursors", async () => {
		host = await startHost({ mode: "embedded" });
		const { chatUri } = await seedSession(host, 3);
		const dir = host.dir;
		await host.stop();

		host = await startHost({ mode: "embedded", dir });
		const client = await TestClient.connect(host.url);
		try {
			await client.initialize();
			await client.subscribe(chatUri, { turns: 0 });
			const initial = client.chats.get(chatUri);
			assert.ok(initial);
			assert.equal(initial.turns.length, 0);
			assert.ok(initial.turnsNextCursor);

			await assert.rejects(
				() => client.request("fetchTurns", { channel: chatUri, cursor: "invalid-cursor" }),
				(err: { code?: number }) => err.code === JsonRpcErrorCodes.InvalidParams,
			);
			await assert.rejects(
				() => client.request("fetchTurns", { channel: chatUri, cursor: "turns:99" }),
				(err: { code?: number }) => err.code === JsonRpcErrorCodes.InvalidParams,
			);
		} finally {
			client.close();
		}
	});

	it("handles multiple subscribers with different view.turns", async () => {
		host = await startHost({ mode: "embedded" });
		const { chatUri } = await seedSession(host, 5);
		const dir = host.dir;
		await host.stop();

		host = await startHost({ mode: "embedded", dir });
		const client1 = await TestClient.connect(host.url);
		const client2 = await TestClient.connect(host.url);
		try {
			await client1.initialize();
			await client1.subscribe(chatUri); // full
			assert.equal(client1.chats.get(chatUri)?.turns.length, 5);
			assert.equal(client1.chats.get(chatUri)?.turnsNextCursor, undefined);

			await client2.initialize();
			await client2.subscribe(chatUri, { turns: 2 }); // trimmed snapshot
			const c2 = client2.chats.get(chatUri);
			assert.ok(c2);
			assert.deepEqual(
				c2.turns.map((t) => t.message.text),
				["prompt 4", "prompt 5"],
			);
			assert.ok(c2.turnsNextCursor);

			await client2.request("fetchTurns", { channel: chatUri, cursor: c2.turnsNextCursor });
			const c2After = client2.chats.get(chatUri);
			assert.ok(c2After);
			assert.deepEqual(
				c2After.turns.map((t) => t.message.text),
				["prompt 1", "prompt 2", "prompt 3", "prompt 4", "prompt 5"],
			);
			assert.equal(c2After.turnsNextCursor, undefined);
		} finally {
			client1.close();
			client2.close();
		}
	});

	it("eagerly backfills older turns when forking or truncating an unloaded turn", async () => {
		host = await startHost({ mode: "embedded" });
		const { sessionUri, chatUri } = await seedSession(host, 4);
		const dir = host.dir;
		await host.stop();

		host = await startHost({ mode: "embedded", dir });
		const client = await TestClient.connect(host.url);
		try {
			await client.initialize();
			await client.subscribe(sessionUri);
			await client.subscribe(chatUri, { turns: 1 });
			assert.equal(client.chats.get(chatUri)?.turns.length, 1);

			// Read the full turn IDs from a second client? No—let's get the 2nd turn ID via fetchTurns?
			// Wait: we want to test forking/truncating an UNLOADED turn, so let's read the session file's turn IDs
			// from listSessions/SessionManager or subscribe with a helper client? Wait: if a helper client
			// subscribes without view, it would call loadAllTurns(). Instead, we can get the turn IDs from
			// the seeded session's entries before restarting, or read `host.host.backend`!
			const sessions = await host.host.backend.listSessions();
			const manager = host.host.backend.openSessionManager(sessions[0]!.path);
			const userEntries = manager.getBranch().filter((e) => e.type === "message" && e.message.role === "user");
			const secondTurnId = userEntries[1]!.id;

			// Fork at the 2nd turn (which is not yet loaded in `chatUri`'s window).
			const forkChatUri = `ahp-chat://fork/${crypto.randomUUID()}`;
			await client.request("createChat", {
				channel: sessionUri,
				chat: forkChatUri,
				source: { kind: ChatOriginKind.Fork, chat: chatUri, turnId: secondTurnId },
			});
			await client.subscribe(forkChatUri);
			assert.deepEqual(
				client.chats.get(forkChatUri)?.turns.map((t) => t.message.text),
				["prompt 1", "prompt 2"],
			);

			// Truncate to the 1st turn (already loaded via the fork backfill above, so test truncation on a fresh restart too).
		} finally {
			client.close();
		}
	});

	it("eagerly backfills older turns when truncating to an unloaded turn", async () => {
		host = await startHost({ mode: "embedded" });
		const { sessionUri, chatUri } = await seedSession(host, 4);
		const dir = host.dir;
		await host.stop();

		host = await startHost({ mode: "embedded", dir });
		const client = await TestClient.connect(host.url);
		try {
			await client.initialize();
			await client.subscribe(sessionUri);
			await client.subscribe(chatUri, { turns: 1 });
			assert.equal(client.chats.get(chatUri)?.turns.length, 1);

			const sessions = await host.host.backend.listSessions();
			const manager = host.host.backend.openSessionManager(sessions[0]!.path);
			const userEntries = manager.getBranch().filter((e) => e.type === "message" && e.message.role === "user");
			const secondTurnId = userEntries[1]!.id;

			client.dispatch(chatUri, { type: ActionType.ChatTruncated, turnId: secondTurnId });
			await client.waitForAction(ActionType.ChatTruncated);
			assert.deepEqual(
				client.chats.get(chatUri)?.turns.map((t) => t.message.text),
				["prompt 1", "prompt 2"],
			);
		} finally {
			client.close();
		}
	});
});
