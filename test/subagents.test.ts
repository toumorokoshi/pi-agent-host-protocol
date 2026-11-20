import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	ActionType,
	BackgroundWorkKind,
	type ChatAction,
	type ChatState,
	chatReducer,
	MessageKind,
	SessionStatus,
	ToolResultContentType,
	TurnState,
} from "@microsoft/agent-host-protocol";
import { subagentChatSession, subagentChatUri } from "../src/core/uris.ts";
import { turnsFromEntries } from "../src/pi/history.ts";
import {
	childrenFromArgs,
	childrenFromSessionFiles,
	isSubagentRunner,
	mergeChildren,
	NO_PROGRESS,
	normalizeStatus,
	notifiedChildren,
	parseRunStatus,
	processAlive,
	sessionLineage,
	subagentCallId,
	subagentCalls,
	subagentChatId,
	subagentRunFromResult,
	subagentTitle,
	subagentWork,
	subagentWorkActions,
	transcriptActions,
} from "../src/pi/subagents.ts";

const FIXTURES = new URL("./fixtures/subagents/", import.meta.url);
const fixture = (name: string): string => readFileSync(new URL(name, FIXTURES), "utf8");
const json = (name: string) => JSON.parse(fixture(name));
const SESSION = "ahp-session:/s1";
const WORKFLOW_RUN = "1bb47ca0-7b21-4fc2-9b39-7338d1beb8f5";
const NOW = "2026-11-20T09:00:00.000Z";

function entries(text: string): SessionEntry[] {
	return text
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as SessionEntry);
}

/** Applies actions to an empty chat with the AHP reducer, as a client would. */
function reduce(actions: readonly ChatAction[], state?: ChatState): ChatState {
	let chat: ChatState = state ?? {
		resource: "ahp-chat://x/y",
		title: "t",
		status: SessionStatus.Idle,
		modifiedAt: NOW,
		turns: [],
	};
	for (const action of actions) chat = chatReducer(chat, action);
	return chat;
}

describe("subagent tool results", () => {
	test("a 0.84 async workflow names its children from the arguments", () => {
		const { args, details } = json("workflow-0.84.tool-result.json");
		const run = subagentRunFromResult("call-1", args, details);
		assert.equal(run?.runId, WORKFLOW_RUN);
		assert.equal(run?.asyncDir, `/tmp/pi-subagents-uid-1001/async-subagent-runs/${WORKFLOW_RUN}`);
		assert.deepEqual(
			run?.children.map((child) => [child.key, child.agent, child.status]),
			[
				["task-1", "delegate", "pending"],
				["task-2", "delegate", "pending"],
			],
		);
	});

	test("a 0.73 async single run has one child labelled from its task", () => {
		const { args, details } = json("single-0.73.tool-result.json");
		const run = subagentRunFromResult("call-2", args, details);
		assert.equal(run?.runId, "a44d414e-e78e-4da5-8098-d2ae7a3fe1e1");
		assert.equal(run?.children.length, 1);
		assert.equal(run?.children[0]?.key, "0");
		assert.equal(run?.children[0]?.agent, "delegate");
		assert.match(run?.children[0]?.label ?? "", /^Run `sleep 30`/);
	});

	test("a foreground run's children are finished, with their session files", () => {
		const { args, details } = json("foreground-0.84.tool-result.json");
		const run = subagentRunFromResult("call-3", args, details);
		assert.equal(run?.asyncDir, undefined);
		assert.equal(run?.children[0]?.status, "complete");
		assert.match(run?.children[0]?.sessionFile ?? "", /6eb96a16-cbd7-4ec0-90b1-d8ba2a7ba7f4\/run-0\/session\.jsonl$/);
	});

	test("management calls and errors start no run", () => {
		const { args, details } = json("management.tool-result.json");
		assert.equal(subagentRunFromResult("call-4", args, details), undefined);
		assert.equal(subagentRunFromResult("call-5", {}, undefined), undefined);
		assert.equal(subagentRunFromResult("call-6", {}, { mode: "single" }), undefined);
	});

	test("structured tasks and chains name children as pi-subagents' workflows do", () => {
		const tasks = {
			tasks: [
				{ agent: "scout", task: "a" },
				{ agent: "worker", task: "b" },
			],
		};
		assert.deepEqual(
			childrenFromArgs(tasks, "workflow").map((child) => child.key),
			["task-1", "task-2"],
		);
		const chain = {
			chain: [
				{ agent: "scout", task: "a" },
				{
					parallel: [
						{ agent: "x", task: "b" },
						{ agent: "y", task: "c" },
					],
				},
			],
		};
		assert.deepEqual(
			childrenFromArgs(chain, "workflow").map((child) => child.key),
			["step-1", "step-2-1", "step-2-2"],
		);
		assert.deepEqual(childrenFromArgs({ workflow: "review", args: { task: "x" } }, "workflow"), []);
	});
});

