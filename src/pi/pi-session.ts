import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { SessionEntry, SessionManager, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import {
	type ActionOrigin,
	ActionType,
	type ChatAction,
	type ChatInputAnswer,
	ChatInputResponseKind,
	ChatOriginKind,
	type ChatState,
	type ChatSummary,
	type CompletionItem,
	type Message,
	MessageAttachmentKind,
	MessageKind,
	PendingMessageKind,
	ResponsePartKind,
	SessionLifecycle,
	type SessionState,
	SessionStatus,
	type SessionSummary,
	type StateAction,
	TurnState,
} from "@microsoft/agent-host-protocol";
import type { Logger } from "../core/logger.ts";
import type { StateStore } from "../core/state-store.ts";
import { fileUri, PROVIDER, pathFromFileUri } from "../core/uris.ts";
import type { AnnotationStore } from "../host/annotation-store.ts";
import type { ArchiveStore } from "../host/archive-store.ts";
import type { ImageInput, PiAgent, PiBackend, PiEvent, PiQueue, PromptInput } from "./agent.ts";
import { ACT_ON_FEEDBACK_PROMPT, isActOnFeedback, referencedComments } from "./annotations.ts";
import { backgroundWorkActions, backgroundWorkMeta } from "./background-work.ts";
import { COMPACT_IN_TERMINAL, compactDoneText, compactInstructions, withCompactCommand } from "./compaction.ts";
import {
	referencedSkills,
	skillBlocks,
	slashCompletions,
	toCustomizations,
	type UserCommand,
	userCommands,
	withFrontmatter,
} from "./customizations.ts";
import {
	CANCELLED,
	dialogAnswer,
	dialogRequest,
	type NotifyLevel,
	noticeMarkdown,
	type PiDialog,
	type PiDialogAnswer,
	type PiUiHandler,
} from "./dialogs.ts";
import { forkKeep, forkLeaf, forkTurnError } from "./forks.ts";
import { CONTINUED, turnsFromEntries, userMessageText } from "./history.ts";
import { type IdleState, suspendBlocker } from "./idle.ts";
import { parseModelSelection, thinkingLevelOf } from "./models.ts";
import type { BackgroundProcess } from "./processes.ts";
import { loadSubagentRuns, type RestoredRun, SubagentTracker } from "./subagent-tracker.ts";
import { isSubagentRunner, subagentWorkActions } from "./subagents.ts";
import { recordedUserTurns } from "./truncation.ts";
import { TurnMapper, type TurnOutcome } from "./turn-mapper.ts";

/** A pi session file's active branch and the subagent runs found in it (see `PiSession.readHistory`). */
export interface SessionHistory {
	readonly manager: SessionManager;
	readonly entries: readonly SessionEntry[];
	readonly subagents: readonly RestoredRun[];
}

export interface SessionHostContext {
	readonly store: StateStore;
	readonly backend: PiBackend;
	readonly logger: Logger;
	/** Archived ("done") flags, which pi's session files cannot hold. */
	readonly archive: ArchiveStore;
	/**
	 * Review comments (annotations), which pi's session files cannot hold either.
	 * Read-only here: `AgentHost` saves them in one place, its listener on every
	 * annotations-channel action, whoever dispatched it (a client or `#resolveComments`).
	 */
	readonly annotations: Pick<AnnotationStore, "annotationsOf">;
	/** Publishes `root/sessionSummaryChanged` for this session. */
	summaryChanged(sessionId: string, changes: SessionSummaryChanges): void;
	/** Called whenever a session starts or stops running a turn. */
	activityChanged(): void;
	/** The current time in ms (replaced in tests). */
	now(): number;
}

/**
 * Fields of a `root/sessionSummaryChanged` notification. Omitted fields are
 * unchanged on the client, so `activity: null` is how a cleared activity is
 * sent (VS Code treats it as an explicit clear).
 */
export type SessionSummaryChanges = Omit<Partial<SessionSummary>, "activity"> & { activity?: string | null };

interface ActiveTurn {
	readonly id: string;
	readonly mapper: TurnMapper;
	readonly startedAt: number;
	/** Set when the client already ended the turn with `chat/turnCancelled`. */
	cancelledByClient: boolean;
	/**
	 * Set once pi's run has settled and the host is deciding what to do with
	 * steering messages it never delivered. A steering message set after that
	 * waits for the next turn, so pi's queue cannot change under that decision.
	 */
	settled: boolean;
}

/** What to do with the steering messages a host run ended without pi delivering (see `#planUndelivered`). */
type UndeliveredPlan =
	| { kind: "none" }
	| { kind: "dropped"; messages: readonly Message[] }
	| { kind: "deliver"; messages: readonly Message[] }
	| { kind: "queue"; messages: readonly Message[] };

/** An extension dialog shown as an input request in a turn, waiting for the user. */
interface OpenDialog {
	readonly turn: ActiveTurn;
	readonly dialog: PiDialog;
	readonly resolve: (answer: PiDialogAnswer) => void;
	readonly timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * What a run does: send a new user message, continue a turn that ended in a
 * resumable error, start a run in which pi delivers the steering messages
 * still in its queue (the first opens the turn), or compact the context
 * (`/compact`, which pi handles only in its terminal UI).
 */
type RunKind =
	| { kind: "prompt"; message: Message }
	| { kind: "resume" }
	| { kind: "steering" }
	| { kind: "compact"; instructions: string; message: Message };

const RUN_STARTED: Record<RunKind["kind"], string> = {
	prompt: "turn started",
	resume: "turn resumed",
	steering: "turn started for queued steering",
	compact: "compact turn started",
};

/** The run for a user message that opens a turn: `/compact` compacts, anything else is a prompt. */
function runOfMessage(message: Message): RunKind {
	const instructions = compactInstructions(message.text);
	return instructions === undefined ? { kind: "prompt", message } : { kind: "compact", instructions, message };
}

const TITLE_LENGTH = 80;
const UNTITLED = "New session";

function titleFrom(text: string): string {
	const line = text.trim().split("\n")[0] ?? "";
	return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1)}…` : line || UNTITLED;
}

/**
 * Where a pi session is published: as an AHP session and its default chat,
 * or as a chat forked inside another AHP session.
 */
export type ChatBinding =
	| { kind: "session" }
	| { kind: "fork"; session: string; chat: string; origin: { chat: string; turnId: string } };

/**
 * Binds one pi agent session to one AHP chat: an AHP session's default chat
 * (and the session itself), or a chat forked inside another session.
 */
export class PiSession {
	/** The pi session id; for a default chat, also the AHP session's id. */
	readonly id: string;
	#cwd: string;
	readonly createdAt: string;
	readonly #ctx: SessionHostContext;
	readonly #binding: ChatBinding;
	#sessionManager: SessionManager;
	#agent: Promise<PiAgent> | undefined;
	#turn: ActiveTurn | undefined;
	#lastRun: Promise<void> = Promise.resolve();
	/** True while a run the host started (prompt or resume) is in flight. */
	#hostRun = false;
	/**
	 * The turn of a run started outside the host (typed in a pi TUI). Kept
	 * until pi settles, even after a client cancels it, so the rest of that
	 * run's events are not mistaken for a new run.
	 */
	#externalRun: ActiveTurn | undefined;
	/**
	 * Steering messages sent to pi during the current host run, oldest first.
	 * Each becomes its own turn when pi echoes it (see `#promoteSteering`).
	 */
	#steered: Message[] = [];
	/** The user messages in an agent's pi queues, from its latest `queue_update` (see `#queuedIn`). */
	#piQueue: { agent: PiAgent; queue: PiQueue } | undefined;
	/** `steer` requests sent to pi that it has not answered yet (see `#sendSteer`). */
	readonly #steerSends = new Set<Promise<void>>();
	/** Agents whose events are observed for runs started outside the host. */
	readonly #observed = new WeakSet<PiAgent>();
	/** The turn whose last run ended in a resumable provider error, if any. */
	#resumableTurn: string | undefined;
	/** Runs started per turn, so a resumed run gets fresh response part ids. */
	readonly #attempts = new Map<string, number>();
	/** Turns whose prompt never reached pi, so pi has no user message for them (see `recordedUserTurns`). */
	readonly #unrecorded = new Set<string>();
	/** Why the last truncation failed; the next run fails with it rather than run on the untruncated context. */
	#truncationError: string | undefined;
	/** The interactive pi driving this session through the bridge, if any. */
	#tuiAgent: PiAgent | undefined;
	/**
	 * Skills and prompt templates of the current agent, loaded when it is
	 * first observed; before that, those read for the session's folder.
	 */
	#commands: Promise<readonly UserCommand[]> | undefined;
	/** Extension dialogs open in the current host run, by pi's request id. */
	readonly #dialogs = new Map<string, OpenDialog>();
	readonly #ui: PiUiHandler = {
		dialog: (dialog) => this.#openDialog(dialog),
		notify: (message, level) => this.#notify(message, level),
	};
	#disposed = false;
	/** The subagents this chat started, shown as read-only chats of its session (see specs/subagents.md). */
	readonly #subagents: SubagentTracker;
	#hasTurns: boolean;
	/** When a client or pi last used the session, for stopping idle pi processes. */
	#lastActivity: number;

	private constructor(
		ctx: SessionHostContext,
		id: string,
		cwd: string,
		sessionManager: SessionManager,
		createdAt: string,
		binding: ChatBinding = { kind: "session" },
	) {
		this.#ctx = ctx;
		this.id = id;
		this.#cwd = cwd;
		this.#sessionManager = sessionManager;
		this.createdAt = createdAt;
		this.#binding = binding;
		this.#hasTurns = false;
		this.#lastActivity = ctx.now();
		this.#subagents = new SubagentTracker({
			store: ctx.store,
			logger: ctx.logger,
			sessionId: this.sessionId,
			...(binding.kind === "fork" ? { scope: id } : {}),
			parentChat: this.chat,
			activeTurnWith: (toolCallId) => this.#activeTurnWith(toolCallId),
			sessionFile: () => this.#sessionManager.getSessionFile(),
			catalogChanged: () => this.#syncCatalog(),
			backgroundWorkChanged: () => this.#applySubagentWork(),
			now: ctx.now,
		});
	}

	get cwd(): string {
		return this.#cwd;
	}

	get isTuiAttached(): boolean {
		return this.#tuiAgent !== undefined;
	}

	/** Id of the AHP session the chat belongs to. */
	get sessionId(): string {
		return this.#binding.kind === "fork" ? this.#binding.session : this.id;
	}

	/** The chat's URI. */
	get chat(): string {
		return this.#binding.kind === "fork" ? this.#binding.chat : this.#ctx.store.defaultChatResource(this.id);
	}

	get isFork(): boolean {
		return this.#binding.kind === "fork";
	}

	/** A new, empty session. The pi agent starts immediately; `session/ready` follows. */
	static create(ctx: SessionHostContext, id: string, cwd: string): PiSession {
		const now = new Date().toISOString();
		const session = new PiSession(ctx, id, cwd, ctx.backend.newSessionManager(cwd, id), now);
		ctx.store.addSession(
			id,
			session.#initialSessionState(UNTITLED, SessionLifecycle.Creating, SessionStatus.Idle),
			{ ...session.#chatSummary(UNTITLED, SessionStatus.Idle, now), turns: [] },
			ctx.annotations.annotationsOf(id),
		);
		return session;
	}

	/**
	 * Reads an existing pi session file's active branch and what is left of
	 * the subagent runs in it. Async, and apart from `open` so that the host
	 * can check for a concurrent load before the session is registered.
	 */
	static async readHistory(ctx: SessionHostContext, path: string): Promise<SessionHistory> {
		const manager = ctx.backend.openSessionManager(path);
		const entries = manager.getBranch();
		return { manager, entries, subagents: await loadSubagentRuns(entries, manager.getSessionFile()) };
	}

	/**
	 * An existing pi session file. History is loaded eagerly; the agent starts
	 * on the first turn. Its folder's commands are read meanwhile (without an
	 * agent) and published, so `/` completes before pi starts.
	 */
	static open(ctx: SessionHostContext, history: SessionHistory): PiSession {
		const { manager, entries, subagents } = history;
		const session = PiSession.#fromHistory(
			ctx,
			manager,
			entries,
			manager.getSessionName(),
			manager.getSessionId(),
			manager.getCwd(),
			{ kind: "session" },
			subagents,
		);
		session.#loadCommands(ctx.backend.folderCommands(session.cwd));
		return session;
	}

	/**
	 * A forked chat's pi session file, published as a chat of its AHP
	 * session (`session/chatAdded`). The agent starts on the chat's first turn.
	 */
	static openFork(
		ctx: SessionHostContext,
		history: SessionHistory,
		binding: Extract<ChatBinding, { kind: "fork" }>,
	): PiSession {
		const { manager, entries, subagents } = history;
		const session = PiSession.#fromHistory(
			ctx,
			manager,
			entries,
			manager.getSessionName(),
			manager.getSessionId(),
			manager.getCwd(),
			binding,
			subagents,
		);
		session.#dispatchSession({ type: ActionType.SessionChatAdded, summary: session.#currentChatSummary() });
		session.#subagents.publish();
		session.#syncCatalog();
		session.#loadCommands(ctx.backend.folderCommands(session.cwd));
		return session;
	}

	/**
	 * Writes a new pi session file holding this chat's history through its
	 * completed turn `turnId`, named `title`, and returns its path. pi's
	 * `createBranchedSession` copies the entries (with their ids) and records
	 * this session's file as the parent. The file is read afresh, since a
	 * pi process may have appended to it.
	 */
	async fork(turnId: string, title: string): Promise<string> {
		const chat = this.#ctx.store.chat(this.id);
		const error = chat ? forkTurnError(chat.turns, turnId) : "Unknown chat";
		if (error || !chat) throw new Error(error);
		const file = await this.#sessionFile();
		if (!file) throw new Error("The chat has no session file to fork");
		const source = this.#ctx.backend.openSessionManager(file);
		const leaf = forkLeaf(source.getBranch(), forkKeep(chat.turns, turnId, this.#unrecorded));
		if (!leaf) throw new Error("The chat has no history to fork");
		const path = source.createBranchedSession(leaf);
		if (!path) throw new Error("pi did not write the forked session");
		this.#ctx.backend.openSessionManager(path).appendSessionInfo(title);
		return path;
	}

	/**
	 * A session open in an interactive pi (attached through the bridge).
	 * History comes from pi's live branch; `agent` drives the TUI's session.
	 */
	static live(
		ctx: SessionHostContext,
		info: { sessionId: string; sessionFile?: string; cwd: string; name?: string },
		agent: PiAgent,
		entries: readonly SessionEntry[],
		subagents: readonly RestoredRun[],
	): PiSession {
		const manager =
			info.sessionFile && existsSync(info.sessionFile)
				? ctx.backend.openSessionManager(info.sessionFile)
				: ctx.backend.newSessionManager(info.cwd, info.sessionId);
		const session = PiSession.#fromHistory(
			ctx,
			manager,
			entries,
			info.name,
			info.sessionId,
			info.cwd,
			{ kind: "session" },
			subagents,
		);
		session.#agent = Promise.resolve(session.#observe(agent));
		session.#tuiAgent = agent;
		return session;
	}

	static #fromHistory(
		ctx: SessionHostContext,
		manager: SessionManager,
		entries: readonly SessionEntry[],
		name: string | undefined,
		id = manager.getSessionId(),
		cwd = manager.getCwd(),
		binding: ChatBinding = { kind: "session" },
		restored: readonly RestoredRun[] = [],
	): PiSession {
		const header = manager.getHeader();
		const createdAt = header?.timestamp ?? new Date().toISOString();
		const session = new PiSession(ctx, id, cwd, manager, createdAt, binding);
		session.#subagents.restore(restored);
		const turns = turnsFromEntries([...entries], (toolCallId) => session.#subagents.callsFor(toolCallId));
		const title = name ?? (turns[0] ? titleFrom(turns[0].message.text) : UNTITLED);
		const lastTurn = turns.at(-1);
		const modifiedAt =
			lastTurn?.startedAt && lastTurn.duration !== undefined
				? new Date(Date.parse(lastTurn.startedAt) + lastTurn.duration).toISOString()
				: createdAt;
		session.#hasTurns = turns.length > 0;
		if (binding.kind === "fork") {
			const chat = { ...session.#chatSummary(title, restoredStatus(false), modifiedAt), turns };
			ctx.store.addForkedChat({ kind: "chat", sessionId: binding.session, chatId: id }, binding.chat, chat);
			return session;
		}
		const status = restoredStatus(ctx.archive.isArchived(id));
		ctx.store.addSession(
			id,
			session.#initialSessionState(title, SessionLifecycle.Ready, status),
			{ ...session.#chatSummary(title, status, modifiedAt), turns },
			ctx.annotations.annotationsOf(id),
		);
		session.#subagents.publish();
		return session;
	}

	/** Resolves once the subagent chats of a loaded chat show their transcripts (read asynchronously after the chat was added). */
	subagentsLoaded(): Promise<void> {
		return this.#subagents.refresh();
	}

	/** The id of this chat's running turn, if it holds the tool call `toolCallId`. */
	#activeTurnWith(toolCallId: string): string | undefined {
		const turn = this.#ctx.store.chat(this.id)?.activeTurn;
		const holds = turn?.responseParts.some(
			(part) => part.kind === ResponsePartKind.ToolCall && part.toolCall.toolCallId === toolCallId,
		);
		return holds ? turn?.id : undefined;
	}

	/** True if `chatId` is one of the read-only subagent chats this chat started. */
	ownsSubagentChat(chatId: string): boolean {
		return this.#subagents.owns(chatId);
	}

	/** Applies a client's action on one of this chat's subagent chats, or says why not. */
	subagentChatAction(chatId: string, action: StateAction, origin: ActionOrigin): string | undefined {
		return this.#subagents.clientAction(chatId, action, origin);
	}

	get hasTurns(): boolean {
		return this.#hasTurns;
	}

	/** When a client or pi last used the session (ms since the epoch). */
	get lastActivity(): number {
		return this.#lastActivity;
	}

	get isRunning(): boolean {
		return this.#turn !== undefined;
	}

	/** Starts the pi agent for a freshly created session and reports the lifecycle outcome. */
	async initialize(): Promise<void> {
		try {
			await this.#ensureAgent();
			this.#dispatchSession({ type: ActionType.SessionReady });
			this.#ctx.logger.debug("session ready", { session: this.id });
		} catch (error) {
			this.#dispatchSession({
				type: ActionType.SessionCreationFailed,
				error: { errorType: "creationFailed", message: error instanceof Error ? error.message : String(error) },
			});
		}
	}

	summary(): SessionSummary {
		const session = this.#ctx.store.session(this.id);
		const chat = this.#ctx.store.chat(this.id);
		return {
			resource: this.#ctx.store.sessionResource(this.id),
			provider: PROVIDER,
			title: session?.title ?? UNTITLED,
			status: chat?.status ?? SessionStatus.Idle,
			createdAt: this.createdAt,
			modifiedAt: chat?.modifiedAt ?? this.createdAt,
			workingDirectories: this.#ctx.store.session(this.id)?.workingDirectories ?? [fileUri(this.cwd)],
			...(session?.chats ? { chats: session.chats } : {}),
			...(session?.annotations ? { annotations: session.annotations } : {}),
			...(chat?.activity ? { activity: chat.activity } : {}),
			...(chat?.backgroundWork?.length ? { _meta: backgroundWorkMeta(chat.backgroundWork.length) } : {}),
		};
	}

	/**
	 * Slash-command completions for a message being typed: the agent's
	 * commands, else those read for the session's folder. Starts the agent
	 * only when neither could be read, since the commands come from pi.
	 */
	async completions(text: string, offset: number): Promise<CompletionItem[]> {
		this.#touch();
		let commands = await this.#commands?.catch(() => undefined);
		if (!commands) {
			await this.#ensureAgent();
			commands = await this.#commands;
		}
		// The host's `/compact` is offered where it can run: not in a session a pi terminal drives.
		const agent = await this.#agent?.catch(() => undefined);
		const available = commands ?? [];
		return slashCompletions(!agent || agent.compact ? withCompactCommand(available) : available, text, offset);
	}

	/** Returns a rejection reason for a client-dispatched chat action, or `undefined` to accept it. */
	validateChatAction(action: StateAction): string | undefined {
		const chat = this.#ctx.store.chat(this.id);
		if (!chat) return "Unknown chat";
		switch (action.type) {
			case ActionType.ChatTurnStarted:
				if (chat.activeTurn) return "A turn is already in progress";
				if (action.message.text.trim().length === 0 && !action.message.attachments?.length) return "Empty message";
				return undefined;
			case ActionType.ChatTurnCancelled:
				if (!chat.activeTurn) return "No active turn";
				if (chat.activeTurn.id !== action.turnId) return "Turn is not active";
				return undefined;
			case ActionType.ChatPendingMessageSet:
				return undefined;
			case ActionType.ChatPendingMessageRemoved: {
				const exists =
					action.kind === PendingMessageKind.Steering
						? chat.steeringMessage?.id === action.id
						: chat.queuedMessages?.some((message) => message.id === action.id);
				return exists ? undefined : "No such pending message";
			}
			case ActionType.ChatQueuedMessagesReordered:
			case ActionType.ChatDraftChanged:
			case ActionType.ChatIsReadChanged:
			case ActionType.ChatIsArchivedChanged:
				return undefined;
			case ActionType.ChatToolCallConfirmed:
			case ActionType.ChatToolCallResultConfirmed:
				return "Tool call is not awaiting confirmation";
			case ActionType.ChatTurnResume: {
				// Mirrors the reducer's own preconditions so a rejected resume has no side effects.
				const last = chat.turns.at(-1);
				const lastPart = last?.responseParts.at(-1);
				if (chat.activeTurn) return "A turn is already in progress";
				if (!last || last.id !== action.turnId || last.state !== TurnState.Error) {
					return "Turn is not the latest errored turn";
				}
				if (lastPart?.kind !== ResponsePartKind.Error || !lastPart.resumable || this.#resumableTurn !== action.turnId) {
					return "Turn is not resumable";
				}
				return undefined;
			}
			case ActionType.ChatInputAnswerChanged:
			case ActionType.ChatInputCompleted:
				return this.#dialogs.has(action.requestId) ? undefined : "No open input request";
			case ActionType.ChatTruncated:
				// The bridge cannot run the extension command that moves pi's leaf.
				if (this.#tuiAgent) return "Not supported while the session is open in a pi terminal";
				if (action.turnId !== undefined && !chat.turns.some((turn) => turn.id === action.turnId)) {
					return "Unknown turn";
				}
				return undefined;
			default:
				return `Unsupported action: ${action.type}`;
		}
	}

	/** Side effects of an accepted client chat action (already applied to state). */
	onChatAction(action: ChatAction): void {
		this.#touch();
		switch (action.type) {
			case ActionType.ChatTurnStarted:
				this.#runTurn(action.turnId, runOfMessage(action.message));
				break;
			case ActionType.ChatTurnResume:
				this.#runTurn(action.turnId, { kind: "resume" });
				break;
			case ActionType.ChatInputCompleted:
				this.#answerDialog(action.requestId, action.response, action.answers);
				break;
			case ActionType.ChatTurnCancelled:
				if (this.#turn?.id === action.turnId) {
					this.#ctx.logger.debug("turn cancelled by client", { session: this.id, turn: action.turnId });
					this.#abandonTurn(this.#turn);
				}
				this.#syncSummary();
				break;
			case ActionType.ChatPendingMessageSet:
				this.#consumePending();
				break;
			case ActionType.ChatTruncated:
				this.#truncate();
				break;
			case ActionType.ChatIsArchivedChanged:
				// A forked chat is not listed as a session, so only the default chat archives one.
				if (!this.isFork) this.#ctx.archive.setArchived(this.id, action.isArchived);
				this.#syncSummary();
				break;
			case ActionType.ChatIsReadChanged:
				this.#syncSummary();
				break;
			default:
				break;
		}
	}

	/**
	 * Renames this chat alone, as for a forked chat, leaving its session's title
	 * unchanged. The client's rename arrives on the chat's channel, which has no
	 * title action, so `origin` tags the `session/chatUpdated` that carries it.
	 */
	renameChat(title: string, origin?: ActionOrigin): void {
		this.#touch();
		this.#applyTitle(title, origin);
		this.#syncCatalog();
	}

	/** Saves a new title in pi and shows it as this chat's title in the store and the session's chat catalog. */
	#applyTitle(title: string, origin?: ActionOrigin): void {
		this.#saveTitle(title);
		this.#ctx.store.setChatTitle(this.id, title);
		this.#dispatchSession({ type: ActionType.SessionChatUpdated, chat: this.chat, changes: { title } }, origin);
	}

	/** Side effects of an accepted client session action (already applied to state). */
	onSessionAction(action: StateAction): void {
		this.#touch();
		switch (action.type) {
			case ActionType.SessionTitleChanged:
				this.#applyTitle(action.title);
				this.#syncTitle(action.title);
				break;
			// The default chat's status is the session's summary status (it carries
			// the turn's activity bits), so session-level flags are mirrored onto it.
			case ActionType.SessionIsReadChanged:
				this.#dispatchChat({ type: ActionType.ChatIsReadChanged, isRead: action.isRead });
				this.#syncSummary();
				break;
			case ActionType.SessionIsArchivedChanged:
				this.#dispatchChat({ type: ActionType.ChatIsArchivedChanged, isArchived: action.isArchived });
				this.#ctx.archive.setArchived(this.id, action.isArchived);
				this.#syncSummary();
				break;
			case ActionType.SessionWorkingDirectoryReplaced:
				this.#ctx.summaryChanged(this.id, {
					workingDirectories: this.#ctx.store.session(this.id)?.workingDirectories ?? [fileUri(this.cwd)],
				});
				break;
			default:
				break;
		}
	}

	/**
	 * Moves this chat's working directory to `newCwd`, stopping any started
	 * pi agent and relocating/updating its session file before the state
	 * change is broadcast.
	 */
	async moveWorkingDirectory(newCwd: string): Promise<void> {
		this.#touch();
		const resolved = resolve(newCwd);
		if (resolved === resolve(this.#cwd)) return;
		await this.#lastRun.catch(() => {});
		const agent = this.#agent;
		this.#agent = undefined;
		if (agent) {
			try {
				await (await agent).dispose();
			} catch {
				// Creation failed; nothing to dispose.
			}
		}
		const file = await this.#sessionFile();
		const currentManager = file ? this.#ctx.backend.openSessionManager(file) : this.#sessionManager;
		this.#sessionManager = await this.#ctx.backend.moveSessionManager(currentManager, resolved);
		this.#cwd = resolved;
		this.#loadCommands(this.#ctx.backend.folderCommands(resolved));
	}

	/**
	 * Hands the session to a live TUI pi (single writer per session file).
	 * A pi process the host started for it is stopped once its current run
	 * has finished; new runs go to `agent`.
	 */
	adoptAgent(agent: PiAgent): void {
		const previous = this.#agent;
		this.#agent = Promise.resolve(this.#observe(agent));
		this.#tuiAgent = agent;
		if (!previous) return;
		const lastRun = this.#lastRun;
		void previous
			.then(async (old) => {
				if (old === agent) return;
				await lastRun;
				await old.dispose();
			})
			.catch(() => {});
	}

	/**
	 * The live TUI pi let go of the session (detached, switched session or
	 * quit). A turn it was running ends in an error, and the next turn starts
	 * a pi process in the host on the same session file.
	 */
	agentDetached(agent: PiAgent, sessionFile: string | undefined): void {
		void this.#agent?.then((current) => {
			if (current !== agent) return;
			if (this.#tuiAgent === agent) this.#tuiAgent = undefined;
			const turn = this.#externalRun;
			this.#externalRun = undefined;
			if (turn) this.#finishExternalTurn(turn, { kind: "error", message: "pi closed the session" });
			this.#reopenSessionFile(sessionFile);
		});
	}

	/**
	 * Re-reads the session file after a pi process that wrote to it let go,
	 * so direct writes (a rename with no pi running) append to its latest entry.
	 */
	#reopenSessionFile(file = this.#sessionManager.getSessionFile()): void {
		if (file && existsSync(file)) this.#sessionManager = this.#ctx.backend.openSessionManager(file);
	}

	/**
	 * The session's file on disk. A `pi --mode rpc` child names the file of
	 * a session it created itself, so the host's manager may not know it.
	 */
	async #sessionFile(): Promise<string | undefined> {
		const file = this.#sessionManager.getSessionFile();
		if (file && existsSync(file)) return file;
		return (await this.#ctx.backend.listSessions()).find((info) => info.id === this.id)?.path;
	}

	#touch(): void {
		this.#lastActivity = this.#ctx.now();
	}

	/** What the session is doing, for deciding whether its pi process may be stopped. */
	idleState(agent: PiAgent | undefined): IdleState {
		const chat = this.#ctx.store.chat(this.id);
		return {
			suspendable: agent !== undefined && !agent.closed && agent.backgroundProcesses !== undefined,
			running: this.#turn !== undefined || this.#externalRun !== undefined || this.#hostRun || !!chat?.activeTurn,
			pending: !!chat?.steeringMessage || (chat?.queuedMessages?.length ?? 0) > 0,
			lastActivity: this.#lastActivity,
		};
	}

	/**
	 * Stops the session's pi process if it has been idle since `cutoff` and
	 * has no background work. The session itself stays: it is still listed,
	 * its state and subscriptions are unchanged, and the next turn starts a
	 * new pi on the same session file. Returns whether it stopped pi.
	 */
	async suspend(cutoff: number): Promise<boolean> {
		const pending = this.#agent;
		const agent = await pending?.catch(() => undefined);
		if (!agent || this.#agent !== pending || suspendBlocker(this.idleState(agent), cutoff)) return false;
		// A process table that cannot be read counts as busy.
		const background = await (agent.backgroundProcesses?.() ?? Promise.resolve([])).catch(() => undefined);
		if (!background || background.length > 0) {
			this.#ctx.logger.debug("idle session kept (background processes)", {
				session: this.id,
				pids: background ? background.map((process) => process.pid).join(",") : "unknown",
			});
			return false;
		}
		// Re-checked: a turn may have started while the process table was read.
		if (this.#agent !== pending || suspendBlocker(this.idleState(agent), cutoff)) return false;
		this.#agent = undefined;
		await agent.dispose();
		this.#reopenSessionFile();
		this.#applyBackgroundWork([]);
		return true;
	}

	/**
	 * Publishes the processes the session's pi started in the background as
	 * the chat's background work (`chat/backgroundWorkSet` and
	 * `chat/backgroundWorkRemoved`), and their count in the summary's
	 * `_meta`. Only reads an agent that is already running: it never starts
	 * pi. Without one (pi stopped, embedded or a pi terminal) the entries are
	 * cleared. A process table that cannot be read leaves them as they are.
	 */
	async refreshBackgroundWork(): Promise<void> {
		// The subagents' files change without a pi event; their chats follow this refresh too.
		const subagents = this.#subagents.refresh();
		try {
			await this.#refreshProcesses();
		} finally {
			await subagents;
		}
	}

	async #refreshProcesses(): Promise<void> {
		const pending = this.#agent;
		const agent = await pending?.catch(() => undefined);
		if (!agent || agent.closed || !agent.backgroundProcesses) {
			this.#applyBackgroundWork([]);
			return;
		}
		let processes: BackgroundProcess[];
		try {
			processes = await agent.backgroundProcesses();
		} catch {
			return;
		}
		// The agent may have been stopped or replaced while `ps` ran.
		if (this.#agent === pending && !agent.closed) this.#applyBackgroundWork(processes);
	}

	/**
	 * Publishes pi's background processes as shells. The processes
	 * pi-subagents runs subagents in are left out: the subagents are listed as
	 * `subagent` entries instead (see `#applySubagentWork`). They still keep
	 * an idle pi from being stopped (`suspend` reads the processes itself).
	 */
	#applyBackgroundWork(processes: readonly BackgroundProcess[]): void {
		const chat = this.#ctx.store.chat(this.id);
		if (!chat) return;
		const before = chat.backgroundWork?.length ?? 0;
		const shells = processes.filter((process) => !isSubagentRunner(process.command));
		const actions = [
			...backgroundWorkActions(chat.backgroundWork ?? [], {
				processes: shells,
				running: this.idleState(undefined).running,
				now: new Date(this.#ctx.now()).toISOString(),
			}),
			...subagentWorkActions(chat.backgroundWork ?? [], this.#subagents.runningWork()),
		];
		this.#publishBackgroundWork(before, actions);
	}

	/** Lists the subagents still running as the chat's `subagent` background work. */
	#applySubagentWork(): void {
		const chat = this.#ctx.store.chat(this.id);
		if (!chat) return;
		const before = chat.backgroundWork?.length ?? 0;
		this.#publishBackgroundWork(before, subagentWorkActions(chat.backgroundWork ?? [], this.#subagents.runningWork()));
	}

	#publishBackgroundWork(before: number, actions: readonly ChatAction[]): void {
		for (const action of actions) this.#dispatchChat(action);
		const after = this.#ctx.store.chat(this.id)?.backgroundWork?.length ?? 0;
		if (after !== before) {
			this.#ctx.logger.debug("background work changed", { session: this.id, count: after });
			if (!this.isFork) this.#ctx.summaryChanged(this.id, { _meta: backgroundWorkMeta(after) });
		}
	}

	async dispose(): Promise<void> {
		this.#disposed = true;
		this.#subagents.dispose();
		this.#closeDialogs();
		const agent = this.#agent;
		this.#agent = undefined;
		if (agent) {
			try {
				await (await agent).dispose();
			} catch {
				// Creation failed; nothing to dispose.
			}
		}
	}

	/** The running agent, starting one if there is none or the last one's pi process exited. */
	#ensureAgent(): Promise<PiAgent> {
		if (this.#disposed) return Promise.reject(new Error("Session disposed"));
		// A pi in a terminal shows its own dialogs, so only agents the host starts get the handler.
		const start = () =>
			this.#ctx.backend.startAgent(this.cwd, this.#sessionManager).then((agent) => {
				agent.setUiHandler?.(this.#ui);
				return this.#observe(agent);
			});
		const previous = this.#agent;
		const agent = previous ? previous.then((current) => (current.closed ? start() : current)) : start();
		this.#agent = agent;
		agent.catch(() => {
			if (this.#agent === agent) this.#agent = undefined;
		});
		return agent;
	}

	/**
	 * Saves a client rename to pi. Once an agent has been started it owns the
	 * session file and writes the name (restarting if its pi exited);
	 * otherwise the file is appended directly.
	 */
	#saveTitle(title: string): void {
		if (!this.#agent) {
			this.#sessionManager.appendSessionInfo(title);
			return;
		}
		void this.#ensureAgent()
			.then((agent) => agent.setSessionName(title))
			.catch((error) => {
				this.#ctx.logger.warn("could not save session title", {
					session: this.id,
					error: error instanceof Error ? error.message : String(error),
				});
			});
	}

	/**
	 * Starts a turn. Runs are serialized: after a client cancellation pi may
	 * still be unwinding the aborted run, and pi rejects a new prompt while
	 * streaming, so each run waits for the previous one to settle.
	 */
	#runTurn(turnId: string, run: RunKind): void {
		const attempt = this.#attempts.get(turnId) ?? 0;
		this.#attempts.set(turnId, attempt + 1);
		this.#resumableTurn = undefined;
		const mapper = new TurnMapper(
			turnId,
			(action) => {
				if (this.#turn === turn && !turn.cancelledByClient) this.#dispatchChat(action);
			},
			attempt,
			this.#subagentCalls,
		);
		const turn: ActiveTurn = { id: turnId, mapper, startedAt: Date.now(), cancelledByClient: false, settled: false };
		this.#turn = turn;
		this.#ctx.activityChanged();
		this.#syncSummary();
		if (run.kind === "prompt") this.#maybeSetTitle(run.message.text);
		const previous = this.#lastRun;
		this.#lastRun = previous.then(() => this.#execute(turn, run));
	}

	async #execute(first: ActiveTurn, run: RunKind): Promise<void> {
		// A steering message pi delivers mid-run moves the rest of the run to a new turn.
		let turn = first;
		let outcome: TurnOutcome = { kind: "cancelled" };
		let unsubscribe: (() => void) | undefined;
		// The first user message of a prompt run is the prompt itself (of a steering run, the
		// queued steer that opened the turn); later ones were steered in.
		let promptSeen = run.kind === "resume";
		let comments: readonly string[] = [];
		try {
			if (!turn.cancelledByClient) {
				const agent = await this.#ensureAgent();
				const truncationError = this.#truncationError;
				this.#truncationError = undefined;
				if (truncationError) throw new Error(`pi could not drop the edited turns: ${truncationError}`);
				if (run.kind === "prompt" || run.kind === "compact") await this.#applyModel(agent, run.message);
				unsubscribe = agent.subscribe((event) => {
					const user = userMessageStarted(event);
					if (user !== undefined) {
						if (!promptSeen) promptSeen = true;
						else if (!turn.cancelledByClient) {
							turn = this.#promoteSteering(turn, user);
							return;
						}
					}
					this.#logEvent(turn, event);
					turn.mapper.handle(event);
				});
				this.#ctx.logger.debug(RUN_STARTED[run.kind], {
					session: this.id,
					turn: turn.id,
					model: agent.model ? `${agent.model.provider}/${agent.model.id}` : undefined,
					chars: run.kind === "prompt" ? run.message.text.length : undefined,
					attachments: run.kind === "prompt" ? run.message.attachments?.length : undefined,
				});
				this.#hostRun = true;
				if (run.kind === "compact") {
					await this.#compact(agent, turn, run.instructions);
				} else if (run.kind === "prompt") {
					const prompt = await this.#promptInput(run.message);
					comments = prompt.comments;
					await agent.prompt(prompt.input);
				} else if (run.kind === "steering") {
					await agent.runQueued();
				} else {
					await agent.resume();
				}
				outcome = turn.mapper.impliedOutcome();
			}
		} catch (error) {
			outcome = turn.mapper.aborted
				? { kind: "cancelled" }
				: { kind: "error", message: error instanceof Error ? error.message : String(error) };
		} finally {
			this.#hostRun = false;
			unsubscribe?.();
		}
		// From here no steering message goes to pi (see `ActiveTurn.settled`), so what is left
		// in `#steered` is what pi never delivered.
		turn.settled = true;
		const plan = await this.#planUndelivered(turn, outcome, this.#steered.splice(0));
		if (!promptSeen) this.#unrecorded.add(first.id);
		this.#hasTurns = true;
		this.#closeDialogs();
		if (!turn.cancelledByClient) turn.mapper.finish(outcome, Date.now() - turn.startedAt);
		if (!turn.cancelledByClient && outcome.kind === "error" && outcome.resumable) this.#resumableTurn = turn.id;
		if (!turn.cancelledByClient && outcome.kind === "complete") this.#resolveComments(comments);
		this.#ctx.logger.debug("turn finished", {
			session: this.id,
			turn: turn.id,
			outcome: turn.cancelledByClient ? "cancelled" : outcome.kind,
			error: outcome.kind === "error" ? outcome.message : undefined,
			ms: Date.now() - turn.startedAt,
		});
		if (this.#turn === turn) {
			this.#turn = undefined;
			this.#ctx.activityChanged();
		}
		this.#applyUndelivered(plan);
		this.#touch();
		this.#syncSummary();
		this.#consumePending();
	}

	/**
	 * Runs `/compact` in a turn of its own: pi compacts the context (it is
	 * never asked while a run streams; runs are serialized) and the turn ends
	 * with the token estimate before and after. A session a pi terminal
	 * drives can only compact there, so the turn says so instead. pi's
	 * errors (nothing to compact, cancelled) end the turn as errors, and a
	 * client cancel aborts pi, which cancels the compaction.
	 */
	async #compact(agent: PiAgent, turn: ActiveTurn, instructions: string): Promise<void> {
		if (!agent.compact) {
			turn.mapper.notice(COMPACT_IN_TERMINAL);
			return;
		}
		const result = await agent.compact(instructions || undefined);
		this.#ctx.logger.debug("compaction finished", {
			session: this.id,
			turn: turn.id,
			tokensBefore: result?.tokensBefore,
			tokensAfter: result?.estimatedTokensAfter,
		});
		if (!turn.cancelledByClient) {
			turn.mapper.notice(compactDoneText(result));
			if (result?.estimatedTokensAfter !== undefined) turn.mapper.compacted(result.estimatedTokensAfter);
		}
	}

	/**
	 * Decides what to do with the steering messages a host run ended without
	 * pi delivering them: pi's loop had already made its last check when they
	 * arrived, or the run was aborted (pi's `abort` leaves them queued). It
	 * runs before the turn is finished, so everything that waits (pi's answers
	 * to `steer` requests still in flight, `clear_queue`) is over by the time
	 * `#applyUndelivered` changes state, with no await in between.
	 * - After a client cancel, pi's queue is cleared so they don't surface in
	 *   the next run, as pi's own Esc does, and they are dropped.
	 * - If pi still holds them as steers, a new turn opens with the first, and
	 *   a run starts in which pi delivers them along with anything extensions
	 *   queued meanwhile (pi's queue is not cleared, since `clear_queue` would
	 *   drop those, such as a background subagent's result).
	 * - If pi holds them as follow-ups (Bolt's `bash` backgrounds a running
	 *   command on new input and resends it that way), a run would answer
	 *   before delivering them, so the queue is cleared and they go to the
	 *   front of the chat's queue instead. So do they when pi holds nothing
	 *   (a failed `steer`), when its process exited, and when the run ended in
	 *   a provider error that `chat/turnResume` can continue: the steering run
	 *   would resume it, dropping the failed reply from the model's context
	 *   without the user asking.
	 * An agent that cannot clear pi's queue (a pi terminal) keeps them there, as pi would.
	 */
	async #planUndelivered(
		turn: ActiveTurn,
		outcome: TurnOutcome,
		messages: readonly Message[],
	): Promise<UndeliveredPlan> {
		if (messages.length === 0) return { kind: "none" };
		// pi answers `steer` after the `queue_update` it caused, so once these settle `#queuedIn` is current.
		while (this.#steerSends.size > 0) await Promise.allSettled([...this.#steerSends]);
		const agent = await this.#agent?.catch(() => undefined);
		if (!agent?.clearQueue) return { kind: "none" };
		const clear = async (): Promise<void> => {
			await agent.clearQueue?.().catch(() => undefined);
			this.#piQueue = { agent, queue: { steering: [], followUp: [] } };
		};
		if (turn.cancelledByClient) {
			if (!agent.closed) await clear();
			return { kind: "dropped", messages };
		}
		const held = this.#queuedIn(agent);
		const resumableError = outcome.kind === "error" && outcome.resumable === true;
		if (held.steering.length > 0 && !resumableError) return { kind: "deliver", messages };
		if (held.steering.length > 0 || held.followUp.length > 0) await clear();
		// The client may have cancelled while pi's queue was cleared.
		return turn.cancelledByClient ? { kind: "dropped", messages } : { kind: "queue", messages };
	}

	/** Carries out `plan` (see `#planUndelivered`) with the turn released, so it starts the next work with no gap. */
	#applyUndelivered(plan: UndeliveredPlan): void {
		if (plan.kind === "none") return;
		const { messages } = plan;
		const fields = { session: this.id, messages: messages.length };
		if (plan.kind === "dropped") {
			this.#ctx.logger.info("undelivered steering messages dropped", fields);
			return;
		}
		if (plan.kind === "deliver") {
			const [first, ...rest] = messages;
			this.#steered = rest;
			const turnId = crypto.randomUUID();
			this.#dispatchChat({
				type: ActionType.ChatTurnStarted,
				turnId,
				startedAt: new Date().toISOString(),
				message: first!,
			});
			this.#ctx.logger.info("undelivered steering messages resumed", fields);
			this.#runTurn(turnId, { kind: "steering" });
			return;
		}
		const ids = messages.map(() => `steer-${crypto.randomUUID()}`);
		messages.forEach((message, index) => {
			this.#dispatchChat({
				type: ActionType.ChatPendingMessageSet,
				kind: PendingMessageKind.Queued,
				id: ids[index]!,
				message,
			});
		});
		const others = (this.#ctx.store.chat(this.id)?.queuedMessages ?? [])
			.map((queued) => queued.id)
			.filter((id) => !ids.includes(id));
		this.#dispatchChat({ type: ActionType.ChatQueuedMessagesReordered, order: [...ids, ...others] });
		this.#ctx.logger.info("undelivered steering messages queued", fields);
	}

	/** The messages in `agent`'s pi queues; none for another agent, or one whose pi process exited. */
	#queuedIn(agent: PiAgent): PiQueue {
		return this.#piQueue?.agent === agent && !agent.closed ? this.#piQueue.queue : { steering: [], followUp: [] };
	}

	/**
	 * Ends the running turn the client has already ended in state: closes its
	 * dialogs, frees the session for the next turn and aborts pi's run.
	 */
	#abandonTurn(turn: ActiveTurn): void {
		turn.cancelledByClient = true;
		this.#closeDialogs();
		this.#turn = undefined;
		this.#ctx.activityChanged();
		void this.#agent?.then((agent) => agent.abort()).catch(() => {});
	}

	/**
	 * Side effect of an accepted `chat/truncated` (already applied to state):
	 * ends the running turn the reducer dropped, as a cancellation does, then
	 * moves pi back to the kept turns once the aborted run has settled. Runs
	 * queue behind it, so a `chat/turnStarted` sent right after (an edited
	 * message) runs on the truncated context. See specs/truncation.md.
	 */
	#truncate(): void {
		const chat = this.#ctx.store.chat(this.id);
		if (!chat) return;
		const keep = recordedUserTurns(chat.turns, this.#unrecorded);
		const running = this.#turn;
		if (running) this.#abandonTurn(running);
		this.#resumableTurn = undefined;
		this.#truncationError = undefined;
		this.#ctx.logger.debug("chat truncated by client", { session: this.id, keep, turns: chat.turns.length });
		this.#lastRun = this.#lastRun
			.then(async () => (await this.#ensureAgent()).truncate(keep))
			.catch((error) => {
				const message = error instanceof Error ? error.message : String(error);
				this.#truncationError = message;
				this.#ctx.logger.warn("could not truncate the session", { session: this.id, error: message });
			});
		this.#syncSummary();
	}

	/**
	 * pi delivered a steering message mid-run. The current turn completes and
	 * the rest of the run streams into a new turn that opens with the steering
	 * message, the same split pi's session file (and so the reloaded history)
	 * has. Returns the new turn.
	 */
	#promoteSteering(previous: ActiveTurn, text: string): ActiveTurn {
		const sent = this.#steered.shift();
		const message: Message = sent ?? { text, origin: { kind: MessageKind.User } };
		this.#hasTurns = true;
		this.#closeDialogs();
		previous.mapper.finish({ kind: "complete" }, Date.now() - previous.startedAt);
		const turnId = crypto.randomUUID();
		const mapper = new TurnMapper(
			turnId,
			(action) => {
				if (this.#turn === turn && !turn.cancelledByClient) this.#dispatchChat(action);
			},
			0,
			this.#subagentCalls,
		);
		const turn: ActiveTurn = { id: turnId, mapper, startedAt: Date.now(), cancelledByClient: false, settled: false };
		this.#dispatchChat({ type: ActionType.ChatTurnStarted, turnId, startedAt: new Date().toISOString(), message });
		if (this.#turn === previous) this.#turn = turn;
		this.#ctx.logger.debug("steering message started a turn", { session: this.id, from: previous.id, turn: turnId });
		this.#syncSummary();
		return turn;
	}

	/**
	 * Shows an extension dialog as an input request in the running turn: one
	 * the host started, or a run the agent started on its own, such as the
	 * planning run `/plan <prompt>` starts after its command returns. Only
	 * agents the host started get the UI handler, so a pi terminal's dialogs
	 * never get here. Clients add input requests only to an active turn, so
	 * outside one (and while a client cancels) the dialog is left to be
	 * cancelled.
	 * pi drops a dialog when its timeout passes, so the request is withdrawn
	 * then too. See specs/extension-dialogs.md.
	 */
	#openDialog(dialog: PiDialog): Promise<PiDialogAnswer> | undefined {
		const turn = this.#turn;
		if (!turn || turn.cancelledByClient || this.#dialogs.has(dialog.id)) return undefined;
		return new Promise((resolve) => {
			const timer = dialog.timeout ? setTimeout(() => this.#closeDialog(dialog.id), dialog.timeout) : undefined;
			this.#dialogs.set(dialog.id, { turn, dialog, resolve, timer });
			this.#ctx.logger.debug("extension dialog shown", { session: this.id, turn: turn.id, method: dialog.method });
			this.#dispatchChat({ type: ActionType.ChatInputRequested, request: dialogRequest(dialog) });
			this.#syncSummary();
		});
	}

	/** Answers pi from the request the client completed, with its final answers. */
	#answerDialog(
		requestId: string,
		response: ChatInputResponseKind,
		answers: Readonly<Record<string, ChatInputAnswer>> | undefined,
	): void {
		const open = this.#dialogs.get(requestId);
		if (!open) return;
		const part = this.#ctx.store
			.chat(this.id)
			?.activeTurn?.responseParts.find(
				(candidate) => candidate.kind === ResponsePartKind.InputRequest && candidate.request.id === requestId,
			);
		const final = part?.kind === ResponsePartKind.InputRequest ? part.request.answers : answers;
		this.#dialogs.delete(requestId);
		clearTimeout(open.timer);
		open.resolve(dialogAnswer(open.dialog, response, final));
		this.#ctx.logger.debug("extension dialog answered", { session: this.id, method: open.dialog.method, response });
		this.#syncSummary();
	}

	/**
	 * Cancels a dialog the user has not answered: pi gets `cancelled`, and
	 * the request is marked cancelled while its turn is still the client's
	 * active turn.
	 */
	#closeDialog(requestId: string): void {
		const open = this.#dialogs.get(requestId);
		if (!open) return;
		this.#dialogs.delete(requestId);
		clearTimeout(open.timer);
		if (this.#turn === open.turn && !open.turn.cancelledByClient) {
			this.#dispatchChat({ type: ActionType.ChatInputCompleted, requestId, response: ChatInputResponseKind.Cancel });
			this.#syncSummary();
		}
		open.resolve(CANCELLED);
	}

	/** Cancels every open dialog, before the turn they belong to ends. */
	#closeDialogs(): void {
		for (const requestId of [...this.#dialogs.keys()]) this.#closeDialog(requestId);
	}

	/** Adds an extension's notification to the running turn; other notifications are only logged. */
	#notify(message: string, level: NotifyLevel): void {
		const turn = this.#turn;
		if (turn && !turn.cancelledByClient) {
			turn.mapper.notice(noticeMarkdown(message, level));
			return;
		}
		this.#ctx.logger.debug("extension notification outside a turn", { session: this.id, level, message });
	}

	/** The rows, one per subagent, that follow a `subagent` tool call in its turn. */
	readonly #subagentCalls = (toolCallId: string) => this.#subagents.callsFor(toolCallId);

	/**
	 * Watches an agent for runs started outside the host, and for subagents.
	 * Subscribed before any run's turn mapper, so a `subagent` call's run is
	 * tracked by the time the mapper publishes its result. Returns the agent.
	 */
	#observe(agent: PiAgent): PiAgent {
		if (!this.#observed.has(agent)) {
			this.#observed.add(agent);
			agent.subscribe((event) => {
				if (event.type === "queue_update") {
					this.#piQueue = { agent, queue: { steering: event.steering, followUp: event.followUp } };
				}
				this.#subagents.handle(event);
				this.#onAgentEvent(event);
			});
			this.#loadCommands(agent.commands());
		}
		return agent;
	}

	/**
	 * pi's prompt for a message: the review comments it refers to and the skills
	 * its completion chips reference later in the text. Also the ids of those
	 * comments, which a completed turn resolves.
	 */
	async #promptInput(message: Message): Promise<{ input: PromptInput; comments: readonly string[] }> {
		const commands = await (this.#commands ?? Promise.resolve([])).catch(() => []);
		const store = this.#ctx.store;
		const comments = referencedComments(
			message,
			store.annotationsResource(this.sessionId),
			store.annotations(this.sessionId)?.annotations ?? [],
			this.cwd,
		);
		const text = isActOnFeedback(message) ? ACT_ON_FEEDBACK_PROMPT : message.text;
		const context = [
			...(comments.text ? [comments.text] : []),
			...(await skillBlocks(referencedSkills(message, commands))),
		];
		return { input: promptInput({ ...message, text }, context), comments: comments.ids };
	}

	/**
	 * Marks the review comments a completed turn acted on as resolved, which
	 * is how VS Code learns that the agent handled them (pi has no tool to
	 * resolve them itself).
	 */
	#resolveComments(ids: readonly string[]): void {
		const store = this.#ctx.store;
		const channel = store.annotationsResource(this.sessionId);
		const open = new Set(
			(store.annotations(this.sessionId)?.annotations ?? []).filter((a) => !a.resolved).map((a) => a.id),
		);
		const resolved = ids.filter((id) => open.has(id));
		for (const annotationId of resolved) {
			store.dispatch(channel, { type: ActionType.AnnotationsUpdated, annotationId, resolved: true });
		}
		if (resolved.length > 0)
			this.#ctx.logger.debug("review comments resolved", { session: this.id, count: resolved.length });
	}

	/**
	 * Keeps the skills and prompt templates in `commands` (an agent's, or
	 * those read for the session's folder) and publishes them as session
	 * customizations. A later load replaces an earlier one, even when the
	 * earlier one finishes last.
	 */
	#loadCommands(commands: Promise<readonly SlashCommandInfo[]>): void {
		const loaded = commands.then((list) => withFrontmatter(userCommands(list)));
		this.#commands = loaded;
		loaded
			.then((commands) => {
				// A forked chat shares its session's folder, whose default chat publishes them.
				if (this.#commands !== loaded || this.#disposed || this.isFork) return;
				const customizations = toCustomizations(commands);
				const current = this.#ctx.store.session(this.id)?.customizations ?? [];
				if (JSON.stringify(current) === JSON.stringify(customizations)) return;
				this.#dispatchSession({ type: ActionType.SessionCustomizationsChanged, customizations });
			})
			.catch((error) => {
				if (this.#commands === loaded) this.#commands = undefined;
				this.#ctx.logger.warn("could not read pi commands", {
					session: this.id,
					error: error instanceof Error ? error.message : String(error),
				});
			});
	}

	/**
	 * Turns runs the host did not start into turns: each user message opens a
	 * turn (closing the previous one), an assistant message without one opens
	 * a "continued" turn, and `agent_settled` closes it.
	 */
	#onAgentEvent(event: PiEvent): void {
		if (this.#hostRun) return;
		if (event.type === "agent_settled") {
			const turn = this.#externalRun;
			this.#externalRun = undefined;
			if (turn) this.#finishExternalTurn(turn, turn.mapper.impliedOutcome());
			return;
		}
		if (event.type === "message_start") {
			const message = event.message as { role?: string; content?: Parameters<typeof userMessageText>[0] };
			if (message.role === "user") {
				const previous = this.#externalRun;
				if (previous) this.#finishExternalTurn(previous, { kind: "complete" });
				this.#startExternalTurn({ text: userMessageText(message.content), origin: { kind: MessageKind.User } });
				return;
			}
			if (message.role === "assistant" && !this.#externalRun) {
				this.#startExternalTurn({ text: CONTINUED, origin: { kind: MessageKind.SystemNotification } });
			}
		}
		const turn = this.#externalRun;
		if (turn) {
			this.#logEvent(turn, event);
			turn.mapper.handle(event);
		}
	}

	#startExternalTurn(message: Message): void {
		const turnId = crypto.randomUUID();
		const mapper = new TurnMapper(
			turnId,
			(action) => {
				if (!turn.cancelledByClient) this.#dispatchChat(action);
			},
			0,
			this.#subagentCalls,
		);
		const turn: ActiveTurn = { id: turnId, mapper, startedAt: Date.now(), cancelledByClient: false, settled: false };
		this.#externalRun = turn;
		this.#resumableTurn = undefined;
		this.#dispatchChat({ type: ActionType.ChatTurnStarted, turnId, startedAt: new Date().toISOString(), message });
		this.#turn = turn;
		this.#ctx.logger.debug("turn started outside the host", { session: this.id, turn: turnId });
		this.#ctx.activityChanged();
		this.#syncSummary();
		if (message.origin.kind === MessageKind.User) this.#maybeSetTitle(message.text);
	}

	#finishExternalTurn(turn: ActiveTurn, outcome: TurnOutcome): void {
		this.#hasTurns = true;
		this.#touch();
		this.#closeDialogs();
		if (!turn.cancelledByClient) {
			turn.mapper.finish(outcome, Date.now() - turn.startedAt);
			if (outcome.kind === "error" && outcome.resumable) this.#resumableTurn = turn.id;
		}
		this.#ctx.logger.debug("turn finished", {
			session: this.id,
			turn: turn.id,
			outcome: turn.cancelledByClient ? "cancelled" : outcome.kind,
			error: outcome.kind === "error" ? outcome.message : undefined,
			ms: Date.now() - turn.startedAt,
		});
		if (this.#turn === turn) {
			this.#turn = undefined;
			this.#ctx.activityChanged();
		}
		this.#syncSummary();
		this.#consumePending();
	}

	#logEvent(turn: ActiveTurn, event: PiEvent): void {
		const fields = { session: this.id, turn: turn.id };
		if (event.type === "tool_execution_start") {
			this.#ctx.logger.debug("tool started", { ...fields, tool: event.toolName, toolCallId: event.toolCallId });
		} else if (event.type === "tool_execution_end") {
			this.#ctx.logger.debug("tool finished", {
				...fields,
				tool: event.toolName,
				toolCallId: event.toolCallId,
				isError: event.isError,
			});
		} else if (event.type === "auto_retry_start") {
			this.#ctx.logger.debug("model retry", { ...fields, attempt: event.attempt, error: event.errorMessage });
		}
	}

	async #applyModel(agent: PiAgent, message: Message): Promise<void> {
		const selection = message.model;
		if (!selection) return;
		const model = parseModelSelection(selection);
		if (!model) throw new Error(`Unknown model: ${selection.id}`);
		await agent.setModel(model.provider, model.id);
		const level = thinkingLevelOf(selection);
		if (level) await agent.setThinkingLevel(level);
	}

	/**
	 * Consumes steering and queued messages as the chat-channel spec describes.
	 * A steering message that arrives with no turn running (for example a queued
	 * message the client "sends immediately" just as the turn ends) starts its
	 * own turn, ahead of the queue, so it is never left pending.
	 */
	#consumePending(): void {
		const chat = this.#ctx.store.chat(this.id);
		if (!chat) return;
		if (chat.steeringMessage && !this.#turn && !chat.activeTurn) {
			this.#startPendingTurn(PendingMessageKind.Steering, chat.steeringMessage);
			return;
		}
		if (
			chat.steeringMessage &&
			this.#turn &&
			!this.#turn.cancelledByClient &&
			!this.#turn.settled &&
			runOfMessage(chat.steeringMessage.message).kind === "compact"
		) {
			this.#holdCompact(chat.steeringMessage);
			return;
		}
		if (chat.steeringMessage && this.#turn && !this.#turn.cancelledByClient && !this.#turn.settled) {
			const { id, message } = chat.steeringMessage;
			this.#dispatchChat({ type: ActionType.ChatPendingMessageRemoved, kind: PendingMessageKind.Steering, id });
			this.#ctx.logger.debug("steering message sent", { session: this.id, turn: this.#turn.id, message: id });
			// In a run the TUI started, pi's echo of the message already opens a turn (`#onAgentEvent`).
			if (this.#turn !== this.#externalRun) this.#steered.push(message);
			this.#sendSteer(message);
		}
		const next = chat.queuedMessages?.[0];
		if (next && !this.#turn && !chat.activeTurn) this.#startPendingTurn(PendingMessageKind.Queued, next);
	}

	/**
	 * Sends a steering message to pi without waiting. The request is tracked so
	 * a run that ends meanwhile waits for pi's answer before it decides what
	 * pi still holds (`#planUndelivered`).
	 */
	#sendSteer(message: Message): void {
		const pending = this.#agent;
		if (!pending) return;
		const send: Promise<void> = pending
			.then(async (agent) => agent.steer((await this.#promptInput(message)).input))
			.catch(() => {})
			.finally(() => this.#steerSends.delete(send));
		this.#steerSends.add(send);
	}

	/**
	 * A `/compact` sent as a steering message while the agent works. pi would
	 * hand it to the model as text, and compacting would abort the run, so it
	 * moves to the front of the chat's queue and runs as its own turn when
	 * the current run ends.
	 */
	#holdCompact(steering: { id: string; message: Message }): void {
		this.#dispatchChat({
			type: ActionType.ChatPendingMessageRemoved,
			kind: PendingMessageKind.Steering,
			id: steering.id,
		});
		const id = `compact-${crypto.randomUUID()}`;
		this.#dispatchChat({
			type: ActionType.ChatPendingMessageSet,
			kind: PendingMessageKind.Queued,
			id,
			message: steering.message,
		});
		const others = (this.#ctx.store.chat(this.id)?.queuedMessages ?? [])
			.map((queued) => queued.id)
			.filter((queued) => queued !== id);
		this.#dispatchChat({ type: ActionType.ChatQueuedMessagesReordered, order: [id, ...others] });
		this.#ctx.logger.debug("compaction held until the run ends", { session: this.id, message: steering.id });
	}

	/** Removes a pending message and runs it as a new turn. */
	#startPendingTurn(kind: PendingMessageKind, pending: { id: string; message: Message }): void {
		this.#dispatchChat({ type: ActionType.ChatPendingMessageRemoved, kind, id: pending.id });
		this.#ctx.logger.debug(`${kind} message started a turn`, { session: this.id, message: pending.id });
		const turnId = crypto.randomUUID();
		this.#dispatchChat({
			type: ActionType.ChatTurnStarted,
			turnId,
			startedAt: new Date().toISOString(),
			message: pending.message,
			...(kind === PendingMessageKind.Queued ? { queuedMessageId: pending.id } : {}),
		});
		this.#runTurn(turnId, runOfMessage(pending.message));
	}

	#maybeSetTitle(text: string): void {
		// A forked chat is named when it is forked; the session keeps its own title.
		if (this.isFork) return;
		const session = this.#ctx.store.session(this.id);
		if (!session || session.title !== UNTITLED || this.#sessionManager.getSessionName()) return;
		const title = titleFrom(text);
		if (title === UNTITLED) return;
		this.#dispatchSession({ type: ActionType.SessionTitleChanged, title });
		this.#dispatchSession({
			type: ActionType.SessionChatUpdated,
			chat: this.chat,
			changes: { title },
		});
		this.#ctx.store.setChatTitle(this.id, title);
		this.#saveTitle(title);
		this.#syncTitle(title);
	}

	#syncTitle(title: string): void {
		const chats = this.#ctx.store.session(this.sessionId)?.chats;
		this.#ctx.summaryChanged(this.sessionId, { title, ...(chats ? { chats } : {}) });
	}

	/** Publishes the session's chat catalog (default and forked chats) in the root summary. */
	#syncCatalog(): void {
		const chats = this.#ctx.store.session(this.sessionId)?.chats;
		if (chats) this.#ctx.summaryChanged(this.sessionId, { chats });
	}

	/**
	 * Mirrors the chat's summary fields into the session catalog and root
	 * summary. A default chat's status is its session's; a forked chat's
	 * only changes its entry in the catalog.
	 */
	#syncSummary(): void {
		const chat = this.#ctx.store.chat(this.id);
		if (!chat) return;
		// A turn the client cancelled drops the mapper's final actions, so its activity is cleared here.
		if (!chat.activeTurn && chat.activity !== undefined) {
			this.#dispatchChat({ type: ActionType.ChatActivityChanged, activity: undefined });
		}
		this.#dispatchSession({
			type: ActionType.SessionChatUpdated,
			chat: this.chat,
			changes: { status: chat.status, modifiedAt: chat.modifiedAt },
		});
		if (this.isFork) {
			this.#syncCatalog();
			return;
		}
		this.#ctx.store.setSessionStatus(this.id, chat.status);
		this.#ctx.summaryChanged(this.id, { status: chat.status, modifiedAt: chat.modifiedAt });
	}

	/**
	 * Mirrors the chat's activity text into the session state, the session's
	 * chat catalog and the root summary, as AHP's summary aggregation rules ask.
	 * `null` in the root summary explicitly clears the text (omitting the field
	 * would leave the client's cached value in place). A forked chat's text
	 * only goes into its catalog entry.
	 */
	#syncActivity(): void {
		const activity = this.#ctx.store.chat(this.id)?.activity;
		if (this.isFork) {
			const entry = this.#ctx.store.session(this.sessionId)?.chats.find((chat) => chat.resource === this.chat);
			if (entry?.activity === activity) return;
			this.#dispatchSession({ type: ActionType.SessionChatUpdated, chat: this.chat, changes: { activity } });
			this.#syncCatalog();
			return;
		}
		if (this.#ctx.store.session(this.id)?.activity === activity) return;
		this.#dispatchSession({ type: ActionType.SessionActivityChanged, activity });
		this.#dispatchSession({ type: ActionType.SessionChatUpdated, chat: this.chat, changes: { activity } });
		this.#ctx.summaryChanged(this.id, { activity: activity ?? null });
	}

	#dispatchChat(action: ChatAction): void {
		this.#ctx.store.dispatch(this.chat, action);
		if (action.type === ActionType.ChatActivityChanged) this.#syncActivity();
	}

	#dispatchSession(action: StateAction, origin?: ActionOrigin): void {
		this.#ctx.store.dispatch(this.#ctx.store.sessionResource(this.sessionId), action, origin);
	}

	#chatSummary(title: string, status: SessionStatus, modifiedAt: string): ChatSummary & Pick<ChatState, "resource"> {
		const summary = { resource: this.chat, title, status, modifiedAt };
		if (this.#binding.kind !== "fork") return summary;
		return { ...summary, origin: { kind: ChatOriginKind.Fork as const, ...this.#binding.origin } };
	}

	/** The chat's catalog entry, from its current state. */
	#currentChatSummary(): ChatSummary {
		const chat = this.#ctx.store.chat(this.id);
		if (!chat) throw new Error(`Unknown chat: ${this.chat}`);
		const { resource, title, status, modifiedAt, origin, activity } = chat;
		return { resource, title, status, modifiedAt, ...(origin ? { origin } : {}), ...(activity ? { activity } : {}) };
	}

	#initialSessionState(title: string, lifecycle: SessionLifecycle, status: SessionStatus): SessionState {
		return {
			provider: PROVIDER,
			title,
			status,
			workingDirectories: [fileUri(this.cwd)],
			lifecycle,
			activeClients: [],
			chats: [this.#chatSummary(title, status, this.createdAt)],
			defaultChat: this.#ctx.store.defaultChatResource(this.id),
		};
	}
}

