import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { silentLogger } from "../src/core/logger.ts";
import { BridgeServer, HostAlreadyRunningError } from "../src/host/bridges.ts";
import { FakeBridge, runEvents } from "./fake-pi.ts";
import { newSession, startHost, startTurn, TestClient, type TestHost, vscodeChatUri } from "./helpers.ts";

const userEntry = (id: string, text: string) => ({
	type: "message",
	id,
	parentId: null,
	timestamp: "2026-10-03T12:00:00.000Z",
	message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
});
const assistantEntry = (id: string, parentId: string, text: string) => ({
	type: "message",
	id,
	parentId,
	timestamp: "2026-10-03T12:00:01.000Z",
	message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 0 },
});

describe("live TUI sessions over the bridge socket", () => {
	let host: TestHost;
	let client: TestClient;
	before(async () => {
		host = await startHost({ mode: "rpc", bridge: true });
		client = await TestClient.connect(host.url);
		await client.initialize();
	});
	after(async () => {
		client.close();
		await host.cleanup();
	});

	test("an attached TUI session is announced with its live history and runs both ways", async () => {
		const bridge = await FakeBridge.connect(host.socketPath!);
		const sessionId = crypto.randomUUID();
		bridge.entries = [userEntry("u1", "Earlier question"), assistantEntry("a1", "u1", "Earlier answer")];
		const { url } = await bridge.attach({ sessionId, cwd: host.cwd });
		assert.equal(url, host.url, "the bridge learns the URL to show the user");

		const session = `pi:/${sessionId}`;
		const added = await client.waitFor(
			(m) => m.method === "root/sessionAdded" && m.params.summary.resource === session,
		);
		assert.equal(added.params.summary.title, "Earlier question");
		const chat = vscodeChatUri(session);
		await client.subscribe(chat);
		assert.equal(client.chats.get(chat)!.turns[0]!.message.text, "Earlier question");

		// Typed in the TUI.
		bridge.emit(runEvents("From the terminal", "Terminal reply"));
		await client.waitFor(
			(m) => m.params?.action?.type === "chat/turnStarted" && m.params.action.message.text === "From the terminal",
		);
		await client.waitFor((m) => m.params?.action?.type === "chat/turnComplete" && m.params.channel === chat);

		// Sent from VS Code: runs in the TUI's pi.
		bridge.replies = ["Reply in the TUI"];
		const turnId = startTurn(client, chat, "From VS Code");
		await client.waitFor((m) => m.params?.action?.type === "chat/turnComplete" && m.params.action.turnId === turnId);
		assert.ok(bridge.commands.some((command) => command.type === "prompt" && command.message === "From VS Code"));
		const turn = client.chats.get(chat)!.turns.at(-1)!;
		assert.equal(turn.responseParts.find((part) => part.kind === "markdown")?.content, "Reply in the TUI");
		await bridge.close();
	});

	test("after the TUI lets go, the next turn runs in a pi started by the host", async () => {
		const bridge = await FakeBridge.connect(host.socketPath!);
		const sessionId = crypto.randomUUID();
		await bridge.attach({ sessionId, cwd: host.cwd });
		const chat = vscodeChatUri(`pi:/${sessionId}`);
		await client.waitFor((m) => m.method === "root/sessionAdded" && m.params.summary.resource === `pi:/${sessionId}`);
		await client.subscribe(chat);

		// A run in progress when the TUI quits ends with an error.
		const events = runEvents("Interrupted", "never");
		bridge.emit(events.slice(0, 3));
		const started = await client.waitFor(
			(m) => m.params?.action?.type === "chat/turnStarted" && m.params.action.message.text === "Interrupted",
		);
		await bridge.detach(sessionId);
		const error = await client.waitFor(
			(m) => m.params?.action?.type === "chat/error" && m.params.action.turnId === started.params.action.turnId,
		);
		assert.match(error.params.action.part.error.message, /pi closed the session/);

		host.faux.setResponses([fauxAssistantMessage("From the host's pi.")]);
		const turnId = startTurn(client, chat, "Still there?");
		await client.waitFor((m) => m.params?.action?.type === "chat/turnComplete" && m.params.action.turnId === turnId);
		assert.equal(
			client.chats
				.get(chat)!
				.turns.at(-1)!
				.responseParts.find((part) => part.kind === "markdown")?.content,
			"From the host's pi.",
		);
		await bridge.close();
	});

	test("a session the host is running is handed over to a TUI that opens it", async () => {
		const { session, chat } = await newSession(host, client);
		const sessionId = session.slice("pi:/".length);
		host.faux.setResponses([fauxAssistantMessage("Host pi.")]);
		const first = startTurn(client, chat, "First");
		await client.waitFor((m) => m.params?.action?.type === "chat/turnComplete" && m.params.action.turnId === first);

		const bridge = await FakeBridge.connect(host.socketPath!);
		await bridge.attach({ sessionId, cwd: host.cwd });
		await waitUntil(() => bridge.commands.some((command) => command.type === "get_commands"));
		bridge.replies = ["TUI pi."];
		const second = startTurn(client, chat, "Second");
		await client.waitFor((m) => m.params?.action?.type === "chat/turnComplete" && m.params.action.turnId === second);
		assert.ok(bridge.commands.some((command) => command.type === "prompt" && command.message === "Second"));
		await bridge.close();
	});

	test("rejects a bridge that speaks another protocol version", async () => {
		const bridge = await FakeBridge.connect(host.socketPath!);
		await assert.rejects(
			bridge.attach({ sessionId: crypto.randomUUID(), cwd: host.cwd, protocol: 99 }),
			/bridge protocol 1/,
		);
		await bridge.close();
	});
});

describe("bridge socket", () => {
	const handler = { attachLive: async () => {} };

	test("a second host on the same socket reports the one already running", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-agent-host-protocol-sock-"));
		const path = join(dir, "host.sock");
		const first = await BridgeServer.listen(path, handler, silentLogger);
		try {
			await assert.rejects(
				BridgeServer.listen(path, handler, silentLogger),
				(error: unknown) => error instanceof HostAlreadyRunningError,
			);
		} finally {
			await first.close();
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("replaces the socket of a host that died without cleaning up", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-agent-host-protocol-sock-"));
		const path = join(dir, "host.sock");
		const child = spawn(process.execPath, [
			"-e",
			`require("node:net").createServer().listen(${JSON.stringify(path)}, () => console.log("up"))`,
		]);
		await new Promise((resolve) => child.stdout.once("data", resolve));
		child.kill("SIGKILL");
		await new Promise((resolve) => child.once("exit", resolve));
		assert.ok(existsSync(path), "the dead host left its socket file");
		const server = await BridgeServer.listen(path, handler, silentLogger);
		await server.close();
		await rm(dir, { recursive: true, force: true });
	});
});

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
