import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ActionType, ChatOriginKind, type ListSessionsResult, TurnState } from "@microsoft/agent-host-protocol";
import { moveSessionManager, rewriteSessionHeaderCwd } from "../src/pi/session-move.ts";
import { newSession, PI_MODES, startHost, startTurn, TestClient, type TestHost } from "./helpers.ts";

describe("session move helpers", () => {
	test("rewriteSessionHeaderCwd updates cwd without touching entries", () => {
		const header = JSON.stringify({
			type: "session",
			version: 3,
			id: "s1",
			timestamp: "2026-01-01T00:00:00Z",
			cwd: "/old",
		});
		const entry = JSON.stringify({
			type: "message",
			id: "e1",
			parentId: null,
			timestamp: "2026-01-01T00:00:01Z",
			message: { role: "user", content: "hi" },
		});
		const single = rewriteSessionHeaderCwd(header, "/new");
		assert.equal(JSON.parse(single).cwd, "/new");

		const multi = rewriteSessionHeaderCwd(`${header}\n${entry}\n`, "/new");
		const lines = multi.split("\n");
		assert.equal(JSON.parse(lines[0]).cwd, "/new");
		assert.equal(lines[1], entry);

		assert.throws(() => rewriteSessionHeaderCwd("not json", "/new"));
		assert.throws(() => rewriteSessionHeaderCwd('{"type":"message"}', "/new"));
	});

	test("moveSessionManager moves an unpersisted session and preserves its name", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-ahp-move-unit-"));
		const oldCwd = join(dir, "old");
		const newCwd = join(dir, "new");
		const sessionDir = join(dir, "sessions");
		await mkdir(oldCwd, { recursive: true });
		await mkdir(newCwd, { recursive: true });
		try {
			const manager = SessionManager.create(oldCwd, sessionDir, { id: "s-unpersisted" });
			manager.appendSessionInfo("My title");
			const moved = await moveSessionManager(manager, newCwd, { sessionDir });
			assert.equal(moved.getSessionId(), "s-unpersisted");
			assert.equal(moved.getCwd(), newCwd);
			assert.equal(moved.getSessionName(), "My title");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("moveSessionManager relocates persisted files when grouped per cwd", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-ahp-move-unit-"));
		const agentDir = join(dir, "agent");
		const oldCwd = join(dir, "old");
		const newCwd = join(dir, "new");
		await mkdir(oldCwd, { recursive: true });
		await mkdir(newCwd, { recursive: true });
		const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const manager = SessionManager.create(oldCwd, undefined, { id: "s-grouped" });
			manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
			const oldFile = manager.getSessionFile();
			assert.ok(oldFile && existsSync(oldFile));

			const moved = await moveSessionManager(manager, newCwd, { agentDir });
			const newFile = moved.getSessionFile();
			assert.ok(newFile && existsSync(newFile));
			assert.notEqual(dirname(newFile), dirname(oldFile));
			assert.equal(basename(newFile), basename(oldFile));
			assert.equal(existsSync(oldFile), false);
			assert.equal(moved.getCwd(), newCwd);
			assert.equal(moved.getEntries().length, 1);
			const header = JSON.parse((await readFile(newFile, "utf8")).split("\n")[0]);
			assert.equal(header.cwd, newCwd);
		} finally {
			if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("moveSessionManager updates header in place when using flat sessionDir", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-ahp-move-unit-"));
		const oldCwd = join(dir, "old");
		const newCwd = join(dir, "new");
		const sessionDir = join(dir, "sessions");
		await mkdir(oldCwd, { recursive: true });
		await mkdir(newCwd, { recursive: true });
		try {
			const manager = SessionManager.create(oldCwd, sessionDir, { id: "s-flat" });
			manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
			const oldFile = manager.getSessionFile();
			assert.ok(oldFile && existsSync(oldFile));

			const moved = await moveSessionManager(manager, newCwd, { sessionDir });
			assert.equal(moved.getSessionFile(), oldFile);
			assert.equal(moved.getCwd(), newCwd);
			assert.equal(moved.getEntries().length, 1);
			const header = JSON.parse((await readFile(oldFile, "utf8")).split("\n")[0]);
			assert.equal(header.cwd, newCwd);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

for (const mode of PI_MODES) {
	describe(`moving session working directory (${mode})`, () => {
		let host: TestHost;
		let client: TestClient;
		let secondDir: string;

		before(async () => {
			host = await startHost({ mode });
			secondDir = join(host.dir, "second-workspace");
			await mkdir(secondDir, { recursive: true });
			client = await TestClient.connect(host.url);
			await client.initialize();
		});

		after(async () => {
			client.close();
			await host.cleanup();
		});

		const complete = (id: string) =>
			client.waitFor((m) => m.params?.action?.type === "chat/turnComplete" && m.params.action.turnId === id);

		test("advertises multipleWorkingDirectories with primaryReplacement", () => {
			assert.deepEqual(client.root?.agents[0]?.capabilities?.multipleWorkingDirectories, {
				immutablePrimary: true,
				primaryReplacement: true,
			});
		});

		test("moves a session with history, updates summaries, and persists across restart", async () => {
			const oldUri = pathToFileURL(host.cwd).href;
			const newUri = pathToFileURL(secondDir).href;

			const { session, chat } = await newSession(host, client);
			host.faux.setResponses([fauxAssistantMessage("First reply")]);
			const t1 = startTurn(client, chat, "Hello");
			await complete(t1);

			const summaryChanged = client.waitFor(
				(m) =>
					m.method === "root/sessionSummaryChanged" &&
					m.params?.session === session &&
					Array.isArray((m.params?.changes as { workingDirectories?: unknown } | undefined)?.workingDirectories),
			);
			const replaced = client.waitFor(
				(m) => m.params?.channel === session && m.params?.action?.type === ActionType.SessionWorkingDirectoryReplaced,
			);
			client.dispatch(session, {
				type: ActionType.SessionWorkingDirectoryReplaced,
				directory: oldUri,
				replacement: newUri,
			});
			const [notice] = await Promise.all([summaryChanged, replaced]);
			assert.deepEqual((notice.params?.changes as { workingDirectories?: string[] } | undefined)?.workingDirectories, [
				newUri,
			]);

			assert.deepEqual(client.sessions.get(session)?.workingDirectories, [newUri]);

			const listed = (await client.request("listSessions", { channel: "ahp-root://" })) as ListSessionsResult;
			const item = listed.items.find((s) => s.resource === session);
			assert.deepEqual(item?.workingDirectories, [newUri]);

			host.faux.setResponses([fauxAssistantMessage("Second reply")]);
			const t2 = startTurn(client, chat, "After move");
			await complete(t2);
			assert.equal(client.chats.get(chat)?.turns.length, 2);

			// Restart the host and verify the moved cwd and history persist.
			client.close();
			await host.stop();

			host = await startHost({ dir: host.dir, mode });
			client = await TestClient.connect(host.url);
			await client.initialize();

			const afterRestart = (await client.request("listSessions", { channel: "ahp-root://" })) as ListSessionsResult;
			const reloadedSummary = afterRestart.items.find((s) => s.resource === session);
			assert.deepEqual(reloadedSummary?.workingDirectories, [newUri]);

			await client.subscribe(session);
			await client.subscribe(chat);
			assert.deepEqual(client.sessions.get(session)?.workingDirectories, [newUri]);
			assert.equal(client.chats.get(chat)?.turns.length, 2);
		});

		test("moves an empty session before any turn and moves forked chats with it", async () => {
			const oldUri = pathToFileURL(host.cwd).href;
			const newUri = pathToFileURL(secondDir).href;

			// Empty session moved before first turn.
			const empty = await newSession(host, client);
			const emptyMoved = client.waitFor(
				(m) =>
					m.params?.channel === empty.session && m.params?.action?.type === ActionType.SessionWorkingDirectoryReplaced,
			);
			client.dispatch(empty.session, {
				type: ActionType.SessionWorkingDirectoryReplaced,
				directory: oldUri,
				replacement: newUri,
			});
			await emptyMoved;
			assert.deepEqual(client.sessions.get(empty.session)?.workingDirectories, [newUri]);

			host.faux.setResponses([fauxAssistantMessage("Ready")]);
			const emptyTurn = startTurn(client, empty.chat, "Ping");
			await complete(emptyTurn);
			assert.equal(client.chats.get(empty.chat)?.turns.at(-1)?.state, TurnState.Complete);

			// Session with a fork moved together.
			const withFork = await newSession(host, client);
			host.faux.setResponses([fauxAssistantMessage("Base")]);
			const baseTurn = startTurn(client, withFork.chat, "Base");
			await complete(baseTurn);

			const forkChat = `ahp-chat:/${crypto.randomUUID()}`;
			await client.request("createChat", {
				channel: withFork.session,
				chat: forkChat,
				source: { kind: ChatOriginKind.Fork, chat: withFork.chat, turnId: baseTurn },
			});
			await client.subscribe(forkChat);

			const forkMoved = client.waitFor(
				(m) =>
					m.params?.channel === withFork.session &&
					m.params?.action?.type === ActionType.SessionWorkingDirectoryReplaced,
			);
			client.dispatch(withFork.session, {
				type: ActionType.SessionWorkingDirectoryReplaced,
				directory: oldUri,
				replacement: newUri,
			});
			await forkMoved;
			assert.deepEqual(client.sessions.get(withFork.session)?.workingDirectories, [newUri]);

			host.faux.setResponses([fauxAssistantMessage("Fork reply")]);
			const forkTurn = startTurn(client, forkChat, "Continue fork");
			await complete(forkTurn);
			assert.equal(client.chats.get(forkChat)?.turns.at(-1)?.state, TurnState.Complete);
		});

		test("rejects invalid working directory mutations", async () => {
			const oldUri = pathToFileURL(host.cwd).href;
			const newUri = pathToFileURL(secondDir).href;
			const { session, chat } = await newSession(host, client);

			const waitRejected = (predicate: (action: Record<string, unknown>) => boolean) =>
				client.waitFor(
					(m) =>
						m.params?.channel === session &&
						Boolean(m.params?.rejectionReason) &&
						predicate((m.params?.action ?? {}) as Record<string, unknown>),
				);

			// Generic add/remove are rejected.
			const addP = waitRejected((a) => a.type === ActionType.SessionWorkingDirectorySet);
			client.dispatch(session, { type: ActionType.SessionWorkingDirectorySet, directory: newUri });
			assert.match((await addP).params?.rejectionReason ?? "", /Unsupported/);

			const removeP = waitRejected((a) => a.type === ActionType.SessionWorkingDirectoryRemoved);
			client.dispatch(session, { type: ActionType.SessionWorkingDirectoryRemoved, directory: oldUri });
			assert.match((await removeP).params?.rejectionReason ?? "", /Unsupported/);

			// Unknown directory is rejected.
			const unknownP = waitRejected(
				(a) => a.type === ActionType.SessionWorkingDirectoryReplaced && a.directory === newUri,
			);
			client.dispatch(session, {
				type: ActionType.SessionWorkingDirectoryReplaced,
				directory: newUri,
				replacement: oldUri,
			});
			assert.match((await unknownP).params?.rejectionReason ?? "", /not in session/i);

			// Missing replacement directory is rejected.
			const missingUri = pathToFileURL(join(host.dir, "does-not-exist")).href;
			const missingP = waitRejected(
				(a) => a.type === ActionType.SessionWorkingDirectoryReplaced && a.replacement === missingUri,
			);
			client.dispatch(session, {
				type: ActionType.SessionWorkingDirectoryReplaced,
				directory: oldUri,
				replacement: missingUri,
			});
			assert.match((await missingP).params?.rejectionReason ?? "", /not a local directory/i);

			// Moving while a turn is in progress is rejected.
			const { promise: modelCalled, resolve: onModelCall } = Promise.withResolvers<void>();
			const { promise: release, resolve: releaseTurn } = Promise.withResolvers<void>();
			host.faux.setResponses([
				async () => {
					onModelCall();
					await release;
					return fauxAssistantMessage("Done");
				},
			]);
			const turnId = startTurn(client, chat, "Wait");
			await modelCalled;
			const busyP = waitRejected(
				(a) => a.type === ActionType.SessionWorkingDirectoryReplaced && a.replacement === newUri,
			);
			client.dispatch(session, {
				type: ActionType.SessionWorkingDirectoryReplaced,
				directory: oldUri,
				replacement: newUri,
			});
			assert.match((await busyP).params?.rejectionReason ?? "", /in progress/i);
			releaseTurn();
			await complete(turnId);

			assert.deepEqual(client.sessions.get(session)?.workingDirectories, [oldUri]);
		});
	});
}
