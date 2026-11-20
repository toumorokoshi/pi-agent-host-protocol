import { open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	ActionType,
	type BackgroundSubagentWork,
	type BackgroundWork,
	BackgroundWorkKind,
	type ChatAction,
	type Message,
	MessageKind,
	ResponsePartKind,
	type ToolCallCompletedState,
	ToolCallConfirmationReason,
	ToolCallStatus,
	ToolResultContentType,
	type Turn,
	TurnState,
} from "@microsoft/agent-host-protocol";
import { subagentChatUri } from "../core/uris.ts";
import { toolCallCompleteAction, toolCallStartActions } from "./tool-call-actions.ts";

/**
 * Pure helpers for showing pi-subagents' subagents as chats: what a `subagent`
 * tool result and a run's `status.json` say about its children, the chat ids
 * and titles derived from them, and the actions that stream a child's session
 * file into its chat. The stateful side is `SubagentTracker` in
 * `subagent-tracker.ts`. See specs/subagents.md.
 */

/** The tool pi-subagents registers. */
export const SUBAGENT_TOOL = "subagent";

/** Why a client action on a subagent chat was refused. */
export const SUBAGENT_CHAT_READ_ONLY = "Subagent chats are read-only";

/** Prefix of background work entries for subagents (shells use `process:`). */
const WORK_ID_PREFIX = "subagent:";

const TITLE_LABEL_LENGTH = 48;
const DESCRIPTION_LENGTH = 200;

/** Where a child is in its life. */
export type SubagentStatus = "pending" | "running" | "complete" | "failed" | "stopped";

/** One subagent of a run, from the tool result, `status.json`, or the session files. */
export interface SubagentChild {
	/** The child's key within its run: a workflow key (`task-1`) or its step index (`0`). */
	readonly key: string;
	/** The child's own run id, when pi-subagents reported one. */
	readonly runId?: string;
	readonly agent: string;
	/** A short name: the workflow key, the step's label, or the start of its task. */
	readonly label: string;
	readonly task?: string;
	readonly status: SubagentStatus;
	readonly sessionFile?: string;
	/** ms since the epoch. */
	readonly startedAt?: number;
	/** Why it failed, when pi-subagents said. */
	readonly error?: string;
}

/** A `subagent` tool call that started subagents: one run (async or foreground) and the children known so far. */
export interface SubagentRun {
	/** The parent's tool call. */
	readonly toolCallId: string;
	/** pi-subagents' run id: the workflow's for a workflow, the run's own otherwise. */
	readonly runId: string;
	/** The run's directory with its `status.json` (async runs only). */
	readonly asyncDir?: string;
	readonly children: readonly SubagentChild[];
}

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);
const num = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** pi-subagents' many status words, reduced to five. Unknown words count as running. */
export function normalizeStatus(value: unknown): SubagentStatus {
	switch (typeof value === "string" ? value.toLowerCase() : "") {
		case "pending":
		case "queued":
			return "pending";
		case "complete":
		case "completed":
		case "done":
		case "verified":
		case "settled":
			return "complete";
		case "failed":
		case "error":
		case "rejected":
			return "failed";
		case "stopped":
		case "cancelled":
		case "canceled":
		case "aborted":
		case "detached":
		case "paused":
			return "stopped";
		default:
			return "running";
	}
}

/** True once a child will not change any more. */
export function isFinished(status: SubagentStatus): boolean {
	return status === "complete" || status === "failed" || status === "stopped";
}

/** A short label from a task: its first line, cut. */
export function taskLabel(task: string | undefined): string | undefined {
	const line = task
		?.trim()
		.split("\n")[0]
		?.replace(/^task:\s*/i, "");
	if (!line) return undefined;
	return line.length > TITLE_LABEL_LENGTH ? `${line.slice(0, TITLE_LABEL_LENGTH - 1)}…` : line;
}

/** Title suffixes for a child that did not complete; VS Code lists a failed chat with the completed ones. */
const OUTCOME_SUFFIX: Partial<Record<SubagentStatus, string>> = { failed: " · failed", stopped: " · stopped" };

/**
 * The chat title of a child: `<label> (<agent>)`, or the agent alone when
 * the label is the agent, then ` · failed` or ` · stopped` once it ended so.
 */