describe("status.json", () => {
	test("a 0.84 workflow lists its children before and after their steps exist", () => {
		assert.deepEqual(parseRunStatus(fixture("workflow-0.84-starting.status.json"))?.children, []);
		const running = parseRunStatus(fixture("workflow-0.84-running.status.json"));
		assert.equal(running?.state, "running");
		assert.equal(running?.toolCallId, "toolu_vrtx_01EoGsvXbAQKDGPbgsVEQ5dp");
		assert.deepEqual(
			running?.children.map((child) => [child.key, child.status, child.runId?.slice(0, 8), !!child.sessionFile]),
			[
				["task-1", "running", "c58fb5c0", true],
				["task-2", "running", "478a2a04", true],
			],
		);
		const partial = parseRunStatus(fixture("workflow-0.84-partial.status.json"));
		assert.deepEqual(
			partial?.children.map((child) => child.status),
			["running", "complete"],
		);
		const complete = parseRunStatus(fixture("workflow-0.84-complete.status.json"));
		assert.equal(complete?.state, "complete");
		assert.deepEqual(
			complete?.children.map((child) => child.status),
			["complete", "complete"],
		);
	});

	test("a single run (0.73 and 0.84) has one child keyed by its step", () => {
		const pending = parseRunStatus(fixture("single-0.84-pending.status.json"));
		assert.deepEqual(
			pending?.children.map((child) => [child.key, child.status, !!child.sessionFile]),
			[["0", "pending", false]],
		);
		assert.equal(parseRunStatus(fixture("single-0.84-running.status.json"))?.children[0]?.status, "running");
		assert.equal(parseRunStatus(fixture("single-0.73-complete.status.json"))?.children[0]?.status, "complete");
		const failed = parseRunStatus(fixture("single-0.73-failed.status.json"));
		assert.equal(failed?.state, "failed");
		assert.equal(failed?.children[0]?.status, "failed");
		assert.match(failed?.children[0]?.error ?? "", /No models available/);
	});

	test("the runner's pid is read, and only a valid one", () => {
		assert.equal(parseRunStatus(fixture("single-0.84-running.status.json"))?.pid, 20365);
		assert.equal(parseRunStatus('{"runId":"r","pid":-3}')?.pid, undefined);
		assert.equal(parseRunStatus('{"runId":"r","pid":"12"}')?.pid, undefined);
	});

	test("processAlive tells running from gone processes", () => {
		assert.equal(processAlive(process.pid), true);
		assert.equal(processAlive(2 ** 22 + 12345), false);
	});

	test("unreadable text is not a status", () => {
		assert.equal(parseRunStatus("{"), undefined);
		assert.equal(parseRunStatus("{}"), undefined);
	});

	test("status words reduce to five", () => {
		assert.equal(normalizeStatus("completed"), "complete");
		assert.equal(normalizeStatus("complete"), "complete");
		assert.equal(normalizeStatus("queued"), "pending");
		assert.equal(normalizeStatus("rejected"), "failed");
		assert.equal(normalizeStatus("detached"), "stopped");
		assert.equal(normalizeStatus("something-new"), "running");
	});

	test("merging keeps the label from the arguments and takes the status file's state", () => {
		const { args, details } = json("workflow-0.84.tool-result.json");
		const run = subagentRunFromResult("call-1", args, details)!;
		const status = parseRunStatus(fixture("workflow-0.84-partial.status.json"))!;
		const merged = mergeChildren(run.children, status.children);
		assert.deepEqual(
			merged.map((child) => [child.label, child.status, !!child.task, !!child.sessionFile]),
			[
				["task-1", "running", true, true],
				["task-2", "complete", true, true],
			],
		);
	});
});

