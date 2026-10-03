import type { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	ActionType,
	type ChatAction,
	type ChatState,
	type ChatSummary,
	type Message,
	MessageAttachmentKind,
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
import { chatUri, fileUri, PROVIDER, pathFromFileUri, sessionUri } from "../core/uris.ts";
import type { ImageInput, PiAgent, PiBackend, PiEvent, PromptInput } from "./agent.ts";
import { turnsFromEntries } from "./history.ts";
import { parseModelSelection, thinkingLevelOf } from "./models.ts";
import { TurnMapper, type TurnOutcome } from "./turn-mapper.ts";

export interface SessionHostContext {
	readonly store: StateStore;
	readonly backend: PiBackend;
	readonly logger: Logger;
	/** Publishes `root/sessionSummaryChanged` for this session. */
	summaryChanged(sessionId: string, changes: Partial<SessionSummary>): void;
	/** Called whenever a session starts or stops running a turn. */
	activityChanged(): void;
}

interface ActiveTurn {
	readonly id: string;
	readonly mapper: TurnMapper;
	readonly startedAt: number;
	/** Set when the client already ended the turn with `chat/turnCancelled`. */
	cancelledByClient: boolean;
}

/** What a run does: send a new user message, or continue a turn that ended in a resumable error. */
type RunKind = { kind: "prompt"; message: Message } | { kind: "resume" };

const TITLE_LENGTH = 80;
const UNTITLED = "New session";

function titleFrom(text: string): string {
	const line = text.trim().split("\n")[0] ?? "";
	return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1)}…` : line || UNTITLED;
}

/** Binds one AHP session (and its single default chat) to one pi agent session. */
export class PiSession {
	readonly id: string;
	readonly cwd: string;
	readonly createdAt: string;
	readonly #ctx: SessionHostContext;
	readonly #sessionManager: SessionManager;
	#agent: Promise<PiAgent> | undefined;
	#turn: ActiveTurn | undefined;
	#lastRun: Promise<void> = Promise.resolve();
	/** The turn whose last run ended in a resumable provider error, if any. */
	#resumableTurn: string | undefined;
	/** Runs started per turn, so a resumed run gets fresh response part ids. */
	readonly #attempts = new Map<string, number>();
	#disposed = false;
	#hasTurns: boolean;

	private constructor(
		ctx: SessionHostContext,
		id: string,
		cwd: string,
		sessionManager: SessionManager,
		createdAt: string,
	) {
		this.#ctx = ctx;
		this.id = id;
		this.cwd = cwd;
		this.#sessionManager = sessionManager;
		this.createdAt = createdAt;
		this.#hasTurns = false;
	}

	/** A new, empty session. The pi agent starts immediately; `session/ready` follows. */
	static create(ctx: SessionHostContext, id: string, cwd: string): PiSession {
		const now = new Date().toISOString();
		const session = new PiSession(ctx, id, cwd, ctx.backend.newSessionManager(cwd, id), now);
		ctx.store.addSession(id, session.#initialSessionState(UNTITLED, SessionLifecycle.Creating, SessionStatus.Idle), {
			...session.#chatSummary(UNTITLED, SessionStatus.Idle, now),
			turns: [],
		});
		return session;
	}

	/** An existing pi session file. History is loaded eagerly; the agent starts on the first turn. */
	static open(ctx: SessionHostContext, path: string): PiSession {
		const manager = ctx.backend.openSessionManager(path);
		const header = manager.getHeader();
		const id = manager.getSessionId();
		const cwd = manager.getCwd();
		const createdAt = header?.timestamp ?? new Date().toISOString();
		const session = new PiSession(ctx, id, cwd, manager, createdAt);
		const turns = turnsFromEntries(manager.getBranch());
		const title = manager.getSessionName() ?? (turns[0] ? titleFrom(turns[0].message.text) : UNTITLED);
		const lastTurn = turns.at(-1);
		const modifiedAt =
			lastTurn?.startedAt && lastTurn.duration !== undefined
				? new Date(Date.parse(lastTurn.startedAt) + lastTurn.duration).toISOString()
				: createdAt;
		const status = SessionStatus.Idle | SessionStatus.IsRead;
		session.#hasTurns = turns.length > 0;
		ctx.store.addSession(id, session.#initialSessionState(title, SessionLifecycle.Ready, status), {
			...session.#chatSummary(title, status, modifiedAt),
			turns,
		});
		return session;
	}

	get hasTurns(): boolean {
		return this.#hasTurns;
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
			resource: sessionUri(this.id),
			provider: PROVIDER,
			title: session?.title ?? UNTITLED,
			status: chat?.status ?? SessionStatus.Idle,
			createdAt: this.createdAt,
			modifiedAt: chat?.modifiedAt ?? this.createdAt,
			workingDirectories: [fileUri(this.cwd)],
		};
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
			default:
				return `Unsupported action: ${action.type}`;
		}
	}

	/** Side effects of an accepted client chat action (already applied to state). */
	onChatAction(action: ChatAction): void {
		switch (action.type) {
			case ActionType.ChatTurnStarted:
				this.#runTurn(action.turnId, { kind: "prompt", message: action.message });
				break;
			case ActionType.ChatTurnResume:
				this.#runTurn(action.turnId, { kind: "resume" });
				break;
			case ActionType.ChatTurnCancelled:
				if (this.#turn?.id === action.turnId) {
					this.#turn.cancelledByClient = true;
					this.#ctx.logger.debug("turn cancelled by client", { session: this.id, turn: action.turnId });
					this.#turn = undefined;
					this.#ctx.activityChanged();
					void this.#agent?.then((agent) => agent.abort()).catch(() => {});
				}
				this.#syncSummary();
				break;
			case ActionType.ChatPendingMessageSet:
				this.#consumePending();
				break;
			case ActionType.ChatIsReadChanged:
			case ActionType.ChatIsArchivedChanged:
				this.#syncSummary();
				break;
			default:
				break;
		}
	}

	/** Side effects of an accepted client session action (already applied to state). */
	onSessionAction(action: StateAction): void {
		if (action.type === ActionType.SessionTitleChanged) {
			this.#saveTitle(action.title);
			this.#ctx.summaryChanged(this.id, { title: action.title });
		}
	}

	async dispose(): Promise<void> {
		this.#disposed = true;
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
		const start = () => this.#ctx.backend.startAgent(this.cwd, this.#sessionManager);
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
		);
		const turn: ActiveTurn = { id: turnId, mapper, startedAt: Date.now(), cancelledByClient: false };
		this.#turn = turn;
		this.#ctx.activityChanged();
		this.#syncSummary();
		if (run.kind === "prompt") this.#maybeSetTitle(run.message.text);
		const previous = this.#lastRun;
		this.#lastRun = previous.then(() => this.#execute(turn, run));
	}

	async #execute(turn: ActiveTurn, run: RunKind): Promise<void> {
		const { mapper } = turn;
		let outcome: TurnOutcome = { kind: "cancelled" };
		let unsubscribe: (() => void) | undefined;
		try {
			if (!turn.cancelledByClient) {
				const agent = await this.#ensureAgent();
				if (run.kind === "prompt") await this.#applyModel(agent, run.message);
				unsubscribe = agent.subscribe((event) => {
					this.#logEvent(turn, event);
					mapper.handle(event);
				});
				this.#ctx.logger.debug(run.kind === "prompt" ? "turn started" : "turn resumed", {
					session: this.id,
					turn: turn.id,
					model: agent.model ? `${agent.model.provider}/${agent.model.id}` : undefined,
					chars: run.kind === "prompt" ? run.message.text.length : undefined,
					attachments: run.kind === "prompt" ? run.message.attachments?.length : undefined,
				});
				if (run.kind === "prompt") await agent.prompt(promptInput(run.message));
				else await agent.resume();
				outcome = mapper.impliedOutcome();
			}
		} catch (error) {
			outcome = mapper.aborted
				? { kind: "cancelled" }
				: { kind: "error", message: error instanceof Error ? error.message : String(error) };
		} finally {
			unsubscribe?.();
		}
		this.#hasTurns = true;
		if (!turn.cancelledByClient) mapper.finish(outcome, Date.now() - turn.startedAt);
		if (!turn.cancelledByClient && outcome.kind === "error" && outcome.resumable) this.#resumableTurn = turn.id;
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

	/** Consumes steering and queued messages as the chat-channel spec describes. */
	#consumePending(): void {
		const chat = this.#ctx.store.chat(this.id);
		if (!chat) return;
		if (chat.steeringMessage && this.#turn && !this.#turn.cancelledByClient) {
			const { id, message } = chat.steeringMessage;
			this.#dispatchChat({ type: ActionType.ChatPendingMessageRemoved, kind: PendingMessageKind.Steering, id });
			this.#ctx.logger.debug("steering message sent", { session: this.id, turn: this.#turn.id, message: id });
			void this.#agent?.then((agent) => agent.steer(promptInput(message))).catch(() => {});
		}
		const next = chat.queuedMessages?.[0];
		if (next && !this.#turn && !chat.activeTurn) {
			this.#dispatchChat({ type: ActionType.ChatPendingMessageRemoved, kind: PendingMessageKind.Queued, id: next.id });
			this.#ctx.logger.debug("queued message started", { session: this.id, message: next.id });
			const turnId = crypto.randomUUID();
			this.#dispatchChat({
				type: ActionType.ChatTurnStarted,
				turnId,
				startedAt: new Date().toISOString(),
				message: next.message,
				queuedMessageId: next.id,
			});
			this.#runTurn(turnId, { kind: "prompt", message: next.message });
		}
	}

	#maybeSetTitle(text: string): void {
		const session = this.#ctx.store.session(this.id);
		if (!session || session.title !== UNTITLED || this.#sessionManager.getSessionName()) return;
		const title = titleFrom(text);
		if (title === UNTITLED) return;
		this.#dispatchSession({ type: ActionType.SessionTitleChanged, title });
		this.#ctx.summaryChanged(this.id, { title });
	}

	/** Mirrors the chat's summary fields into the session catalog and root summary. */
	#syncSummary(): void {
		const chat = this.#ctx.store.chat(this.id);
		if (!chat) return;
		this.#dispatchSession({
			type: ActionType.SessionChatUpdated,
			chat: chatUri(this.id),
			changes: { status: chat.status, modifiedAt: chat.modifiedAt },
		});
		this.#ctx.summaryChanged(this.id, { status: chat.status, modifiedAt: chat.modifiedAt });
	}

	#dispatchChat(action: ChatAction): void {
		this.#ctx.store.dispatch(chatUri(this.id), action);
	}

	#dispatchSession(action: StateAction): void {
		this.#ctx.store.dispatch(sessionUri(this.id), action);
	}

	#chatSummary(title: string, status: SessionStatus, modifiedAt: string): ChatSummary & Pick<ChatState, "resource"> {
		return { resource: chatUri(this.id), title, status, modifiedAt };
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
			defaultChat: chatUri(this.id),
		};
	}
}

/** Builds pi prompt input from an AHP message and its attachments. */
export function promptInput(message: Message): PromptInput {
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
	const text = [message.text, ...extra].filter((part) => part.length > 0).join("\n\n");
	return { text, images };
}
