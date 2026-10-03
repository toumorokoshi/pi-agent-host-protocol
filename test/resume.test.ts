import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ResponsePartKind } from "@microsoft/agent-host-protocol";
import { lastErroredAssistantEntry } from "../src/pi/embedded-backend.ts";
import { newSession, PI_MODES, startHost, startTurn, TestClient, type TestHost } from "./helpers.ts";

const PARSE_ERROR = "Failed to parse input at pos 12: <tool_call>";

function entry(id: string, role: string, stopReason?: string) {
	return { type: "message", id, parentId: null, timestamp: "", message: { role, stopReason } } as any;
}

describe("lastErroredAssistantEntry", () => {
	test("finds a trailing errored assistant message", () => {
		assert.equal(lastErroredAssistantEntry([entry("u", "user"), entry("a", "assistant", "error")]), "a");
	});

	test("ignores branches that do not end in an assistant error", () => {
		assert.equal(lastErroredAssistantEntry([entry("u", "user"), entry("a", "assistant", "stop")]), undefined);
		assert.equal(lastErroredAssistantEntry([entry("a", "assistant", "error"), entry("u", "user")]), undefined);
		assert.equal(lastErroredAssistantEntry([]), undefined);
	});
});

for (const mode of PI_MODES) {
	describe(`resuming errored turns (${mode})`, () => {
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

		test("a provider error is resumable and resuming completes the same turn", async () => {
			const { chat } = await newSession(host, client);
			let resumedContextRoles: string[] = [];
			host.faux.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage: PARSE_ERROR }),
				(context) => {
					resumedContextRoles = context.messages.map((message) => message.role);
					return fauxAssistantMessage("Recovered.");
				},
			]);
			const turnId = startTurn(client, chat, "Write the files");
			const error = await client.waitFor(
				(m) => m.params?.action?.type === "chat/error" && m.params.action.turnId === turnId,
			);
			assert.equal(error.params.action.part.resumable, true);
			assert.equal(error.params.action.part.error.message, PARSE_ERROR);

			client.dispatch(chat, { type: "chat/turnResume", turnId });
			await client.waitFor((m) => m.params?.action?.type === "chat/turnComplete" && m.params.action.turnId === turnId);

			const state = client.chats.get(chat)!;
			assert.equal(state.turns.length, 1, "the resumed run finished the same turn");
			const turn = state.turns[0]!;
			assert.equal(turn.state, "complete");
			assert.ok(
				turn.responseParts.some((part) => part.kind === ResponsePartKind.Error),
				"the earlier error stays in the response stream",
			);
			assert.equal(turn.responseParts.at(-1)?.kind, "markdown");
			assert.equal((turn.responseParts.at(-1) as { content: string }).content, "Recovered.");
			assert.deepEqual(resumedContextRoles, ["system", "user"], "the failed reply is not sent back to the model");
		});

		test("rejects resuming a turn that did not error", async () => {
			const { chat } = await newSession(host, client);
			host.faux.setResponses([fauxAssistantMessage("Fine.")]);
			const turnId = startTurn(client, chat, "Hello");
			await client.waitFor((m) => m.params?.action?.type === "chat/turnComplete" && m.params.action.turnId === turnId);
			const seq = client.dispatch(chat, { type: "chat/turnResume", turnId });
			const echo = await client.waitFor((m) => m.method === "action" && m.params.origin?.clientSeq === seq);
			assert.equal(echo.params.rejectionReason, "Turn is not the latest errored turn");
		});

		test("errors that are not from the model provider are not resumable", async () => {
			const { chat } = await newSession(host, client);
			const turnId = crypto.randomUUID();
			client.dispatch(chat, {
				type: "chat/turnStarted",
				turnId,
				startedAt: new Date().toISOString(),
				message: { text: "Hi", origin: { kind: "user" }, model: { id: "faux/no-such-model" } },
			});
			const error = await client.waitFor(
				(m) => m.params?.action?.type === "chat/error" && m.params.action.turnId === turnId,
			);
			assert.equal(error.params.action.part.resumable, undefined);
			const seq = client.dispatch(chat, { type: "chat/turnResume", turnId });
			const echo = await client.waitFor((m) => m.method === "action" && m.params.origin?.clientSeq === seq);
			assert.equal(echo.params.rejectionReason, "Turn is not resumable");
		});
	});
}
