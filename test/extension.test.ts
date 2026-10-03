import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { silentLogger } from "../src/core/logger.ts";
import { BridgeClient } from "../src/extension/client.ts";
import { executeHostCommand } from "../src/extension/commands.ts";
import piAgentHostBridge from "../src/extension/index.ts";
import { BridgeServer } from "../src/host/bridges.ts";
import { runEvents } from "./fake-pi.ts";
import { startHost, startTurn, TestClient, vscodeChatUri } from "./helpers.ts";

interface Call {
	method: string;
	args: unknown[];
}

/** Fake `pi` and `ctx` objects that record what the bridge calls. */
function fakePi(options: { idle?: boolean; sessionId?: string } = {}) {
	const calls: Call[] = [];
	const notices: string[] = [];
	const record =
		(method: string, result?: unknown) =>
		(...args: unknown[]) => {
			calls.push({ method, args });
			return result;
		};
	const model = { provider: "faux", id: "faux-1" };
	const pi = {
		sendUserMessage: record("sendUserMessage"),
		sendMessage: record("sendMessage"),
		setModel: async (...args: unknown[]) => (calls.push({ method: "setModel", args }), true),
		getThinkingLevel: () => "off",
		setThinkingLevel: record("setThinkingLevel"),
		setSessionName: record("setSessionName"),
		getSessionName: () => undefined,
		getCommands: () => [{ name: "ahp-resume" }],
		on: record("on"),
		registerCommand: record("registerCommand"),
	};
	const ctx = {
		mode: "tui",
		cwd: "/tmp",
		model,
		isIdle: () => options.idle ?? true,
		abort: record("abort"),
		modelRegistry: {
			find: (provider: string, id: string) => (provider === "faux" && id === "faux-1" ? model : undefined),
		},
		sessionManager: {
			getSessionId: () => options.sessionId ?? "s1",
			getSessionFile: () => undefined,
			getBranch: () => [],
		},
		ui: { notify: (message: string) => notices.push(message) },
	};
	return { pi: pi as any, ctx: ctx as any, calls, notices };
}

describe("bridge commands", () => {
	test("prompts start a run when idle and queue a follow-up while pi is busy", async () => {
		const idle = fakePi({ idle: true });
		assert.deepEqual(await executeHostCommand({ type: "prompt", message: "Hi" }, idle.pi, idle.ctx), {
			disposition: "started",
		});
		assert.deepEqual(idle.calls[0], { method: "sendUserMessage", args: ["Hi", { expandPromptTemplates: true }] });

		const busy = fakePi({ idle: false });
		const images = [{ type: "image", data: "AAAA", mimeType: "image/png" }];
		assert.deepEqual(await executeHostCommand({ type: "prompt", message: "Also", images }, busy.pi, busy.ctx), {
			disposition: "queued",
		});
		assert.deepEqual(busy.calls[0]!.args, [
			[{ type: "text", text: "Also" }, ...images],
			{ expandPromptTemplates: true, deliverAs: "followUp" },
		]);
	});

	test("resume, steer, abort, model and names map to pi's extension API", async () => {
		const { pi, ctx, calls } = fakePi();
		assert.deepEqual(await executeHostCommand({ type: "prompt", message: "/ahp-resume" }, pi, ctx), {
			disposition: "handled",
		});
		assert.equal(calls.at(-1)!.method, "sendMessage");
		await executeHostCommand({ type: "steer", message: "Stop" }, pi, ctx);
		assert.deepEqual(calls.at(-1)!.args[1], { expandPromptTemplates: true, deliverAs: "steer" });
		await executeHostCommand({ type: "abort" }, pi, ctx);
		assert.equal(calls.at(-1)!.method, "abort");
		assert.deepEqual(await executeHostCommand({ type: "set_model", provider: "faux", modelId: "faux-1" }, pi, ctx), {
			provider: "faux",
			id: "faux-1",
		});
		await assert.rejects(
			executeHostCommand({ type: "set_model", provider: "faux", modelId: "nope" }, pi, ctx),
			/Model not found/,
		);
		await executeHostCommand({ type: "set_session_name", name: "Named" }, pi, ctx);
		assert.deepEqual(calls.at(-1), { method: "setSessionName", args: ["Named"] });
		assert.deepEqual(await executeHostCommand({ type: "get_state" }, pi, ctx), {
			model: { provider: "faux", id: "faux-1" },
			thinkingLevel: "off",
			isStreaming: false,
		});
		await assert.rejects(executeHostCommand({ type: "bash" }, pi, ctx), /Unknown command/);
	});
});

