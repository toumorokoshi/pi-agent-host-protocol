import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";
import { silentLogger } from "../src/core/logger.ts";
import { AgentHost } from "../src/host/agent-host.ts";
import type { PiAgent, PiBackend } from "../src/pi/agent.ts";
import { parseIdleTimeout, suspendBlocker, sweepInterval } from "../src/pi/idle.ts";
import { childrenOf, newChildren, parseProcessTable } from "../src/pi/processes.ts";
import { connectRpcAgent } from "../src/pi/rpc-agent.ts";
import { type Listener, listen } from "../src/transport/websocket.ts";
import { FakePi, runEvents } from "./fake-pi.ts";
import { channelPair, newSession, startHost, startTurn, TestClient, vscodeChatUri } from "./helpers.ts";

const MINUTE = 60_000;
const TIMEOUT = 30 * MINUTE;

describe("idle helpers", () => {
	test("parses idle timeouts in minutes", () => {
		assert.equal(parseIdleTimeout("30"), 30 * MINUTE);
		assert.equal(parseIdleTimeout(0.5), 30_000);
		assert.equal(parseIdleTimeout("0"), 0);
		assert.throws(() => parseIdleTimeout("-1"));
		assert.throws(() => parseIdleTimeout("soon"));
		assert.throws(() => parseIdleTimeout(" "));
	});

	test("sweeps at half the timeout, between 1 s and 1 min", () => {
		assert.equal(sweepInterval(30 * MINUTE), MINUTE);
		assert.equal(sweepInterval(10_000), 5_000);
		assert.equal(sweepInterval(100), 1_000);
	});

	test("a session may be suspended only when idle past the cutoff", () => {
		const idle = { suspendable: true, running: false, pending: false, lastActivity: 100 };
		assert.equal(suspendBlocker(idle, 100), undefined);
		assert.equal(suspendBlocker({ ...idle, lastActivity: 101 }, 100), "recently active");
		assert.equal(suspendBlocker({ ...idle, running: true }, 100), "running");
		assert.equal(suspendBlocker({ ...idle, pending: true }, 100), "pending messages");
		assert.equal(suspendBlocker({ ...idle, suspendable: false }, 100), "not suspendable");
	});

	test("finds children started after the baseline", () => {
		const table = parseProcessTable("  1     0\n 10     1\n 11    10\n 12    10\nnot a line\n 13    11\n");
		assert.deepEqual([...childrenOf(table, 10)], [11, 12]);
		assert.deepEqual(newChildren(table, 10, new Set([11])), [12]);
		assert.deepEqual(newChildren(table, 10, new Set([11, 12])), []);
	});
});

/** Agents are `FakePi`s; `background` stands in for processes pi started since it became ready. */
class FakeBackend implements PiBackend {
	readonly mode = "rpc";
	readonly pis: FakePi[] = [];
	background: number[] = [];
	/** When false, agents look like live TUI sessions, which the host never stops. */
	suspendable = true;
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
		return connectRpcAgent(host, silentLogger, {
			backgroundProcesses: this.suspendable ? async () => this.background : undefined,
		});
	}

	async dispose(): Promise<void> {}
}

