import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
	ActionType,
	BackgroundWorkKind,
	type ChatState,
	MessageKind,
	SessionLifecycle,
	type SessionState,
	SessionStatus,
} from "@microsoft/agent-host-protocol";
import { silentLogger } from "../src/core/logger.ts";
import { StateStore } from "../src/core/state-store.ts";
import type { PiEvent } from "../src/pi/agent.ts";
import { STATUS_GRACE_MS, SubagentTracker } from "../src/pi/subagent-tracker.ts";
import { subagentChatId } from "../src/pi/subagents.ts";
import { toolCallStartActions } from "../src/pi/tool-call-actions.ts";

const SESSION = "s1";
const NOW = "2026-11-20T09:00:00.000Z";
const CALL = "call-1";

/** A tracker over a real store holding one parent chat, with a turn open that holds the `subagent` call. */
function setup(options: { alive?: (pid: number) => boolean; withTurn?: boolean } = {}) {
	const store = new StateStore({ agents: [], activeSessions: 0, terminals: [] });
	const chat: ChatState = {
		resource: store.defaultChatResource(SESSION),
		title: "t",
		status: SessionStatus.Idle,
		modifiedAt: NOW,
		turns: [],
	};
	const session = {
		provider: "pi",
		title: "t",
		status: SessionStatus.Idle,
		workingDirectories: [],
		lifecycle: SessionLifecycle.Ready,
		activeClients: [],
		chats: [],
		defaultChat: chat.resource,
	} as SessionState;
	store.addSession(SESSION, session, chat);
	if (options.withTurn !== false) {
		store.dispatch(chat.resource, {
			type: ActionType.ChatTurnStarted,
			turnId: "turn-1",
			startedAt: NOW,
			message: { text: "go", origin: { kind: MessageKind.User } },
		});
		for (const action of toolCallStartActions("turn-1", {
			status: "running",
			toolCallId: CALL,
			toolName: "subagent",
			displayName: "Subagent",
			invocationMessage: "Running",
			confirmed: "not-needed",
		} as never)) {
			store.dispatch(chat.resource, action);
		}
	}
	const clock = { now: Date.parse(NOW) };
	const tracker = new SubagentTracker({
		store,
		logger: silentLogger,
		sessionId: SESSION,
		parentChat: chat.resource,
		activeTurnWith: (toolCallId) => {
			const turn = store.chat(SESSION)?.activeTurn;
			return turn?.responseParts.some((part) => part.kind === "toolCall" && part.toolCall.toolCallId === toolCallId)
				? turn.id
				: undefined;
		},
		sessionFile: () => undefined,
		catalogChanged: () => {},
		backgroundWorkChanged: () => {},
		now: () => clock.now,
		...(options.alive ? { isProcessAlive: options.alive } : {}),
	});
	return { store, tracker, clock };
}

const started = (name: string, args: unknown): PiEvent =>
	({ type: "tool_execution_start", toolCallId: CALL, toolName: name, args }) as PiEvent;
const ended = (details: unknown): PiEvent =>
	({
		type: "tool_execution_end",
		toolCallId: CALL,
		toolName: "subagent",
		result: { details },
		isError: false,
	}) as PiEvent;

