import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { parsePiMode } from "../src/pi/agent.ts";
import { omitResumedErrors } from "../src/pi/extensions/ahp-resume.ts";
import { parseModelSelection } from "../src/pi/models.ts";
import { RpcBackend } from "../src/pi/rpc-backend.ts";
import { PiStartError, spawnCommand, splitRecords } from "../src/pi/rpc-process.ts";
import { startedToolCall } from "../src/pi/turn-mapper.ts";
import { newSession, startHost, startTurn, TestClient } from "./helpers.ts";

describe("rpc helpers", () => {
	test("splits JSONL records on LF only", () => {
		const separator = " ";
		assert.deepEqual(splitRecords(`{"a":1}\r\n{"b":"x${separator}y"}\n{"c"`), {
			lines: ['{"a":1}', `{"b":"x${separator}y"}`],
			rest: '{"c"',
		});
		assert.deepEqual(splitRecords("\n\n"), { lines: [], rest: "" });
	});

	test("runs script entry points with this Node and executables directly", () => {
		assert.deepEqual(spawnCommand("/x/cli.js"), { file: process.execPath, args: ["/x/cli.js"] });
		assert.deepEqual(spawnCommand("/x/cli.ts"), { file: process.execPath, args: ["/x/cli.ts"] });
		assert.deepEqual(spawnCommand("pi"), { file: "pi", args: [] });
	});

	test("parses pi modes", () => {
		assert.equal(parsePiMode("RPC"), "rpc");
		assert.equal(parsePiMode("embedded"), "embedded");
		assert.throws(() => parsePiMode("remote"), /Invalid pi mode/);
	});

	test("splits AHP model ids into provider and model", () => {
		assert.deepEqual(parseModelSelection({ id: "llama/qwen/coder" }), { provider: "llama", id: "qwen/coder" });
		assert.equal(parseModelSelection({ id: "no-provider" }), undefined);
		assert.equal(parseModelSelection({ id: "trailing/" }), undefined);
	});

	test("reads a started tool call from either event form", () => {
		assert.deepEqual(startedToolCall({ contentIndex: 0, id: "c1", toolName: "read" }), { id: "c1", name: "read" });
		const partial = { content: [{ type: "text" }, { type: "toolCall", id: "c2", name: "bash" }] };
		assert.deepEqual(startedToolCall({ contentIndex: 1, partial }), { id: "c2", name: "bash" });
		assert.equal(startedToolCall({ contentIndex: 0, partial }), undefined);
	});

	test("the resume extension drops markers and the failed replies they resumed", () => {
		const marker = { role: "custom", customType: "ahp-resume" };
		const failed = { role: "assistant", stopReason: "error" };
		const user = { role: "user" };
		const reply = { role: "assistant", stopReason: "stop" };
		assert.deepEqual(omitResumedErrors([user, failed, marker, reply]), [user, reply]);
		// An error that was not resumed stays in context.
		assert.deepEqual(omitResumedErrors([user, failed, user]), [user, failed, user]);
	});
});

describe("rpc backend", () => {
	test("reports a pi executable that cannot start", async () => {
		const backend = new RpcBackend({ pi: "/nonexistent/pi-agent-host-test/pi" });
		await assert.rejects(backend.models(), (error: unknown) => error instanceof PiStartError);
	});

	test("a pi crash mid-turn ends the turn with a final error, and the next turn starts a new pi", async () => {
		const host = await startHost({ mode: "rpc" });
		const client = await TestClient.connect(host.url);
		try {
			await client.initialize();
			const { chat } = await newSession(host, client);
			host.faux.setResponses([{ exitProcess: 3 } as never]);
			const turnId = startTurn(client, chat, "Crash");
			const error = await client.waitFor(
				(m) => m.params?.action?.type === "chat/error" && m.params.action.turnId === turnId,
			);
			assert.match(error.params.action.part.error.message, /pi exited with code 3/);
			assert.equal(error.params.action.part.resumable, undefined);

			host.faux.setResponses([fauxAssistantMessage("Restarted.")]);
			const next = startTurn(client, chat, "Again");
			await client.waitFor((m) => m.params?.action?.type === "chat/turnComplete" && m.params.action.turnId === next);
			const turn = client.chats.get(chat)!.turns.at(-1)!;
			assert.equal(turn.responseParts.find((part) => part.kind === "markdown")?.content, "Restarted.");
		} finally {
			client.close();
			await host.cleanup();
		}
	});
});