describe("bridge extension", () => {
	test("stays inactive inside the host's own pi processes", () => {
		const { pi, calls } = fakePi();
		process.env.PI_AGENT_HOST_DAEMON = "1";
		try {
			piAgentHostBridge(pi);
		} finally {
			delete process.env.PI_AGENT_HOST_DAEMON;
		}
		assert.deepEqual(calls, []);
	});

	test("shares the session with a running host, forwards its runs and takes commands", async () => {
		const host = await startHost({ mode: "rpc", bridge: true });
		const client = await TestClient.connect(host.url);
		const bridge = new BridgeClient({
			socketPath: host.socketPath!,
			logFile: join(host.dir, "host.log"),
			startHost: () => assert.fail("must not start a host when one is running"),
		});
		try {
			await client.initialize();
			const sessionId = crypto.randomUUID();
			const fake = fakePi({ sessionId });
			await bridge.sessionStarted(fake.pi, fake.ctx);
			assert.equal(bridge.attachedSession, sessionId);
			assert.deepEqual(fake.notices, [], "no URL notice when the host was already running");
			assert.match(bridge.status(), new RegExp(host.url.replace(/[?]/g, "\\?")));

			const chat = vscodeChatUri(`pi:/${sessionId}`);
			await client.waitFor((m) => m.method === "root/sessionAdded");
			await client.subscribe(chat);
			for (const event of runEvents("Typed", "Answer")) bridge.forward(event as never);
			await client.waitFor((m) => m.params?.action?.type === "chat/turnComplete" && m.params.channel === chat);

			startTurn(client, chat, "From VS Code");
			await waitUntil(() => fake.calls.some((call) => call.method === "sendUserMessage"));
			assert.equal(fake.calls.find((call) => call.method === "sendUserMessage")!.args[0], "From VS Code");

			await bridge.disable();
			assert.equal(bridge.attachedSession, undefined);
			assert.match(bridge.status(), /sharing is off/);
		} finally {
			await bridge.close();
			client.close();
			await host.cleanup();
		}
	});

	test("starts a host when none is running and shows its URL once", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-agent-host-autostart-"));
		const socketPath = join(dir, "host.sock");
		let server: BridgeServer | undefined;
		let starts = 0;
		const bridge = new BridgeClient({
			socketPath,
			logFile: join(dir, "host.log"),
			startHost: () => {
				starts++;
				void BridgeServer.listen(socketPath, { attachLive: async () => {} }, silentLogger).then((started) => {
					server = started;
					server.setUrl("ws://127.0.0.1:1234?tkn=abc");
				});
			},
		});
		try {
			const first = fakePi({ sessionId: "one" });
			await bridge.sessionStarted(first.pi, first.ctx);
			assert.equal(starts, 1);
			assert.equal(bridge.attachedSession, "one");
			assert.equal(first.notices.length, 1);
			assert.match(first.notices[0]!, /ws:\/\/127\.0\.0\.1:1234\?tkn=abc/);

			// `/new`: the next session reuses the connection and does not repeat the notice.
			await bridge.sessionEnding("new");
			const second = fakePi({ sessionId: "two" });
			await bridge.sessionStarted(second.pi, second.ctx);
			assert.equal(bridge.attachedSession, "two");
			assert.deepEqual(second.notices, []);
			assert.equal(starts, 1);
		} finally {
			await bridge.close();
			await server?.close();
			await rm(dir, { recursive: true, force: true });
		}
	});
});

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
