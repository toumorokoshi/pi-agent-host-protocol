import { type FSWatcher, watch } from "node:fs";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	type ActionOrigin,
	ActionType,
	type BackgroundSubagentWork,
	type ChatAction,
	ChatInteractivity,
	ChatOriginKind,
	type ChatState,
	type ChatSummary,
	SessionStatus,
	type StateAction,
	type ToolCallCompletedState,
} from "@microsoft/agent-host-protocol";
import type { Logger } from "../core/logger.ts";
import type { StateStore } from "../core/state-store.ts";
import { subagentChatUri } from "../core/uris.ts";
import type { PiEvent } from "./agent.ts";
import { turnsFromEntries } from "./history.ts";
import {
	childrenFromSessionFiles,
	type FileStamp,
	fileStamp,
	isFinished,
	mergeChildren,
	NO_PROGRESS,
	notifiedChildren,
	parseRunStatus,
	processAlive,
	type RunStatus,
	readText,
	SUBAGENT_CHAT_READ_ONLY,
	SUBAGENT_TOOL,
	type SubagentChild,
	type SubagentRun,
	sessionLineage,
	subagentCallId,
	subagentCalls,
	subagentChatId,
	subagentRunFromResult,
	subagentTitle,
	subagentWork,
	type TranscriptProgress,
	transcriptActions,
} from "./subagents.ts";
import { completedToolCallActions } from "./tool-call-actions.ts";

/**
 * How long a run's `status.json` may be missing after its `subagent` call
 * returned before the run counts as gone: its runner may still be starting.
 */
export const STATUS_GRACE_MS = 30_000;

/** What the tracker needs from the chat that started the subagents. */
export interface SubagentHost {
	readonly store: StateStore;
	readonly logger: Logger;
	/** The AHP session the parent chat belongs to. */
	readonly sessionId: string;
	/** Set for a forked chat (its pi session id), so its subagent chats don't collide with its source's. */
	readonly scope?: string;
	/** The parent chat's URI. */
	readonly parentChat: string;
	/** Whether a process exists (replaced in tests). */
	isProcessAlive?(pid: number): boolean;
	/** The id of the parent chat's running turn, if it holds the tool call `toolCallId`. */
	activeTurnWith(toolCallId: string): string | undefined;
	/** pi's session file of the parent chat, when it has one. */
	sessionFile(): string | undefined;
	/** Publishes the session's chat catalog after chats were added or changed. */
	catalogChanged(): void;
	/** The subagents' background work changed. */
	backgroundWorkChanged(): void;
	now(): number;
}

interface TrackedChild {
	readonly chatId: string;
	readonly chat: string;
	child: SubagentChild;
	progress: TranscriptProgress;
	/** Size and modification time of the session file when last read, to skip an unchanged file. */
	stamp: FileStamp | undefined;
	/** Whether its chat exists yet (a restore builds children before publishing them). */
	published: boolean;
}

interface TrackedRun {
	run: SubagentRun;
	readonly children: Map<string, TrackedChild>;
	watcher: FSWatcher | undefined;
	finished: boolean;
	/** When the run was first tracked (ms): a status file not written yet is waited for until then plus `STATUS_GRACE_MS`. */
	readonly trackedAt: number;
	/** Whether `status.json` was ever read: only then does its absence mean it was cleaned up. */
	statusSeen: boolean;
	/** `status.json` as last read, to skip re-parsing an unchanged file. */
	status: { readonly stamp: FileStamp; readonly parsed: RunStatus } | undefined;
	/** Keys of the children that have a row in the parent's turn; undefined until the parent's turn asked for the rows (`callsFor`). */
	rowed: Set<string> | undefined;
}

/** A `subagent` run found in a session file's history, with its status file's content if it was still there. */
export interface RestoredRun {
	readonly run: SubagentRun;
	readonly status?: RunStatus;
}

/**
 * Finds every `subagent` tool result on a session's branch and what is left
 * of its run: read from its status file, or, when that is gone (`/tmp`
 * cleaned, or a new machine), from the session files under `sessionFile`
 * and the files it was forked from. Async, so a session loads without
 * blocking the host; the tracker's `restore` then applies it synchronously.
 */