describe("SubagentTracker", () => {
	let dir: string;
	before(async () => {
		dir = await mkdtemp(join(tmpdir(), "subagent-tracker-"));
	});
	after(() => rm(dir, { recursive: true, force: true }));

	const asyncRun = async (name: string) => {
		const asyncDir = join(dir, name);
		await mkdir(asyncDir, { recursive: true });
		return asyncDir;
	};
	const writeStatus = (asyncDir: string, status: object) =>
		writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: "r", ...status }));
	const single = { agent: "scout", task: "look", async: true };
	const state = (store: StateStore, asyncDirName = "r") => store.chat(subagentChatId(asyncDirName, "0"))?.title ?? "";

	test("a status file that is not written yet when the call returns does not stop the run", async () => {
		const { tracker, store, clock } = setup();
		const asyncDir = await asyncRun("not-yet");
		tracker.handle(started("subagent", single));
		tracker.handle(ended({ mode: "single", runId: "r", asyncDir }));
		await tracker.refresh();
		assert.equal(tracker.runningWork().length, 1, "still running without its status file");
		assert.equal(state(store), "look (scout)");
		await writeStatus(asyncDir, { state: "running", steps: [{ agent: "scout", status: "running" }] });
		await tracker.refresh();
		assert.equal(tracker.runningWork().length, 1);
		await writeStatus(asyncDir, { state: "complete", steps: [{ agent: "scout", status: "complete" }] });
		await tracker.refresh();
		assert.equal(tracker.runningWork().length, 0);
		clock.now += STATUS_GRACE_MS * 2;
		tracker.dispose();
	});

	test("a status file that never appears stops the run after the grace period", async () => {
		const { tracker, clock } = setup();
		const asyncDir = await asyncRun("never");
		tracker.handle(started("subagent", single));
		tracker.handle(ended({ mode: "single", runId: "r", asyncDir }));
		await tracker.refresh();
		assert.equal(tracker.runningWork().length, 1);
		clock.now += STATUS_GRACE_MS + 1;
		await tracker.refresh();
		assert.equal(tracker.runningWork().length, 0);
		tracker.dispose();
	});

	test("a status file that was seen and then removed stops the run at once", async () => {
		const { tracker } = setup();
		const asyncDir = await asyncRun("removed");
		await writeStatus(asyncDir, { state: "running", steps: [{ agent: "scout", status: "running" }] });
		tracker.handle(started("subagent", single));
		tracker.handle(ended({ mode: "single", runId: "r", asyncDir }));
		await tracker.refresh();
		assert.equal(tracker.runningWork().length, 1);
		await rm(join(asyncDir, "status.json"));
		await tracker.refresh();
		assert.equal(tracker.runningWork().length, 0);
		tracker.dispose();
	});

	test("a runner that died without a final state stops the run", async () => {
		const alive = new Set([4242]);
		const { tracker, store } = setup({ alive: (pid) => alive.has(pid) });
		const asyncDir = await asyncRun("dead");
		await writeStatus(asyncDir, { state: "running", pid: 4242, steps: [{ agent: "scout", status: "running" }] });
		tracker.handle(started("subagent", single));
		tracker.handle(ended({ mode: "single", runId: "r", asyncDir }));
		await tracker.refresh();
		assert.equal(tracker.runningWork().length, 1);
		alive.clear();
		await tracker.refresh();
		assert.equal(tracker.runningWork().length, 0);
		assert.equal(state(store), "look (scout) · stopped");
		tracker.dispose();
	});

	test("a runner that finished and exited is not taken for dead", async () => {
		const { tracker, store } = setup({ alive: () => false });
		const asyncDir = await asyncRun("exited");
		await writeStatus(asyncDir, { state: "complete", pid: 4242, steps: [{ agent: "scout", status: "complete" }] });
		tracker.handle(started("subagent", single));
		tracker.handle(ended({ mode: "single", runId: "r", asyncDir }));
		await tracker.refresh();
		assert.equal(state(store), "look (scout)");
		tracker.dispose();
	});

	test("children that appear later in status.json get a row in the running parent turn", async () => {
		const { tracker, store } = setup();
		const asyncDir = await asyncRun("late");
		const workflow = { workflow: "review", args: { task: "x" }, async: true };
		tracker.handle(started("subagent", workflow));
		tracker.handle(ended({ mode: "workflow", runId: "r", asyncDir }));
		// What the turn mapper does when the call completes: no rows yet.
		assert.deepEqual(tracker.callsFor(CALL), []);
		await writeStatus(asyncDir, {
			mode: "workflow",
			state: "running",
			steps: [{ agent: "reviewer", workflowKey: "task-1", status: "running" }],
		});
		await tracker.refresh();
		await writeStatus(asyncDir, {
			mode: "workflow",
			state: "running",
			steps: [
				{ agent: "reviewer", workflowKey: "task-1", status: "running" },
				{ agent: "reviewer", workflowKey: "task-2", status: "running" },
			],
		});
		await tracker.refresh();
		const parts = store
			.chat(SESSION)!
			.activeTurn!.responseParts.flatMap((part) => (part.kind === "toolCall" ? [part.toolCall.toolCallId] : []));
		assert.deepEqual(parts, [CALL, `${CALL}.task-1`, `${CALL}.task-2`]);
		const chat = store.chat(subagentChatId("r", "task-1"))!;
		assert.deepEqual(chat.origin && "toolCallId" in chat.origin ? chat.origin.toolCallId : undefined, `${CALL}.task-1`);
		assert.equal(tracker.runningWork().filter((work) => work.kind === BackgroundWorkKind.Subagent).length, 2);
		tracker.dispose();
	});

	test("children that appear after the parent's turn ended have no live row to add", async () => {
		const { tracker, store } = setup({ withTurn: false });
		const asyncDir = await asyncRun("after-turn");
		tracker.handle(started("subagent", { workflow: "review", async: true }));
		tracker.handle(ended({ mode: "workflow", runId: "r", asyncDir }));
		tracker.callsFor(CALL);
		await writeStatus(asyncDir, {
			mode: "workflow",
			state: "running",
			steps: [{ agent: "reviewer", workflowKey: "task-1", status: "running" }],
		});
		await tracker.refresh();
		assert.equal(store.chat(SESSION)!.activeTurn, undefined);
		assert.equal(tracker.runningWork().length, 1);
		tracker.dispose();
	});
});
