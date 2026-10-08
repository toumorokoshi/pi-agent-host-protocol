import { existsSync } from "node:fs";
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import {
	ActionType,
	type ChatAction,
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
import { chatUri, fileUri, PROVIDER, pathFromFileUri, sessionUri } from "../core/uris.ts";
import type { ImageInput, PiAgent, PiBackend, PiEvent, PromptInput } from "./agent.ts";
import {
	referencedSkills,
	skillBlocks,
	slashCompletions,
	toCustomizations,
	type UserCommand,
	userCommands,
	withFrontmatter,
} from "./customizations.ts";
import { turnsFromEntries, userMessageText } from "./history.ts";
import { type IdleState, suspendBlocker } from "./idle.ts";
import { parseModelSelection, thinkingLevelOf } from "./models.ts";
import { TurnMapper, type TurnOutcome } from "./turn-mapper.ts";

export interface SessionHostContext {
	readonly store: StateStore;
	readonly backend: PiBackend;
	readonly logger: Logger;
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
}

/** What a run does: send a new user message, or continue a turn that ended in a resumable error. */
type RunKind = { kind: "prompt"; message: Message } | { kind: "resume" };

/** Text of a turn that pi started without a user message (for example, an extension continuing a run). */
const CONTINUED = "Continued in pi";

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
	/** Agents whose events are observed for runs started outside the host. */
	readonly #observed = new WeakSet<PiAgent>();
	/** The turn whose last run ended in a resumable provider error, if any. */
	#resumableTurn: string | undefined;
	/** Runs started per turn, so a resumed run gets fresh response part ids. */
	readonly #attempts = new Map<string, number>();
	/** Skills and prompt templates of the current agent, loaded when it is first observed. */
	#commands: Promise<readonly UserCommand[]> | undefined;
	#disposed = false;
	#hasTurns: boolean;
	/** When a client or pi last used the session, for stopping idle pi processes. */
	#lastActivity: number;

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
		this.#lastActivity = ctx.now();
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
		return PiSession.#fromHistory(ctx, manager, manager.getBranch(), manager.getSessionName());
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
	): PiSession {
		const manager =
			info.sessionFile && existsSync(info.sessionFile)
				? ctx.backend.openSessionManager(info.sessionFile)
				: ctx.backend.newSessionManager(info.cwd, info.sessionId);
		const session = PiSession.#fromHistory(ctx, manager, entries, info.name, info.sessionId, info.cwd);
		session.#agent = Promise.resolve(session.#observe(agent));
		return session;
	}

	static #fromHistory(
		ctx: SessionHostContext,
		manager: SessionManager,
		entries: readonly SessionEntry[],
		name: string | undefined,
		id = manager.getSessionId(),
		cwd = manager.getCwd(),
	): PiSession {
		const header = manager.getHeader();
		const createdAt = header?.timestamp ?? new Date().toISOString();
		const session = new PiSession(ctx, id, cwd, manager, createdAt);
		const turns = turnsFromEntries([...entries]);
		const title = name ?? (turns[0] ? titleFrom(turns[0].message.text) : UNTITLED);
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
			resource: sessionUri(this.id),
			provider: PROVIDER,
			title: session?.title ?? UNTITLED,
			status: chat?.status ?? SessionStatus.Idle,
			createdAt: this.createdAt,
			modifiedAt: chat?.modifiedAt ?? this.createdAt,
			workingDirectories: [fileUri(this.cwd)],
			...(chat?.activity ? { activity: chat.activity } : {}),
		};
	}

	/**
	 * Slash-command completions for a message being typed. Starts the agent
	 * if the session has none yet, since its commands come from pi.
	 */
	async completions(text: string, offset: number): Promise<CompletionItem[]> {
		this.#touch();
		if (!this.#commands) await this.#ensureAgent();
		return slashCompletions((await this.#commands) ?? [], text, offset);
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
		this.#touch();
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
		this.#touch();
		switch (action.type) {
			case ActionType.SessionTitleChanged:
				this.#saveTitle(action.title);
				this.#ctx.summaryChanged(this.id, { title: action.title });
				break;
			// The default chat's status is the session's summary status (it carries
			// the turn's activity bits), so session-level flags are mirrored onto it.
			case ActionType.SessionIsReadChanged:
				this.#dispatchChat({ type: ActionType.ChatIsReadChanged, isRead: action.isRead });
				this.#syncSummary();
				break;
			case ActionType.SessionIsArchivedChanged:
				this.#dispatchChat({ type: ActionType.ChatIsArchivedChanged, isArchived: action.isArchived });
				this.#syncSummary();
				break;
			default:
				break;
		}
	}

	/**
	 * Hands the session to a live TUI pi (single writer per session file).
	 * A pi process the host started for it is stopped once its current run
	 * has finished; new runs go to `agent`.
	 */
	adoptAgent(agent: PiAgent): void {
		const previous = this.#agent;
		this.#agent = Promise.resolve(this.#observe(agent));
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
		const background = await (agent.backgroundProcesses?.() ?? Promise.resolve([])).catch(() => [-1]);
		if (background.length > 0) {
			this.#ctx.logger.debug("idle session kept (background processes)", {
				session: this.id,
				pids: background.join(","),
			});
			return false;
		}
		// Re-checked: a turn may have started while the process table was read.
		if (this.#agent !== pending || suspendBlocker(this.idleState(agent), cutoff)) return false;
		this.#agent = undefined;
		await agent.dispose();
		this.#reopenSessionFile();
		return true;
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
		const start = () =>
			this.#ctx.backend.startAgent(this.cwd, this.#sessionManager).then((agent) => this.#observe(agent));
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

	async #execute(first: ActiveTurn, run: RunKind): Promise<void> {
		// A steering message pi delivers mid-run moves the rest of the run to a new turn.
		let turn = first;
		let outcome: TurnOutcome = { kind: "cancelled" };
		let unsubscribe: (() => void) | undefined;
		try {
			if (!turn.cancelledByClient) {
				const agent = await this.#ensureAgent();
				if (run.kind === "prompt") await this.#applyModel(agent, run.message);
				// The first user message of a prompt run is the prompt itself; later ones were steered in.
				let promptSeen = run.kind !== "prompt";
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
				this.#ctx.logger.debug(run.kind === "prompt" ? "turn started" : "turn resumed", {
					session: this.id,
					turn: turn.id,
					model: agent.model ? `${agent.model.provider}/${agent.model.id}` : undefined,
					chars: run.kind === "prompt" ? run.message.text.length : undefined,
					attachments: run.kind === "prompt" ? run.message.attachments?.length : undefined,
				});
				this.#hostRun = true;
				if (run.kind === "prompt") await agent.prompt(await this.#promptInput(run.message));
				else await agent.resume();
				outcome = turn.mapper.impliedOutcome();
			}
		} catch (error) {
			outcome = turn.mapper.aborted
				? { kind: "cancelled" }
				: { kind: "error", message: error instanceof Error ? error.message : String(error) };
		} finally {
			this.#hostRun = false;
			this.#steered = [];
			unsubscribe?.();
		}
		this.#hasTurns = true;
		if (!turn.cancelledByClient) turn.mapper.finish(outcome, Date.now() - turn.startedAt);
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
		this.#touch();
		this.#syncSummary();
		this.#consumePending();
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
		previous.mapper.finish({ kind: "complete" }, Date.now() - previous.startedAt);
		const turnId = crypto.randomUUID();
		const mapper = new TurnMapper(turnId, (action) => {
			if (this.#turn === turn && !turn.cancelledByClient) this.#dispatchChat(action);
		});
		const turn: ActiveTurn = { id: turnId, mapper, startedAt: Date.now(), cancelledByClient: false };
		this.#dispatchChat({ type: ActionType.ChatTurnStarted, turnId, startedAt: new Date().toISOString(), message });
		if (this.#turn === previous) this.#turn = turn;
		this.#ctx.logger.debug("steering message started a turn", { session: this.id, from: previous.id, turn: turnId });
		this.#syncSummary();
		return turn;
	}

	/** Watches an agent for runs started outside the host. Returns the agent. */
	#observe(agent: PiAgent): PiAgent {
		if (!this.#observed.has(agent)) {
			this.#observed.add(agent);
			agent.subscribe((event) => this.#onAgentEvent(event));
			this.#loadCommands(agent);
		}
		return agent;
	}

	/** Prompt input for a message, with the skills its completion chips reference later in the text. */
	async #promptInput(message: Message): Promise<PromptInput> {
		const commands = await (this.#commands ?? Promise.resolve([])).catch(() => []);
		return promptInput(message, await skillBlocks(referencedSkills(message, commands)));
	}

	/** Reads the agent's skills and prompt templates and publishes them as session customizations. */
	#loadCommands(agent: PiAgent): void {
		const loaded = agent.commands().then((commands) => withFrontmatter(userCommands(commands)));
		this.#commands = loaded;
		loaded
			.then((commands) => {
				if (this.#commands !== loaded || this.#disposed) return;
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
		const mapper = new TurnMapper(turnId, (action) => {
			if (!turn.cancelledByClient) this.#dispatchChat(action);
		});
		const turn: ActiveTurn = { id: turnId, mapper, startedAt: Date.now(), cancelledByClient: false };
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

	/** Consumes steering and queued messages as the chat-channel spec describes. */
	#consumePending(): void {
		const chat = this.#ctx.store.chat(this.id);
		if (!chat) return;
		if (chat.steeringMessage && this.#turn && !this.#turn.cancelledByClient) {
			const { id, message } = chat.steeringMessage;
			this.#dispatchChat({ type: ActionType.ChatPendingMessageRemoved, kind: PendingMessageKind.Steering, id });
			this.#ctx.logger.debug("steering message sent", { session: this.id, turn: this.#turn.id, message: id });
			// In a run the TUI started, pi's echo of the message already opens a turn (`#onAgentEvent`).
			if (this.#turn !== this.#externalRun) this.#steered.push(message);
			void this.#agent?.then(async (agent) => agent.steer(await this.#promptInput(message))).catch(() => {});
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
		// A turn the client cancelled drops the mapper's final actions, so its activity is cleared here.
		if (!chat.activeTurn && chat.activity !== undefined) {
			this.#dispatchChat({ type: ActionType.ChatActivityChanged, activity: undefined });
		}
		this.#dispatchSession({
			type: ActionType.SessionChatUpdated,
			chat: chatUri(this.id),
			changes: { status: chat.status, modifiedAt: chat.modifiedAt },
		});
		this.#ctx.store.setSessionStatus(this.id, chat.status);
		this.#ctx.summaryChanged(this.id, { status: chat.status, modifiedAt: chat.modifiedAt });
	}

	/**
	 * Mirrors the chat's activity text into the session state, the session's
	 * chat catalog and the root summary, as AHP's summary aggregation rules ask.
	 * `null` in the root summary explicitly clears the text (omitting the field
	 * would leave the client's cached value in place).
	 */
	#syncActivity(): void {
		const activity = this.#ctx.store.chat(this.id)?.activity;
		if (this.#ctx.store.session(this.id)?.activity === activity) return;
		this.#dispatchSession({ type: ActionType.SessionActivityChanged, activity });
		this.#dispatchSession({ type: ActionType.SessionChatUpdated, chat: chatUri(this.id), changes: { activity } });
		this.#ctx.summaryChanged(this.id, { activity: activity ?? null });
	}

	#dispatchChat(action: ChatAction): void {
		this.#ctx.store.dispatch(chatUri(this.id), action);
		if (action.type === ActionType.ChatActivityChanged) this.#syncActivity();
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
