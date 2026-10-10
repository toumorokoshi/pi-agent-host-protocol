import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionStatus } from "@microsoft/agent-host-protocol";
import { newSession, PI_MODES, startHost, startTurn, TestClient, type TestHost, vscodeChatUri } from "./helpers.ts";

describe("handshake", () => {
	let host: TestHost;
	before(async () => {
		host = await startHost();
	});
	after(() => host.cleanup());

	test("negotiates 0.9.0 with VS Code's version offer and publishes the pi agent", async () => {
		const client = await TestClient.connect(host.url);
		const result = await client.initialize();
		assert.equal(result.protocolVersion, "0.9.0");
		assert.equal(result.snapshots[0].resource, "ahp-root://");
		const agent = client.root?.agents[0];
		assert.equal(agent?.provider, "pi");
		assert.ok(
			agent?.models.some((model) => model.id === "faux/faux-1"),
			"faux model is listed",
		);
		client.close();
	});

	test("rejects unsupported protocol versions with -32005", async () => {
		const client = await TestClient.connect(host.url);
		await assert.rejects(client.initialize(["ahp-root://"], ["0.4.0"]), (error: any) => {
			assert.equal(error.code, -32005);
			assert.ok(Array.isArray(error.data.supportedVersions));
			return true;
		});
		client.close();
	});

	test("answers ping before initialize but nothing else", async () => {
		const client = await TestClient.connect(host.url);
		assert.equal(await client.request("ping", { channel: "ahp-root://" }), null);
		await assert.rejects(client.request("listSessions", { channel: "ahp-root://" }));
		client.close();
	});
});

describe("connection token", () => {
	let host: TestHost;
	before(async () => {
		host = await startHost({ token: "secret-token" });
	});
	after(() => host.cleanup());

	test("rejects a missing or wrong token with HTTP 403", async () => {
		const base = host.url.replace(/\?.*$/, "");
		await assert.rejects(TestClient.connect(base), /403/);
		await assert.rejects(TestClient.connect(`${base}?tkn=wrong`), /403/);
		const client = await TestClient.connect(host.url);
		await client.initialize();
		client.close();
	});
});

