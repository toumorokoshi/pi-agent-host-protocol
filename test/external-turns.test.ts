import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { type SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";
import { silentLogger } from "../src/core/logger.ts";
import { AgentHost } from "../src/host/agent-host.ts";
import type { PiAgent, PiBackend } from "../src/pi/agent.ts";
import { connectRpcAgent } from "../src/pi/rpc-agent.ts";
import { type Listener, listen } from "../src/transport/websocket.ts";
import { FakePi, runEvents } from "./fake-pi.ts";
import { channelPair, newSession, TestClient } from "./helpers.ts";

/** A backend whose agents are `FakePi`s, so tests can play runs that the host did not start. */
class FakeBackend implements PiBackend {
	readonly mode = "rpc";
	readonly pis: FakePi[] = [];
	readonly #dir: string;

	constructor(dir: string) {
		this.#dir = dir;
	}

	async models() {
		return [{ provider: "faux", id: "faux-1" }];
	}

	listSessions(): Promise<SessionInfo[]> {
		return SessionManager.listAll(this.#dir);
	}

	newSessionManager(cwd: string, id: string): SessionManager {
		return SessionManager.create(cwd, this.#dir, { id });
	}

	openSessionManager(path: string): SessionManager {
		return SessionManager.open(path, this.#dir);
	}

	async startAgent(): Promise<PiAgent> {
		const [host, pi] = channelPair();
		this.pis.push(new FakePi(pi));
		return connectRpcAgent(host, silentLogger);
	}

	async dispose(): Promise<void> {}
}

describe("turns started outside the host", () => {
	let dir: string;
	let backend: FakeBackend;
	let host: AgentHost;
	let listener: Listener;
	let client: TestClient;

	before(async () => {
		dir = await mkdtemp(join(tmpdir(), "pi-agent-host-external-"));
		backend = new FakeBackend(dir);
		host = new AgentHost({ backend, defaultDirectory: dir });
		listener = await listen(host, { host: "127.0.0.1", port: 0, token: undefined });
		client = await TestClient.connect(listener.url);
		await client.initialize();
	});
	after(async () => {
		client.close();
		await listener.close();
		await host.dispose();
		await rm(dir, { recursive: true, force: true });
	});

	const started = (chat: string, after: number) =>
		client.waitFor(
			(m) => m.params?.action?.type === "chat/turnStarted" && m.params.channel === chat && m.params.serverSeq > after,
		);
	const lastSeq = () => Math.max(0, ...client.envelopes.map((envelope) => envelope.serverSeq));

	test("a run typed in pi becomes a host-originated turn", async () => {
		const { chat } = await newSession({ cwd: dir } as never, client);
		const pi = backend.pis.at(-1)!;
		const seq = lastSeq();
		pi.emit(runEvents("Typed in the terminal", "Hello from the TUI"));
		const start = await started(chat, seq);
		assert.equal(start.params.origin, undefined, "the host, not a client, started the turn");
		assert.equal(start.params.action.message.text, "Typed in the terminal");
		const turnId = start.params.action.turnId;
		await client.waitFor((m) => m.params?.action?.type === "chat/turnComplete" && m.params.action.turnId === turnId);
		const turn = client.chats.get(chat)!.turns.at(-1)!;
		assert.equal(turn.responseParts.find((part) => part.kind === "markdown")?.content, "Hello from the TUI");
	});

	test("an assistant message without a user message opens a continued turn", async () => {
		const { chat } = await newSession({ cwd: dir } as never, client);
		const seq = lastSeq();
		backend.pis.at(-1)!.emit(runEvents(undefined, "More"));
		const start = await started(chat, seq);
		assert.equal(start.params.action.message.text, "Continued in pi");
		assert.equal(start.params.action.message.origin.kind, "systemNotification");
	});

	test("cancelling an outside turn aborts pi, and the rest of that run is ignored", async () => {
		const { chat } = await newSession({ cwd: dir } as never, client);
		const pi = backend.pis.at(-1)!;
		const events = runEvents("Long task", "Done");
		const seq = lastSeq();
		pi.emit(events.slice(0, 3));
		const turnId = (await started(chat, seq)).params.action.turnId;
		client.dispatch(chat, { type: "chat/turnCancelled", turnId, duration: 5 });
		await client.waitFor((m) => m.params?.action?.type === "chat/turnCancelled" && m.params.action.turnId === turnId);
		await waitUntil(() => pi.commands.some((command) => command.type === "abort"));
		pi.emit(events.slice(3));
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(client.chats.get(chat)!.turns.length, 1, "no new turn from the aborted run's events");
	});

	test("a message the client queued during an outside turn runs once pi settles", async () => {
		const { chat } = await newSession({ cwd: dir } as never, client);
		const pi = backend.pis.at(-1)!;
		pi.replies = ["Queued reply"];
		const events = runEvents("From the TUI", "TUI reply");
		const seq = lastSeq();
		pi.emit(events.slice(0, 3));
		await started(chat, seq);
		client.dispatch(chat, {
			type: "chat/pendingMessageSet",
			kind: "queued",
			id: "q1",
			message: { text: "From VS Code", origin: { kind: "user" } },
		});
		pi.emit(events.slice(3));
		const queued = await client.waitFor(
			(m) => m.params?.action?.type === "chat/turnStarted" && m.params.action.queuedMessageId === "q1",
		);
		await client.waitFor(
			(m) => m.params?.action?.type === "chat/turnComplete" && m.params.action.turnId === queued.params.action.turnId,
		);
		const turns = client.chats.get(chat)!.turns;
		assert.deepEqual(
			turns.map((turn) => turn.message.text),
			["From the TUI", "From VS Code"],
		);
		assert.equal(turns[1]!.responseParts.find((part) => part.kind === "markdown")?.content, "Queued reply");
	});
});

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