export async function loadSubagentRuns(
	entries: readonly SessionEntry[],
	sessionFile: string | undefined,
): Promise<RestoredRun[]> {
	const args = new Map<string, unknown>();
	const runs: SubagentRun[] = [];
	const notices: unknown[] = [];
	for (const entry of entries) {
		if (entry.type === "custom_message" && (entry as { customType?: string }).customType === "subagent-notify") {
			notices.push((entry as { details?: unknown }).details);
		}
		if (entry.type !== "message") continue;
		const message = entry.message as {
			role?: string;
			content?: unknown;
			toolCallId?: string;
			toolName?: string;
			details?: unknown;
		};
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content as { type?: string; id?: string; name?: string; arguments?: unknown }[]) {
				if (block.type === "toolCall" && block.name === SUBAGENT_TOOL && block.id) args.set(block.id, block.arguments);
			}
		}
		if (message.role === "toolResult" && message.toolName === SUBAGENT_TOOL && message.toolCallId) {
			const run = subagentRunFromResult(message.toolCallId, args.get(message.toolCallId), message.details);
			if (run) runs.push(run);
		}
	}
	const restored: RestoredRun[] = [];
	let lineage: string[] | undefined;
	for (const run of runs) {
		const statusText = run.asyncDir ? await readText(`${run.asyncDir}/status.json`) : undefined;
		if (!run.asyncDir || statusText !== undefined) {
			const status = statusText === undefined ? undefined : parseRunStatus(statusText);
			restored.push({ run, ...(status ? { status } : {}) });
			continue;
		}
		if (!sessionFile) continue;
		lineage ??= await sessionLineage(sessionFile);
		const notified = notices.flatMap((details) => notifiedChildren(details, run.runId));
		const children = await childrenFromSessionFiles(lineage, run, notified);
		if (children.length > 0) restored.push({ run: { toolCallId: run.toolCallId, runId: run.runId, children } });
	}
	return restored;
}

/**
 * Shows the subagents a pi chat starts with pi-subagents' `subagent` tool as
 * read-only chats of its session (`origin: { kind: "tool" }`), linked from
 * the tool call, listed as `subagent` background work while they run, and
 * streaming each child's session file into its chat. See specs/subagents.md.
 *
 * Files are read asynchronously, one refresh at a time, and only when their
 * size or modification time changed.
 */
export class SubagentTracker {
	readonly #host: SubagentHost;
	readonly #runs = new Map<string, TrackedRun>();
	/** Arguments of `subagent` tool calls, by tool call id, until their result arrives. */
	readonly #args = new Map<string, unknown>();
	#disposed = false;
	/** False while a restore builds children whose chats `publish()` adds later. */
	#publishing = true;
	/** Refreshes run one after the other, so none reads files while another is dispatching. */
	#chain: Promise<void> = Promise.resolve();
	#pendingRefresh: Promise<void> | undefined;

	constructor(host: SubagentHost) {
		this.#host = host;
	}

	/** True if `chat` is one of this tracker's subagent chats. */
	owns(chatId: string): boolean {
		for (const run of this.#runs.values()) if (run.children.has(chatId)) return true;
		return false;
	}

	/**
	 * Applies what a client may change on a subagent chat it can't type into:
	 * whether it has been read and the input's draft. Anything else is
	 * refused; `undefined` means the action was applied.
	 */
	clientAction(chatId: string, action: StateAction, origin: ActionOrigin | undefined): string | undefined {
		if (action.type !== ActionType.ChatIsReadChanged && action.type !== ActionType.ChatDraftChanged) {
			return SUBAGENT_CHAT_READ_ONLY;
		}
		const tracked = this.#tracked(chatId);
		if (!tracked?.published) return SUBAGENT_CHAT_READ_ONLY;
		const { store } = this.#host;
		if (!store.dispatch(tracked.chat, action, origin) || action.type !== ActionType.ChatIsReadChanged) return undefined;
		const chat = store.chat(chatId);
		if (chat) {
			store.dispatch(store.sessionResource(this.#host.sessionId), {
				type: ActionType.SessionChatUpdated,
				chat: tracked.chat,
				changes: { status: chat.status },
			});
			this.#host.catalogChanged();
		}
		return undefined;
	}

	#tracked(chatId: string): TrackedChild | undefined {
		for (const run of this.#runs.values()) {
			const tracked = run.children.get(chatId);
			if (tracked) return tracked;
		}
		return undefined;
	}

	/**
	 * Builds the runs of a chat loaded from its session file (see
	 * `loadSubagentRuns`). Their chats are added by `publish()`, once the
	 * parent chat is in the store; `callsFor` works before that, so the
	 * parent's history can carry the rows.
	 */
	restore(restored: readonly RestoredRun[]): void {
		this.#publishing = false;
		for (const { run, status } of restored) this.#track(run, status);
	}