describe("chats", () => {
	test("ids are stable and URI-safe, and the URI names the session", () => {
		const id = subagentChatId(WORKFLOW_RUN, "task-1");
		assert.equal(id, `subagent-${WORKFLOW_RUN}-task-1`);
		assert.equal(subagentChatId("A_B", "0"), "subagent-a-b-0");
		assert.equal(subagentChatId("r", "0", "Fork_1"), "subagent-r-0-in-fork-1");
		const uri = subagentChatUri(SESSION, id);
		assert.match(uri, /^ahp-chat:\/\/subagent-[a-z0-9-]+\/[A-Za-z0-9_-]+$/);
		assert.equal(subagentChatSession(uri), SESSION);
		assert.equal(subagentChatSession("ahp-chat://default/abc"), undefined);
	});

	test("titles are '<label> (<agent>)'", () => {
		assert.equal(subagentTitle({ label: "task-1", agent: "delegate" }), "task-1 (delegate)");
		assert.equal(subagentTitle({ label: "delegate", agent: "delegate" }), "delegate");
		assert.equal(subagentTitle({ label: "task-1", agent: "delegate", status: "running" }), "task-1 (delegate)");
		assert.equal(subagentTitle({ label: "task-1", agent: "delegate", status: "complete" }), "task-1 (delegate)");
		assert.equal(subagentTitle({ label: "task-1", agent: "delegate", status: "failed" }), "task-1 (delegate) · failed");
		assert.equal(subagentTitle({ label: "scout", agent: "scout", status: "stopped" }), "scout · stopped");
	});

	test("each child gets a completed tool call of its own that opens its chat", () => {
		const { args, details } = json("workflow-0.84.tool-result.json");
		const calls = subagentCalls(SESSION, subagentRunFromResult("call-1", args, details));
		assert.equal(calls.length, 2);
		const resource = subagentChatUri(SESSION, subagentChatId(WORKFLOW_RUN, "task-1"));
		assert.deepEqual(calls[0], {
			status: "completed",
			toolCallId: "call-1.task-1",
			toolName: "subagent",
			displayName: "task-1 (delegate)",
			invocationMessage: "Starting task-1 (delegate)",
			confirmed: "not-needed",
			success: true,
			pastTenseMessage: "Started task-1 (delegate)",
			content: [
				{
					type: ToolResultContentType.Subagent,
					resource,
					title: "task-1 (delegate)",
					agentName: "delegate",
					description: "Run 'sleep 20' with the bash tool, then reply with exactly: done",
				},
			],
			_meta: {
				toolKind: "subagent",
				subagentChatUri: resource,
				subagentAgentName: "delegate",
				subagentDescription: "task-1: Run 'sleep 20' with the bash tool, then reply w…",
			},
		});
		assert.equal(calls[1]?.toolCallId, subagentCallId("call-1", "task-2"));
		assert.deepEqual(subagentCalls(SESSION, undefined), []);
	});

	test("restored history has a row per child after the subagent tool call", () => {
		const { args, details } = json("workflow-0.84.tool-result.json");
		const run = subagentRunFromResult("call-1", args, details);
		const history = [
			{ type: "message", id: "u", timestamp: NOW, message: { role: "user", content: "go" } },
			{
				type: "message",
				id: "a",
				timestamp: NOW,
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "subagent", arguments: args }],
				},
			},
			{
				type: "message",
				id: "r",
				timestamp: NOW,
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "subagent",
					content: [{ type: "text", text: "started" }],
					details,
				},
			},
		] as unknown as SessionEntry[];
		const [turn] = turnsFromEntries(history, (id) => (id === "call-1" ? subagentCalls(SESSION, run) : undefined));
		assert.deepEqual(
			turn?.responseParts.map((part) =>
				part.kind === "toolCall" ? [part.toolCall.toolCallId, part.toolCall.status] : [],
			),
			[
				["call-1", "completed"],
				["call-1.task-1", "completed"],
				["call-1.task-2", "completed"],
			],
		);
	});
});

