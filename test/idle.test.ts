import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type SessionInfo, SessionManager } from "@earendil-works/pi-coding-agent";
import { silentLogger } from "../src/core/logger.ts";
import { AgentHost } from "../src/host/agent-host.ts";
import type { PiAgent, PiBackend } from "../src/pi/agent.ts";
import { BACKGROUND_WORK_META } from "../src/pi/background-work.ts";
import { parseIdleTimeout, suspendBlocker, sweepInterval } from "../src/pi/idle.ts";
import {
	type BackgroundProcess,
	childrenOf,
	newChildren,
	parseProcessTable,
	readProcessTable,
} from "../src/pi/processes.ts";
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

	test("finds children started after the baseline, with their command lines", () => {
		const table = parseProcessTable(
			"  1     0 /sbin/init\n 10     1 pi --mode rpc\n 11    10 mcp-server\n 12    10 npm run  dev\nnot a line\n 13    11\n",
		);
		assert.deepEqual([...childrenOf(table, 10)], [11, 12]);
		assert.deepEqual(newChildren(table, 10, new Set([11])), [{ pid: 12, command: "npm run  dev" }]);
		assert.deepEqual(newChildren(table, 10, new Set([11, 12])), []);
		assert.deepEqual(newChildren(table, 11, new Set()), [{ pid: 13, command: "" }]);
	});

	test("reads this process's children from the real process table", async () => {
		const baseline = childrenOf(await readProcessTable(), process.pid);
		const child = spawn("sleep", ["30"], { stdio: "ignore" });
		try {
			await once(child, "spawn");
			// `ps` itself is also a new child of this process.
			const found = newChildren(await readProcessTable(), process.pid, baseline);
			assert.deepEqual(
				found.filter((p) => p.pid === child.pid),
				[{ pid: child.pid, command: "sleep 30" }],
			);
		} finally {
			child.kill();
		}
	});
});

/** Agents are `FakePi`s; `background` stands in for processes pi started since it became ready. */
class FakeBackend implements PiBackend {
	readonly mode = "rpc";
	readonly pis: FakePi[] = [];
	background: BackgroundProcess[] = [];
	/** When set, reading the process table fails. */
	tableError = false;
	/** When false, agents look like live TUI sessions, which the host never stops. */
	suspendable = true;
	readonly #dir: string;

	constructor(dir: string) {
		this.#dir = dir;
	}

	async models() {
		return [{ provider: "faux", id: "faux-1" }];
	}

	async globalCommands() {
		return [];
	}

	async folderCommands() {
		return [];
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

	async moveSessionManager(manager: SessionManager, newCwd: string): Promise<SessionManager> {
		return SessionManager.create(newCwd, this.#dir, { id: manager.getSessionId() });
	}

	async startAgent(): Promise<PiAgent> {
		const [host, pi] = channelPair();
		this.pis.push(new FakePi(pi));
		return connectRpcAgent(host, silentLogger, {
			backgroundProcesses: this.suspendable
				? async () => {
						if (this.tableError) throw new Error("ps failed");
						return this.background;
					}
				: undefined,
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
		backend.tableError = false;
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
		backend.background = [{ pid: 4242, command: "sleep 60" }];
		clock += TIMEOUT;
		await host.suspendIdleSessions();
		assert.equal(pi.channel.closed, false);
		backend.background = [];
		await host.suspendIdleSessions();
		assert.equal(pi.channel.closed, true);
	});

	test("keeps a pi whose process table cannot be read", async () => {
		await session();
		const pi = backend.pis.at(-1)!;
		backend.tableError = true;
		clock += TIMEOUT;
		await host.suspendIdleSessions();
		assert.equal(pi.channel.closed, false);
		backend.tableError = false;
		await host.suspendIdleSessions();
		assert.equal(pi.channel.closed, true);
	});

	test("publishes background processes as the chat's background work and in the summary", async () => {
		const { session: uri, chat } = await session();
		const changed = (count: number | undefined) =>
			client.waitFor(
				(m) =>
					m.method === "root/sessionSummaryChanged" &&
					m.params.session === uri &&
					m.params.changes._meta !== undefined &&
					m.params.changes._meta[BACKGROUND_WORK_META] === count,
			);

		backend.background = [{ pid: 4242, command: "npm run dev" }];
		await host.refreshBackgroundWork();
		await client.waitFor((m) => m.params?.action?.type === "chat/backgroundWorkSet" && m.params.channel === chat);
		assert.deepEqual(client.chats.get(chat)!.backgroundWork, [
			{
				kind: "shell",
				id: "process:4242",
				label: "npm run dev",
				command: "npm run dev",
				startedAt: new Date(clock).toISOString(),
				_meta: { pid: 4242 },
			},
		]);
		await changed(1);
		const list = await client.request("listSessions", { channel: "ahp-root://" });
		const listed = list.items.find((item: { resource: string }) => item.resource === uri);
		assert.deepEqual(listed._meta, { [BACKGROUND_WORK_META]: 1 });

		// A failed read keeps what was published.
		backend.tableError = true;
		await host.refreshBackgroundWork();
		assert.equal(client.chats.get(chat)!.backgroundWork?.length, 1);
		backend.tableError = false;

		backend.background = [];
		await host.refreshBackgroundWork();
		await client.waitFor((m) => m.params?.action?.type === "chat/backgroundWorkRemoved" && m.params.channel === chat);
		assert.deepEqual(client.chats.get(chat)!.backgroundWork, []);
		await changed(undefined);
	});

	test("does not publish processes that start during a turn until it ends", async () => {
		const { chat } = await session();
		const pi = backend.pis.at(-1)!;
		const events = runEvents("Long task", "Done");
		pi.emit(events.slice(0, 3));
		await client.waitFor((m) => m.params?.action?.type === "chat/turnStarted" && m.params.channel === chat);
		backend.background = [{ pid: 5151, command: "npm test" }];
		await host.refreshBackgroundWork();
		assert.equal(client.chats.get(chat)!.backgroundWork?.length ?? 0, 0, "a tool the turn waits on");

		pi.emit(events.slice(3));
		await client.waitFor((m) => m.params?.action?.type === "chat/turnComplete" && m.params.channel === chat);
		await host.refreshBackgroundWork();
		await client.waitFor((m) => m.params?.action?.type === "chat/backgroundWorkSet" && m.params.channel === chat);
		assert.equal(client.chats.get(chat)!.backgroundWork?.length, 1, "still running after the turn");
		backend.background = [];
		await host.refreshBackgroundWork();
		await client.waitFor((m) => m.params?.action?.type === "chat/backgroundWorkRemoved" && m.params.channel === chat);
	});

	test("never reads a pi terminal's processes", async () => {
		backend.suspendable = false;
		const { chat } = await session();
		backend.background = [{ pid: 6161, command: "sleep 60" }];
		await host.refreshBackgroundWork();
		assert.equal(client.chats.get(chat)!.backgroundWork?.length ?? 0, 0);
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