	/** Adds the chats of restored children and starts following the runs still going. */
	publish(): void {
		if (this.#publishing) return;
		this.#publishing = true;
		let added = false;
		for (const run of this.#runs.values()) {
			for (const tracked of run.children.values()) {
				if (tracked.published) continue;
				this.#addChat(tracked, run.run.toolCallId);
				added = true;
			}
			if (!run.finished) this.#watch(run);
		}
		if (added) this.#host.catalogChanged();
		void this.refresh();
		this.#host.backgroundWorkChanged();
	}

	/** Follows a live pi event stream: records `subagent` calls' arguments and tracks the runs their results start. */
	handle(event: PiEvent): void {
		if (event.type === "tool_execution_start" && event.toolName === SUBAGENT_TOOL) {
			this.#args.set(event.toolCallId, event.args);
			return;
		}
		if (event.type !== "tool_execution_end" || event.toolName !== SUBAGENT_TOOL) return;
		const args = this.#args.get(event.toolCallId);
		this.#args.delete(event.toolCallId);
		if (event.isError) return;
		const details = (event.result as { details?: unknown } | undefined)?.details;
		const run = subagentRunFromResult(event.toolCallId, args, details);
		if (!run) return;
		const tracked = this.#track(run);
		this.#host.logger.debug("subagents started", {
			session: this.#host.sessionId,
			run: run.runId,
			children: tracked?.children.size ?? 0,
		});
		if (tracked) this.#enqueue(() => this.#refreshRun(tracked));
	}

	/**
	 * The rows, one per subagent, that follow the parent's `subagent` tool call
	 * in its turn. Undefined for calls that started no subagents. Children
	 * found later get their rows through `#serveRows`.
	 */
	callsFor(toolCallId: string): ToolCallCompletedState[] | undefined {
		const run = [...this.#runs.values()].find((candidate) => candidate.run.toolCallId === toolCallId);
		if (!run) return undefined;
		run.rowed = new Set([...run.children.values()].map((tracked) => tracked.child.key));
		return subagentCalls(this.#host.store.sessionResource(this.#host.sessionId), this.#runOf(run), this.#host.scope);
	}

	/** The `subagent` background work entries of the children still running. */
	runningWork(): BackgroundSubagentWork[] {
		return [...this.#runs.values()].flatMap((run) =>
			[...run.children.values()]
				.filter((tracked) => !isFinished(tracked.child.status))
				.map((tracked) =>
					subagentWork(
						tracked.chatId,
						tracked.chat,
						subagentTitle(tracked.child),
						new Date(tracked.child.startedAt ?? this.#host.now()).toISOString(),
					),
				),
		);
	}

	/**
	 * Re-reads the status file of every unfinished run and the session file of
	 * every unfinished child that changed. The host calls it with its
	 * background work refresh (`AgentHost`'s timer, and turn starts and ends);
	 * `fs.watch` on a status file is the low-latency path. Nothing is read
	 * for runs that finished. Calls made while a refresh is waiting share it.
	 */
	refresh(): Promise<void> {
		if (this.#disposed) return Promise.resolve();
		this.#pendingRefresh ??= this.#enqueue(async () => {
			this.#pendingRefresh = undefined;
			for (const run of [...this.#runs.values()]) await this.#refreshRun(run);
		});
		return this.#pendingRefresh;
	}

	dispose(): void {
		this.#disposed = true;
		for (const run of this.#runs.values()) run.watcher?.close();
	}

	#enqueue(task: () => Promise<void>): Promise<void> {
		const next = this.#chain.then(task).catch((error) => {
			this.#host.logger.warn("could not refresh subagents", {
				session: this.#host.sessionId,
				error: error instanceof Error ? error.message : String(error),
			});
		});
		this.#chain = next;
		return next;
	}

	#runOf(run: TrackedRun): SubagentRun {
		return { ...run.run, children: [...run.children.values()].map((tracked) => tracked.child) };
	}

	/** Starts tracking a run (or adds to the known one) and, once published, follows it. */
	#track(run: SubagentRun, status?: RunStatus): TrackedRun | undefined {
		if (this.#disposed) return undefined;
		const existing = this.#runs.get(run.runId);
		const tracked: TrackedRun = existing ?? {
			run,
			children: new Map(),
			watcher: undefined,
			finished: !run.asyncDir,
			trackedAt: this.#host.now(),
			statusSeen: false,
			status: undefined,
			rowed: undefined,
		};
		if (!existing) this.#runs.set(run.runId, tracked);
		this.#addChildren(tracked, run.children);
		if (status) {
			tracked.statusSeen = true;
			this.#addChildren(tracked, status.children);
			if (isFinished(status.state)) tracked.finished = true;
		}
		if (!this.#publishing) return tracked;
		if (!tracked.finished) this.#watch(tracked);
		this.#host.backgroundWorkChanged();
		return tracked;
	}

	/** Adds chats for children not seen yet and updates the known ones. */
	#addChildren(run: TrackedRun, children: readonly SubagentChild[]): void {
		const known = [...run.children.values()].map((tracked) => tracked.child);
		const merged = mergeChildren(known, children);
		let added = false;
		for (const child of merged) {
			const chatId = subagentChatId(run.run.runId, child.key, this.#host.scope);
			const tracked = run.children.get(chatId);
			if (tracked) {
				this.#updateChild(tracked, child);
				continue;
			}
			const chat = subagentChatUri(this.#host.store.sessionResource(this.#host.sessionId), chatId);
			const created: TrackedChild = { chatId, chat, child, progress: NO_PROGRESS, stamp: undefined, published: false };
			run.children.set(chatId, created);
			if (!this.#publishing) continue;
			this.#addChat(created, run.run.toolCallId);
			added = true;
		}
		if (added) this.#host.catalogChanged();
	}

	#addChat(tracked: TrackedChild, toolCallId: string): void {
		tracked.published = true;
		const { chatId, chat, child } = tracked;
		const { store } = this.#host;
		const now = new Date(child.startedAt ?? this.#host.now()).toISOString();
		const summary: ChatSummary = {
			resource: chat,
			title: subagentTitle(child),
			// Until its first turn, a child is shown working; its turns decide from then on.
			status: SessionStatus.InProgress | SessionStatus.IsRead,
			modifiedAt: now,
			// Its row in the parent's turn (see `subagentCalls`).
			origin: {
				kind: ChatOriginKind.Tool,
				chat: this.#host.parentChat,
				toolCallId: subagentCallId(toolCallId, child.key),
			},
			interactivity: ChatInteractivity.ReadOnly,
		};
		const state: ChatState = { ...summary, turns: [] };
		store.addForkedChat({ kind: "chat", sessionId: this.#host.sessionId, chatId }, chat, state);
		store.dispatch(store.sessionResource(this.#host.sessionId), { type: ActionType.SessionChatAdded, summary });
	}

	#updateChild(tracked: TrackedChild, child: SubagentChild): void {
		const before = tracked.child;
		tracked.child = child;
		const { store } = this.#host;
		const title = subagentTitle(child);
		const current = tracked.published ? store.chat(tracked.chatId) : undefined;
		if (current && current.title !== title) {
			store.setChatTitle(tracked.chatId, title);
			store.dispatch(store.sessionResource(this.#host.sessionId), {
				type: ActionType.SessionChatUpdated,
				chat: tracked.chat,
				changes: { title },
			});
			this.#host.catalogChanged();
		}
		if (before.status !== child.status) {
			this.#host.logger.debug("subagent status changed", {
				session: this.#host.sessionId,
				chat: tracked.chatId,
				status: child.status,
			});
			if (isFinished(child.status) !== isFinished(before.status)) this.#host.backgroundWorkChanged();
		}
	}

	async #refreshRun(run: TrackedRun): Promise<void> {
		if (this.#disposed) return;
		if (run.run.asyncDir && !run.finished) await this.#refreshStatus(run, `${run.run.asyncDir}/status.json`);
		if (this.#disposed || !this.#publishing) return;
		this.#serveRows(run);
		for (const child of [...run.children.values()]) await this.#refreshChild(child);
	}

	/**
	 * Reads a run's status file. A run ends when the file says so, when the
	 * file is gone after it was seen (or after `STATUS_GRACE_MS` without it
	 * ever appearing: its runner may still be starting), or when the runner
	 * process recorded in it no longer exists though it never wrote a final state.
	 */
	async #refreshStatus(run: TrackedRun, file: string): Promise<void> {
		let status = await this.#readStatus(run, file, false);
		if (this.#disposed) return;
		if (status === "missing") {
			if (run.statusSeen || this.#host.now() - run.trackedAt > STATUS_GRACE_MS) this.#end(run, "stopped");
			return;
		}
		if (!status) return;
		run.statusSeen = true;
		this.#addChildren(run, status.children);
		const alive = this.#host.isProcessAlive ?? processAlive;
		if (!isFinished(status.state) && status.pid !== undefined && !alive(status.pid)) {
			// The runner may have written its final state and exited since the read: read once more.
			status = await this.#readStatus(run, file, true);
			if (this.#disposed) return;
			if (status && status !== "missing") this.#addChildren(run, status.children);
			if (!status || status === "missing" || !isFinished(status.state)) {
				this.#end(run, "stopped");
				return;
			}
		}
		if (isFinished(status.state)) this.#finish(run);
	}

	async #readStatus(run: TrackedRun, file: string, force: boolean): Promise<RunStatus | "missing" | undefined> {
		const stamp = await fileStamp(file);
		if (!stamp) return "missing";
		if (!force && run.status && run.status.stamp.size === stamp.size && run.status.stamp.mtimeMs === stamp.mtimeMs) {
			return run.status.parsed;
		}
		const text = await readText(file);
		if (text === undefined) return "missing";
		const parsed = parseRunStatus(text);
		if (parsed) run.status = { stamp, parsed };
		return parsed;
	}

	/** A run nobody can see ending is over: its children still going show as `status`. */
	#end(run: TrackedRun, status: "stopped"): void {
		for (const tracked of run.children.values()) {
			if (!isFinished(tracked.child.status)) this.#updateChild(tracked, { ...tracked.child, status });
		}
		this.#finish(run);
	}

	#finish(run: TrackedRun): void {
		run.finished = true;
		run.watcher?.close();
		run.watcher = undefined;
		if (this.#publishing) this.#host.backgroundWorkChanged();
	}

	/**
	 * Adds the rows of children found after the parent's turn took its rows
	 * (a workflow whose arguments don't name its children), while that turn
	 * is still running: a completed turn can't take more parts, but its
	 * rebuilt history has them (`callsFor`).
	 */
	#serveRows(run: TrackedRun): void {
		const { rowed } = run;
		if (!rowed) return;
		const { store } = this.#host;
		for (const tracked of run.children.values()) {
			if (rowed.has(tracked.child.key)) continue;
			const turnId = this.#host.activeTurnWith(run.run.toolCallId);
			if (!turnId) return;
			const sessionResource = store.sessionResource(this.#host.sessionId);
			for (const row of subagentCalls(sessionResource, { ...run.run, children: [tracked.child] }, this.#host.scope)) {
				for (const action of completedToolCallActions(turnId, row)) store.dispatch(this.#host.parentChat, action);
			}
			rowed.add(tracked.child.key);
		}
	}

	/** Streams new entries of a child's session file into its chat. */
	async #refreshChild(tracked: TrackedChild): Promise<void> {
		if (!tracked.published) return;
		const { child } = tracked;
		// A finished child's file is final once its end is shown: its open turn closed,
		// or a turn saying it ended without a transcript.
		const mustEnd =
			isFinished(child.status) && (tracked.progress.open !== undefined || tracked.progress.ended.size === 0);
		if (isFinished(child.status) && !mustEnd) return;
		const stamp = child.sessionFile ? await fileStamp(child.sessionFile) : undefined;
		if (this.#disposed) return;
		const unchanged =
			stamp === undefined || (tracked.stamp?.size === stamp.size && tracked.stamp.mtimeMs === stamp.mtimeMs);
		if (unchanged && !mustEnd) return;
		const text = stamp && child.sessionFile ? await readText(child.sessionFile) : undefined;
		if (this.#disposed) return;
		tracked.stamp = stamp;
		const entries = text === undefined ? [] : parseEntries(text);
		const turns = turnsFromEntries(entries);
		const { actions, progress } = transcriptActions(
			turns,
			tracked.progress,
			child,
			tracked.chatId,
			new Date(this.#host.now()).toISOString(),
		);
		tracked.progress = progress;
		this.#dispatch(tracked, actions);
	}

	#dispatch(tracked: TrackedChild, actions: readonly ChatAction[]): void {
		const { store } = this.#host;
		for (const action of actions) store.dispatch(tracked.chat, action);
		if (actions.length === 0) return;
		const chat = store.chat(tracked.chatId);
		if (!chat) return;
		store.dispatch(store.sessionResource(this.#host.sessionId), {
			type: ActionType.SessionChatUpdated,
			chat: tracked.chat,
			changes: { status: chat.status, modifiedAt: chat.modifiedAt },
		});
		this.#host.catalogChanged();
	}

	#watch(run: TrackedRun): void {
		if (run.watcher || !run.run.asyncDir) return;
		try {
			const watcher = watch(run.run.asyncDir, { persistent: false }, (_event, file) => {
				if (file === "status.json") this.#enqueue(() => this.#refreshRun(run));
			});
			watcher.on("error", () => {
				watcher.close();
				if (run.watcher === watcher) run.watcher = undefined;
			});
			run.watcher = watcher;
		} catch {
			// No watch (the directory is gone, or no inotify watches left): polling covers it.
		}
	}
}

/** Session file lines as entries; a half-written last line (pi still appending) is skipped. */
function parseEntries(text: string): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line) as SessionEntry);
		} catch {
			// The line pi is writing right now; the next read gets it whole.
		}
	}
	return entries;
}
