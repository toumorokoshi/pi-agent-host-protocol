import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { MessageKind, type Turn, TurnState } from "@microsoft/agent-host-protocol";
import { branchTo, recordedUserTurns, truncationTarget } from "../src/pi/truncation.ts";
import { newSession, PI_MODES, startHost, startTurn, TestClient, type TestHost, vscodeChatUri } from "./helpers.ts";

function entry(id: string, parentId: string | null, role?: string) {
	return role
		? { type: "message", id, parentId, message: { role } }
		: { type: "model_change", id, parentId, message: undefined };
}

function turn(id: string, kind: MessageKind = MessageKind.User): Turn {
	return {
		id,
		message: { text: id, origin: { kind } },
		responseParts: [],
		usage: undefined,
		state: TurnState.Complete,
	};
}

describe("truncation helpers", () => {
	const entries = [
		entry("m", null),
		entry("u1", "m", "user"),
		entry("a1", "u1", "assistant"),
		entry("u2", "a1", "user"),
		entry("a2", "u2", "assistant"),
		entry("x", "a1", "user"),
	];

	test("branchTo follows parent links from the leaf", () => {
		assert.deepEqual(
			branchTo(entries, "a2").map((e) => e.id),
			["m", "u1", "a1", "u2", "a2"],
		);
		assert.deepEqual(
			branchTo(entries, "x").map((e) => e.id),
			["m", "u1", "a1", "x"],
		);
		assert.deepEqual(branchTo(entries, null), []);
	});

	test("truncationTarget is the first user message past the kept ones", () => {
		const branch = branchTo(entries, "a2");
		assert.equal(truncationTarget(branch, 0)?.id, "u1");
		assert.equal(truncationTarget(branch, 1)?.id, "u2");
		assert.equal(truncationTarget(branch, 2), undefined);
	});

	test("recordedUserTurns skips continued turns and prompts pi never saw", () => {
		const turns = [turn("t1"), turn("c", MessageKind.SystemNotification), turn("bad"), turn("t2")];
		assert.equal(recordedUserTurns(turns, new Set(["bad"])), 2);
	});
});

for (const mode of PI_MODES) {
	describe(`truncating to edit a message (${mode})`, () => {
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

		test("an edited earlier message restarts from that point", async () => {
			const { chat } = await newSession(host, client);
			let userTexts: string[] = [];
			host.faux.setResponses([
				fauxAssistantMessage("One."),
				fauxAssistantMessage("Two."),
				(context) => {
					userTexts = context.messages
						.filter((message) => message.role === "user")
						.map((message) =>
							typeof message.content === "string"
								? message.content
								: message.content.map((block) => ("text" in block ? block.text : "")).join(""),
						);
					return fauxAssistantMessage("Two, again.");
				},
			]);
			const first = startTurn(client, chat, "first");
			await complete(first);
			const second = startTurn(client, chat, "second");
			await complete(second);

			client.dispatch(chat, { type: "chat/truncated", turnId: first });
			const edited = startTurn(client, chat, "second, edited");
			await complete(edited);

			const state = client.chats.get(chat)!;
			assert.deepEqual(
				state.turns.map((t) => t.message.text),
				["first", "second, edited"],
			);
			assert.deepEqual(userTexts, ["first", "second, edited"], "the dropped turn is not sent to the model");
		});

		test("editing the running message cancels it and restarts", async () => {
			const { chat } = await newSession(host, client);
			const { promise: modelCalled, resolve: onModelCall } = Promise.withResolvers<void>();
			let roles: string[] = [];
			host.faux.setResponses([
				async () => {
					onModelCall();
					await new Promise((resolve) => setTimeout(resolve, 300));
					return fauxAssistantMessage("x".repeat(5000));
				},
				(context) => {
					roles = context.messages.map((message) => message.role);
					return fauxAssistantMessage("Better.");
				},
			]);
			startTurn(client, chat, "do the wrong thing");
			await modelCalled;
			client.dispatch(chat, { type: "chat/truncated" });
			const edited = startTurn(client, chat, "do the right thing");
			await complete(edited);

			const state = client.chats.get(chat)!;
			assert.deepEqual(
				state.turns.map((t) => t.message.text),
				["do the right thing"],
			);
			assert.deepEqual(roles, ["system", "user"], "the cancelled message is not in context");
		});

		test("rejects an unknown turn", async () => {
			const { chat } = await newSession(host, client);
			const seq = client.dispatch(chat, { type: "chat/truncated", turnId: "nope" });
			const echo = await client.waitFor((m) => m.method === "action" && m.params.origin?.clientSeq === seq);
			assert.equal(echo.params.rejectionReason, "Unknown turn");
		});
	});

	describe(`truncation persistence (${mode})`, () => {
		test("a restarted host loads the edited branch", async () => {
			const first = await startHost({ mode });
			const client = await TestClient.connect(first.url);
			await client.initialize();
			const { session } = await newSession(first, client);
			const chat = vscodeChatUri(session);
			const complete = (id: string) =>
				client.waitFor((m) => m.params?.action?.type === "chat/turnComplete" && m.params.action.turnId === id);
			first.faux.setResponses([fauxAssistantMessage("A."), fauxAssistantMessage("B."), fauxAssistantMessage("C.")]);
			const one = startTurn(client, chat, "one");
			await complete(one);
			await complete(startTurn(client, chat, "two"));
			client.dispatch(chat, { type: "chat/truncated", turnId: one });
			await complete(startTurn(client, chat, "two, edited"));
			client.close();
			await first.stop();

			const second = await startHost({ dir: first.dir, mode });
			try {
				const reconnected = await TestClient.connect(second.url);
				await reconnected.initialize();
				await reconnected.subscribe(chat);
				assert.deepEqual(
					reconnected.chats.get(chat)!.turns.map((t) => t.message.text),
					["one", "two, edited"],
				);
				reconnected.close();
			} finally {
				await second.cleanup();
			}
		});
	});
}