describe("background work", () => {
	test("running subagents are subagent entries, finished ones are removed, shells are left alone", () => {
		const work = subagentWork("c1", "ahp-chat://c1/x", "task-1 (delegate)", NOW);
		assert.deepEqual(work, {
			kind: BackgroundWorkKind.Subagent,
			id: "subagent:c1",
			label: "task-1 (delegate)",
			startedAt: NOW,
			chat: "ahp-chat://c1/x",
		});
		const shell = {
			kind: BackgroundWorkKind.Shell as const,
			id: "process:1",
			label: "x",
			startedAt: NOW,
			command: "x",
		};
		assert.deepEqual(subagentWorkActions([shell], [work]), [{ type: ActionType.ChatBackgroundWorkSet, work }]);
		assert.deepEqual(subagentWorkActions([shell, work], [work]), []);
		assert.deepEqual(subagentWorkActions([shell, work], []), [
			{ type: ActionType.ChatBackgroundWorkRemoved, id: "subagent:c1" },
		]);
	});

	test("pi-subagents' runner processes are recognized (0.73 and 0.84 paths)", () => {
		assert.ok(
			isSubagentRunner(
				"/usr/bin/node --import file:///x/node_modules/pi-subagents/runner-peer-preload.mjs /x/node_modules/pi-subagents/src/runs/background/subagent-runner-bootstrap.js /tmp/cfg.json",
			),
		);
		assert.ok(
			isSubagentRunner("node /opt/bolt/plugins/node_modules/pi-subagents/src/runs/background/subagent-runner.ts"),
		);
		assert.ok(
			isSubagentRunner(
				"/opt/bolt/bolt --no-extensions --no-skills --no-prompt-templates --no-session --mode rpc --extension /opt/bolt/plugins/node_modules/pi-subagents/src/runs/background/binary-bootstrap.js",
			),
		);
		assert.ok(!isSubagentRunner("sleep 30"));
		assert.ok(!isSubagentRunner("npm run dev"));
	});
});