/**
 * Status of a session loaded from disk: idle and read, plus the archived
 * flag the host persisted for it.
 */
export function restoredStatus(archived: boolean): SessionStatus {
	return SessionStatus.Idle | SessionStatus.IsRead | (archived ? SessionStatus.IsArchived : 0);
}

/** Text of the user message an event starts, or `undefined` if it starts no user message. */
export function userMessageStarted(event: PiEvent): string | undefined {
	if (event.type !== "message_start") return undefined;
	const message = event.message as { role?: string; content?: Parameters<typeof userMessageText>[0] };
	return message.role === "user" ? userMessageText(message.content) : undefined;
}

/**
 * Builds pi prompt input from an AHP message and its attachments. `context`
 * is extra text the host resolved for the message (such as referenced
 * skills), appended after the attachments.
 */
export function promptInput(message: Message, context: readonly string[] = []): PromptInput {
	const images: ImageInput[] = [];
	const extra: string[] = [];
	for (const attachment of message.attachments ?? []) {
		switch (attachment.type) {
			case MessageAttachmentKind.EmbeddedResource:
				if (attachment.contentType.startsWith("image/")) {
					images.push({ type: "image", data: attachment.data, mimeType: attachment.contentType });
				} else if (attachment.contentType.startsWith("text/") || attachment.contentType === "application/json") {
					extra.push(`<attachment name="${attachment.label}">\n${attachment.data}\n</attachment>`);
				}
				break;
			case MessageAttachmentKind.Resource: {
				const path = pathFromFileUri(attachment.uri);
				if (path) extra.push(`Attached file: ${path}`);
				break;
			}
			case MessageAttachmentKind.Simple:
				if (attachment.modelRepresentation) extra.push(attachment.modelRepresentation);
				break;
			default:
				break;
		}
	}
	const text = [message.text, ...extra, ...context].filter((part) => part.length > 0).join("\n\n");
	return { text, images };
}