export function subagentTitle(child: Pick<SubagentChild, "label" | "agent"> & { status?: SubagentStatus }): string {
	const name = child.label === child.agent ? child.agent : `${child.label} (${child.agent})`;
	return `${name}${(child.status && OUTCOME_SUFFIX[child.status]) ?? ""}`;
}

/**
 * The id of a child's chat, stable across host restarts: from the run id and
 * the child's key, plus `scope` for a run seen from a forked chat (whose
 * history repeats its source's `subagent` calls). It doubles as the
 * authority of the chat's URI, so it keeps to lower-case letters, digits and
 * hyphens.
 */
export function subagentChatId(runId: string, key: string, scope?: string): string {
	return `subagent-${runId}-${key}${scope ? `-in-${scope}` : ""}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}

/** The children a `subagent` call's arguments name, before pi-subagents reports them. */
export function childrenFromArgs(args: unknown, mode: string | undefined): SubagentChild[] {
	if (!isRecord(args)) return [];
	const child = (key: string, item: unknown): SubagentChild | undefined => {
		if (!isRecord(item)) return undefined;
		const agent = str(item.agent);
		if (!agent) return undefined;
		const task = str(item.task);
		return { key, agent, label: key, ...(task ? { task } : {}), status: "pending" };
	};
	const tasks = Array.isArray(args.tasks)
		? args.tasks
		: str(args.workflow) === "parallel" && isRecord(args.args) && Array.isArray(args.args.tasks)
			? args.args.tasks
			: undefined;
	if (tasks) {
		// Structured `tasks` and the `parallel` workflow name their children task-1, task-2, ...
		return tasks.flatMap((item, index) => child(mode === "workflow" ? `task-${index + 1}` : String(index), item) ?? []);
	}
	if (Array.isArray(args.chain)) {
		if (mode !== "workflow") return [];
		return args.chain.flatMap((step, index) => {
			const number = index + 1;
			if (isRecord(step) && Array.isArray(step.parallel)) {
				return step.parallel.flatMap((item, itemIndex) => child(`step-${number}-${itemIndex + 1}`, item) ?? []);
			}
			return child(`step-${number}`, step) ?? [];
		});
	}
	const agent = str(args.agent);
	if (agent && !args.workflow) {
		const task = str(args.task);
		return [{ key: "0", agent, label: taskLabel(task) ?? agent, ...(task ? { task } : {}), status: "pending" }];
	}
	return [];
}

/**
 * The run a `subagent` tool result started, or undefined for calls that
 * started none (management actions such as `status` or `list`, and errors).
 * Async runs carry their directory; foreground runs carry finished children
 * with their session files.
 */
export function subagentRunFromResult(toolCallId: string, args: unknown, details: unknown): SubagentRun | undefined {
	if (!isRecord(details)) return undefined;
	const mode = str(details.mode);
	if (mode === "management") return undefined;
	const runId = str(details.runId) ?? str(details.asyncId);
	if (!runId) return undefined;
	const asyncDir = str(details.asyncDir);
	if (asyncDir) return { toolCallId, runId, asyncDir, children: childrenFromArgs(args, mode) };
	const results = Array.isArray(details.results) ? details.results.filter(isRecord) : [];
	const fromArgs = childrenFromArgs(args, mode);
	const children = results.flatMap((result, index): SubagentChild[] => {
		const sessionFile = str(result.sessionFile);
		if (!sessionFile) return [];
		const key = str(result.workflowKey) ?? str(result.key) ?? String(num(result.index) ?? index);
		const planned = fromArgs.find((candidate) => candidate.key === key) ?? fromArgs[index];
		const agent = str(result.agent) ?? planned?.agent ?? "subagent";
		const exitCode = num(result.exitCode);
		const error = str(result.error);
		return [
			{
				key,
				agent,
				label: planned?.label ?? agent,
				...(planned?.task ? { task: planned.task } : {}),
				status: error || (exitCode !== undefined && exitCode !== 0) ? "failed" : "complete",
				sessionFile,
				...(error ? { error } : {}),
			},
		];
	});
	return children.length > 0 ? { toolCallId, runId, children } : undefined;
}

/** What a run's `status.json` says: its state, its runner's pid, its parent tool call, and its children. */
export interface RunStatus {
	readonly state: SubagentStatus;
	/** The runner process's pid, when the file names it. */
	readonly pid?: number;
	readonly toolCallId?: string;
	readonly children: readonly SubagentChild[];
}

/** Parses a run's `status.json` (pi-subagents 0.73 and 0.84). Undefined when it is not one. */
export function parseRunStatus(text: string): RunStatus | undefined {
	let status: unknown;
	try {
		status = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isRecord(status) || !str(status.runId)) return undefined;
	const workflow = str(status.mode) === "workflow";
	const runState = normalizeStatus(status.state);
	const steps = Array.isArray(status.steps) ? status.steps.filter(isRecord) : [];
	const children: SubagentChild[] = steps.map((step, index) => {
		const key = workflow ? (str(step.workflowKey) ?? str(step.label) ?? String(index)) : String(index);
		const agent = str(step.agent) ?? "subagent";
		const stepStatus = normalizeStatus(step.status);
		const error = str(step.error);
		const startedAt = num(step.startedAt);
		const runId = str(step.runId);
		const sessionFile = str(step.sessionFile);
		return {
			key,
			agent,
			label: workflow ? key : (str(step.label) ?? taskLabel(str(step.sessionName)?.replace(/^[^:]+:\s*/, "")) ?? agent),
			// A finished run leaves no step running, whatever the step last recorded.
			status: isFinished(runState) && !isFinished(stepStatus) ? runState : stepStatus,
			...(runId ? { runId } : {}),
			...(sessionFile ? { sessionFile } : {}),
			...(startedAt !== undefined ? { startedAt } : {}),
			...(error ? { error } : {}),
		};
	});
	// Before its steps are written, a workflow lists its children in `workflowChildren`.
	if (workflow && children.length === 0 && isRecord(status.workflowChildren)) {
		const listed = Array.isArray(status.workflowChildren.children) ? status.workflowChildren.children : [];
		for (const item of listed.filter(isRecord)) {
			const key = str(item.childId);
			if (!key) continue;
			const runId = str(item.runId);
			children.push({
				key,
				agent: str(item.agent) ?? "subagent",
				label: key,
				status: normalizeStatus(item.state),
				...(runId ? { runId } : {}),
			});
		}
	}
	const toolCallId = str(status.toolCallId);
	const pid = num(status.pid);
	return {
		state: runState,
		...(pid !== undefined && Number.isInteger(pid) && pid > 0 ? { pid } : {}),
		...(toolCallId ? { toolCallId } : {}),
		children,
	};
}

/**
 * Children of a run whose `status.json` is gone (pi-subagents keeps it in
 * `/tmp`, which may be cleaned): pi-subagents 0.84 keeps each child's
 * session at `<parent session file without .jsonl>/<child run id>/run-0/session.jsonl`.
 * `parentSessionFiles` is the chat's own session file and the files it was
 * forked from, since a fork repeats its source's `subagent` calls and the
 * children sit under the session that ran them; the first with the child's
 * file wins. `notified` lists a workflow's children with their run ids, from
 * its completion notice. Children whose file is missing are left out.
 */
export async function childrenFromSessionFiles(
	parentSessionFiles: readonly string[],
	run: SubagentRun,
	notified: readonly { key: string; runId: string; agent?: string; status?: string }[],
	exists: (path: string) => Promise<boolean> = fileExists,
): Promise<SubagentChild[]> {
	const find = async (runId: string): Promise<string | undefined> => {
		for (const parent of parentSessionFiles) {
			const file = join(parent.replace(/\.jsonl$/, ""), runId, "run-0", "session.jsonl");
			if (await exists(file)) return file;
		}
		return undefined;
	};
	if (notified.length > 0) {
		const children: SubagentChild[] = [];
		for (const entry of notified) {
			const sessionFile = await find(entry.runId);
			if (!sessionFile) continue;
			const planned = run.children.find((child) => child.key === entry.key);
			const agent = entry.agent ?? planned?.agent ?? "subagent";
			const status = entry.status ? normalizeStatus(entry.status) : "complete";
			children.push({
				key: entry.key,
				runId: entry.runId,
				agent,
				label: planned?.label ?? entry.key,
				status: isFinished(status) ? status : "stopped",
				sessionFile,
			});
		}
		return children;
	}
	const single = run.children.length === 1 ? run.children[0] : undefined;
	const sessionFile = single ? await find(run.runId) : undefined;
	if (!single || !sessionFile) return [];
	return [{ ...single, runId: run.runId, status: "complete", sessionFile }];
}

/** A workflow's children as its completion notices list them (`subagent-notify` details). */
export function notifiedChildren(
	details: unknown,
	runId: string,
): { key: string; runId: string; agent?: string; status?: string }[] {
	if (!isRecord(details)) return [];
	const runs = Array.isArray(details.runs) ? details.runs.filter(isRecord) : [];
	const run = runs.find((candidate) => str(candidate.runId) === runId || str(candidate.workflowRunId) === runId);
	const childRuns = run && Array.isArray(run.childRuns) ? run.childRuns.filter(isRecord) : [];
	return childRuns.flatMap((child) => {
		const key = str(child.workflowKey);
		const childRunId = str(child.runId);
		if (!key || !childRunId) return [];
		const agent = str(child.agent);
		const status = str(child.status);
		return [{ key, runId: childRunId, ...(agent ? { agent } : {}), ...(status ? { status } : {}) }];
	});
}

/**
 * Merges what is known about a run's children: later sources (status file)
 * update earlier ones (tool arguments) by key, keeping a known label and task.
 */
export function mergeChildren(known: readonly SubagentChild[], update: readonly SubagentChild[]): SubagentChild[] {
	const merged = new Map(known.map((child) => [child.key, child]));
	for (const child of update) {
		const previous = merged.get(child.key);
		merged.set(
			child.key,
			previous
				? {
						...previous,
						...child,
						label: previous.label,
						...(previous.task && !child.task ? { task: previous.task } : {}),
					}
				: child,
		);
	}
	return [...merged.values()];
}

/** The id of the host-made tool call that stands for one child in its parent's turn. */
export function subagentCallId(toolCallId: string, key: string): string {
	return `${toolCallId}.${key}`;
}

/**
 * One completed tool call per child, placed in the parent's turn after the
 * `subagent` call that started them. VS Code shows one subagent row per tool
 * call, for its first subagent link only, so a call starting seven children
 * would show one; each child gets a row of its own that opens its chat. The
 * child's chat names its row as its origin (`subagentCallId`).
 */
export function subagentCalls(
	sessionResource: string,
	run: SubagentRun | undefined,
	scope?: string,
): ToolCallCompletedState[] {
	if (!run) return [];
	return run.children.map((child) => {
		const resource = subagentChatUri(sessionResource, subagentChatId(run.runId, child.key, scope));
		const title = subagentTitle({ label: child.label, agent: child.agent });
		// The row's label: the child's name, then its task when the name isn't already the task.
		const task = taskLabel(child.task);
		const label = task && task !== child.label ? `${child.label}: ${task}` : child.label;
		return {
			status: ToolCallStatus.Completed,
			toolCallId: subagentCallId(run.toolCallId, child.key),
			toolName: SUBAGENT_TOOL,
			displayName: title,
			invocationMessage: `Starting ${title}`,
			confirmed: ToolCallConfirmationReason.NotNeeded,
			success: true,
			pastTenseMessage: `Started ${title}`,
			content: [
				{
					type: ToolResultContentType.Subagent,
					resource,
					title,
					agentName: child.agent,
					...(child.task ? { description: cut(child.task, DESCRIPTION_LENGTH) } : {}),
				},
			],
			// What VS Code's subagent row reads: its kind, chat, agent and label.
			_meta: {
				toolKind: "subagent",
				subagentChatUri: resource,
				subagentAgentName: child.agent,
				subagentDescription: label,
			},
		};
	});
}

/**
 * True for the process pi-subagents runs an async run in (it is pi's child,
 * so it would show as a shell): node running its `subagent-runner`, or, under
 * a standalone binary such as Bolt, the binary loading its `binary-bootstrap`.
 */
export function isSubagentRunner(command: string): boolean {
	return /pi-subagents[\\/].*(subagent-runner|binary-bootstrap)/.test(command);
}

/** The background work entry of a running child. */
export function subagentWork(chatId: string, chat: string, title: string, startedAt: string): BackgroundSubagentWork {
	return { kind: BackgroundWorkKind.Subagent, id: `${WORK_ID_PREFIX}${chatId}`, label: title, startedAt, chat };
}

/**
 * The actions that bring a chat's subagent entries in line with `running`;
 * entries of other kinds are left alone.
 */
export function subagentWorkActions(
	current: readonly BackgroundWork[],
	running: readonly BackgroundSubagentWork[],
): ChatAction[] {
	const wanted = new Map(running.map((work) => [work.id, work]));
	const listed = new Set(current.map((work) => work.id));
	return [
		...current
			.filter((work) => work.id.startsWith(WORK_ID_PREFIX) && !wanted.has(work.id))
			.map((work): ChatAction => ({ type: ActionType.ChatBackgroundWorkRemoved, id: work.id })),
		...running
			.filter((work) => !listed.has(work.id))
			.map((work): ChatAction => ({ type: ActionType.ChatBackgroundWorkSet, work })),
	];
}

/** Reads a file, or undefined when it cannot be read. */
export async function readText(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

/** What tells that a file changed: its size and modification time. */
export interface FileStamp {
	readonly size: number;
	readonly mtimeMs: number;
}

/** A file's stamp, or undefined when it cannot be read. */
export async function fileStamp(path: string): Promise<FileStamp | undefined> {
	try {
		const { size, mtimeMs } = await stat(path);
		return { size, mtimeMs };
	} catch {
		return undefined;
	}
}

async function fileExists(path: string): Promise<boolean> {
	return (await fileStamp(path)) !== undefined;
}

/** How far into a session file its header line is looked for. */
const HEADER_BYTES = 16 * 1024;
const MAX_LINEAGE = 8;

/**
 * A pi session file followed by the session files it was forked from (the
 * `parentSession` of each header), nearest first, up to a few generations.
 */
export async function sessionLineage(file: string): Promise<string[]> {
	const lineage: string[] = [];
	for (let next: string | undefined = file; next && !lineage.includes(next) && lineage.length < MAX_LINEAGE; ) {
		lineage.push(next);
		next = await parentSessionOf(next);
	}
	return lineage;
}

async function parentSessionOf(file: string): Promise<string | undefined> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(file, "r");
		const buffer = Buffer.alloc(HEADER_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
		const header = JSON.parse(buffer.toString("utf8", 0, bytesRead).split("\n")[0] ?? "") as unknown;
		return isRecord(header) ? str(header.parentSession) : undefined;
	} catch {
		return undefined;
	} finally {
		await handle?.close();
	}
}

/** Whether a process exists. `EPERM` means it does, under another user. */
export function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

// ── Streaming a child's transcript ──────────────────────────────────────────

/** What has been published of a child's turns. */
export interface TranscriptProgress {
	/** Turns already ended in the chat. */
	readonly ended: ReadonlySet<string>;
	/** The turn still open in the chat, with how many of its parts were sent and which tool calls completed. */
	readonly open?: { readonly id: string; readonly parts: number; readonly completedTools: ReadonlySet<string> };
}

export const NO_PROGRESS: TranscriptProgress = { ended: new Set() };

/** A child that ended without a transcript gets one turn with this id suffix, to show how it ended. */
const EMPTY_TURN = "ended";

/**
 * The actions that bring a child's chat from `progress` to `turns` (the
 * turns of its session file, as `turnsFromEntries` builds them), and the
 * progress after them. The last turn stays open while the child runs; a
 * finished child's turns all end, the last one as the child ended (failed
 * or stopped) unless its file recorded an error. A child that ended without
 * a transcript gets one turn saying so. Parts only ever grow, and a tool
 * call changes only from running to completed, which is how pi appends to
 * a session file.
 */
export function transcriptActions(
	turns: readonly Turn[],
	progress: TranscriptProgress,
	child: Pick<SubagentChild, "status" | "error" | "task">,
	chatId: string,
	now: string,
): { actions: ChatAction[]; progress: TranscriptProgress } {
	const actions: ChatAction[] = [];
	const ended = new Set(progress.ended);
	let open = progress.open;
	const finished = isFinished(child.status);
	const shown = turns.length === 0 && finished ? [emptyTurn(`${chatId}.${EMPTY_TURN}`, child, now)] : turns;
	shown.forEach((turn, index) => {
		if (ended.has(turn.id)) return;
		if (open && open.id !== turn.id) {
			// A later turn started, so the open one is done; end it as its file recorded it.
			const previous = shown.find((candidate) => candidate.id === open?.id);
			actions.push(...endTurn(previous, open.id));
			ended.add(open.id);
			open = undefined;
		}
		if (!open) {
			actions.push({
				type: ActionType.ChatTurnStarted,
				turnId: turn.id,
				startedAt: turn.startedAt ?? now,
				message: turn.message.origin.kind === MessageKind.User ? agentMessage(turn.message) : turn.message,
			});
			open = { id: turn.id, parts: 0, completedTools: new Set() };
		}
		const parts = turn.responseParts.filter((part) => part.kind !== ResponsePartKind.Error);
		const completedTools = new Set(open.completedTools);
		parts.forEach((part, partIndex) => {
			const isNew = partIndex >= (open?.parts ?? 0);
			if (part.kind === ResponsePartKind.ToolCall) {
				const toolCall = part.toolCall;
				// History never has streaming tool calls; they have no arguments to show yet.
				if (toolCall.status === ToolCallStatus.Streaming) return;
				if (isNew) actions.push(...toolCallStartActions(turn.id, toolCall));
				if (toolCall.status === ToolCallStatus.Completed && !completedTools.has(toolCall.toolCallId)) {
					actions.push(toolCallCompleteAction(turn.id, toolCall));
					completedTools.add(toolCall.toolCallId);
				}
			} else if (isNew && (part.kind === ResponsePartKind.Markdown || part.kind === ResponsePartKind.Reasoning)) {
				actions.push({ type: ActionType.ChatResponsePart, turnId: turn.id, part });
			}
		});
		open = { id: turn.id, parts: parts.length, completedTools };
		if (index < shown.length - 1) {
			actions.push(...endTurn(turn, turn.id));
			ended.add(turn.id);
			open = undefined;
		} else if (finished) {
			actions.push(...endTurn(asEnded(turn, child), turn.id));
			ended.add(turn.id);
			open = undefined;
		}
	});
	if (open && finished) {
		// The child finished but its open turn is no longer in the file.
		actions.push(...endTurn(undefined, open.id));
		ended.add(open.id);
		open = undefined;
	}
	return { actions, progress: { ended, ...(open ? { open } : {}) } };
}

function agentMessage(message: Message): Message {
	return { ...message, origin: { kind: MessageKind.Agent } };
}

/** The turn shown for a child that ended without a transcript. */
function emptyTurn(id: string, child: Pick<SubagentChild, "status" | "error" | "task">, now: string): Turn {
	const turn: Turn = {
		id,
		startedAt: now,
		message: { text: child.task ?? "Subagent", origin: { kind: MessageKind.Agent } },
		responseParts: [],
		usage: undefined,
		state: TurnState.Complete,
	};
	if (child.status === "complete") {
		return {
			...turn,
			responseParts: [
				{ kind: ResponsePartKind.Markdown, id: `${id}.note`, content: "The subagent's transcript is not available." },
			],
		};
	}
	return asEnded(turn, child);
}

/** A finished child's last turn, marked failed or stopped as the child ended, unless its file recorded an error. */
function asEnded(turn: Turn, child: Pick<SubagentChild, "status" | "error">): Turn {
	if (turn.state === TurnState.Error || child.status === "complete") return turn;
	if (child.status === "stopped") return { ...turn, state: TurnState.Cancelled };
	return {
		...turn,
		state: TurnState.Error,
		responseParts: [
			...turn.responseParts,
			{
				kind: ResponsePartKind.Error,
				error: { errorType: "agentError", message: child.error ?? "The subagent failed" },
			},
		],
	};
}

function endTurn(turn: Turn | undefined, turnId: string): ChatAction[] {
	const duration = turn?.duration ?? 0;
	const usage: ChatAction[] = turn?.usage ? [{ type: ActionType.ChatUsage, turnId, usage: turn.usage }] : [];
	if (turn?.state === TurnState.Error) {
		const error = turn.responseParts.find((part) => part.kind === ResponsePartKind.Error);
		return [
			...usage,
			{
				type: ActionType.ChatError,
				turnId,
				duration,
				part:
					error?.kind === ResponsePartKind.Error
						? error
						: { kind: ResponsePartKind.Error, error: { errorType: "agentError", message: "The subagent failed" } },
			},
		];
	}
	if (turn?.state === TurnState.Cancelled) return [...usage, { type: ActionType.ChatTurnCancelled, turnId, duration }];
	return [...usage, { type: ActionType.ChatTurnComplete, turnId, duration }];
}

function cut(text: string, length: number): string {
	const flat = text.trim();
	return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}