describe("restoring without status files", () => {
	test("a workflow's children come from its completion notice and their session files", async () => {
		const { args, details } = json("workflow-0.84.tool-result.json");
		const run = subagentRunFromResult("call-1", args, details)!;
		const notified = notifiedChildren(json("workflow-0.84.notify.json"), WORKFLOW_RUN);
		assert.deepEqual(
			notified.map((child) => [child.key, child.runId.slice(0, 8)]),
			[
				["task-1", "c58fb5c0"],
				["task-2", "478a2a04"],
			],
		);
		const seen: string[] = [];
		const children = await childrenFromSessionFiles(["/s/parent.jsonl"], run, notified, async (path) => {
			seen.push(path);
			return path.includes("c58fb5c0");
		});
		assert.equal(seen[0], "/s/parent/c58fb5c0-2926-4d15-bae0-f2cdc2b58c80/run-0/session.jsonl");
		assert.deepEqual(
			children.map((child) => [child.key, child.status]),
			[["task-1", "complete"]],
		);
	});

	test("a single run's child is found by its run id", async () => {
		const { args, details } = json("single-0.73.tool-result.json");
		const run = subagentRunFromResult("call-2", args, details)!;
		const children = await childrenFromSessionFiles(["/s/parent.jsonl"], run, [], async () => true);
		assert.equal(children[0]?.sessionFile, "/s/parent/a44d414e-e78e-4da5-8098-d2ae7a3fe1e1/run-0/session.jsonl");
		assert.deepEqual(await childrenFromSessionFiles(["/s/parent.jsonl"], run, [], async () => false), []);
	});

	test("a fork finds its source's children under the session that ran them", async () => {
		const { args, details } = json("single-0.73.tool-result.json");
		const run = subagentRunFromResult("call-2", args, details)!;
		const children = await childrenFromSessionFiles(["/s/fork.jsonl", "/s/source.jsonl"], run, [], async (path) =>
			path.startsWith("/s/source/"),
		);
		assert.equal(children[0]?.sessionFile, "/s/source/a44d414e-e78e-4da5-8098-d2ae7a3fe1e1/run-0/session.jsonl");
	});

	test("a session's lineage follows the parentSession of each header", async () => {
		const dir = await mkdtemp(join(tmpdir(), "subagents-lineage-"));
		try {
			const grand = join(dir, "grand.jsonl");
			const parent = join(dir, "parent.jsonl");
			const child = join(dir, "child.jsonl");
			await writeFile(grand, `${JSON.stringify({ type: "session", id: "g" })}\n`);
			await writeFile(parent, `${JSON.stringify({ type: "session", id: "p", parentSession: grand })}\n{"x":1}\n`);
			await writeFile(child, `${JSON.stringify({ type: "session", id: "c", parentSession: parent })}\n`);
			assert.deepEqual(await sessionLineage(child), [child, parent, grand]);
			assert.deepEqual(await sessionLineage(join(dir, "missing.jsonl")), [join(dir, "missing.jsonl")]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("transcripts", () => {
	const all = entries(fixture("child-0.84.session.jsonl"));
	// The file as it grows: user prompt, then the tool call, then its result, then the reply.
	const upTo = (count: number) => turnsFromEntries(all.slice(0, count));
	const running = { status: "running" as const, task: "Run sleep" };
	const complete = { status: "complete" as const, task: "Run sleep" };

	test("the transcript grows into an open turn while the child runs, and ends when it finishes", () => {
		const first = transcriptActions(upTo(6), NO_PROGRESS, running, "c1", NOW);
		let chat = reduce(first.actions);
		assert.equal(chat.activeTurn?.message.origin.kind, MessageKind.Agent);
		assert.match(chat.activeTurn?.message.text ?? "", /^Task: Run 'sleep 20'/);
		assert.equal(chat.status & SessionStatus.InProgress, SessionStatus.InProgress);

		const second = transcriptActions(upTo(7), first.progress, running, "c1", NOW);
		chat = reduce(second.actions, chat);
		const toolCall = chat.activeTurn?.responseParts.find((part) => part.kind === "toolCall");
		assert.equal(toolCall?.kind === "toolCall" && toolCall.toolCall.status, "running");

		const third = transcriptActions(upTo(all.length), second.progress, running, "c1", NOW);
		chat = reduce(third.actions, chat);
		const done = chat.activeTurn?.responseParts.find((part) => part.kind === "toolCall");
		assert.equal(done?.kind === "toolCall" && done.toolCall.status, "completed");
		assert.ok(
			chat.activeTurn?.responseParts.some((part) => part.kind === "markdown" && part.content.startsWith("done")),
		);

		const repeat = transcriptActions(upTo(all.length), third.progress, running, "c1", NOW);
		assert.deepEqual(repeat.actions, []);

		const finished = transcriptActions(upTo(all.length), third.progress, complete, "c1", NOW);
		chat = reduce(finished.actions, chat);
		assert.equal(chat.activeTurn, undefined);
		assert.equal(chat.turns.length, 1);
		assert.equal(chat.turns[0]?.state, TurnState.Complete);
		assert.equal(chat.status & SessionStatus.InProgress, 0);
	});

	test("a finished child's whole transcript arrives at once", () => {
		const { actions } = transcriptActions(upTo(all.length), NO_PROGRESS, complete, "c1", NOW);
		const chat = reduce(actions);
		assert.equal(chat.turns.length, 1);
		assert.ok(chat.turns[0]!.usage);
	});

	test("a child that failed without a transcript shows its error", () => {
		const { actions } = transcriptActions(
			[],
			NO_PROGRESS,
			{ status: "failed", error: "No models available." },
			"c1",
			NOW,
		);
		const chat = reduce(actions);
		assert.equal(chat.turns[0]?.state, TurnState.Error);
		assert.equal(chat.status & SessionStatus.Error, SessionStatus.Error);
		assert.ok(
			chat.turns[0]?.responseParts.some(
				(part) => part.kind === "error" && part.error.message === "No models available.",
			),
		);
	});

	test("a stopped child's open turn ends cancelled", () => {
		const first = transcriptActions(upTo(7), NO_PROGRESS, running, "c1", NOW);
		const stopped = transcriptActions(upTo(7), first.progress, { status: "stopped" }, "c1", NOW);
		const chat = reduce([...first.actions, ...stopped.actions]);
		assert.equal(chat.turns[0]?.state, TurnState.Cancelled);
	});
});