for (const mode of PI_MODES) {
	describe(`sessions and turns (${mode})`, () => {
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

		test("streams a text response into a completed turn", async () => {
			const { session, chat } = await newSession(host, client);
			await client.waitFor((m) => m.method === "root/sessionAdded" && m.params.summary.resource === session);

			host.faux.setResponses([fauxAssistantMessage("Hello from pi!")]);
			const turnId = startTurn(client, chat, "Say hello");
			await client.waitFor((m) => m.params?.action?.type === "chat/turnComplete" && m.params.action.turnId === turnId);

			const state = client.chats.get(chat)!;
			assert.equal(state.activeTurn, undefined);
			const turn = state.turns.at(-1)!;
			assert.equal(turn.state, "complete");
			const markdown = turn.responseParts.filter((part) => part.kind === "markdown");
			assert.equal(markdown.map((part) => (part as { content: string }).content).join(""), "Hello from pi!");
			assert.equal(client.sessions.get(session)?.title, "Say hello");
		});

		test("maps tool calls to completed tool call parts", async () => {
			const { chat } = await newSession(host, client);
			await writeFile(join(host.cwd, "notes.txt"), "the secret is 42\n");
			host.faux.setResponses([
				fauxAssistantMessage([fauxText("Reading."), fauxToolCall("read", { path: "notes.txt" }, { id: "call-1" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("The secret is 42."),
			]);
			const turnId = startTurn(client, chat, "What is the secret?");
			await client.waitFor((m) => m.params?.action?.type === "chat/turnComplete" && m.params.action.turnId === turnId);

			const turn = client.chats.get(chat)!.turns.at(-1)!;
			const toolPart = turn.responseParts.find((part) => part.kind === "toolCall");
			assert.ok(toolPart && toolPart.kind === "toolCall");
			const toolCall = toolPart.toolCall;
			assert.equal(toolCall.status, "completed");
			assert.equal(toolCall.toolName, "read");
			assert.equal(toolCall.invocationMessage, "Reading notes.txt");
			if (toolCall.status === "completed") {
				assert.equal(toolCall.success, true);
				assert.match(JSON.stringify(toolCall.content), /the secret is 42/);
			}
			const text = turn.responseParts
				.filter((part) => part.kind === "markdown")
				.map((part) => (part as { content: string }).content)
				.join("");
			assert.equal(text, "Reading.The secret is 42.");
		});

		test("cancels an in-flight turn", async () => {
			const { chat } = await newSession(host, client);
			// Cancel only once the model call has started, so a late call cannot
			// take the next turn's scripted response (pi runs in a child in rpc mode).
			const { promise: modelCalled, resolve: onModelCall } = Promise.withResolvers<void>();
			host.faux.setResponses([
				async () => {
					onModelCall();
					await new Promise((resolve) => setTimeout(resolve, 300));
					return fauxAssistantMessage("x".repeat(5000));
				},
			]);
			const turnId = startTurn(client, chat, "Write a lot");
			await modelCalled;
			client.dispatch(chat, { type: "chat/turnCancelled", turnId, duration: 10 });
			await client.waitFor((m) => m.params?.action?.type === "chat/turnCancelled" && m.params.action.turnId === turnId);
			const turn = client.chats.get(chat)!.turns.at(-1)!;
			assert.equal(turn.state, "cancelled");

			// The next turn works normally after a cancellation.
			host.faux.setResponses([fauxAssistantMessage("Back again.")]);
			const next = startTurn(client, chat, "Are you there?");
			await client.waitFor((m) => m.params?.action?.type === "chat/turnComplete" && m.params.action.turnId === next);
		});

		test("keeps reporting a running turn after the client marks the session read", async () => {
			const { session, chat } = await newSession(host, client);
			const { promise: modelCalled, resolve: onModelCall } = Promise.withResolvers<void>();
			const { promise: release, resolve: onRelease } = Promise.withResolvers<void>();
			host.faux.setResponses([
				async () => {
					onModelCall();
					await release;
					return fauxAssistantMessage("Done.");
				},
			]);
			const turnId = startTurn(client, chat, "Work for a while");
			await modelCalled;

			try {
				// VS Code marks a session read when the user opens it or navigates away.
				client.dispatch(session, { type: "session/isReadChanged", isRead: true });
				const summary = await client.waitFor(
					(m) =>
						m.method === "root/sessionSummaryChanged" &&
						m.params.session === session &&
						((m.params.changes.status ?? 0) & SessionStatus.IsRead) !== 0,
				);
				const status = summary.params.changes.status as number;
				assert.ok(status & SessionStatus.InProgress, `summary status ${status} keeps InProgress`);
				const running = await client.request("subscribe", { channel: session });
				assert.ok(running.snapshot.state.status & SessionStatus.InProgress, "session snapshot keeps InProgress");
				assert.ok(client.chats.get(chat)!.status! & SessionStatus.IsRead, "chat is marked read too");
			} finally {
				onRelease();
			}
			await client.waitFor((m) => m.params?.action?.type === "chat/turnComplete" && m.params.action.turnId === turnId);
			const snapshot = await client.request("subscribe", { channel: session });
			assert.equal((snapshot.snapshot.state.status as number) & SessionStatus.InProgress, 0);
		});

		test("reports what a running turn is doing as the session activity", async () => {
			const { session, chat } = await newSession(host, client);
			await writeFile(join(host.cwd, "activity.txt"), "busy\n");
			host.faux.setResponses([
				fauxAssistantMessage([fauxToolCall("read", { path: "activity.txt" }, { id: "call-activity" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Done."),
			]);
			const turnId = startTurn(client, chat, "Read the file");
			const reading = await client.waitFor(
				(m) =>
					m.method === "root/sessionSummaryChanged" &&
					m.params.session === session &&
					m.params.changes.activity === "Reading activity.txt",
			);
			assert.ok(reading);
			await client.waitFor((m) => m.params?.action?.type === "chat/turnComplete" && m.params.action.turnId === turnId);
			await client.waitFor(
				(m) =>
					m.method === "root/sessionSummaryChanged" &&
					m.params.session === session &&
					m.params.changes.activity === null,
			);
			assert.equal(client.chats.get(chat)!.activity, undefined);
			assert.equal(client.sessions.get(session)!.activity, undefined);
		});

		test("rejects invalid client actions back to the sender", async () => {
			const { chat } = await newSession(host, client);
			const seq = client.dispatch(chat, { type: "chat/turnCancelled", turnId: "nope", duration: 0 });
			const echo = await client.waitFor((m) => m.method === "action" && m.params.origin?.clientSeq === seq);
			assert.equal(echo.params.rejectionReason, "No active turn");
		});

		test("runs a queued message after the active turn completes", async () => {
			const { chat } = await newSession(host, client);
			host.faux.setResponses([
				async () => {
					await new Promise((resolve) => setTimeout(resolve, 100));
					return fauxAssistantMessage("First.");
				},
				fauxAssistantMessage("Second."),
			]);
			startTurn(client, chat, "One");
			client.dispatch(chat, {
				type: "chat/pendingMessageSet",
				kind: "queued",
				id: "queued-1",
				message: { text: "Two", origin: { kind: "user" } },
			});
			const started = await client.waitFor(
				(m) => m.params?.action?.type === "chat/turnStarted" && m.params.action.queuedMessageId === "queued-1",
			);
			const queuedTurn = started.params.action.turnId;
			await client.waitFor(
				(m) => m.params?.action?.type === "chat/turnComplete" && m.params.action.turnId === queuedTurn,
			);
			const turns = client.chats.get(chat)!.turns;
			assert.deepEqual(
				turns.map((turn) => turn.message.text),
				["One", "Two"],
			);
			assert.equal(client.chats.get(chat)!.queuedMessages, undefined);
		});

		test("accepts VS Code's session rename addressed to the chat channel", async () => {
			const { session, chat } = await newSession(host, client);
			client.dispatch(chat, { type: "session/titleChanged", title: "Renamed" });
			await client.waitFor((m) => m.method === "root/sessionSummaryChanged" && m.params.changes.title === "Renamed");
			assert.equal(client.sessions.get(session)?.title, "Renamed");
		});

		test("replays missed actions on reconnect", async () => {
			const { chat } = await newSession(host, client);
			const lastSeen = Math.max(...client.envelopes.map((envelope) => envelope.serverSeq));
			host.faux.setResponses([fauxAssistantMessage("While you were away.")]);
			const turnId = startTurn(client, chat, "Ping");
			await client.waitFor((m) => m.params?.action?.type === "chat/turnComplete" && m.params.action.turnId === turnId);

			const second = await TestClient.connect(host.url);
			const result = await second.request("reconnect", {
				clientId: client.clientId,
				lastSeenServerSeq: lastSeen,
				subscriptions: [chat],
			});
			assert.equal(result.type, "replay");
			const types = result.actions.map((envelope: any) => envelope.action.type);
			assert.ok(types.includes("chat/turnStarted"));
			assert.ok(types.includes("chat/turnComplete"));
			assert.ok(result.actions.every((envelope: any) => envelope.channel === chat));
			second.close();
		});

		test("asks an unknown client to initialize instead of reconnecting", async () => {
			const stranger = await TestClient.connect(host.url);
			await assert.rejects(
				stranger.request("reconnect", {
					clientId: "from-a-previous-host-instance",
					lastSeenServerSeq: 42,
					subscriptions: ["ahp-root://"],
				}),
				(error: any) => error.code === -32008,
			);
			const result = await stranger.request("initialize", {
				protocolVersions: ["0.9.0"],
				clientId: "from-a-previous-host-instance",
			});
			assert.deepEqual(result.completionTriggerCharacters, ["/"]);
			stranger.close();
		});

		test("rejects creating a session that already exists", async () => {
			const { session } = await newSession(host, client);
			await assert.rejects(
				client.request("createSession", { channel: session }),
				(error: any) => error.code === -32003,
			);
		});
	});
}

for (const mode of PI_MODES) {
	describe(`persistence (${mode})`, () => {
		test("lists and reloads sessions from pi's session files after a restart", async () => {
			const first = await startHost({ mode });
			const client = await TestClient.connect(first.url);
			await client.initialize();
			const { session } = await newSession(first, client);
			first.faux.setResponses([fauxAssistantMessage("Remember me.")]);
			const turnId = startTurn(client, vscodeChatUri(session), "A durable question");
			await client.waitFor((m) => m.params?.action?.type === "chat/turnComplete" && m.params.action.turnId === turnId);
			client.close();
			await first.stop();

			const second = await startHost({ dir: first.dir, mode });
			try {
				const reconnected = await TestClient.connect(second.url);
				await reconnected.initialize();
				const list = await reconnected.request("listSessions", { channel: "ahp-root://" });
				const summary = list.items.find((item: any) => item.resource === session);
				assert.ok(summary, "session is listed after restart");
				assert.equal(summary.title, "A durable question");

				const chat = vscodeChatUri(session);
				await reconnected.subscribe(chat);
				const turns = reconnected.chats.get(chat)!.turns;
				assert.equal(turns.length, 1);
				assert.equal(turns[0]!.message.text, "A durable question");
				assert.equal(turns[0]!.responseParts.find((part) => part.kind === "markdown")?.content, "Remember me.");

				// The reloaded session accepts new turns.
				second.faux.setResponses([fauxAssistantMessage("Still here.")]);
				const next = startTurn(reconnected, chat, "Follow-up");
				await reconnected.waitFor(
					(m) => m.params?.action?.type === "chat/turnComplete" && m.params.action.turnId === next,
				);
				reconnected.close();
			} finally {
				await second.cleanup();
			}
		});

		test("keeps sessions archived across a restart", async () => {
			const first = await startHost({ mode });
			const client = await TestClient.connect(first.url);
			await client.initialize();
			const archived = await newSession(first, client);
			const kept = await newSession(first, client);
			for (const { chat } of [archived, kept]) {
				first.faux.setResponses([fauxAssistantMessage("Done.")]);
				const turnId = startTurn(client, chat, "Finish this");
				await client.waitFor(
					(m) => m.params?.action?.type === "chat/turnComplete" && m.params.action.turnId === turnId,
				);
			}
			// VS Code's "mark as done" archives the session; archiving and unarchiving
			// the other one checks that the flag can be cleared again.
			client.dispatch(archived.session, { type: "session/isArchivedChanged", isArchived: true });
			client.dispatch(kept.session, { type: "session/isArchivedChanged", isArchived: true });
			client.dispatch(kept.chat, { type: "chat/isArchivedChanged", isArchived: false });
			// Requests are handled in order, so this also waits for the dispatches.
			const before = await client.request("listSessions", { channel: "ahp-root://" });
			const statusBefore = (session: string) =>
				before.items.find((item: any) => item.resource === session)?.status ?? 0;
			assert.ok(statusBefore(archived.session) & SessionStatus.IsArchived);
			assert.equal(statusBefore(kept.session) & SessionStatus.IsArchived, 0);
			client.close();
			await first.stop();

			const second = await startHost({ dir: first.dir, mode });
			try {
				const reconnected = await TestClient.connect(second.url);
				await reconnected.initialize();
				const list = await reconnected.request("listSessions", { channel: "ahp-root://" });
				const status = (session: string) => list.items.find((item: any) => item.resource === session)?.status ?? 0;
				assert.ok(status(archived.session) & SessionStatus.IsArchived, "archived session is still archived");
				assert.equal(status(kept.session) & SessionStatus.IsArchived, 0, "unarchived session stays unarchived");

				// Loading the session from disk keeps the flag in its state too.
				const snapshot = await reconnected.request("subscribe", { channel: archived.session });
				assert.ok(snapshot.snapshot.state.status & SessionStatus.IsArchived, "session snapshot is archived");
				reconnected.close();
			} finally {
				await second.cleanup();
			}
		});
	});
}