describe("idle sessions", () => {
	let dir: string;
	let backend: FakeBackend;
	let host: AgentHost;
	let listener: Listener;
	let client: TestClient;
	let clock = 0;

	before(async () => {
		dir = await mkdtemp(join(tmpdir(), "pi-agent-host-protocol-idle-"));
		backend = new FakeBackend(dir);
		host = new AgentHost({ backend, defaultDirectory: dir, idleTimeoutMs: TIMEOUT, now: () => clock });
		listener = await listen(host, { host: "127.0.0.1", port: 0, token: undefined });
		client = await TestClient.connect(listener.url);
		await client.initialize();
	});
	beforeEach(() => {
		backend.background = [];
		backend.suspendable = true;
	});
	after(async () => {
		client.close();
		await listener.close();
		await host.dispose();
		await rm(dir, { recursive: true, force: true });
	});

	const session = () => newSession({ cwd: dir } as never, client);
	const runTurn = async (chat: string, text: string) => {
		const turnId = startTurn(client, chat, text);
		await client.waitFor((m) => m.params?.action?.type === "chat/turnComplete" && m.params.action.turnId === turnId);
	};

	test("stops an idle pi, keeps the session listed, and starts a new pi for the next turn", async () => {
		const { session: uri, chat } = await session();
		const pi = backend.pis.at(-1)!;
		pi.replies = ["First"];
		await runTurn(chat, "Hello");

		clock += TIMEOUT - 1;
		assert.equal(await host.suspendIdleSessions(), 0, "not idle long enough");
		clock += 1;
		assert.equal(await host.suspendIdleSessions(), 1);
		assert.equal(pi.channel.closed, true, "pi was stopped");

		const list = await client.request("listSessions", { channel: "ahp-root://" });
		assert.ok(
			list.items.some((item: { resource: string }) => item.resource === uri),
			"still listed",
		);
		assert.equal(client.chats.get(chat)!.turns.length, 1, "state unchanged");

		const before = backend.pis.length;
		await runTurn(chat, "Again");
		assert.equal(backend.pis.length, before + 1, "a new pi was started");
		assert.equal(client.chats.get(chat)!.turns.length, 2);
	});

	test("client activity restarts the idle clock", async () => {
		const { session: uri } = await session();
		const pi = backend.pis.at(-1)!;
		clock += TIMEOUT;
		client.dispatch(uri, { type: "session/titleChanged", title: "Renamed" });
		await client.waitFor((m) => m.params?.action?.type === "session/titleChanged" && m.params.channel === uri);
		await host.suspendIdleSessions();
		assert.equal(pi.channel.closed, false);
	});

	test("keeps a pi with background processes", async () => {
		await session();
		const pi = backend.pis.at(-1)!;
		backend.background = [4242];
		clock += TIMEOUT;
		await host.suspendIdleSessions();
		assert.equal(pi.channel.closed, false);
		backend.background = [];
		await host.suspendIdleSessions();
		assert.equal(pi.channel.closed, true);
	});

	test("keeps a pi while a run typed in the terminal is in progress", async () => {
		const { chat } = await session();
		const pi = backend.pis.at(-1)!;
		const events = runEvents("Long task", "Done");
		pi.emit(events.slice(0, 3));
		await client.waitFor((m) => m.params?.action?.type === "chat/turnStarted" && m.params.channel === chat);
		clock += TIMEOUT;
		await host.suspendIdleSessions();
		assert.equal(pi.channel.closed, false);
		pi.emit(events.slice(3));
		await client.waitFor((m) => m.params?.action?.type === "chat/turnComplete" && m.params.channel === chat);
	});

	test("never stops a pi the host did not start", async () => {
		backend.suspendable = false;
		await session();
		const pi = backend.pis.at(-1)!;
		clock += 10 * TIMEOUT;
		await host.suspendIdleSessions();
		assert.equal(pi.channel.closed, false);
	});
});

describe("idle sessions (rpc)", () => {
	test("a suspended session reloads its history into a new pi", async () => {
		let clock = 0;
		const host = await startHost({ mode: "rpc", idleTimeoutMs: TIMEOUT, now: () => clock });
		const client = await TestClient.connect(host.url);
		try {
			await client.initialize();
			const { session } = await newSession(host, client);
			const chat = vscodeChatUri(session);
			host.faux.setResponses([fauxAssistantMessage("The answer is 42.")]);
			const first = startTurn(client, chat, "Remember 42");
			await client.waitFor((m) => m.params?.action?.type === "chat/turnComplete" && m.params.action.turnId === first);

			clock += TIMEOUT;
			assert.equal(await host.host.suspendIdleSessions(), 1);

			// The new pi sends the earlier exchange to the model.
			let context = "";
			host.faux.setResponses([
				(request: { messages: unknown[] }) => {
					context = JSON.stringify(request.messages);
					return fauxAssistantMessage("Still 42.");
				},
			]);
			const next = startTurn(client, chat, "What was it?");
			await client.waitFor((m) => m.params?.action?.type === "chat/turnComplete" && m.params.action.turnId === next);
			assert.match(context, /The answer is 42\./);
			assert.equal(client.chats.get(chat)!.turns.length, 2);
		} finally {
			client.close();
			await host.cleanup();
		}
	});
});
